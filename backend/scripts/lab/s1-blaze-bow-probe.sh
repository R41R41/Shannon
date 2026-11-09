#!/bin/bash
# usage: s1-blaze-bow-probe.sh <pin-dir> <label> <world-key> <scenes> [HUNT_KEY=VALUE ...]      (HOME=/home/azureuser: the PC's WSL lab, or the VM)
#
# S1's bow at the blaze spawner's blazes: S2's hunt probe (scripts/minecraft-hunt-probe.ts of <pin-dir>, a directory holding backend/{src,scripts,package.json,...}) with S1's scenes added
# (s1-blaze-bow.part.ts), run by the pinned run-hunt-lab.sh on a staged world (lab-world.sh). Nothing of <pin-dir> is changed except two new files in its backend/scripts. No model, no paid key.
# Take the slot first:  lab-slot.sh --label s1 -- s1-blaze-bow-probe.sh ...   (the PC's WSL lab: LAB_SLOT_COUNT=3 LAB_PORT_FROM=25590; the VM only as the lab rules allow).
set -eu
PIN=${1:?pin dir}; LABEL=${2:?label}; KEY=${3:?world key}; SCENES=${4:?scenes}; shift 4
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PART_FILE=${S1_SCENES_PART:-"$HERE/s1-blaze-bow.part.ts"}
SRC=$PIN/backend/scripts/minecraft-hunt-probe.ts
RUN=$PIN/backend/scripts/lab/run-hunt-lab.sh
[ -f "$SRC" ] && [ -f "$RUN" ] && [ -f "$PART_FILE" ] || { echo "missing $SRC, $RUN or $PART_FILE" >&2; exit 2; }
MARK='// ---- run -'
[ "$(grep -c -- "^$MARK" "$SRC")" = 1 ] || { echo "the hunt probe has no single '$MARK' line to insert before" >&2; exit 2; }
OUT=$PIN/backend/scripts/s1-blaze-bow-probe.ts
awk -v mark="$MARK" -v part="$PART_FILE" 'index($0, mark) == 1 && !done { while ((getline line < part) > 0) print line; done = 1 } { print }' "$SRC" > "$OUT"
sed 's#scripts/minecraft-hunt-probe\.ts#scripts/${HUNT_PROBE:-minecraft-hunt-probe.ts}#g' "$RUN" > "$PIN/backend/scripts/lab/run-hunt-lab-s1.sh"
chmod +x "$PIN/backend/scripts/lab/run-hunt-lab-s1.sh"
exec bash "$PIN/backend/scripts/lab/run-hunt-lab-s1.sh" "$LABEL" "$PIN" "$KEY" HUNT_PROBE=s1-blaze-bow-probe.ts HUNT_SCENES="$SCENES" "$@"
