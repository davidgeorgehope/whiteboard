#!/usr/bin/env bash
# Tune the Anker PowerConf C200 for the overhead whiteboard rig via UVC.
# The camera ships with autofocus disabled and focus parked for conference
# distance; these values were calibrated with a sharpness sweep against the
# actual paper. Re-run after the camera is unplugged or the Mac reboots.
set -euo pipefail

FOCUS="${FOCUS:-300}" # sharpest for the overhead stand (valid 300-650)
ZOOM="${ZOOM:-100}"   # camera sits close enough that the page fills the frame unzoomed

UVC_DIR="$(dirname "$0")/../.uvc-util"
UVC="$UVC_DIR/uvc-util"

if [ ! -x "$UVC" ]; then
  echo "building uvc-util..."
  git clone --depth 1 https://github.com/jtfrey/uvc-util.git "$UVC_DIR"
  (cd "$UVC_DIR" && clang -o uvc-util src/*.m -framework Foundation -framework IOKit -fno-objc-arc)
fi

INDEX=$("$UVC" -d | awk '/Anker PowerConf C200/ {print $1}')
if [ -z "$INDEX" ]; then
  echo "Anker PowerConf C200 not found:" >&2
  "$UVC" -d >&2
  exit 1
fi

"$UVC" -I "$INDEX" -s auto-focus=false
"$UVC" -I "$INDEX" -s focus-abs="$FOCUS"
"$UVC" -I "$INDEX" -s zoom-abs="$ZOOM"
echo "C200 tuned: focus=$FOCUS zoom=$ZOOM"
