#!/usr/bin/env python3
"""A picture of a box of a lab world, from the JSON scripts/minecraft-box-dump-probe.ts writes (MINECRAFT_BOX_JSON).

Not a screenshot (the game's renderer needs a GL build this VM does not have): blocks are drawn as cubes seen from
above the south-east corner, slabs as half cubes, mobs and dropped items as labelled markers drawn over the blocks.
Two panels: the whole box, and the same box with everything above a level cut away (to see into a shelter).

usage: render-box.py <box.json> <out.png> [--cut Y] [--body x,y,z] [--title TEXT]
"""
import argparse
import hashlib
import json

from PIL import Image, ImageDraw, ImageFont

FONT = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
A, B, H = 24, 13, 28          # half tile width, half tile height, block height on screen

BLOCKS = {
    'nether_bricks': (74, 31, 36), 'red_nether_bricks': (90, 20, 20), 'nether_brick_fence': (58, 23, 27),
    'nether_brick_stairs': (74, 31, 36), 'nether_brick_slab': (74, 31, 36),
    'cobblestone': (128, 128, 128), 'cobblestone_slab': (160, 160, 160), 'cobbled_deepslate': (80, 80, 86),
    'stone': (125, 125, 125), 'spawner': (30, 44, 58), 'netherrack': (112, 50, 50), 'soul_sand': (90, 68, 52),
    'soul_soil': (79, 59, 44), 'basalt': (92, 92, 100), 'polished_basalt': (100, 100, 108), 'blackstone': (43, 39, 48),
    'lava': (255, 122, 0), 'fire': (255, 154, 26), 'soul_fire': (60, 200, 230), 'magma_block': (150, 60, 20),
    'gravel': (133, 127, 123), 'glowstone': (232, 200, 106), 'nether_quartz_ore': (150, 100, 90),
    'nether_gold_ore': (160, 110, 60), 'obsidian': (25, 15, 40), 'chest': (160, 110, 40), 'crafting_table': (150, 100, 55),
    'dirt': (130, 90, 60), 'andesite': (136, 136, 140), 'granite': (150, 105, 90), 'diorite': (190, 190, 190),
}
MOBS = {
    'blaze': (255, 176, 0), 'wither_skeleton': (30, 30, 30), 'skeleton': (225, 225, 225), 'magma_cube': (200, 50, 40),
    'ghast': (245, 245, 245), 'zombified_piglin': (220, 140, 140), 'piglin': (230, 170, 110), 'hoglin': (180, 120, 100),
    'enderman': (40, 0, 60), 'player': (40, 130, 255), 'MinebotTrial': (40, 130, 255),
}


def colour(name):
    base = name.split(':')[0]
    if base in BLOCKS:
        return BLOCKS[base]
    digest = hashlib.md5(base.encode()).digest()
    return (60 + digest[0] % 140, 60 + digest[1] % 140, 60 + digest[2] % 140)


def shade(rgb, k):
    return tuple(max(0, min(255, int(c * k))) for c in rgb)


def panel(data, cut, body, label, font, small):
    cells = [c for c in data['cells'] if cut is None or c[1] <= cut]
    # The picture is as big as what is drawn, not as the box asked for (mostly air).
    xs = [c[0] for c in data['cells']] or [0]; ys = [c[1] for c in data['cells']] or [0]; zs = [c[2] for c in data['cells']] or [0]
    lo = (min(xs), min(ys), min(zs))
    hi = (max(xs) + 1, max(ys) + 3, max(zs) + 1)
    corners = [(x, y, z) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]
    sx = [(x - z) * A for x, y, z in corners]
    sy = [(x + z) * B - y * H for x, y, z in corners]
    pad = 70
    width, height = int(max(sx) - min(sx)) + 2 * pad, int(max(sy) - min(sy)) + 2 * pad + 30
    ox, oy = pad - min(sx), pad + 30 - min(sy)
    image = Image.new('RGB', (width, height), (18, 18, 24))
    draw = ImageDraw.Draw(image)
    P = lambda x, y, z: (ox + (x - z) * A, oy + (x + z) * B - y * H)

    for x, y, z, name in sorted(cells, key=lambda c: c[0] + c[1] + c[2]):
        rgb = colour(name)
        y0, y1_ = y, y + 1
        if name.endswith(':top'):
            y0 = y + 0.5
        elif name.endswith(':bottom') or 'fence' in name or name.startswith('fire') or name.startswith('soul_fire'):
            y1_ = y + 0.5
        top = [P(x, y1_, z), P(x + 1, y1_, z), P(x + 1, y1_, z + 1), P(x, y1_, z + 1)]
        east = [P(x + 1, y0, z), P(x + 1, y1_, z), P(x + 1, y1_, z + 1), P(x + 1, y0, z + 1)]
        south = [P(x, y0, z + 1), P(x + 1, y0, z + 1), P(x + 1, y1_, z + 1), P(x, y1_, z + 1)]
        edge = shade(rgb, 0.45)
        draw.polygon(east, fill=shade(rgb, 0.72), outline=edge)
        draw.polygon(south, fill=shade(rgb, 0.85), outline=edge)
        draw.polygon(top, fill=rgb, outline=edge)
        if name.startswith('spawner'):
            cx, cy = P(x + 0.5, y1_, z + 0.5)
            draw.line([top[0], top[2]], fill=(120, 170, 220))
            draw.line([top[1], top[3]], fill=(120, 170, 220))
            draw.text((cx - 22, cy - 6), 'spawner', fill=(170, 210, 250), font=small)

    marks = [t for t in data.get('entities', []) if t['name'] not in ('experience_orb', 'arrow', 'small_fireball')]
    if body:
        marks.append({'name': 'body', 'x': body[0] + 0.5, 'y': body[1], 'z': body[2] + 0.5, 'height': 1.8})
    for thing in sorted(marks, key=lambda t: t['x'] + t['z']):
        name = thing['name']
        if cut is not None and thing['y'] > cut + 1:
            continue
        bx, by = P(thing['x'], thing['y'], thing['z'])
        tx, ty = P(thing['x'], thing['y'] + thing.get('height', 1), thing['z'])
        if name.startswith('item:'):
            r = 4
            fill = (255, 215, 0) if 'blaze_rod' in name else (200, 200, 200)
            draw.ellipse([bx - r, by - r, bx + r, by + r], fill=fill, outline=(0, 0, 0))
            if 'blaze_rod' in name:
                draw.text((bx + 6, by - 8), 'rod', fill=fill, font=small)
            continue
        fill = (40, 130, 255) if name == 'body' else MOBS.get(name, (255, 80, 200))
        draw.line([(bx, by), (tx, ty)], fill=fill, width=5)
        draw.ellipse([tx - 6, ty - 6, tx + 6, ty + 6], fill=fill, outline=(255, 255, 255))
        draw.text((tx + 8, ty - 10), name, fill=fill if name != 'wither_skeleton' else (200, 200, 200), font=small)

    draw.text((10, 6), label, fill=(235, 235, 235), font=font)
    return image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('json')
    parser.add_argument('out')
    parser.add_argument('--cut', type=int)
    parser.add_argument('--body')
    parser.add_argument('--title', default='')
    args = parser.parse_args()
    data = json.load(open(args.json))
    body = tuple(int(float(v)) for v in args.body.split(',')) if args.body else None
    font = ImageFont.truetype(FONT, 18)
    small = ImageFont.truetype(FONT, 15)
    whole = panel(data, None, body, '全体', font, small)
    panels = [whole]
    if args.cut is not None:
        panels.append(panel(data, args.cut, body, f'y={args.cut} より上を外した断面', font, small))
    width = sum(p.width for p in panels)
    height = max(p.height for p in panels) + 40
    out = Image.new('RGB', (width, height), (18, 18, 24))
    x = 0
    for p in panels:
        out.paste(p, (x, 40))
        x += p.width
    ImageDraw.Draw(out).text((10, 8), args.title, fill=(255, 255, 255), font=font)
    out.save(args.out)
    print(args.out, out.size)


if __name__ == '__main__':
    main()
