#!/bin/bash
# usage: s4-section-probe.sh <pin-dir> <label> <world-key> <scenes> [HUNT_KEY=VALUE ...]      (HOME=/home/azureuser: the PC's WSL lab, or the VM)
#
# S4's body-only checks of the sections on the real seed: S2's hunt probe (scripts/minecraft-hunt-probe.ts of <pin-dir>, a directory holding backend/{src,scripts,package.json,...})
# with S4's four scenes added (s4-section-scenes.part.ts: route_fortress, route_stronghold, dig_to_room, frames_enter), run by the pinned run-hunt-lab.sh on a staged world
# (lab-world.sh). Nothing of <pin-dir> is changed except two new files in its backend/scripts (the built probe and the patched runner). No model, no paid key.
# Take the slot first:  lab-slot.sh --label s4 -- s4-section-probe.sh ...   (the PC's WSL lab: LAB_SLOT_COUNT=3 LAB_PORT_FROM=25590; the VM only when no production run is going).
set -eu
PIN=${1:?pin dir}; LABEL=${2:?label}; KEY=${3:?world key}; SCENES=${4:?scenes}; shift 4
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PART=${S4_SCENES_PART:-$HERE/s4-section-scenes.part.ts}
SRC=$PIN/backend/scripts/minecraft-hunt-probe.ts
RUN=$PIN/backend/scripts/lab/run-hunt-lab.sh
[ -f "$SRC" ] && [ -f "$RUN" ] && [ -f "$PART" ] || { echo "missing $SRC, $RUN or $PART" >&2; exit 2; }
MARK='// ---- run -'
[ "$(grep -c -- "^$MARK" "$SRC")" = 1 ] || { echo "the hunt probe has no single '$MARK' line to insert before" >&2; exit 2; }
OUT=$PIN/backend/scripts/s4-section-probe.ts
awk -v mark="$MARK" -v part="$PART" 'index($0, mark) == 1 && !done { while ((getline line < part) > 0) print line; done = 1 } { print }' "$SRC" > "$OUT"
# the runner of S2 with the probe file chosen by HUNT_PROBE (default: S2's own)
sed 's#scripts/minecraft-hunt-probe\.ts#scripts/${HUNT_PROBE:-minecraft-hunt-probe.ts}#g' "$RUN" > "$PIN/backend/scripts/lab/run-hunt-lab-s4.sh"
chmod +x "$PIN/backend/scripts/lab/run-hunt-lab-s4.sh"
exec bash "$PIN/backend/scripts/lab/run-hunt-lab-s4.sh" "$LABEL" "$PIN" "$KEY" HUNT_PROBE=s4-section-probe.ts HUNT_SCENES="$SCENES" "$@"
