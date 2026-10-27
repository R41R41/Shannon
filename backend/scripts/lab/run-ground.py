#!/usr/bin/env python3
"""The ground of a paid run at one moment, put back from the world it left (no dependencies; python3 -I).

usage:
  run-ground.py --current <region dir> --pristine <region dir> --ops ops.jsonl [--samples samples.jsonl] --t0 <ISO of +0>
                --at <seconds> --box x0 y0 z0 x1 y1 z1 [--name label] [--out case-ground.json] [--section x|z]

What it does:
  * <current> is the world as the run left it (the region files of the stopped server, copied). <pristine> is the same seed as the
    generator made it (lab/world-pristine.sh). A cell that differs in a way only the body makes (dug to air; cobblestone, a crafting
    table, a furnace or water put where there was air) is the body's work.
  * When it was done is told by where the body was: the positions of the run (each act's `at` and its lines' `where`, the cells the
    hands named, the 12-second samples), joined by straight lines. A cell first come within reach (5 m) after <at> was changed after
    <at>: it is put back to the pristine block (with its block state). A cell come near before <at> stays as it is now, unless a map the
    body saw (the `map` of an act's result, the layers around the feet) at or before <at> shows it otherwise: the latest such map wins.
  * Changes no record can put back are marked: sand and gravel that moved, water that flowed, blocks that differ between the two worlds
    without the body (chunk-edge structures, lush-cave growth) are left as they are now and counted.
  * The result: `restore` (cells to /setblock to the pristine state), `marks` (what could not be put back), `check` (the maps of the
    failing act and the act before, against the ground put back: cells that agree / disagree), and a cross-section as text.
"""
import re, argparse, datetime as dt, gzip, json, math, os, struct, sys, zlib

# ---- the region files ---------------------------------------------------------------------------------------------------------------
# A sample's position (a sample may carry the server's error text after it).
POS = re.compile(r'\[(-?[\d.Ee+-]+)d, (-?[\d.Ee+-]+)d, (-?[\d.Ee+-]+)d\]')

def _nbt(buf, pos, tag):
    if tag == 1: return struct.unpack_from('>b', buf, pos)[0], pos + 1
    if tag == 2: return struct.unpack_from('>h', buf, pos)[0], pos + 2
    if tag == 3: return struct.unpack_from('>i', buf, pos)[0], pos + 4
    if tag == 4: return struct.unpack_from('>q', buf, pos)[0], pos + 8
    if tag == 5: return struct.unpack_from('>f', buf, pos)[0], pos + 4
    if tag == 6: return struct.unpack_from('>d', buf, pos)[0], pos + 8
    if tag == 7:
        n = struct.unpack_from('>i', buf, pos)[0]; pos += 4
        return buf[pos:pos + n], pos + n
    if tag == 8:
        n = struct.unpack_from('>H', buf, pos)[0]; pos += 2
        return buf[pos:pos + n].decode('utf8', 'replace'), pos + n
    if tag == 9:
        t = buf[pos]; n = struct.unpack_from('>i', buf, pos + 1)[0]; pos += 5
        out = []
        for _ in range(n):
            v, pos = _nbt(buf, pos, t); out.append(v)
        return out, pos
    if tag == 10:
        out = {}
        while True:
            t = buf[pos]; pos += 1
            if t == 0: return out, pos
            n = struct.unpack_from('>H', buf, pos)[0]; pos += 2
            name = buf[pos:pos + n].decode('utf8', 'replace'); pos += n
            v, pos = _nbt(buf, pos, t); out[name] = v
    if tag == 11:
        n = struct.unpack_from('>i', buf, pos)[0]; pos += 4
        return list(struct.unpack_from('>%di' % n, buf, pos)), pos + 4 * n
    if tag == 12:
        n = struct.unpack_from('>i', buf, pos)[0]; pos += 4
        return list(struct.unpack_from('>%dq' % n, buf, pos)), pos + 8 * n
    raise ValueError(tag)

class World:
    """Blocks of a world's overworld region files (1.18+ chunk format), with their states: 'deepslate[axis=y]'."""
    def __init__(self, region_dir):
        self.dir = region_dir; self.files = {}; self.chunks = {}
    def _region(self, rx, rz):
        key = (rx, rz)
        if key not in self.files:
            p = os.path.join(self.dir, f'r.{rx}.{rz}.mca')
            self.files[key] = open(p, 'rb').read() if os.path.exists(p) else None
        return self.files[key]
    def _chunk(self, cx, cz):
        key = (cx, cz)
        if key in self.chunks: return self.chunks[key]
        f = self._region(cx >> 5, cz >> 5); out = None
        if f:
            i = 4 * ((cx & 31) + (cz & 31) * 32)
            off = int.from_bytes(f[i:i + 3], 'big')
            if off:
                p = off * 4096; ln = struct.unpack_from('>i', f, p)[0]; comp = f[p + 4]; raw = f[p + 5:p + 4 + ln]
                data = zlib.decompress(raw) if comp == 2 else gzip.decompress(raw) if comp == 1 else raw
                n = struct.unpack_from('>H', data, 1)[0]; nbt, _ = _nbt(data, 3 + n, data[0])
                secs = {}
                for s in nbt.get('sections', []):
                    bs = s.get('block_states')
                    if not bs: continue
                    pal = [q['Name'].replace('minecraft:', '') + (('[' + ','.join(f'{k}={v}' for k, v in sorted(q['Properties'].items())) + ']') if q.get('Properties') else '') for q in bs['palette']]
                    y = s['Y'] if s['Y'] < 128 else s['Y'] - 256
                    secs[y] = (pal, bs.get('data'))
                out = (secs, nbt.get('Status'))
        self.chunks[key] = out
        return out
    def state(self, x, y, z):
        c = self._chunk(x >> 4, z >> 4)
        if c is None: return None
        secs = c[0]
        if (y >> 4) not in secs: return 'air'
        pal, data = secs[y >> 4]
        if data is None or len(pal) == 1: return pal[0]
        bits = max(4, math.ceil(math.log2(len(pal)))); per = 64 // bits
        idx = ((y & 15) * 16 + (z & 15)) * 16 + (x & 15)
        v = ((data[idx // per] & 0xFFFFFFFFFFFFFFFF) >> ((idx % per) * bits)) & ((1 << bits) - 1)
        return pal[v] if v < len(pal) else '?'
    def name(self, x, y, z):
        s = self.state(x, y, z)
        return s.split('[')[0] if s else None

# ---- what is open, what the body makes -------------------------------------------------------------------------------------------------
OPEN = set('air cave_air void_air vine cave_vines cave_vines_plant short_grass tall_grass fern large_fern moss_carpet glow_lichen brown_mushroom red_mushroom '
           'small_amethyst_bud medium_amethyst_bud large_amethyst_bud amethyst_cluster rail torch wall_torch dead_bush sweet_berry_bush hanging_roots '
           'spore_blossom small_dripleaf big_dripleaf_stem dandelion poppy snow cobweb water lava kelp kelp_plant seagrass tall_seagrass'.split())
BODY_PUTS = set('cobblestone cobbled_deepslate crafting_table furnace water dirt oak_planks spruce_planks torch'.split())
FALLING = set('sand red_sand gravel suspicious_sand suspicious_gravel'.split())
def is_open(name): return name is None or name in OPEN
def body_change(p, c):
    """'dug', 'put', 'fell', 'flowed' or None (not the body's: generation or growth)."""
    pn, cn = p.split('[')[0], c.split('[')[0]
    if pn == cn: return None
    if pn in FALLING or cn in FALLING: return 'fell'
    if cn == 'water' and pn in ('air', 'cave_air'): return 'flowed'
    if cn == 'air' and pn not in ('air', 'cave_air'): return 'dug'
    if cn in BODY_PUTS and pn in ('air', 'cave_air', 'water'): return 'put'
    return None

# ---- the record: positions and maps over time ------------------------------------------------------------------------------------------
def load_record(ops_path, samples_path, t0):
    T0 = dt.datetime.fromisoformat(t0.replace('Z', '+00:00'))
    sec = lambda s: (dt.datetime.fromisoformat(s.replace('Z', '+00:00')) - T0).total_seconds()
    track, maps = [], []
    for line in open(ops_path, encoding='utf8'):
        o = json.loads(line); rc = o.get('rc') or {}
        try: r = json.loads(rc.get('result') or '')
        except Exception: r = None
        if not isinstance(r, dict) or not rc.get('observedAt'): continue
        end = sec(rc['observedAt']); ms = r.get('ms') if isinstance(r.get('ms'), (int, float)) else 0
        start = end - ms / 1000
        if isinstance(r.get('at'), dict): track.append((end, (r['at']['x'] + .5, r['at']['y'], r['at']['z'] + .5)))
        for l in r.get('lines') or []:
            if isinstance(l, dict) and isinstance(l.get('where'), dict):
                w = l['where']; track.append((end, (w['x'] + .5, w['y'], w['z'] + .5)))
        if isinstance(r.get('map'), str) and r['map'].startswith('地図'):
            maps.append((end, start, r['map']))
    if samples_path and os.path.exists(samples_path):
        for line in open(samples_path, encoding='utf8'):
            s = json.loads(line)
            m = POS.search(str(s.get('Pos', '')))
            if m: track.append((sec(s['t']), tuple(float(v) for v in m.groups())))
    track.sort()
    return track, maps

def first_near(track, cell, reach=5.0):
    """The first time the body came within `reach` of the cell (the track joined by straight lines, every 0.5 m)."""
    cx, cy, cz = cell[0] + .5, cell[1] + .5, cell[2] + .5
    for (t1, a), (t2, b) in zip(track, track[1:]):
        d = math.dist(a, b); n = max(1, int(d / 0.5))
        for i in range(n + 1):
            f = i / n; p = (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f)
            if math.dist(p, (cx, cy, cz)) <= reach: return t1 + (t2 - t1) * f
    return None

def parse_map(text):
    """{(x,y,z): symbol} of a `地図 v1 ... 方式=layers` map, and the columns ('縦') as runs."""
    out = {}
    lines = text.split('\n')
    head = lines[0]
    import re
    m = re.search(r'x=(-?\d+)\.\.(-?\d+) z=(-?\d+)\.\.(-?\d+)', head)
    if not m or '方式=layers' not in head: return out
    dx0, dx1, dz0, dz1 = map(int, m.groups())
    i = 1; y = None; xs = None
    while i < len(lines):
        l = lines[i]
        my = re.match(r'^y=(-?\d+)(?: x=(-?\d+)\.\.(-?\d+) z=(-?\d+)\.\.(-?\d+))?$', l)
        if my:
            y = int(my.group(1)); x0 = int(my.group(2)) if my.group(2) else dx0; x1 = int(my.group(3)) if my.group(3) else dx1
            xs = list(range(x0, x1 + 1)); i += 1; continue
        if l.startswith('z\\x'): i += 1; continue
        mr = re.match(r'^(-?\d+) (.+)$', l)
        if mr and y is not None and xs:
            z = int(mr.group(1)); syms = mr.group(2).split(' ')
            for x, s in zip(xs, syms): out[(x, y, z)] = s
        mc = re.match(r'^縦 \((-?\d+),(-?\d+)\) (上|下): (.+)$', l)
        if mc:
            x, z = int(mc.group(1)), int(mc.group(2))
            for part in mc.group(4).split(' / '):
                mm = re.match(r'^y=(-?\d+)(?:〜(-?\d+))? (\S)', part.strip())
                if not mm: continue
                a = int(mm.group(1)); b = int(mm.group(2)) if mm.group(2) else a
                for yy in range(min(a, b), max(a, b) + 1): out[(x, yy, z)] = mm.group(3)
        i += 1
    return out

OPEN_SYMBOLS = set('.,*@!mht=wl-fxq?')
def sym_open(s): return s in OPEN_SYMBOLS

# ---- the work --------------------------------------------------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--current', required=True); ap.add_argument('--pristine', required=True)
    ap.add_argument('--ops', required=True); ap.add_argument('--samples'); ap.add_argument('--t0', required=True)
    ap.add_argument('--at', type=float, required=True); ap.add_argument('--box', type=int, nargs=6, required=True)
    ap.add_argument('--name', default='case'); ap.add_argument('--out'); ap.add_argument('--section', default='')
    ap.add_argument('--reach', type=float, default=5.0)
    ap.add_argument('--own-map', action='store_true', help="also trust the map of the act that starts at --at (only for an act that changed nothing, e.g. a go stopped with 0 dug, 0 laid)")
    a = ap.parse_args()
    cur, pri = World(a.current), World(a.pristine)
    track, maps = load_record(a.ops, a.samples, a.t0)
    x0, y0, z0, x1, y1, z1 = a.box
    restore, marks, kept = [], [], 0
    # the maps seen at or before the moment (the latest first): what they show wins over the track
    seen = {}
    for end, start, text in sorted(maps, key=lambda m: m[0]):
        if end > a.at + 120: break
        if start < a.at - 0.5 or (a.own_map and start <= a.at + 0.5):  # the acts before; the act's own map only when it changed nothing
            for k, s in parse_map(text).items(): seen[k] = (end, s)
    ground = {}
    for x in range(x0, x1 + 1):
        for z in range(z0, z1 + 1):
            for y in range(y0, y1 + 1):
                c = cur.state(x, y, z); p = pri.state(x, y, z)
                if c is None or p is None: continue
                kind = body_change(p, c)
                state = c
                s0 = seen.get((x, y, z))
                cn, pn = c.split('[')[0], p.split('[')[0]
                if not kind and cn in BODY_PUTS and pn != cn and not is_open(pn):
                    kind = 'refilled'  # dug, then filled by the body (a pillar of cobblestone where deepslate was)
                if not kind and s0 and s0[1] not in '?$' and sym_open(s0[1]) != is_open(cn):
                    kind = 'refilled'  # a map shows it otherwise than now, and the generator's block does not explain it
                if kind:
                    t = first_near(track, (x, y, z), a.reach)
                    s = s0
                    if s and s[1] not in '?$':
                        # a map says what was there (the latest at or before the moment)
                        if kind == 'fell':
                            state = (c if cn in FALLING else p if pn in FALLING else 'gravel') if s[1] == 's' else ('air' if sym_open(s[1]) else (p if pn not in FALLING else c))
                        elif sym_open(s[1]) != is_open(cn):
                            state = p if sym_open(s[1]) == is_open(pn) else ('air' if sym_open(s[1]) else p)
                        elif kind == 'refilled' and not sym_open(s[1]) and s[1] == '#' and cn in BODY_PUTS:
                            state = p  # solid then and now, but the body's cobblestone is in the generator's stone
                    elif t is None or t > a.at:
                        state = p
                    if kind in ('fell', 'flowed'): marks.append({'cell': [x, y, z], 'kind': kind, 'now': c, 'pristine': p, 'chosen': state, 'firstNear': t})
                    if state != c: restore.append([x, y, z, state, kind, None if t is None else round(t, 1)])
                    else: kept += 1
                ground[(x, y, z)] = state
    # the check: every map cell at or before the moment against the ground put back
    agree = disagree = 0; bad = []
    for k, (t, s) in seen.items():
        if k in ground and s not in '?':
            g = ground[k].split('[')[0]
            if sym_open(s) == is_open(g): agree += 1
            else:
                disagree += 1
                if len(bad) < 40: bad.append({'cell': list(k), 'map': s, 'mapAt': round(t, 1), 'ground': g})
    result = {'name': a.name, 'at': a.at, 'box': a.box, 'restore': restore, 'keptBodyChanges': kept, 'marks': marks,
              'check': {'mapCells': agree + disagree, 'agree': agree, 'disagree': disagree, 'examples': bad}}
    if a.out:
        json.dump(result, open(a.out, 'w', encoding='utf8'), ensure_ascii=False)
    print(json.dumps({k: (v if k not in ('restore', 'marks') else len(v)) for k, v in result.items() if k != 'check'}, ensure_ascii=False))
    print('check', json.dumps({k: v for k, v in result['check'].items() if k != 'examples'}), 'examples', json.dumps(bad[:8], ensure_ascii=False))
    if a.section:
        # a cross-section through the box at the middle of the other axis: '#' solid, '.' open, '~' water, 's' falling, 'r' restored
        rs = {(r[0], r[1], r[2]) for r in restore}
        sym = lambda st, k: ('r' if k in rs and not is_open(st.split('[')[0]) else '~' if st.startswith('water') else 's' if st.split('[')[0] in FALLING
                             else 'L' if st.startswith('lava') else '.' if is_open(st.split('[')[0]) else 'd' if 'diamond' in st else 'i' if 'iron_ore' in st
                             else 'T' if st.startswith('crafting') else '#')
        for fixed in a.section.split(','):
            axis, val = fixed[0], int(fixed[1:])
            print(f'section {axis}={val} (rows y from top; columns {"z" if axis == "x" else "x"})')
            rng = range(z0, z1 + 1) if axis == 'x' else range(x0, x1 + 1)
            for y in range(y1, y0 - 1, -1):
                row = ''.join(sym(ground.get((val, y, w) if axis == 'x' else (w, y, val), 'air'), (val, y, w) if axis == 'x' else (w, y, val)) for w in rng)
                print(f'{y:4d} {row}')

if __name__ == '__main__':
    main()
