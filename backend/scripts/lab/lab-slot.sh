#!/bin/bash
# lab-slot.sh — the lab slot rules in one place. Take the slot before anything that starts a Minecraft server for a lab
# (run-hands-live.sh, run-replay.sh, run-lab-probe.sh, seedscan.py, ...) on the VM or in the PC's WSL lab.
#
#   lab-slot.sh [--wait SECONDS] [--label TEXT] [--allow-run] -- <command> [args...]    hold the slot while <command> runs
#   lab-slot.sh status                                                                  who holds it, what else is running
#
# The rules (作戦書 2026-11-02, VM のラボの使い方):
#   1. One lab at a time on the 2-vCPU VM: an flock on $MINEBOT_LAB_SCRATCH/slot.lock (default ~/.cache/minebot-lab/slot.lock) is held for
#      the whole command. LAB_SLOT_COUNT=N (default 1; the WSL lab with its 24 cores asks for 3 but gets at most LAB_SLOT_MAX=2 since 2026-11-02 21:50) makes N slots slot.lock, slot.1.lock, ...;
#      the number taken is exported as LAB_SLOT (0-based) so the caller can pick its ports (25570 + 10 * LAB_SLOT ...).
#   2. /tmp/hands-live.lock is respected: run-hands-live.sh, run-incident-lab.sh, run-continue-lab.sh, world-pristine.sh and run-replay.sh
#      take it themselves (it never holds it). Started from here (LAB_PORT set) they hold it shared with their port's /tmp/hands-live.<port>.lock,
#      so slots run side by side; started by hand they hold it alone, and only then does this script refuse to start (coordinator 2026-11-05).
#   3. Not while a real run is going on the production shannon-home: when the production database shows a queued, starting, running or
#      waiting Minecraft task the slot is refused. --allow-run overrides it and is the coordinator's decision, not the caller's.
#      (No database on the machine, e.g. the WSL lab: the check is skipped, and the lab may run any time.)
#   4. A server already listening in 25570-25599 that is not ours (a lab left over) refuses the start; list it with `status`.
#   5. Output stays under ~/.cache/minebot-lab (MINEBOT_LAB_SCRATCH), never /tmp: the VM is a Spot machine and /tmp goes with every stop.
#   6. Resources (the owner's word of 2026-11-02: no wasted worlds, nothing that squeezes the machines): the lab does not start when the disk of
#      $HOME has less than 10 GB free (LAB_MIN_DISK_GB), nor, in the PC's WSL, when Windows has less than 4 GB of free memory (LAB_MIN_WIN_MEM_GB;
#      read through the Windows PowerShell) or C: has less than 10 GB. The caller then tells the coordinator and stops. A lab's Java heap is
#      at most 2 GB (minecraft-isolated-lab.mjs, seedscan.py), and a lab is stopped as soon as it is not used.
#   7. prod.lock: whoever uses shannon-home (a deploy restart, a real run, trials.py) holds `flock ~/.cache/minebot-lab/prod.lock`; the lab stays off
#      while it is held (the same reason as rule 3, and exact where rule 3 only looks at the database).
#   9. First come, first served (coordinator 2026-11-05 02:00): every start takes a ticket in $SCRATCH/slot.queue (one line per waiting pid,
#      the order of the lines is the order) and tries a slot only while it is among the first <free slots> live tickets. Without it the
#      waiter whose 5-second poll happened to come first won (S7 waited 1 h 15 min behind later starts). The coordinator's priority order
#      is put on the queue by slot-handoff.py, which moves the chosen waiter's line to the front. Waiters of an older copy of this
#      script take no ticket and still race; they go as they end. LAB_SLOT_QUEUE=0 skips the tickets.
#
# Exit status: the command's own; 3 = the slot is taken, 4 = a production run is active or prod.lock is held, 5 = another lab is listening,
# 6 = too little disk or memory, 2 = usage.
set -u
SCRATCH=${MINEBOT_LAB_SCRATCH:-$HOME/.cache/minebot-lab}
COUNT=${LAB_SLOT_COUNT:-1}
# The PC (its WSL has the Windows PowerShell): at most LAB_SLOT_MAX (2) labs at a time, whatever the caller asks for (coordinator 2026-11-02 21:46: Windows had 1-2 GB free with three labs and tests running).
if [ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ] && [ "$COUNT" -gt "${LAB_SLOT_MAX:-2}" ]; then COUNT=${LAB_SLOT_MAX:-2}; fi
DB=${LAB_SLOT_PRODUCTION_DB:-$HOME/shannon-ios-data/shannon.sqlite}
HANDS_LOCK=${LAB_SLOT_HANDS_LOCK:-/tmp/hands-live.lock}   # the override is for a test in a private scratch
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
    win=$(windows_free_gb); [ -n "$win" ] && awk -v w="$win" -v m="${LAB_MIN_WIN_MEM_GB:-4}" 'BEGIN{exit !(w < m)}' && echo "Windows has only ${win} GB of free memory (< ${LAB_MIN_WIN_MEM_GB:-4} GB)"
    c=$(disk_free_gb /mnt/c); [ -n "$c" ] && [ "$c" -lt "${LAB_MIN_DISK_GB:-10}" ] && echo "only ${c} GB free on C: (< ${LAB_MIN_DISK_GB:-10} GB)"
  fi
  return 0
}

prod_lock_held() { [ -e "$PROD_LOCK" ] && ! (exec 7>"$PROD_LOCK"; flock -n 7); }

PORT_BASE=${LAB_PORT_BASE:-${LAB_PORT_FROM:-25590}}     # slot i uses port PORT_BASE + i (exported as LAB_PORT; the VM: 25590 + slot)
port_listening() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$1\$"; }

slot_lock() { if [ "$1" -gt 0 ]; then echo "$SCRATCH/slot.$1.lock"; else echo "$SCRATCH/slot.lock"; fi; }

free_slots() {      # slots nobody holds and whose port nobody listens to
  local i n=0
  for i in $(seq 0 $((COUNT - 1))); do
    (exec 7>"$(slot_lock "$i")"; flock -n 7) && ! port_listening $((PORT_BASE + i)) && n=$((n + 1))
  done
  echo "$n"
}

QUEUE="$SCRATCH/slot.queue"
queue() {   # rule 9. queue join | leave | turn <free slots>   (turn: 0 while this pid is among the first <free slots> live tickets)
  [ "${LAB_SLOT_QUEUE:-1}" = 1 ] || return 0
  local op=$1 line pid live="" pos=0 me=-1 rc=0
  exec 9>"$QUEUE.lock"; flock 9
  touch "$QUEUE"
  while IFS= read -r line; do
    pid=${line#pid=}; pid=${pid%% *}
    [ -n "$pid" ] && [ -d "/proc/$pid" ] || continue     # a waiter that is gone (kill -0 cannot see another user's pid)
    if [ "$pid" = "$$" ]; then [ "$op" = leave ] && continue; me=$pos; fi
    live+="$line"$'\n'; pos=$((pos + 1))
  done < "$QUEUE"
  if [ "$op" != leave ] && [ "$me" -lt 0 ]; then live+="pid=$$ since=$(date +%s) label=$QLABEL"$'\n'; me=$pos; fi
  printf '%s' "$live" > "$QUEUE.tmp" && mv -f "$QUEUE.tmp" "$QUEUE"
  if [ "$op" = turn ] && [ "$me" -ge "${2:-1}" ]; then rc=1; fi
  exec 9>&-
  return $rc
}

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
  if [ -e "$HANDS_LOCK" ] && ! (exec 7>"$HANDS_LOCK"; flock -s -n 7); then echo "$HANDS_LOCK: HELD by a run started by hand"; else echo "$HANDS_LOCK: free (or shared by slot runs)"; fi
  echo "labs listening (25570-25599): $(lab_listeners)"
  # the queue, oldest first (a waiter writes waiting.<pid> and removes it when it starts or gives up)
  for w in $(ls -tr "$SCRATCH"/waiting.* 2>/dev/null); do
    wp=${w##*.}
    if kill -0 "$wp" 2>/dev/null; then echo "waiting: $(sed 's/since=\([0-9]*\)/since=\1/' "$w" | cut -c1-220)  ($(( ($(date +%s) - $(sed -n 's/.*since=\([0-9]*\).*/\1/p' "$w")) / 60 )) min)"; else rm -f "$w"; fi
  done
  # rule 9's tickets, in their order (a pid that is gone is shown but no longer counts)
  n=0; while IFS= read -r line; do n=$((n + 1)); qp=${line#pid=}; qp=${qp%% *}
    echo "ticket $n: $line$([ -d "/proc/$qp" ] || echo '  (gone)')"; done < <(cat "$QUEUE" 2>/dev/null)
  # a tmux lab session of the minebot-lab socket whose port no slot holds: left over
  held_ports=" $(cat "$SCRATCH"/slot*.holder 2>/dev/null | sed -n 's/.* port=\([0-9]*\) .*/\1/p' | tr '\n' ' ')"
  for s in $(tmux -L minebot-lab ls 2>/dev/null | sed -n 's/^\(codex-progressive-lab-[0-9]*\):.*/\1/p'); do
    case "$held_ports" in *" ${s##*-} "*) ;; *) echo "STALE tmux session $s (its port is not held by a slot; tmux -L minebot-lab kill-session -t $s if nobody uses it)";; esac
  done
  echo "production Minecraft tasks active: $(run_active)"
  if prod_lock_held; then echo "$PROD_LOCK: HELD   $(cat "$PROD_LOCK" 2>/dev/null | head -c 200)"; else echo "$PROD_LOCK: free"; fi
  echo "disk free on $HOME: $(disk_free_gb "$HOME") GB   memory: $(free -m | awk 'NR==2{printf "%d MB available of %d MB", $7, $2}')"
  [ -x "$WIN_PS" ] && echo "Windows free memory: $(windows_free_gb) GB   C: free: $(disk_free_gb /mnt/c) GB"
  problem=$(resources_problem); [ -n "$problem" ] && echo "RESOURCES TOO LOW: $problem"
  return 0
}

WAIT=0; LABEL=""; ALLOW_RUN=0
WAITING="$SCRATCH/waiting.$$"
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
QLABEL=${LABEL:-$1}
trap 'queue leave; rm -f "$WAITING"' EXIT
queue join
while :; do
  if [ "$ALLOW_RUN" -ne 1 ]; then       # rules 3 and 7 are looked at again on every round: a run may start while we wait, and then we leave
    active=$(run_active)
    if [ -n "$active" ]; then echo "lab-slot: a production run is active ($active); the lab stays off (rule 3)" >&2; exit 4; fi
    if prod_lock_held; then echo "lab-slot: prod.lock is held ($(head -c 120 "$PROD_LOCK" 2>/dev/null)); the lab stays off (rule 7)" >&2; exit 4; fi
  fi
  if [ -e "$HANDS_LOCK" ] && ! (exec 7>"$HANDS_LOCK"; flock -s -n 7); then
    why="$HANDS_LOCK is held by a lab run started by hand (rule 2)"
  elif free=$(free_slots); [ "$free" -gt 0 ] && ! queue turn "$free"; then
    why="not my turn yet in $QUEUE (rule 9: first come, first served; lab-slot.sh status shows the tickets)"
  else
    why="every slot is held: $(pgrep -af 'flock.*slot' | head -1 | cut -c1-200)"
    for i in $(seq 0 $((COUNT - 1))); do
      lock="$SCRATCH/slot.lock"; [ "$i" -gt 0 ] && lock="$SCRATCH/slot.$i.lock"
      exec 8>"$lock"
      if flock -n 8; then
        # rule 8: the slot's own port must not be listened to by anyone (a lab that does not come through a slot, a leftover): then the next slot, never a clash at start
        if port_listening $((PORT_BASE + i)); then why="the port $((PORT_BASE + i)) of slot $i is listened to by another server (${why})"; exec 8>&-; continue; fi
        taken=$i; break
      fi
      exec 8>&-
    done
    [ -n "$taken" ] && break
  fi
  [ -e "$WAITING" ] || echo "pid=$$ since=$(date +%s) label=${LABEL:-$1} why-first=$why" > "$WAITING"
  if [ "$(date +%s)" -ge "$deadline" ]; then echo "lab-slot: $why" >&2; exit 3; fi
  sleep 5
done
rm -f "$WAITING"
queue leave
lock="$SCRATCH/slot.lock"; [ "$taken" -gt 0 ] && lock="$SCRATCH/slot.$taken.lock"

# a lab that is not ours may still be listening (left over by a crashed run): with the only slot in hand it is certain
# (with several slots the others' servers listen legitimately, so the check is for the one-slot VM)
others=$(lab_listeners)
if [ "$COUNT" -eq 1 ] && [ -n "$others" ] && ! port_listening "$PORT_BASE"; then
  : # the one slot is ours and its own port is free: a server on another port does not clash (rule 8 replaces the blanket refusal of rule 4)
fi

LAB_PORT=$((PORT_BASE + taken))
echo "pid=$$ slot=$taken port=$LAB_PORT since=$(date -Is) label=${LABEL:-$1} cmd=$*" > "$lock.holder"
# the end of the lab, however it ends: the slot's server and tmux session go with it (nothing of ours stays on the port)
trap 'rm -f "$lock.holder" "$WAITING"; tmux -L minebot-lab kill-session -t "codex-progressive-lab-$LAB_PORT" 2>/dev/null' EXIT
export LAB_SLOT=$taken LAB_PORT MINEBOT_LAB_SCRATCH="$SCRATCH"
"$@"
exit $?
