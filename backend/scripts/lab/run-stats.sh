#!/bin/bash
# usage: run-stats.sh <label>...  — planner speed, tool use, bookkeeping share, errors and settled cost per run
# Logs live outside /tmp: this is a Spot VM, stopped by the platform now and then, and /tmp is emptied with it.
S=${MINEBOT_LAB_SCRATCH:-$HOME/.cache/minebot-lab}; mkdir -p "$S"
for R in "$@"; do
  L=$S/nether-$R.log
  python3 - "$R" "$L" <<'PY'
import sys,re,json,glob
label,path=sys.argv[1],sys.argv[2]
t=re.sub(r'\x1b\[[0-9;]*m','',open(path,errors='replace').read())
ms=sorted(int(x) for x in re.findall(r'LLM応答: (\d+)ms',t))
tools=[int(x) for x in re.findall(r'LLM応答: \d+ms \(iteration \d+, tools: (\d+)\)',t)]
calls=len(re.findall(r' ▶ [a-z]',t)); camp=len(re.findall(r'▶ manage-campaign-goals',t)); err=len(re.findall(r'エラー: CAMPAIGN',t))
settings=re.search(r'PLANNER_SETTINGS (\{.*\})',t)
first=re.search(r'(\d\d):(\d\d):(\d\d)\.\d+ .*ShannonExecutor: "エンドラ',t)
def at(pattern):
    m=re.search(r'(\d\d):(\d\d):(\d\d)\.\d+ [^\n]*'+pattern,t)
    if not (m and first): return None
    s=(int(m.group(1))*3600+int(m.group(2))*60+int(m.group(3)))-(int(first.group(1))*3600+int(first.group(2))*60+int(first.group(3)))
    return round(s/60,1)
marks={k:at(v) for k,v in {'石つるはし':'craft-one: 結果: 成功 詳細: stone_pickaxe','かまど':'craft-one: 結果: 成功 詳細: furnace','鉄インゴット':'取り出しました: iron_ingot','鉄つるはし':'craft-one: 結果: 成功 詳細: iron_pickaxe','バケツ':'craft-one: 結果: 成功 詳細: bucket','盾':'craft-one: 結果: 成功 詳細: shield','火打石と打ち金':'craft-one: 結果: 成功 詳細: flint_and_steel','ダイヤつるはし':'craft-one: 結果: 成功 詳細: diamond_pickaxe','黒曜石':'obsidian x','ネザーポータル点火':'nether_portal','ネザー':'the_nether'}.items()}
cost=None
m=re.search(r'CAMPAIGN_REPORT (\S+)',t)
if m:
    try:
        r=json.load(open(m.group(1))); cost=round(sum(x.get('chargedUsd',0) or 0 for x in r.get('requests',[])),2)
    except Exception as e: cost='?'
price={'claude-sonnet-5-5':(2,2.5,0.2,10),'claude-opus-5-5':(4,5,0.2,20)}
model=(json.loads(settings.group(1)).get('model') if settings else 'gpt-5.6-luna')
planner_cost=None
if model in price:
    pi,pw,pr,po=price[model]
    rows=re.findall(r'tokens: in=(\d+)(?:\+cw=(\d+))?\+cached=(\d+) \(\d+%\), out=(\d+)',t)
    planner_cost=round(sum((int(i)*pi+int(w or 0)*pw+int(c)*pr+int(o)*po)/1e6 for i,w,c,o in rows),2)
p=lambda q: ms[min(len(ms)-1,int(len(ms)*q))] if ms else None
print(json.dumps({'run':label,'planner':json.loads(settings.group(1)) if settings else 'gpt-5.6-luna/none','llmCalls':len(ms),'p50ms':p(0.5),'p90ms':p(0.9),'toolsPerTurn':round(sum(tools)/max(1,len(tools)),2),'toolCalls':calls,'bookkeepingShare':round(camp/max(1,calls),2),'campaignErrors':err,'deaths':len(re.findall('ボット死亡',t)),'minutesTo':{k:v for k,v in marks.items() if v is not None},'chargedUsd(台帳,余裕1.25込み)':cost,'plannerUsd(使用量×公式単価)':planner_cost},ensure_ascii=False))
PY
done
