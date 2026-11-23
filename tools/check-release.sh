#!/usr/bin/env bash
# Checks a published release the way an installed copy will see it:
#   tools/check-release.sh 0.1.2        (CI: .github/workflows/release-check.yml, when a release is published)
# - latest.json (the updater's endpoint in tauri.conf.json) names this version, and the release is Latest
# - it lists Apple silicon, Intel and Windows, and each download is there
# - each download's signature verifies against the updater public key in tauri.conf.json
#   (what the app checks before installing), using minisign
# - the release has the DMG and the Windows installer for people installing by hand
# Needs curl, python3, minisign. Downloads ~150 MB into a temp folder.
set -euo pipefail
VER="${1:?usage: tools/check-release.sh <version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF="$ROOT/app/src-tauri/tauri.conf.json"
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
fail=0
bad() { echo "FAIL $*"; fail=1; }
good() { echo "PASS $*"; }

ENDPOINT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["plugins"]["updater"]["endpoints"][0])' "$CONF")
python3 -c 'import json,sys,base64; open(sys.argv[2],"wb").write(base64.b64decode(json.load(open(sys.argv[1]))["plugins"]["updater"]["pubkey"]))' "$CONF" "$W/key.pub"
# the release page can lag a few seconds behind the publish event
for i in 1 2 3 4 5 6; do curl -fsSL -o "$W/latest.json" "$ENDPOINT" && break; sleep 10; done
[ -s "$W/latest.json" ] || { bad "could not download $ENDPOINT"; exit 1; }

got=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$W/latest.json")
[ "$got" = "$VER" ] && good "latest.json is version $VER" || bad "latest.json is version $got, not $VER (is v$VER marked Latest?)"

# one line per platform: name url signature
python3 - "$W/latest.json" > "$W/platforms" <<'PY'
import json, sys
for k, v in json.load(open(sys.argv[1]))["platforms"].items():
    print(k, v["url"], v["signature"])
PY
for p in darwin-aarch64 darwin-x86_64 windows-x86_64; do
  grep -q "^$p " "$W/platforms" && good "latest.json lists $p" || bad "latest.json has no $p (installed copies there won't update)"
done

# each distinct download: present, and its signature verifies against the app's public key
seen=""
while read -r plat url sig; do
  case " $seen " in *" $url "*) continue ;; esac
  seen="$seen $url"
  f="$W/$(basename "$url")"
  if ! curl -fsSL --retry 3 -o "$f" "$url"; then bad "$plat: cannot download $url"; continue; fi
  printf '%s' "$sig" | python3 -c 'import sys,base64; sys.stdout.buffer.write(base64.b64decode(sys.stdin.read()))' > "$f.minisig"
  if minisign -Vq -p "$W/key.pub" -m "$f" -x "$f.minisig"; then
    good "$plat: $(basename "$url") ($(($(wc -c < "$f") / 1000000)) MB) verifies against the updater key"
  else
    bad "$plat: $(basename "$url") does not verify against the updater key (the app will refuse it)"
  fi
done < "$W/platforms"

# files for installing by hand
assets=$(gh release view "v$VER" -R agadin/slide-viewer --json assets -q '.assets[].name' 2>/dev/null || true)
for a in "Slide-Viewer_${VER}_macOS.dmg" "Slide-Viewer_${VER}_Windows-x64-setup.exe" "Slide-Viewer.app.tar.gz.sig" latest.json; do
  grep -qx "$a" <<<"$assets" && good "release has $a" || bad "release v$VER has no $a"
done

exit $fail
