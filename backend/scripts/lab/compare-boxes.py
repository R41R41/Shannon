#!/usr/bin/env python3
"""Two black boxes of the same act side by side (2026-10-28, the fix run): the run's (or a first replay's) and the replay's from its scene.

For each: how the act ended, its hands, the route searches (status, nodes, ms), the route's resets and their reasons, the places and digs with the
server's answers, the server's corrections of the position, the reflexes, and the feet every second from the act's first hand. Where they part is
where to look.

    python3 -I compare-boxes.py <a.json.gz> <b.json.gz> [--seconds 40]
"""
import argparse, gzip, json, sys


def load(path):
    box = json.loads(gzip.open(path).read().decode('utf8'))
    events = box.get('events', [])
    began = next((e['t'] for e in events if e.get('k') == 'hand' and e.get('i') == 0 and e.get('status') == 'in_progress'), None)
    if began is None:
        began = box['window']['from']
    return box, events, began


def summary(box, events, began, seconds):
    out = []
    act = box.get('act') or {}
    out.append(f"id {box['id']}  {box.get('reason', '')[:100]}")
    for line in act.get('lines', []):
        out.append(f"  hand {line.get('do')} {line.get('status')}: {str(line.get('line', ''))[:150]}")
    rel = lambda t: f"{(t - began) / 1000:6.1f}s"
    for e in events:
        if e['t'] < began - 1000 or e['t'] > began + seconds * 1000:
            continue
        k = e.get('k')
        if k == 'search':
            out.append(f"  {rel(e['t'])} search {e.get('status')} {e.get('nodes')}n {e.get('ms')}ms to {e.get('goal', '')[:50]} end {e.get('end')}")
        elif k == 'reset':
            out.append(f"  {rel(e['t'])} reset {e.get('reason')}")
        elif k in ('place', 'dig'):
            out.append(f"  {rel(e['t'])} {k} {e.get('at')} {'ok' if e.get('ok') else 'FAILED ' + str(e.get('error', ''))} {e.get('ms')}ms" + (f" feet {e.get('feet')}" if k == 'place' else ''))
        elif k == 'forced':
            out.append(f"  {rel(e['t'])} forced {e.get('from')} -> {e.get('to')}")
        elif k == 'block':
            out.append(f"  {rel(e['t'])} block {e.get('at')} {e.get('from')} -> {e.get('to')}")
        elif k in ('hurt', 'death', 'hold', 'resume'):
            out.append(f"  {rel(e['t'])} {k} {json.dumps({x: e[x] for x in e if x not in ('t', 'k')}, ensure_ascii=False)[:120]}")
    for r in box.get('reflexes', []):
        if began <= r.get('at', 0) <= began + seconds * 1000:
            out.append(f"  {rel(r['at'])} reflex {r.get('kind')} {r.get('outcome')} {str(r.get('detail', ''))[:80]}")
    feet, mark = [], began
    for t in box.get('ticks', []):
        if t[0] >= mark and t[0] <= began + seconds * 1000:
            feet.append(f"{rel(t[0])} ({t[1]:.2f},{t[2]:.2f},{t[3]:.2f}) {'G' if t[7] else 'A'}")
            mark = t[0] + 1000
    out.append('  feet: ' + ' | '.join(feet))
    out.append(f"  tick cost: {box.get('stats')}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('a'); ap.add_argument('b'); ap.add_argument('--seconds', type=int, default=40)
    a = ap.parse_args()
    write = sys.stdout.buffer.write
    for label, path in (('A', a.a), ('B', a.b)):
        box, events, began = load(path)
        write(f"== {label} {path}\n".encode('utf8'))
        for line in summary(box, events, began, a.seconds):
            write((line + '\n').encode('utf8'))


if __name__ == '__main__':
    main()
