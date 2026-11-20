#!/bin/bash
# Build, sign, notarize and publish a Slide Viewer release that the in-app updater picks up:
#   tools/release.sh 0.1.1 "What changed"
# - macOS: one universal app (Apple silicon + Intel), signed, notarized, stapled.
# - Windows: built by the Build workflow on GitHub (started here, on the same commit), then its
#   installer is signed for the updater on this machine, so the updater key never leaves it.
#   SKIP_WINDOWS=1 releases macOS only.
# Needs: Developer ID cert in the keychain, `xcrun notarytool` profile "notary", the updater key
# at ~/.tauri/slide-viewer.key (made once with `npx tauri signer generate -w ~/.tauri/slide-viewer.key`;
# its public key goes in tauri.conf.json plugins.updater.pubkey), rustup targets aarch64- and
# x86_64-apple-darwin, `gh` logged in.
# Native libraries: OpenSlide (tools/fetch-openslide.sh) always; libCZI (tools/fetch-libczi.sh,
# same "mac|windows" interface) when that script exists. Every dylib in app/src-tauri/frameworks/
# is bundled into the app's Frameworks folder (see the overlay config below).
set -euo pipefail
VER="${1:?version, e.g. 0.1.1}"
NOTES="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/app"
T="$APP/src-tauri"
B="$T/target/universal-apple-darwin/release/bundle"
OUT="$(mktemp -d)"
IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Alexander Gadin (8644223FJ6)}"
KEY="${UPDATER_KEY:-$HOME/.tauri/slide-viewer.key}"
REPO=agadin/slide-viewer
NAME="Slide Viewer"        # productName in tauri.conf.json (the .app and DMG names)
FILE="Slide-Viewer"        # the same without spaces, for release asset names
DL="https://github.com/$REPO/releases/download/v$VER"

[ -f "$KEY" ] || { echo "no updater key at $KEY (see the top of this script)" >&2; exit 1; }
grep -q '"pubkey": "TODO' "$T/tauri.conf.json" && { echo "tauri.conf.json has no updater pubkey yet (see the top of this script)" >&2; exit 1; }

# what's released must be what's on GitHub (the release tags main there, and Windows builds from it)
git -C "$ROOT" fetch -q origin main
[ "$(git -C "$ROOT" rev-parse HEAD)" = "$(git -C "$ROOT" rev-parse origin/main)" ] || { echo "push main first: HEAD isn't origin/main" >&2; exit 1; }
CONF_VER=$(python3 -c "import json;print(json.load(open('$T/tauri.conf.json'))['version'])")
[ "$CONF_VER" = "$VER" ] || { echo "the version files say $CONF_VER; bump them to $VER and push first (see CLAUDE.md)" >&2; exit 1; }
SHA=$(git -C "$ROOT" rev-parse HEAD)

# Windows: start it now so it builds while macOS notarizes
if [ -z "${SKIP_WINDOWS:-}" ]; then
  gh workflow run build.yml -R "$REPO" --ref main -f version="$VER"
  RUN=""
  for _ in $(seq 1 30); do
    sleep 4
    RUN=$(gh run list -R "$REPO" --workflow build.yml --event workflow_dispatch --limit 5 --json databaseId,headSha \
      -q "map(select(.headSha == \"$SHA\"))[0].databaseId // empty")
    [ -n "$RUN" ] && break
  done
  [ -n "$RUN" ] || { echo "couldn't find the Windows build run" >&2; exit 1; }
  echo "Windows build: https://github.com/$REPO/actions/runs/$RUN"
fi

# macOS: native libraries, then the universal build
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
"$ROOT/tools/fetch-openslide.sh" mac >/dev/null
if [ -x "$ROOT/tools/fetch-libczi.sh" ]; then "$ROOT/tools/fetch-libczi.sh" mac >/dev/null; fi
# bundle every dylib the fetch scripts left in frameworks/ (OpenSlide, and libCZI when present)
OVERLAY=$(cd "$T" && python3 - <<'PY'
import glob, json
libs = sorted(glob.glob("frameworks/*.dylib"))
lic = {p: "licenses/" + p.split("/")[-1] for p in sorted(glob.glob("frameworks/*LICENSE*"))}
print(json.dumps({"bundle": {"macOS": {"frameworks": libs}, "resources": lic}}))
PY
)
echo "bundling: $OVERLAY"
(cd "$APP" && APPLE_SIGNING_IDENTITY="$IDENTITY" TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")" \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npm run tauri build -- --target universal-apple-darwin --bundles app,dmg --config "$OVERLAY")

# notarize + staple the app, then rebuild the updater archive from the stapled app
cd "$B/macos"
ditto -c -k --keepParent "$NAME.app" "$OUT/app.zip"
xcrun notarytool submit "$OUT/app.zip" --keychain-profile notary --wait
xcrun stapler staple "$NAME.app"
COPYFILE_DISABLE=1 tar -czf "$OUT/$FILE.app.tar.gz" "$NAME.app"
sign() { (cd "$APP" && TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npx tauri signer sign -f "$KEY" "$1" >/dev/null); }
sign "$OUT/$FILE.app.tar.gz"

DMG="$OUT/${FILE}_${VER}_macOS.dmg"
cp "$B/dmg/${NAME}_${VER}_universal.dmg" "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile notary --wait
xcrun stapler staple "$DMG"
ASSETS=("$DMG" "$OUT/$FILE.app.tar.gz" "$OUT/$FILE.app.tar.gz.sig")

# Windows: wait for the build, sign its installer for the updater
WIN=""
if [ -n "${SKIP_WINDOWS:-}" ]; then
  echo "SKIP_WINDOWS set: releasing macOS only"
else
  gh run watch "$RUN" -R "$REPO" --exit-status >/dev/null || { echo "the Windows build failed: https://github.com/$REPO/actions/runs/$RUN (SKIP_WINDOWS=1 releases macOS only)" >&2; exit 1; }
  gh run download "$RUN" -R "$REPO" -n windows-installer -D "$OUT/win"
  src=$(ls "$OUT"/win/*.exe | head -1)
  WIN="$OUT/${FILE}_${VER}_Windows-x64-setup.exe"
  mv "$src" "$WIN"
  sign "$WIN"
  ASSETS+=("$WIN" "$WIN.sig")
fi

python3 - "$OUT" "$VER" "$NOTES" "$DL" "$WIN" "$FILE" <<'PY'
import json, sys, datetime, os
out, ver, notes, dl, win, file = sys.argv[1:7]
mac = {"signature": open(f"{out}/{file}.app.tar.gz.sig").read().strip(), "url": f"{dl}/{file}.app.tar.gz"}
plat = {"darwin-aarch64": mac, "darwin-x86_64": mac}
if win:
    plat["windows-x86_64"] = {"signature": open(win + ".sig").read().strip(), "url": f"{dl}/{os.path.basename(win)}"}
json.dump({"version": ver, "notes": notes,
           "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "platforms": plat}, open(f"{out}/latest.json", "w"), indent=2)
PY
ASSETS+=("$OUT/latest.json")

cd "$ROOT"
gh release create "v$VER" "${ASSETS[@]}" --target "$SHA" --title "$NAME $VER" --notes "${NOTES:-Release $VER}"
echo "released v$VER (files in $OUT)"
