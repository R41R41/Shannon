#!/bin/bash
# usage (in the lab's slot): end-bed-m456.sh <label> <scenes> [KEY=VALUE ...]
#   lab-slot.sh --label s7-<label> -- bash end-bed-m456.sh <label> enter,m4_stand_safety
# The M4-M6 scenes of the bed kill (end-bed-m456-scenes.part.ts) on the isolated End lab. The probe file is not edited: this makes a code tar from the worktree
# (backend/src, backend/scripts, backend/package.json, backend/tsconfig.json, package.json; the tests left out) with the part spliced into its COPY of
# scripts/minecraft-end-fight-probe.ts before "// ===== run =====", and hands it to run-end-fight.sh (which starts the server, runs the probe, cleans up).
# The code directory is ~/Shannon-end-lab-m456-<label>, never the shared ~/Shannon-end-lab another slot's run may be using (run-end-fight.sh removes its own at the end).
# M456_TREE=<worktree> (default: the worktree this script is in). The port is the slot's (25590 + LAB_SLOT in the PC's WSL), or the first free of 25597..25593.
# KEY=VALUE pairs go to run-end-fight.sh (END_TIMEOUT=..., END_VIEW=...); M6_TICK_RATE / M6_SAMPLES / M6_WALL_SECONDS reach the probe's environment only
# through run-end-fight.sh's env -i, so they are not passed: the defaults (60, 30, 1500 s) are used.
set -u
LABEL=${1:?label}; SCENES=${2:?scenes}; shift 2
[[ "$LABEL" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || { echo "bad label" >&2; exit 2; }
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TREE=${M456_TREE:-$(cd "$HERE/../../.." && pwd)}
SCRATCH=${MINEBOT_LAB_SCRATCH:-$HOME/.cache/minebot-lab}
STAGE=$SCRATCH/m456-stage-$LABEL
TAR=$SCRATCH/m456-code-$LABEL.tar
rm -rf "$STAGE"; mkdir -p "$STAGE/backend"
cp -r "$TREE/backend/src" "$TREE/backend/scripts" "$TREE/backend/package.json" "$TREE/backend/tsconfig.json" "$STAGE/backend/"
cp "$TREE/package.json" "$STAGE/"
PROBE=$STAGE/backend/scripts/minecraft-end-fight-probe.ts
PART=$TREE/backend/scripts/lab/end-bed-m456-scenes.part.ts
grep -q '^// ===== run =====$' "$PROBE" || { echo "no run marker in the probe" >&2; exit 2; }
awk -v part="$PART" '/^\/\/ ===== run =====$/ { while ((getline line < part) > 0) print line; close(part) } { print }' "$PROBE" > "$PROBE.new" && mv "$PROBE.new" "$PROBE"
grep -q 'scenes.m4_stand_safety' "$PROBE" || { echo "splice failed" >&2; exit 2; }
find "$STAGE" -name '*.test.ts' -delete
tar -cf "$TAR" -C "$STAGE" backend package.json && rm -rf "$STAGE"
PORT=${LAB_PORT:-$((25590 + ${LAB_SLOT:-0}))}
listening() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$1\$"; }
if [ -z "${LAB_PORT:-}" ] && listening "$PORT"; then
  for candidate in 25597 25598 25599 25596 25595 25594 25593; do listening "$candidate" || { PORT=$candidate; break; }; done
fi
echo "end-bed-m456: slot ${LAB_SLOT:-?} port $PORT tar $TAR"
bash "$HERE/run-end-fight.sh" "$LABEL" "$TAR" END_CODE_DIR="$HOME/Shannon-end-lab-m456-$LABEL" END_PORT=$PORT END_SCENES="$SCENES" END_VIEW=10 END_TIMEOUT=2700 "$@"
STATUS=$?
rm -f "$TAR"
exit $STATUS
