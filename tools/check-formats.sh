#!/usr/bin/env bash
# Open every sample slide with the app's own backends (the `smoke` example) and print a table.
#   tools/fetch-format-samples.py test-data/formats   # once: ~7 GB of OpenSlide/Zeiss samples (checksummed)
#   tools/check-formats.sh                            # all files under test-data/formats
#   tools/check-formats.sh <file>...                  # or just these
# To look at one by eye (overview, a full-resolution tissue region, browser thumbnail, label/macro):
#   cd app/src-tauri && cargo run --release --example inspect -- <file> /tmp/inspect
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
smoke="$root/app/src-tauri/target/release/examples/smoke"
[ -x "$smoke" ] || (cd "$root/app/src-tauri" && cargo build --release --example smoke >/dev/null) || exit 1
if [ $# -eq 0 ]; then
  files=()
  while IFS= read -r f; do files+=("$f"); done < <(find "$root/test-data/formats" -type f \
    \( -iname '*.svs' -o -iname '*.tif' -o -iname '*.tiff' -o -iname '*.ndpi' -o -iname '*.scn' -o -iname '*.mrxs' \
       -o -iname '*.bif' -o -iname '*.vms' -o -iname '*.czi' -o -iname '*.zvi' -o -iname '*.avs' -o -iname '*.vsi' -o -iname '*.nd2' -o -iname '*.jpg' -o -iname '*.jpeg' \
       -o -iname '*.png' -o -iname '*.bmp' -o -iname '*.webp' -o -iname 'DCM_0.dcm' \) -not -path '*Hamamatsu-vms*/*.jpg' | sort)
  set -- "${files[@]}"
fi
# one line of the backend's JSON info -> "vendor | WxH | mpp | calibrated | z-planes"
FMT='
import sys, json
l = sys.stdin.read(); i = l.find("{")
try:
    d = json.loads(l[i:]); z = d.get("zPlanes") or d.get("z_planes") or [1]
    print("%s | %dx%d | %.3f um/px | calibrated=%s | z=%d" % (d.get("vendor") or d.get("format"), d["width"], d["height"], d.get("mppX", d.get("mpp_x")), d["calibrated"], len(z)))
except Exception:
    print("")'
fail=0
for f in "$@"; do
  out=$(perl -e 'alarm 300; exec @ARGV' "$smoke" "$f" 2>&1); code=$?
  info=$(printf '%s\n' "$out" | head -1 | python3 -c "$FMT" 2>/dev/null)
  if [ $code = 0 ]; then echo "PASS  ${f#$root/}  $info"; else fail=1; echo "FAIL  ${f#$root/}  $(printf '%s\n' "$out" | tail -1 | cut -c1-200)"; fi
done
exit $fail
