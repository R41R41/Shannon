#!/bin/bash
# lab-slot.sh — the lab slot rules in one place. Take the slot before anything that starts a Minecraft server for a lab
# (run-hands-live.sh, run-replay.sh, run-lab-probe.sh, seedscan.py, ...) on the VM or in the PC's WSL lab.
#
#   lab-slot.sh [--wait SECONDS] [--label TEXT] [--allow-run] -- <command> [args...]    hold the slot while <command> runs
#   lab-slot.sh status                                                                  who holds it, what else is running
#
# The rules (作戦書 2026-11-02, VM のラボの使い方):
#   1. One lab at a time on the 2-vCPU VM: an flock on $MINEBOT_LAB_SCRATCH/slot.lock (default ~/.cache/minebot-lab/slot.lock) is held for
#      the whole command. LAB_SLOT_COUNT=N (default 1; the WSL lab with its 24 cores uses 3) makes N slots slot.lock, slot.1.lock, ...;
#      the number taken is exported as LAB_SLOT (0-based) so the caller can pick its ports (25570 + 10 * LAB_SLOT ...).
#   2. /tmp/hands-live.lock is respected: run-hands-live.sh, world-pristine.sh and run-replay.sh take it themselves, so this script only
#      refuses to start while it is held (it never holds it, or those scripts would find it taken).
#   3. Not while a real run is going on the production shannon-home: when the production database shows a queued, starting, running or
#      waiting Minecraft task the slot is refused. --allow-run overrides it and is the coordinator's decision, not the caller's.
#      (No database on the machine, e.g. the WSL lab: the check is skipped, and the lab may run any time.)
#   4. A server already listening in 25570-25599 that is not ours (a lab left over) refuses the start; list it with `status`.
#   5. Output stays under ~/.cache/minebot-lab (MINEBOT_LAB_SCRATCH), never /tmp: the VM is a Spot machine and /tmp goes with every stop.
#   6. Resources (the owner's word of 2026-11-02: no wasted worlds, nothing that squeezes the machines): the lab does not start when the disk of
#      $HOME has less than 10 GB free (LAB_MIN_DISK_GB), nor, in the PC's WSL, when Windows has less than 3 GB of free memory (LAB_MIN_WIN_MEM_GB;
#      read through the Windows PowerShell) or C: has less than 10 GB. The caller then tells the coordinator and stops. A lab's Java heap is
#      at most 2 GB (minecraft-isolated-lab.mjs, seedscan.py), and a lab is stopped as soon as it is not used.
#   7. prod.lock: whoever uses shannon-home (a deploy restart, a real run, trials.py) holds `flock ~/.cache/minebot-lab/prod.lock`; the lab stays off
#      while it is held (the same reason as rule 3, and exact where rule 3 only looks at the database).
#
# Exit status: the command's own; 3 = the slot is taken, 4 = a production run is active or prod.lock is held, 5 = another lab is listening,
# 6 = too little disk or memory, 2 = usage.
set -u
SCRATCH=${MINEBOT_LAB_SCRATCH:-$HOME/.cache/minebot-lab}
COUNT=${LAB_SLOT_COUNT:-1}
DB=${LAB_SLOT_PRODUCTION_DB:-$HOME/shannon-ios-data/shannon.sqlite}
HANDS_LOCK=/tmp/hands-live.lock
PROD_LOCK=${LAB_SLOT_PROD_LOCK:-$SCRATCH/prod.lock}
WIN_PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
mkdir -p "$SCRATCH"

disk_free_gb() { df -BG --output=avail "$1" 2>/dev/null | tail -1 | tr -dc 0-9; }

windows_free_gb() {  # the PC's WSL only: Windows' free physical memory in GB (one decimal), empty when it cannot be read
  [ -x "$WIN_PS" ] || return 0
  timeout 20 "$WIN_PS" -NoProfile -Command "[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,1)" 2>/dev/null | tr -d '\r'
}

resources_problem() {   # prints what is too little, empty when all is fine
  local free win c
  free=$(disk_free_gb "$HOME"); [ -n "$free" ] && [ "$free" -lt "${LAB_MIN_DISK_GB:-10}" ] && echo "only ${free} GB free on $HOME (< ${LAB_MIN_DISK_GB:-10} GB)"
  if [ -x "$WIN_PS" ]; then
    win=$(windows_free_gb); [ -n "$win" ] && awk -v w="$win" -v m="${LAB_MIN_WIN_MEM_GB:-3}" 'BEGIN{exit !(w < m)}' && echo "Windows has only ${win} GB of free memory (< ${LAB_MIN_WIN_MEM_GB:-3} GB)"
    c=$(disk_free_gb /mnt/c); [ -n "$c" ] && [ "$c" -lt "${LAB_MIN_DISK_GB:-10}" ] && echo "only ${c} GB free on C: (< ${LAB_MIN_DISK_GB:-10} GB)"
  fi
  return 0
}

prod_lock_held() { [ -e "$PROD_LOCK" ] && ! (exec 7>"$PROD_LOCK"; flock -n 7); }

lab_listeners() {   # ports 25570-25599 with a listener
  ss -ltn 2>/dev/null | awk '{print $4}' | sed -n 's/.*:\(255[7-9][0-9]\)$/\1/p' | sort -u | tr '\n' ' '
}

run_active() {      # prints the active Minecraft tasks of the production database (read-only), empty when none or no database
  [ -r "$DB" ] || return 0
  python3 -I - "$DB" <<'PY' 2>/dev/null
import sqlite3, sys
try:
    c = sqlite3.connect('file:%s?mode=ro' % sys.argv[1], uri=True, timeout=5)
    rows = c.execute("""SELECT task_id, status FROM agent_tasks WHERE status IN ('queued','starting','running','waiting_approval')
                        AND (capability LIKE '%minecraft%' OR task_kind LIKE '%minecraft%' OR goal LIKE '%マイクラ%' OR goal LIKE '%エンドラ%')""").fetchall()
    print(' '.join('%s:%s' % (r[0][:8], r[1]) for r in rows))
except Exception as error:
    print('unknown:%s' % type(error).__name__)
PY
}

status() {
  echo "scratch: $SCRATCH   slots: $COUNT"
  for i in $(seq 0 $((COUNT - 1))); do
    lock="$SCRATCH/slot.lock"; [ "$i" -gt 0 ] && lock="$SCRATCH/slot.$i.lock"
    if [ -e "$lock" ] && ! (exec 7>"$lock"; flock -n 7); then
      # this script writes a .holder file; a plain `flock slot.lock <command>` (the 作戦書 form) leaves only its process line
      echo "slot $i: HELD   $(cat "$lock.holder" 2>/dev/null || pgrep -af 'flock.*slot' | head -1 | cut -c1-200)"
    else
      echo "slot $i: free"
    fi
  done
  if [ -e "$HANDS_LOCK" ] && ! (exec 7>"$HANDS_LOCK"; flock -n 7); then echo "$HANDS_LOCK: HELD"; else echo "$HANDS_LOCK: free"; fi
  echo "labs listening (25570-25599): $(lab_listeners)"
  echo "production Minecraft tasks active: $(run_active)"
  if prod_lock_held; then echo "$PROD_LOCK: HELD   $(cat "$PROD_LOCK" 2>/dev/null | head -c 200)"; else echo "$PROD_LOCK: free"; fi
  echo "disk free on $HOME: $(disk_free_gb "$HOME") GB   memory: $(free -m | awk 'NR==2{printf "%d MB available of %d MB", $7, $2}')"
  [ -x "$WIN_PS" ] && echo "Windows free memory: $(windows_free_gb) GB   C: free: $(disk_free_gb /mnt/c) GB"
  problem=$(resources_problem); [ -n "$problem" ] && echo "RESOURCES TOO LOW: $problem"
  return 0
}

WAIT=0; LABEL=""; ALLOW_RUN=0
if [ "${1:-}" = "status" ]; then status; exit 0; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT=${2:?}; shift 2 ;;
    --label) LABEL=${2:?}; shift 2 ;;
    --allow-run) ALLOW_RUN=1; shift ;;
    --) shift; break ;;
    *) echo "usage: lab-slot.sh [--wait S] [--label T] [--allow-run] -- command...  |  lab-slot.sh status" >&2; exit 2 ;;
  esac
done
[ $# -gt 0 ] || { echo "no command" >&2; exit 2; }

problem=$(resources_problem)
if [ -n "$problem" ]; then echo "lab-slot: $problem; the lab does not start (rule 6). Tell the coordinator." >&2; exit 6; fi

taken=""; why=""
deadline=$(( $(date +%s) + WAIT ))
while :; do
  if [ "$ALLOW_RUN" -ne 1 ]; then       # rules 3 and 7 are looked at again on every round: a run may start while we wait, and then we leave
    active=$(run_active)
    if [ -n "$active" ]; then echo "lab-slot: a production run is active ($active); the lab stays off (rule 3)" >&2; exit 4; fi
    if prod_lock_held; then echo "lab-slot: prod.lock is held ($(head -c 120 "$PROD_LOCK" 2>/dev/null)); the lab stays off (rule 7)" >&2; exit 4; fi
  fi
  if [ -e "$HANDS_LOCK" ] && ! (exec 7>"$HANDS_LOCK"; flock -n 7); then
    why="$HANDS_LOCK is held by another lab run (rule 2)"
  else
    why="every slot is held: $(pgrep -af 'flock.*slot' | head -1 | cut -c1-200)"
    for i in $(seq 0 $((COUNT - 1))); do
      lock="$SCRATCH/slot.lock"; [ "$i" -gt 0 ] && lock="$SCRATCH/slot.$i.lock"
      exec 8>"$lock"
      if flock -n 8; then taken=$i; break; fi
      exec 8>&-
    done
    [ -n "$taken" ] && break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then echo "lab-slot: $why" >&2; exit 3; fi
  sleep 5
done
lock="$SCRATCH/slot.lock"; [ "$taken" -gt 0 ] && lock="$SCRATCH/slot.$taken.lock"

# a lab that is not ours may still be listening (left over by a crashed run): with the only slot in hand it is certain
# (with several slots the others' servers listen legitimately, so the check is for the one-slot VM)
others=$(lab_listeners)
if [ "$COUNT" -eq 1 ] && [ -n "$others" ]; then
  echo "lab-slot: something listens in 25570-25599 ($others); stop it first (tmux -L minebot-lab ls) (rule 4)" >&2
  [ "${LAB_SLOT_IGNORE_LISTENERS:-0}" = 1 ] || exit 5
fi

echo "pid=$$ slot=$taken since=$(date -Is) label=${LABEL:-$1} cmd=$*" > "$lock.holder"
trap 'rm -f "$lock.holder"' EXIT
export LAB_SLOT=$taken MINEBOT_LAB_SCRATCH="$SCRATCH"
"$@"
exit $?
