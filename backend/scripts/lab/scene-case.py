#!/usr/bin/env python3
"""A replay case from a scene and its black box (2026-10-28, the fix run).

The scene (`saves/minecraft/scenes/<id>/`, or a replay's `$OUT/scenes/<id>/`) is the world's own files at the moment of a heavy failure; its box
(`<blackbox>/<task>/<id>.json.gz`) holds the body as it was (feet, health, food, pack, armour, the way it faced) and the act that failed (its
arguments and its lines). The case starts the replay lab from the scene as it is: nothing restored by hand, the creatures kept (`keepEntities`),
the body put where the box says, and the act sent again with the same arguments; what it said in the run is the case's expectation.

    python3 -I scene-case.py --scene <scene dir> --box <box.json.gz> --name s1 [--title ...] [--seconds 120] [--into cases.json] > cases.json
Then: run-replay.sh <label> <code.tar> cases.json REPLAY_SOURCE=<scene dir>/world REPLAY_FLOOR=default
"""
import argparse, gzip, json, sys

ARMOUR = {5: 'armor.head', 6: 'armor.chest', 7: 'armor.legs', 8: 'armor.feet', 45: 'weapon.offhand'}


def nbt_slot(slot):
    """mineflayer's window slot to the player's NBT slot (36..44 the hotbar 0..8, 9..35 the same)."""
    if 36 <= slot <= 44:
        return str(slot - 36)
    if 9 <= slot <= 35:
        return str(slot)
    return ARMOUR.get(slot)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scene', required=True); ap.add_argument('--box', required=True); ap.add_argument('--name', required=True)
    ap.add_argument('--title', default=''); ap.add_argument('--seconds', type=int, default=0); ap.add_argument('--into', default='')
    ap.add_argument('--time', type=int, default=6000)
    a = ap.parse_args()
    manifest = json.load(open(f'{a.scene}/scene.json', encoding='utf8'))
    box = json.loads(gzip.open(a.box).read().decode('utf8'))
    act = box.get('act') or {}
    if not act.get('arguments'):
        sys.exit('the box holds no act (only an act\'s box makes a case)')
    body = box['body']
    items = []
    for item in body.get('items', []) + [dict(entry, count=1) for entry in body.get('armor', [])]:
        slot = nbt_slot(int(item['slot']))
        if slot is None:
            continue
        items.append({'slot': slot, 'id': item['name'], 'count': int(item.get('count', 1)), **({'damage': int(item['durabilityUsed'])} if item.get('durabilityUsed') else {})})
    # The body stood where the act began: the first tick of the act (its first hand), else the box's last feet.
    began = next((e['t'] for e in box.get('events', []) if e.get('k') == 'hand' and e.get('i') == 0 and e.get('status') == 'in_progress'), None)
    tick = next((t for t in box.get('ticks', []) if began is not None and t[0] >= began), None)
    pos = [tick[1], tick[2], tick[3]] if tick else body['pos']
    hp_tick = tick[9] if tick and tick[9] >= 0 else body.get('health')
    stop = next((line for line in act.get('lines', []) if line.get('status') not in ('done', 'skipped')), (act.get('lines') or [{}])[-1])
    cx, cz = int(manifest['center'][0]), int(manifest['center'][2])
    case = {'name': a.name, 'title': a.title or f"scene {manifest['id']}: {box.get('reason', '')}"[:120],
            'forceload': [cx - 48, cz - 48, cx + 48, cz + 48], 'restore': [], 'keepEntities': True, 'time': a.time,
            'actor': {'pos': pos, 'yaw': body.get('yaw'), 'pitch': body.get('pitch'), 'health': hp_tick, 'food': body.get('food'), 'items': items},
            'acts': [{'label': 'scene', 'arguments': act['arguments'], 'seconds': a.seconds or max(30, round(act.get('ms', 60000) / 1000) + 30),
                      'expect': {'line': stop.get('line', ''), 'ms': act.get('ms'), 'outcome': 'completed' if act.get('ok') else 'failed'}}],
            'scene': {'id': manifest['id'], 'box': box['id']}}
    cases = json.load(open(a.into, encoding='utf8')) if a.into else []
    cases = [c for c in cases if c.get('name') != a.name] + [case]
    sys.stdout.buffer.write(json.dumps(cases, ensure_ascii=False).encode('utf8'))


if __name__ == '__main__':
    main()
