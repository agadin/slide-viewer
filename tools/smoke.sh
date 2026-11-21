#!/usr/bin/env bash
# End-to-end smoke run of the real app (macOS): tauri dev + src/dev/smoke.ts.
#
#   tools/smoke.sh <slide.ndpi> [annotations.ndpa] [scratch dir] [screenshot dir]
#
# Makes <scratch>/slides with a SYMLINK to the slide and a COPY of the .ndpa (so the original folder is
# never written to), starts `tauri dev` on port 1437 (1420 may belong to another app's dev server) with
# the main window at index.html?smoke=<scratch>/slides, screenshots the window at each stage, prints
# smoke-report.json, and stops only the processes it started.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SLIDE="${1:?usage: tools/smoke.sh <slide> [ndpa] [scratch] [shots]}"
NDPA="${2:-}"
SCRATCH="${3:-${TMPDIR:-/tmp}/slide-viewer-smoke}"
SHOTS="${4:-$SCRATCH/shots}"
PORT="${SMOKE_PORT:-1437}"

rm -rf "$SCRATCH/slides"
mkdir -p "$SCRATCH/slides" "$SHOTS"
ln -s "$SLIDE" "$SCRATCH/slides/$(basename "$SLIDE")"
if [ -n "$NDPA" ]; then cp "$NDPA" "$SCRATCH/slides/$(basename "$SLIDE").ndpa"; fi
# more slides for the browser list (README screenshots): SMOKE_EXTRA="/a/x.ndpi:/b/y.svs"
IFS=':' read -r -a EXTRA <<< "${SMOKE_EXTRA:-}"
for x in ${EXTRA[@]+"${EXTRA[@]}"}; do [ -n "$x" ] && ln -s "$x" "$SCRATCH/slides/$(basename "$x")"; done
DIR="$SCRATCH/slides"
REPORT="$DIR/smoke-report.json"

CONFIG=$(python3 - "$DIR" "$PORT" <<'PY'
import json, os, sys, urllib.parse
d, port = sys.argv[1], sys.argv[2]
print(json.dumps({
  "build": {"devUrl": f"http://localhost:{port}", "beforeDevCommand": f"npx vite --port {port} --strictPort"},
  "app": {"windows": [{
    "title": "Slide Viewer", "label": "main", "width": 1280, "height": 820, "minWidth": 720, "minHeight": 560,
    "titleBarStyle": "Overlay", "hiddenTitle": True, "trafficLightPosition": {"x": 16, "y": 22}, "center": True,
    "url": "index.html?smoke=" + urllib.parse.quote(d) + os.environ.get("SMOKE_QUERY", "")}]},
}))
PY
)

WINID_SWIFT="$SCRATCH/winid.swift"
cat > "$WINID_SWIFT" <<'SWIFT'
import CoreGraphics
let pid = Int(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list where (w["kCGWindowOwnerPID"] as? Int) == pid && (w["kCGWindowLayer"] as? Int) == 0 {
  if let n = w["kCGWindowNumber"] as? Int { print(n); break }
}
SWIFT

cd "$ROOT/app"
set -m # own process group, so we stop exactly what we started
# SMOKE_RELEASE=1: optimised backend (debug builds decode big microscope frames many times slower)
npx tauri dev ${SMOKE_RELEASE:+--release} --config "$CONFIG" >"$SCRATCH/tauri-dev.log" 2>&1 &
LEADER=$!
PGID=$(ps -o pgid= -p "$LEADER" | tr -d ' ')
set +m
cleanup() { kill -TERM -- "-$PGID" 2>/dev/null || true; sleep 1; kill -KILL -- "-$PGID" 2>/dev/null || true; }
trap cleanup EXIT

seen=""
deadline=$((SECONDS + 900))
while [ $SECONDS -lt $deadline ]; do
  if [ -f "$REPORT" ]; then
    stage=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("stage",""))' "$REPORT" 2>/dev/null || true)
    if [ -n "$stage" ] && [ "$stage" != "$seen" ]; then
      seen="$stage"
      APP_PID=$(ps -o pid=,pgid=,command= -ax | awk -v g="$PGID" '$2==g && $3 ~ /target\/(debug|release)\/app$/ && !p {p=$1} END {print p}' || true)
      if [ -n "$APP_PID" ]; then
        WID=$(swift "$WINID_SWIFT" "$APP_PID" 2>/dev/null || true)
        sleep 1
        if [ -n "$WID" ]; then screencapture -x -o -l "$WID" "$SHOTS/$stage.png" || echo "screenshot failed for $stage"; fi
      fi
      [ "$stage" = "done" ] && break
    fi
  fi
  if ! kill -0 "$LEADER" 2>/dev/null; then echo "tauri dev exited; see $SCRATCH/tauri-dev.log"; break; fi
  sleep 1
done
cat "$REPORT" 2>/dev/null || echo "no report"
ls "$SHOTS"
