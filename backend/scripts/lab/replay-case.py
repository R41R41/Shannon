#!/usr/bin/env python3
"""One case of scripts/minecraft-replay-probe.ts from a paid run's record (no dependencies; python3 -I).

usage:
  replay-case.py --ops ops.jsonl --samples samples.jsonl --equip equip.jsonl --t0 <ISO of +0> --ground <run-ground.py out>
                 --acts q114,q115,q117 --name c1220 --title "..." [--search 5000,30000,60000] [--delay q161=4900] >> cases.json

  * the acts: their arguments as the paid run sent them (ops: cmd.arguments), the seconds the body was given (deadlineAt - the time the
    command was made), and what the run's act said (the stopped line and ms) as the expectation;
  * the body: the position of the 12-second sample nearest before the first act (and the act's own `at` when it is closer in time), the
    health and food of that sample, the pack (slots 0-35 with the damage of each tool) and what it wore (head, chest, legs, feet, offhand);
  * the ground: the cells run-ground.py put back (`restore`), and the chunks to force-load around the box.
Prints the cases file (a JSON list) with this case added to the list read from --into (if given).
"""
import argparse, datetime as dt, json, re, sys

def main():
    ap = argparse.ArgumentParser()
    for k in ('ops', 'samples', 'equip', 't0', 'ground', 'acts', 'name', 'title'): ap.add_argument('--' + k, required=True)
    ap.add_argument('--search', default=''); ap.add_argument('--variants', type=int, default=0); ap.add_argument('--delay', default=''); ap.add_argument('--into', default='')
    ap.add_argument('--time', type=int, default=6000); ap.add_argument('--difficulty', default='normal')
    a = ap.parse_args()
    T0 = dt.datetime.fromisoformat(a.t0.replace('Z', '+00:00'))
    sec = lambda s: (dt.datetime.fromisoformat(s.replace('Z', '+00:00')) - T0).total_seconds()
    labels = a.acts.split(',')
    delays = dict((k, int(v)) for k, v in (p.split('=') for p in a.delay.split(',') if p))
    found = {}
    for line in open(a.ops, encoding='utf8'):
        o = json.loads(line); cmd = o['cmd']
        q = (cmd.get('queue') or {}).get('item')
        if cmd.get('skill') != 'act' or q not in labels: continue
        rc = o.get('rc') or {}
        try: r = json.loads(rc.get('result') or '')
        except Exception: r = {}
        lines = [l for l in (r.get('lines') or []) if isinstance(l, dict)]
        stop = next((l for l in lines if l.get('status') == 'stopped'), lines[-1] if lines else {})
        made = sec(o['c']); deadline = sec(cmd['deadlineAt']) if cmd.get('deadlineAt') else made + 60
        ms = r.get('ms') if isinstance(r.get('ms'), (int, float)) else None
        started = (sec(rc['observedAt']) - ms / 1000) if (ms is not None and rc.get('observedAt')) else made
        found[q] = {'label': q, 'arguments': cmd['arguments'], 'seconds': round(deadline - made), 'startedAt': round(started, 1),
                    'expect': {'line': stop.get('line', ''), 'ms': ms, 'outcome': rc.get('outcome'), 'failureType': rc.get('failureType')},
                    **({'delayMs': delays[q]} if q in delays else {})}
    missing = [q for q in labels if q not in found]
    if missing: sys.exit(f'acts not found: {missing}')
    acts = [found[q] for q in labels]
    at = acts[0]['startedAt']
    # the body: the nearest sample at or before the first act
    best = None
    for line in open(a.samples, encoding='utf8'):
        s = json.loads(line); t = sec(s['t'])
        if t <= at + 1 and (best is None or t > best[0]): best = (t, s)
    t, s = best
    pos = [float(v.rstrip('d')) for v in s['Pos'].strip('[]').split(', ')]
    # an act that ended after the sample and before the first act says where the feet were more lately
    for line in open(a.ops, encoding='utf8'):
        o = json.loads(line); rc = o.get('rc') or {}
        if not rc.get('observedAt'): continue
        te = sec(rc['observedAt'])
        if not (t < te <= at + 0.5): continue
        try: r = json.loads(rc.get('result') or '')
        except Exception: continue
        if isinstance(r, dict) and isinstance(r.get('at'), dict):
            pos = [r['at']['x'] + 0.5, float(r['at']['y']), r['at']['z'] + 0.5]; t = te
    items = []
    for m in re.finditer(r'\{(?:components: \{"minecraft:damage": (\d+)\}, )?count: (\d+), Slot: (-?\d+)b, id: "minecraft:([a-z0-9_]+)"', s['Inventory']):
        damage, count, slot, item = m.groups()
        slot = int(slot)
        if 0 <= slot <= 35: items.append({'slot': str(slot), 'id': item, 'count': int(count), **({'damage': int(damage)} if damage else {})})
    wear = None
    for line in open(a.equip, encoding='utf8'):
        e = json.loads(line); te = sec(e['t'])
        if te <= at + 1 and e['eq'].startswith('{') and (wear is None or te > wear[0]): wear = (te, e['eq'])
    if wear:
        for m in re.finditer(r'(head|chest|legs|feet|offhand): \{(?:components: \{"minecraft:damage": (\d+)\}, )?count: (\d+), id: "minecraft:([a-z0-9_]+)"', wear[1]):
            part, damage, count, item = m.groups()
            slot = 'weapon.offhand' if part == 'offhand' else f'armor.{part}'
            items.append({'slot': slot, 'id': item, 'count': int(count), **({'damage': int(damage)} if damage else {})})
    ground = json.load(open(a.ground, encoding='utf8'))
    x0, y0, z0, x1, y1, z1 = ground['box']
    restore = [[r[0], r[1], r[2], r[3]] for r in ground['restore']]
    hand = next((h for h in acts[0]['arguments'].get('hands', []) if isinstance(h, dict) and h.get('do') == 'go'), None)
    case = {'name': a.name, 'title': a.title, 'forceload': [x0 - 16, z0 - 16, x1 + 16, z1 + 16], 'restore': restore,
            'actor': {'pos': [pos[0], pos[1], pos[2]], 'health': float(s['Health'].rstrip('f')), 'food': int(s['foodLevel']), 'items': items,
                      'sampleAt': round(t, 1)},
            'time': a.time, 'difficulty': a.difficulty, 'acts': acts,
            'watch': [[int(pos[0]), int(pos[1]) - 1, int(pos[2])]] + ([[hand['to']['x'], hand['to']['y'], hand['to']['z']]] if hand and hand.get('to') else []),
            'groundCheck': ground.get('check', {}).get('agree'), 'groundMarks': len(ground.get('marks', []))}
    if a.search: case['search'] = {'timeouts': [int(v) for v in a.search.split(',')], **({'variants': a.variants} if a.variants else {})}
    cases = json.load(open(a.into, encoding='utf8')) if a.into else []
    cases = [c for c in cases if c['name'] != a.name] + [case]
    sys.stdout.buffer.write(json.dumps(cases, ensure_ascii=False).encode("utf-8"))

if __name__ == '__main__':
    main()
