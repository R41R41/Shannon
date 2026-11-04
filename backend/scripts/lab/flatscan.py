#!/usr/bin/env python3
"""Read-only Java 1.18+ Anvil clearing scan; y in the JSON is the actor's FEET, not the floor.

python3 flatscan.py WORLD --dim nether [--around X Z --radius R]
Only saved, full chunks count. Missing chunks block sight. No server or third-party modules.
Vanilla collision names/top exceptions follow 1.21.11 (the hunt lab); modded blocks are unsupported.
"""
import argparse
import functools
import heapq
import json
import math
from pathlib import Path
import re
import struct
import sys
import zlib


class NBT:
    def __init__(self, data):
        self.data, self.pos = memoryview(data), 0

    def take(self, size):
        if size < 0 or self.pos + size > len(self.data):
            raise ValueError("truncated NBT")
        start, self.pos = self.pos, self.pos + size
        return self.data[start:self.pos]

    def number(self, fmt):
        return struct.unpack(">" + fmt, self.take(struct.calcsize(fmt)))[0]

    def string(self):
        return bytes(self.take(self.number("H"))).decode("utf-8", errors="replace")

    def payload(self, kind, depth=0):
        if depth > 64:
            raise ValueError("NBT too deep")
        if 1 <= kind <= 6:
            return self.number({1: "b", 2: "h", 3: "i", 4: "q", 5: "f", 6: "d"}[kind])
        if kind in (7, 11, 12):
            size, width = self.number("i"), {7: 1, 11: 4, 12: 8}[kind]
            raw = self.take(size * width)
            return bytes(raw) if kind == 7 else [v[0] for v in struct.iter_unpack(">" + ("i" if kind == 11 else "Q"), raw)]
        if kind == 8:
            return self.string()
        if kind == 9:
            sub, size = self.number("B"), self.number("i")
            if size < 0 or size > len(self.data) or (sub == 0 and size):
                raise ValueError("invalid NBT list")
            return [self.payload(sub, depth + 1) for _ in range(size)]
        if kind == 10:
            result = {}
            while True:
                sub = self.number("B")
                if not sub:
                    return result
                name = self.string()
                result[name] = self.payload(sub, depth + 1)
        raise ValueError(f"unsupported NBT tag {kind}")

    def root(self):
        if self.number("B") != 10:
            raise ValueError("NBT root must be compound")
        self.string()
        return self.payload(10)


# boundingBox=empty names, with families factored out; potted plants have collision.
EMPTY = re.compile(
    r"(?:.*_(?:sapling|sign|hanging_sign|pressure_plate|button|banner|torch)|.*_coral(?:_fan|_wall_fan)?|"
    r"air|cave_air|void_air|water|lava|bubble_column|.*rail|cobweb|short_grass|tall_grass|fern|large_fern|"
    r"dead_bush|bush|short_dry_grass|tall_dry_grass|seagrass|tall_seagrass|moving_piston|dandelion|torchflower|"
    r"poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|wither_rose|lily_of_the_valley|"
    r"brown_mushroom|red_mushroom|torch|fire|soul_fire|redstone_wire|wheat|lever|snow|cactus_flower|sugar_cane|"
    r"nether_portal|(?:attached_)?(?:pumpkin|melon)_stem|vine|glow_lichen|resin_clump|nether_wart|end_portal|"
    r"tripwire_hook|tripwire|carrots|potatoes|light|sunflower|lilac|rose_bush|peony|torchflower_crop|pitcher_plant|"
    r"beetroots|end_gateway|structure_void|kelp|kelp_plant|sweet_berry_bush|warped_fungus|crimson_fungus|"
    r"warped_roots|crimson_roots|nether_sprouts|(?:weeping|twisting|cave)_vines(?:_plant)?|powder_snow|"
    r"sculk_vein|spore_blossom|pink_petals|wildflowers|leaf_litter|big_dripleaf_stem|small_dripleaf|hanging_roots|"
    r"frogspawn|pale_hanging_moss|(?:open|closed)_eyeblossom|firefly_bush|mangrove_propagule)\Z"
)
LOW = re.compile(
    r"(?:.*_(?:bed|carpet|skull|head|candle|candle_cake|lantern|chest|golem_statue)|potted_.*|chest|farmland|"
    r"cactus|soul_sand|cake|repeater|lily_pad|enchanting_table|brewing_stand|cocoa|flower_pot|comparator|"
    r"daylight_detector|pitcher_crop|dirt_path|turtle_egg|dried_ghast|sea_pickle|conduit|lectern|stonecutter|"
    r"lantern|honey_block|candle|candle_cake|sculk_sensor|calibrated_sculk_sensor|sculk_shrieker|big_dripleaf|mud|heavy_core)\Z"
)
BAD_FLOOR = re.compile(r"lava|water|magma|campfire|slab|stairs|fence|wall|leaves")
BAD_BODY = re.compile(r"lava|water|fire|portal|cobweb")


def block_state(entry):
    name = entry["Name"].removeprefix("minecraft:")
    if ":" in name:
        raise ValueError(f"modded block unsupported: {name}")
    props = entry.get("Properties", {})
    solid = name.startswith("potted_") or name.endswith("wall_hanging_sign") or not EMPTY.fullmatch(name)
    full = not LOW.fullmatch(name)
    if name in ("sea_lantern", "jack_o_lantern"):
        full = True
    if name.endswith("trapdoor"):
        full = props.get("open") == "true" or props.get("half") == "top"
    if name in ("piston", "sticky_piston"):
        full = props.get("extended") != "true" or props.get("facing") != "up"
    if name == "piston_head":
        full = props.get("facing") != "down" or props.get("short") == "true"
    if name.endswith("chain"):
        full = props.get("axis") == "y"
    if name == "end_portal_frame":
        full = props.get("eye") == "true"
    if name.endswith("lightning_rod") or name == "end_rod":
        full = props.get("facing") in ("up", "down")
    if name == "chorus_plant":
        full = props.get("up") == "true"
    if name == "grindstone":
        full = props.get("face") != "wall"
    if name == "bell":
        full = props.get("attachment") in ("ceiling", "floor")
    if "amethyst" in name and name.endswith(("bud", "cluster")):
        full = props.get("facing") == "down"
    if name == "pointed_dripstone":
        full = props.get("vertical_direction") == "down" or props.get("thickness") != "tip"
    if name == "pitcher_crop":
        full = props.get("half") == "upper"
    if name == "big_dripleaf":
        full = props.get("tilt") == "full"
    if name == "pale_moss_carpet":
        full = props.get("bottom") == "false"
    # name, solid, usable floor, usable feet/head (same regexes as chooseClearing).
    return name, bool(solid), bool(solid and full and not BAD_FLOOR.search(name)), not solid and not BAD_BODY.search(name)


AIR = block_state({"Name": "minecraft:air"})


def unpack_palette(container, count, minimum, convert=lambda value: value):
    palette = [convert(value) for value in container["palette"]]
    if not palette:
        raise ValueError("empty palette")
    if len(palette) == 1:
        return [palette[0]] * count
    bits = max(minimum, (len(palette) - 1).bit_length())
    per_long, mask = 64 // bits, (1 << bits) - 1
    data = container["data"]
    if len(data) != math.ceil(count / per_long):
        raise ValueError("invalid packed palette length (requires 1.18+ chunks)")
    return [palette[(data[i // per_long] >> ((i % per_long) * bits)) & mask] for i in range(count)]


class World:
    def __init__(self, directory, dimension):
        self.dimension = dimension
        self.directory = directory / "DIM-1" / "region" if dimension == "nether" else directory / "region"
        self.locations = {}
        if not self.directory.is_dir():
            raise ValueError(f"missing region directory: {self.directory}")
        for file in sorted(self.directory.glob("r.*.*.mca")):
            _, rx, rz, _ = file.name.split(".")
            with file.open("rb") as stream:
                header = stream.read(4096)
            if len(header) != 4096:
                raise ValueError(f"truncated region header: {file}")
            for i, (location,) in enumerate(struct.iter_unpack(">I", header)):
                if location:
                    self.locations[(int(rx) * 32 + i % 32, int(rz) * 32 + i // 32)] = (file, location >> 8, location & 255)

    @functools.lru_cache(maxsize=64)
    def chunk(self, cx, cz):
        location = self.locations.get((cx, cz))
        if not location:
            return None
        file, offset, sectors = location
        with file.open("rb") as stream:
            stream.seek(offset * 4096)
            header = stream.read(5)
            if offset < 2 or not sectors or len(header) != 5:
                raise ValueError(f"bad chunk location: {file} {cx},{cz}")
            length, compression = struct.unpack(">IB", header)
            if length < 1 or length + 4 > sectors * 4096:
                raise ValueError(f"bad chunk length: {file} {cx},{cz}")
            body = stream.read(length - 1)
        if len(body) != length - 1:
            raise ValueError("truncated chunk")
        if compression & 128:
            body = (file.parent / f"c.{cx}.{cz}.mcc").read_bytes()
        compression &= 127
        if compression not in (1, 2, 3):
            raise ValueError(f"unsupported Anvil compression {compression}: {file}")
        raw = body if compression == 3 else zlib.decompress(body, 31 if compression == 1 else 15)
        root = NBT(raw).root()
        if root.get("Status", "").removeprefix("minecraft:") != "full":
            return None
        if "sections" not in root:
            raise ValueError("requires Java 1.18+ sections")
        sections = {}
        for section in root["sections"]:
            if "block_states" in section:
                blocks = unpack_palette(section["block_states"], 4096, 4, block_state)
                biomes = unpack_palette(section["biomes"], 64, 1) if "biomes" in section else None
                sections[section["Y"]] = (blocks, biomes, any(block[1] for block in blocks))
        return sections

    def block(self, x, y, z):
        chunk = self.chunk(x // 16, z // 16)
        if chunk is None:
            return None
        section = chunk.get(y // 16)
        return section[0][(y % 16) * 256 + (z % 16) * 16 + x % 16] if section else AIR

    def surface(self, x, z, chunk):
        if not chunk:
            return None
        top = min(126, max(chunk) * 16 + 15) if self.dimension == "nether" else max(chunk) * 16 + 15
        free = 0 if self.block(x, top + 1, z)[1] else 1 + (not self.block(x, top + 2, z)[1])
        for sy in range(top // 16, min(chunk) - 1, -1):
            section = chunk.get(sy)
            if not section or not section[2]:
                free = 2
                continue
            for ly in range(min(15, top - sy * 16), -1, -1):
                floor = section[0][ly * 256 + (z % 16) * 16 + x % 16]
                if floor[1]:
                    if self.dimension != "nether" or free >= 2:
                        return sy * 16 + ly + 1
                    free = 0
                else:
                    free += 1
        return None

    def biome(self, x, y, z):
        section = self.chunk(x // 16, z // 16).get(y // 16)
        return section[1][(y % 16 // 4) * 16 + (z % 16 // 4) * 4 + x % 16 // 4] if section and section[1] else None


def clearing(read, x, y, z):
    outer_bad = 0
    for dx in range(-2, 3):
        for dz in range(-2, 3):
            floor, feet, head = (read(x + dx, y + dy, z + dz) for dy in (-1, 0, 1))
            bad = not (floor and floor[2] and feet and feet[3] and head and head[3])
            if bad and abs(dx) <= 1 and abs(dz) <= 1:
                return None
            outer_bad += bool(bad)
            if outer_bad > 6:
                return None
    return outer_bad


def sight_rays():
    # endermanLine: actor eye 1.62 -> enderman eye 2.55, 0.05m samples, including endpoint cells.
    steps = math.ceil(math.hypot(12, 2.55 - 1.62) / 0.05)
    rays = []
    for k in range(8):
        dx, dz = 12 * math.cos(k * math.pi / 4), 12 * math.sin(k * math.pi / 4)
        rays.append(tuple(dict.fromkeys((math.floor(0.5 + dx * i / steps), math.floor(1.62 + 0.93 * i / steps),
                                        math.floor(0.5 + dz * i / steps)) for i in range(steps + 1))))
    return rays


RAYS = sight_rays()


def horizons(read, x, y, z):
    opened = 0
    for ray in RAYS:
        for dx, dy, dz in ray:
            block = read(x + dx, y + dy, z + dz)
            cap = dy == 2 and abs(dx) <= 1 and abs(dz) <= 1
            if cap or block is None or block[1]:
                break
        else:
            opened += 1
    return opened


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("world", type=Path)
    parser.add_argument("--dim", choices=("overworld", "nether"), required=True)
    parser.add_argument("--around", type=int, nargs=2, metavar=("X", "Z"))
    parser.add_argument("--radius", type=int)
    args = parser.parse_args()
    if (args.around is None) != (args.radius is None) or (args.radius is not None and args.radius < 0):
        parser.error("--around X Z and --radius R must be supplied together; R must be nonnegative")
    world, best, matched, scanned = World(args.world.expanduser(), args.dim), [], 0, 0
    for cx, cz in sorted(world.locations):
        if args.around and math.hypot(max(cx * 16 - args.around[0], 0, args.around[0] - cx * 16 - 15),
                                     max(cz * 16 - args.around[1], 0, args.around[1] - cz * 16 - 15)) > args.radius:
            continue
        chunk = world.chunk(cx, cz)
        if not chunk:
            continue
        scanned += 1
        for x in range(cx * 16, cx * 16 + 16):
            for z in range(cz * 16, cz * 16 + 16):
                if args.around and math.hypot(x - args.around[0], z - args.around[1]) > args.radius:
                    continue
                y = world.surface(x, z, chunk)
                outer = clearing(world.block, x, y, z) if y is not None else None
                if outer is None:
                    continue
                matched += 1
                if len(best) == 20 and (8, -x, -z, -y) <= best[0][0]:
                    continue
                openness = horizons(world.block, x, y, z)
                candidate = dict(x=x, y=y, z=z, biome=world.biome(x, y, z), horizons=openness, outerBad=outer)
                item = ((openness, -x, -z, -y), candidate)
                if len(best) < 20:
                    heapq.heappush(best, item)
                elif item[0] > best[0][0]:
                    heapq.heapreplace(best, item)
    print(json.dumps(dict(world=str(args.world), dim=args.dim, scannedChunks=scanned, matched=matched,
                          candidates=[item[1] for item in sorted(best, reverse=True)]), indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, IndexError, struct.error, zlib.error) as error:
        sys.exit(f"flatscan: {error}")
