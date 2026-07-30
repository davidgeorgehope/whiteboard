#!/usr/bin/env bash
# Tune the Anker PowerConf C200 for the overhead whiteboard rig via UVC.
# The camera ships with autofocus disabled and focus parked for conference
# distance, and it forgets these settings whenever it re-enumerates (unplug,
# Mac sleep). `npm run dev` re-applies them via --auto; re-run manually if the
# camera resets mid-session.
#
#   FOV=78 scripts/camera-tune.sh    # AnkerWork-style preset: 95, 78, or 65
#   ZOOM=140 scripts/camera-tune.sh  # or set the raw UVC zoom directly
set -euo pipefail

AUTO=0
[ "${1:-}" = "--auto" ] && AUTO=1

FOCUS="${FOCUS:-300}" # sharpest for the overhead stand (valid 300-650)
FOV="${FOV:-78}"      # diagonal field of view in degrees, like AnkerWork's presets
# zoom-abs is digital crop magnification x100 (100 = the full 95-degree
# sensor). AnkerWork's FOV presets are the same crop, so convert via optics:
# magnification = tan(95/2) / tan(fov/2).
ZOOM="${ZOOM:-$(awk -v f="$FOV" 'BEGIN {
  pi = 3.14159265;
  t = 47.5 * pi / 180;
  h = (f / 2) * pi / 180;
  printf "%d", 100 * (sin(t) / cos(t)) / (sin(h) / cos(h)) + 0.5;
}')}"

UVC_DIR="$(dirname "$0")/../.uvc-util"
UVC="$UVC_DIR/uvc-util"

if [ ! -x "$UVC" ]; then
  # In --auto mode (predev hook) never surprise-build on machines that were
  # never tuned manually; a first manual run sets everything up.
  [ "$AUTO" = 1 ] && exit 0
  echo "building uvc-util..."
  git clone --depth 1 https://github.com/jtfrey/uvc-util.git "$UVC_DIR"
  (cd "$UVC_DIR" && clang -o uvc-util src/*.m -framework Foundation -framework IOKit -fno-objc-arc)
fi

INDEX=$("$UVC" -d | awk '/Anker PowerConf C200/ {print $1}')
if [ -z "$INDEX" ]; then
  [ "$AUTO" = 1 ] && exit 0
  echo "Anker PowerConf C200 not found:" >&2
  "$UVC" -d >&2
  exit 1
fi

"$UVC" -I "$INDEX" -s auto-focus=false
"$UVC" -I "$INDEX" -s focus-abs="$FOCUS"
"$UVC" -I "$INDEX" -s zoom-abs="$ZOOM"
echo "C200 tuned: focus=$FOCUS zoom=$ZOOM (fov ~${FOV}deg)"
