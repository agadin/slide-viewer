#!/usr/bin/env bash
# Checks a built macOS app carries the native slide libraries it needs, the way a student's Mac
# will run it (CI: the Build workflow; locally after `npx tauri build --bundles app`):
#   tools/check-mac-bundle.sh "app/src-tauri/target/release/bundle/macos/Slide Viewer.app" <slide>...
# - every dylib in app/src-tauri/frameworks/ (what the fetch scripts leave) is in Contents/Frameworks
# - each of them is universal (Apple silicon + Intel: the release app is universal)
# - nothing in the bundle links to a library outside macOS itself (/usr/lib, /System) or the bundle
#   (e.g. a Homebrew path that only exists on the build machine)
# - the `smoke` example, copied into Contents/MacOS, opens each <slide> and renders tiles with only
#   the bundled libraries: the source tree's frameworks/ is moved aside while it runs
set -euo pipefail
APP="${1:?usage: tools/check-mac-bundle.sh <Name.app> <slide>...}"
shift
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$ROOT/app/src-tauri"
FW="$APP/Contents/Frameworks"
fail=0
bad() { echo "FAIL $*"; fail=1; }
good() { echo "PASS $*"; }

for src in "$T"/frameworks/*.dylib; do
  n=$(basename "$src")
  if [ -f "$FW/$n" ]; then good "bundled: $n"; else bad "the app has no Contents/Frameworks/$n"; continue; fi
  archs=$(lipo -archs "$FW/$n")
  case "$archs" in *arm64*x86_64* | *x86_64*arm64*) good "$n is universal ($archs)" ;; *) bad "$n is only $archs" ;; esac
done

# every Mach-O file in the bundle: its dependencies are in the OS or in the bundle
while IFS= read -r f; do
  file -b "$f" | grep -q "Mach-O" || continue
  self=$(otool -D "$f" 2>/dev/null | tail -n +2 | head -1)
  while IFS= read -r dep; do
    [ "$dep" = "$self" ] && continue
    case "$dep" in
      /usr/lib/* | /System/Library/*) ;;
      @rpath/* | @loader_path/* | @executable_path/*)
        [ -f "$FW/$(basename "$dep")" ] || bad "${f#$APP/} needs $dep, which isn't in Contents/Frameworks" ;;
      *) bad "${f#$APP/} links $dep, outside macOS and the app" ;;
    esac
  done < <(otool -L "$f" | grep $'^\t' | awk '{print $1}' | sort -u)
done < <(find "$APP/Contents" -type f \( -perm -u+x -o -name '*.dylib' \))
[ $fail = 0 ] && good "every library the app links is in macOS or in the app"

# open slides from inside the bundle, with the source tree's copies out of the way
if [ $# -gt 0 ]; then
  (cd "$T" && cargo build --release --example smoke -q)
  cp "$T/target/release/examples/smoke" "$APP/Contents/MacOS/smoke"
  mv "$T/frameworks" "$T/frameworks-moved"
  trap 'mv "$T/frameworks-moved" "$T/frameworks"; rm -f "$APP/Contents/MacOS/smoke"' EXIT
  for s in "$@"; do
    if out=$("$APP/Contents/MacOS/smoke" "$s" 2>&1); then
      good "opened $(basename "$s") from inside the app"
    else
      bad "could not open $(basename "$s") with the bundled libraries: $(printf '%s\n' "$out" | tail -1)"
    fi
  done
fi
exit $fail
