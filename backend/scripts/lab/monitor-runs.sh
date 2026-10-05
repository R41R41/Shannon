#!/bin/bash
# usage: monitor-runs.sh <label> [label...]  — one status line every 3 minutes
# Logs live outside /tmp: this is a Spot VM, stopped by the platform now and then, and /tmp is emptied with it.
S=${MINEBOT_LAB_SCRATCH:-$HOME/.cache/minebot-lab}; mkdir -p "$S"
B=/home/azureuser/Shannon-dev/backend/saves/minecraft/progressive_reports/dragon-campaign-actual-5000-20261001-afternoon.json
while true; do
  bud=$(python3 -c "import json;print(round(json.load(open('$B'))['settledUsd'],2))" 2>/dev/null)
  B2=${B/afternoon/latenight}; [ -f "$B2" ] && bud="$bud+latenight\$$(python3 -c "import json;print(round(json.load(open('$B2'))['settledUsd'],2))" 2>/dev/null)"
  B3=${B/20261001-afternoon/20261002-morning}; [ -f "$B3" ] && bud="$bud+morning\$$(python3 -c "import json;print(round(json.load(open('$B3'))['settledUsd'],2))" 2>/dev/null)"
  B4=${B/20261001-afternoon/20261002-afternoon}; [ -f "$B4" ] && bud="$bud+pm\$$(python3 -c "import json;print(round(json.load(open('$B4'))['settledUsd'],2))" 2>/dev/null)"
  B5=${B/20261001-afternoon/20261003}; [ -f "$B5" ] && bud="$bud+1003\$$(python3 -c "import json;print(round(json.load(open('$B5'))['settledUsd'],2))" 2>/dev/null)"
  B6=${B/20261001-afternoon/20261005}; [ -f "$B6" ] && bud="$bud+1005\$$(python3 -c "import json;print(round(json.load(open('$B6'))['settledUsd'],2))" 2>/dev/null)"
  B7=${B/20261001-afternoon/20261005b}; [ -f "$B7" ] && bud="$bud+1005b\$$(python3 -c "import json;print(round(json.load(open('$B7'))['settledUsd'],2))" 2>/dev/null)"
  B8=${B/actual-5000-20261001-afternoon/actual-1000-20261005c}; [ -f "$B8" ] && bud="$bud+1005c\$$(python3 -c "import json;print(round(json.load(open('$B8'))['settledUsd'],2))" 2>/dev/null)"
  line="$(date +%H:%M) load=$(cut -d' ' -f1 /proc/loadavg) settled=\$$bud"
  for R in "$@"; do
    L=$S/nether-$R.log
    c() { grep -a -c "$1" $L 2>/dev/null; }
    death=$(grep -a "ボット死亡" $L 2>/dev/null | tail -1 | sed 's/\x1b\[[0-9;]*m//g' | grep -o "ボット死亡.*" | cut -c1-70)
    adv=$(c "振り返り(milestone)")
    last=$(sed 's/\x1b\[[0-9;]*m//g' $L 2>/dev/null | grep -a " ▶ " | tail -1 | grep -o "▶ [a-z-]*")
    end=$(grep -a -o "NETHER_${R}_EXIT=[0-9]*\|\"stopReason\":\"[a-z_]*\"" $L 2>/dev/null | tr '\n' ' ')
    push=$(grep -a -o "位置を戻した（累計[0-9]*" $L 2>/dev/null | tail -1 | grep -o "[0-9]*$")
    line="$line | $R tools=$(c ' ▶ ') deaths=$(c 'ボット死亡') [$death] edge=$(c '崖際で停止') breath=$(c '呼吸の最終反射:') fights=$(c '反撃終了') refuse=$(c '間に合いません') campErr=$(c 'エラー: CAMPAIGN') moveFail=$(c '移動失敗') stall=$(c '地形作業が進まない\|経路の実行が始まらない') pushback=${push:-0} ghost=$(c 'ブロックを元に戻した') lease=$(c 'lock_timeout') last=[$last] milestones=$adv $end"
  done
  echo "$line"
  sleep 180
done
