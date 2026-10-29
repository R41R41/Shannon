import { Vec3 } from 'vec3';
import { nativeActionHost } from '../execution/ActionExecution.js';
import { isLikelyHostileMobName } from './hostileMobHints.js';

/**
 * The map the planner reads every decision (design mb-llm-centric 2.2; the format and the symbols are the head's contract,
 * minecraftActContract.ts / mb-llm-centric-contract.md 3): the blocks round the body as one character each, north up and west left,
 * with where the body has walked in the last minute and the creatures' feet.
 *
 * Run 25, d=17: the furnace was seven blocks overhead and the planner, which saw no block round the body, asked for "near it" seven
 * times. A map lets it see the shaft and choose "seven up". Run 25's 85 stops at one bank of water were the same: what stopped the walk
 * was one cell beside it, and nothing showed that cell.
 *
 * One drawer for everything that draws blocks: the decision's map (`localMapFor`), `view` (wider, a slice, the surface from above) and
 * get-blocks-in-area (whose own letters clashed: deepslate and dirt were both `D`, cave_air was not air, an unloaded cell was air). The
 * core is pure (a `BlockReader` in, text out), so the same drawing comes from a live body, a test's fixed blocks, or a saved world
 * read from its region files (scene replay, utils/anvilWorld.ts).
 */

/** One cell as the drawer needs it. `null` from a reader is a cell not loaded. */
export interface MapBlock {
  name: string;
  /** The block stops a body (a full collision box). Unknown: judged by the name. */
  solid?: boolean;
  /** Water and lava: 0 is a source, 1-15 flowing. */
  level?: number;
  /** An end portal frame with an eye in it. */
  eye?: boolean;
  /** A door, fence gate or trapdoor standing open (r5: the walk's rules, utils/walkRules). Unknown: shut. */
  open?: boolean;
  /** `symbolFor`'s answer, kept by the reader that shares one MapBlock per block state (it is a function of the fields above). */
  symbol?: string;
  /**
   * r7: the top of the block's collision box in its cell, when it is not a full one (a slab 0.5, soul sand 0.875, a carpet 0.0625, a fence
   * or a wall 1.5). Absent: 1 for a solid block. The walk's rules (utils/walkRules) read it as the route search does.
   */
  top?: number;
  /**
   * run 47: for an open door, gate or trapdoor, the edges of its cell where a thin plate of it stands (letters w, e, n, s), from its collision boxes. A
   * body does not cross an edge with a plate at its height (the walk's rules, utils/walkRules). Absent: none.
   */
  plates?: string;
}
export type BlockReader = (x: number, y: number, z: number) => MapBlock | null;
export interface Cell { x: number; y: number; z: number }

export const cellKey = (cell: Cell) => `${cell.x},${cell.y},${cell.z}`;

const AIR = new Set(['air', 'cave_air', 'void_air']);
/** Plants and the snow layer: walked through, and a block put into them replaces them (`,`). */
const PASSABLE_PLANTS = /^(short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|light|structure_void|sweet_berry_bush|wither_rose|.*_sapling|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|pink_petals|.*_mushroom|crimson_roots|warped_roots|nether_sprouts|.*_fungus|hanging_roots|glow_lichen|spore_blossom|small_dripleaf|big_dripleaf_stem|moss_carpet|.*_carpet|lily_pad|sugar_cane|bamboo_sapling|cave_vines.*|twisting_vines.*|weeping_vines.*|pitcher_plant|short_dry_grass|tall_dry_grass|bush|firefly_bush|leaf_litter|wildflowers)$/u;
const STONE = /^(stone|deepslate|cobbled_deepslate|cobblestone|mossy_cobblestone|andesite|diorite|granite|tuff|calcite|smooth_basalt|basalt|polished_basalt|blackstone|dripstone_block|sandstone|red_sandstone|smooth_sandstone|smooth_red_sandstone|cut_sandstone|terracotta|.*_terracotta|stone_bricks|mossy_stone_bricks|cracked_stone_bricks|chiseled_stone_bricks|deepslate_bricks|cracked_deepslate_bricks|deepslate_tiles|cracked_deepslate_tiles|chiseled_deepslate|polished_deepslate|polished_andesite|polished_diorite|polished_granite|polished_tuff|tuff_bricks|polished_blackstone.*|gilded_blackstone|infested_.*|reinforced_deepslate|smooth_stone|.*_concrete|amethyst_block|budding_amethyst|.*stone_slab|.*stone_stairs|.*brick_slab|.*brick_stairs)$/u;
const SOFT = /^(dirt|grass_block|coarse_dirt|podzol|mycelium|rooted_dirt|mud|muddy_mangrove_roots|clay|farmland|dirt_path|snow_block|moss_block|packed_mud)$/u;
const FALLING = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel)$/u;
const ICE = /^(ice|packed_ice|blue_ice|frosted_ice)$/u;
const LOGS = /(_log|_wood|_stem|_hyphae)$/u;
// mb-llmc-cand (run 36): one symbol was several kinds the walk treats differently, and the head read them as one. Split by the walk's rules
// (utils/walkRules): leaves are broken on the way (`%`); the nether's wart blocks and shroomlight are walls (`Y`); planks, slabs and
// stairs are walls (`P`); a wooden door (`D`), trapdoor (`A`) and fence gate (`J`) are opened on the way; an iron door or trapdoor is not
// (`K`); a sign, a pressure plate, a button and a lever are walked through and take no block (`q`); a fence and a wall are 1.5 high
// (`+`); glass, panes, bars and chains are thin walls (`b`).
const LEAVES = /_leaves$/u;
const FUNGAL = /^(nether_wart_block|warped_wart_block|shroomlight)$/u;
const WOODEN = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped|pale_oak)_(planks|slab|stairs)$|^bamboo_(block|mosaic.*)$|^bookshelf$|^chiseled_bookshelf$/u;
const TOUCH = /(_pressure_plate|_button|_sign|_wall_sign|_hanging_sign|_wall_hanging_sign)$|^lever$/u;
const FENCES = /(_fence|_wall)$/u;
const PANES = /(_pane|^iron_bars|^glass|_glass|^chain)$/u;
const CONTAINERS = /^(chest|trapped_chest|barrel|ender_chest|.*shulker_box)$/u;
const CROPS = /^(wheat|carrots|potatoes|beetroots|nether_wart|melon_stem|pumpkin_stem|attached_melon_stem|attached_pumpkin_stem|torchflower_crop|pitcher_crop)$/u;
/** A door, a fence gate or a trapdoor: whether it stands open is in its state (read once per state id, as a fluid's level). */
const DOORLIKE = /(_door|_fence_gate|_trapdoor)$/u;
const NETHER_BRICK = /^(nether_bricks|nether_brick_fence|nether_brick_stairs|nether_brick_slab|nether_brick_wall|red_nether_bricks|red_nether_brick_.*|cracked_nether_bricks|chiseled_nether_bricks)$/u;

/**
 * The one character for a block (the contract's legend, MAP_LEGEND). Order matters: the specific kinds first, the families last;
 * anything else solid is `$`, anything else passable `,`.
 */
export function symbolFor(block: MapBlock | null): string {
  if (!block) return '?';
  if (block.symbol !== undefined) return block.symbol;
  const name = block.name.replace(/^minecraft:/u, '');
  if (AIR.has(name)) return '.';
  // r2 (2026-10-22, count_tokens): '~ ' was three tokens a cell and '; ' two, a letter one: water a source is 'w', sand and gravel 's'.
  if (name === 'water') return (block.level ?? 0) === 0 ? 'w' : '-';
  if (name === 'bubble_column' || name === 'kelp' || name === 'kelp_plant' || name === 'seagrass' || name === 'tall_seagrass') return 'w';
  if (name === 'lava') return (block.level ?? 0) === 0 ? 'L' : 'l';
  if (name === 'fire' || name === 'soul_fire' || name === 'campfire' || name === 'soul_campfire') return 'f';
  if (name === 'cobweb' || name === 'powder_snow') return 'x';
  if (name === 'bedrock' || name === 'barrier') return 'X';
  if (name === 'end_portal_frame') return block.eye ? 'R' : 'Q';
  if (name === 'end_portal' || name === 'end_gateway') return 'e';
  if (name === 'nether_portal') return 'p';
  if (name === 'spawner' || name === 'trial_spawner') return 'S';
  if (name === 'obsidian' || name === 'crying_obsidian') return 'O';
  if (name === 'magma_block') return 'M';
  if (name === 'glowstone') return 'G';
  if (name === 'netherrack') return 'n';
  if (name === 'soul_sand' || name === 'soul_soil') return 'u';
  if (name === 'end_stone' || name === 'end_stone_bricks') return 'E';
  if (/(^|_)iron_ore$/u.test(name) || name === 'raw_iron_block') return 'i';
  if (/(^|_)coal_ore$/u.test(name)) return 'c';
  if (/(^|_)diamond_ore$/u.test(name)) return 'd';
  if (/(^|_)gold_ore$/u.test(name) || name === 'raw_gold_block') return 'g';
  if (/(^|_)redstone_ore$/u.test(name)) return 'r';
  if (/_ore$/u.test(name) || name === 'ancient_debris') return 'o';
  if (name === 'furnace' || name === 'blast_furnace' || name === 'smoker') return 'F';
  if (name === 'crafting_table') return 'T';
  if (CONTAINERS.test(name)) return 'C';
  if (/_bed$/u.test(name)) return 'B';
  if (name === 'hay_block') return 'H';
  if (CROPS.test(name)) return 'k';
  if (/^iron_(door|trapdoor)$/u.test(name)) return 'K';
  if (/_door$/u.test(name)) return 'D';
  if (/_trapdoor$/u.test(name)) return 'A';
  if (/_fence_gate$/u.test(name)) return 'J';
  if (NETHER_BRICK.test(name)) return 'N';
  if (name === 'ladder' || name === 'vine' || name === 'scaffolding') return 'h';
  if (/(^|_)torch$/u.test(name) || /_wall_torch$/u.test(name)) return 't';
  if (/(^|_)rail$/u.test(name)) return '=';
  if (FENCES.test(name)) return '+';
  if (PANES.test(name)) return 'b';
  if (TOUCH.test(name)) return 'q';
  if (LOGS.test(name)) return 'W';
  if (LEAVES.test(name)) return '%';
  if (FUNGAL.test(name)) return 'Y';
  if (WOODEN.test(name)) return 'P';
  if (ICE.test(name)) return 'I';
  if (FALLING.test(name)) return 's';
  if (SOFT.test(name)) return ':';
  if (STONE.test(name) || /(stone|deepslate|brick|terracotta|concrete|tuff|basalt|blackstone|prismarine|purpur)/u.test(name)) return '#';
  if (PASSABLE_PLANTS.test(name)) return ',';
  if (block.solid === true) return '$';
  if (block.solid === false) return ',';
  return '$';
}

/** Air or something walked through and replaced by a block put there (`.` and `,`). */
export const isOpenSymbol = (symbol: string) => symbol === '.' || symbol === ',';
/** Whether a block is open (air, a plant, a snow layer). */
export function isOpenBlock(block: MapBlock | null): boolean { return !!block && isOpenSymbol(symbolFor(block)); }

/** The legend, word for word the head's (minecraftActContract.ts MAP_LEGEND): the head puts it in the fixed instructions; the map does not. */
export const MAP_LEGEND = [
  '地図の記号（1字。地図は上が北・左が西。行の頭は z、列の見出しは x の下 1 桁）:',
  '@ 自分の足 / ! 敵の足 / m 動物の足 / * 60秒以内に歩いた空気 / . 空気 / , 通れる草花・雪 / ? 未ロード / X 掘れない（岩盤・バリア）',
  '# 石の類（石・深層岩・安山岩・閃緑岩・花崗岩・凝灰岩・丸石・石レンガ）/ : 土・草・雪・粘土 / s 砂・砂利 / I 氷',
  'w 水源 / - 流れる水 / L 溶岩源 / l 流れる溶岩 / f 火 / x クモの巣',
  'i 鉄 / c 石炭 / d ダイヤ / g 金 / r レッドストーン / o ほかの鉱石（銅・ラピス・エメラルド・石英・古代の残骸）',
  'W 原木（ネザーの幹も）/ % 葉（歩きの中で壊して通る）/ Y ネザーのウォートブロック・シュルームライト（固い）/ P 板・階段・ハーフブロック・本棚（固い）/ h はしご・つた / t 松明 / = レール',
  'D 木の扉 / A 木のトラップドア / J 木のフェンスゲート（D・A・J は閉じていても歩きの中で開けて通る）/ K 鉄の扉・鉄のトラップドア（手では開かない＝壁）/ + 柵・壁（高さ1.5で上れない）/ b ガラス・板ガラス・鉄格子・鎖（通れない）/ q 看板・感圧板・ボタン・レバー（通れる。ブロックは置けない）',
  'F かまど（溶鉱炉・燻製器も）/ T 作業台 / C チェスト・樽 / B ベッド / H 干し草 / k 畑の作物（ネザーウォートも）/ S スポナー',
  'O 黒曜石（泣く黒曜石も）/ p ネザーポータル / n ネザーラック / u ソウルサンド・ソウルソイル / N ネザーレンガ（要塞）/ M マグマ / G グロウストーン',
  'E エンドストーン / Q エンドポータルの枠（空）/ R 枠（アイ入り）/ e エンドポータル・エンドゲートウェイ / $ ほかの固いブロック',
  '方式=surface のマスは「記号＋高さ」: 0〜9 は足より上、+ は10以上上、a〜i は1〜9下、v は10以上下。',
  '方式=layers の層: 足 −1〜+1 は 15×15、足 ±2 は 11×11（「y=47 x=196..206 z=272..282」のように範囲を書く）。足の 3〜6 上に敵（!）かスポナー（S）があれば、その高さの層（11×11）を一番上に足す。',
  '縦: 足の列の上（頭のマスから上へ）と下（足の下のマスから下へ）を、同じ記号の続きでまとめる。「上: y=46〜51 .×6 / y=52 #」は頭から空気が 6 段、その上が石。… はその先も続く。',
].join('\n');

/** The height in a surface view: 0 level with the feet, 1-9 up, + ten or more up, a-i down 1-9, v ten or more down (or nothing). */
export function heightCode(diff: number | null): string {
  if (diff === null) return 'v';
  if (diff === 0) return '0';
  if (diff > 0) return diff <= 9 ? String(diff) : '+';
  return -diff <= 9 ? String.fromCharCode(96 + -diff) : 'v';
}

export type Facing = 'north' | 'east' | 'south' | 'west';
const FACING_JA: Record<Facing, string> = { north: '北', east: '東', south: '南', west: '西' };
const FRONT: Record<Facing, [number, number]> = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };

/** The compass way a yaw faces (mineflayer: yaw 0 looks north, -z; it grows turning left). */
export function facingOfYaw(yaw: number): Facing {
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? 'east' : 'west';
  return dz >= 0 ? 'south' : 'north';
}
/** The cell `front` ahead, `right` to the right and `up` above `base`, for a body facing `facing`. */
export function relativeCell(base: Cell, facing: Facing, rel: { front?: number; right?: number; up?: number }): Cell {
  const [fx, fz] = FRONT[facing];
  const rx = -fz, rz = fx;
  const front = Math.round(rel.front ?? 0), right = Math.round(rel.right ?? 0), up = Math.round(rel.up ?? 0);
  return { x: base.x + fx * front + rx * right, y: base.y + up, z: base.z + fz * front + rz * right };
}
export function facingLabel(facing: Facing): string {
  const [fx, fz] = FRONT[facing];
  const axis = (dx: number, dz: number) => dx ? `${dx > 0 ? '+' : '-'}x` : `${dz > 0 ? '+' : '-'}z`;
  return `${FACING_JA[facing]}（前=${axis(fx, fz)}、右=${axis(-fz, fx)}）`;
}

/** Where `to` is from `from`, in the map's words: "東3・北2・上1" (the compass first, then up or down; "同じマス" for the same cell). */
export function relativeWords(from: Cell, to: Cell): string {
  const parts: string[] = [];
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  if (dx) parts.push(`${dx > 0 ? '東' : '西'}${Math.abs(dx)}`);
  if (dz) parts.push(`${dz > 0 ? '南' : '北'}${Math.abs(dz)}`);
  if (dy) parts.push(`${dy > 0 ? '上' : '下'}${Math.abs(dy)}`);
  return parts.length ? parts.join('・') : '同じマス';
}

const pad = (text: string | number, width: number) => String(text).padStart(width, ' ');
const lastDigit = (n: number) => String(Math.abs(n) % 10);

export interface DrawOptions {
  read: BlockReader;
  /** The body's feet cell (drawn `@`), if it is in the drawing. */
  self?: Cell | null;
  /** Cells walked in the last minute ("x,y,z"): drawn `*` where they are air. */
  trail?: ReadonlySet<string>;
  /** Creatures' feet cells ("x,y,z" → `!` a hostile, `m` an animal): drawn where the cell is open. */
  creatures?: ReadonlyMap<string, string>;
  /** Only these kinds (block names or map symbols) keep their own letter; the rest is `#` (solid) or `.` (not). */
  only?: ((name: string, symbol: string) => boolean) | null;
}

function cellSymbol(options: DrawOptions, x: number, y: number, z: number): string {
  if (options.self && options.self.x === x && options.self.y === y && options.self.z === z) return '@';
  const block = options.read(x, y, z);
  let symbol = symbolFor(block);
  if (block && options.only && !options.only(block.name, symbol)) symbol = isOpenSymbol(symbol) ? '.' : symbol === '?' ? '?' : '#';
  // The key is built only where there is something to look for (a string per open cell was ~4,000 a draw).
  if (isOpenSymbol(symbol) && ((options.creatures?.size ?? 0) > 0 || (options.trail?.size ?? 0) > 0)) {
    const key = `${x},${y},${z}`;
    const creature = options.creatures?.get(key);
    if (creature) return creature;
    if (symbol === '.' && options.trail?.has(key)) return '*';
  }
  return symbol;
}

/** The label column's width: wide enough for "z\x" and every z. */
const labelWidthFor = (minZ: number, maxZ: number) => Math.max(3, String(minZ).length, String(maxZ).length);
/** The column heads: "z\x" then the last digit of each x (or z), over the first character of its cell. */
function columnHeader(minX: number, maxX: number, labelWidth: number, cellWidth: number, step = 1, corner = 'z\\x'): string {
  const digits: string[] = [];
  for (let x = minX; x <= maxX; x += step) digits.push(lastDigit(x).padEnd(cellWidth, ' '));
  return `${corner.padEnd(labelWidth, ' ')} ${digits.join(' ')}`.trimEnd();
}

/**
 * Layers seen from above, the top one first: `yTo` down to `yFrom`, x `minX..maxX` (west to east), z `minZ..maxZ` (north to south).
 * `ranged`: each layer's line names its x and z range too (a layer narrower than the map's header).
 */
export function drawLayers(options: DrawOptions & { minX: number; maxX: number; minZ: number; maxZ: number; yFrom: number; yTo: number; ranged?: boolean }): string {
  const { minX, maxX, minZ, maxZ } = options;
  const labelWidth = labelWidthFor(minZ, maxZ);
  const lines: string[] = [];
  for (let y = options.yTo; y >= options.yFrom; y--) {
    lines.push(options.ranged ? `y=${y} x=${minX}..${maxX} z=${minZ}..${maxZ}` : `y=${y}`);
    lines.push(columnHeader(minX, maxX, labelWidth, 1));
    for (let z = minZ; z <= maxZ; z++) {
      const row: string[] = [];
      for (let x = minX; x <= maxX; x++) row.push(cellSymbol(options, x, y, z));
      lines.push(`${pad(z, labelWidth)} ${row.join(' ')}`);
    }
  }
  return lines.join('\n');
}

/**
 * The ground from above: for each column the top block from `top` down to `bottom` (air and the open left out, leaves kept)
 * and its standing height against the feet (`heightCode`). Two characters a cell.
 */
export function drawTop(options: DrawOptions & { minX: number; maxX: number; minZ: number; maxZ: number; feetY: number; top: number; bottom: number;
  /** Every `step`th column only (2: a 2 x 2 square as its north-west column), for a wide view. */
  step?: number }): string {
  const { minX, maxX, minZ, maxZ } = options;
  const step = Math.max(1, Math.floor(options.step ?? 1));
  const labelWidth = labelWidthFor(minZ, maxZ);
  const lines: string[] = [columnHeader(minX, maxX, labelWidth, 2, step)];
  for (let z = minZ; z <= maxZ; z += step) {
    const row: string[] = [];
    for (let x = minX; x <= maxX; x += step) {
      if (options.self && options.self.x >= x && options.self.x < x + step && options.self.z >= z && options.self.z < z + step) { row.push('@0'); continue; }
      let found: { y: number; symbol: string } | null = null, unloaded = false;
      for (let y = options.top; y >= options.bottom; y--) {
        const block = options.read(x, y, z);
        if (!block) { unloaded = true; break; }
        const symbol = symbolFor(block);
        if (isOpenSymbol(symbol)) continue;
        found = { y, symbol: options.only && !options.only(block.name, symbol) ? '#' : symbol };
        break;
      }
      if (unloaded && !found) { row.push('??'); continue; }
      if (!found) { row.push('.v'); continue; }
      const standing = `${x},${found.y + 1},${z}`;
      const mark = options.creatures?.get(standing) ?? (options.trail?.has(standing) ? '*' : found.symbol);
      row.push(`${mark}${heightCode(found.y + 1 - options.feetY)}`);
    }
    lines.push(`${pad(z, labelWidth)} ${row.join(' ')}`);
  }
  return lines.join('\n');
}

/**
 * A vertical cut through `center`, top row the highest y: `ew` runs west to east (columns x), `ns` north to south (columns z). Every
 * row starts with its y.
 */
export function drawSlice(options: DrawOptions & { center: Cell; radius: number; yFrom: number; yTo: number; axis: 'ns' | 'ew' }): string {
  const { center, radius } = options;
  const ew = options.axis === 'ew';
  const from = (ew ? center.x : center.z) - radius, to = (ew ? center.x : center.z) + radius;
  const labelWidth = labelWidthFor(options.yFrom, options.yTo);
  const lines: string[] = [columnHeader(from, to, labelWidth, 1, 1, ew ? 'y\\x' : 'y\\z')];
  for (let y = options.yTo; y >= options.yFrom; y--) {
    const row: string[] = [];
    for (let a = from; a <= to; a++) row.push(ew ? cellSymbol(options, a, y, center.z) : cellSymbol(options, center.x, y, a));
    lines.push(`${pad(y, labelWidth)} ${row.join(' ')}`);
  }
  return lines.join('\n');
}

/** One column, top to bottom: "y=52 F furnace" lines, runs of the same block merged ("y=40..44 # stone"). */
export function drawColumn(options: DrawOptions & { x: number; z: number; yFrom: number; yTo: number }): string {
  const runs: Array<{ from: number; to: number; text: string }> = [];
  for (let y = options.yTo; y >= options.yFrom; y--) {
    const block = options.read(options.x, y, options.z);
    const text = options.self && options.self.x === options.x && options.self.y === y && options.self.z === options.z ? '@ 自分'
      : `${symbolFor(block)} ${block ? block.name : '未ロード'}`;
    const last = runs[runs.length - 1];
    if (last && last.text === text) last.to = y; else runs.push({ from: y, to: y, text });
  }
  return runs.map(run => `y=${run.from === run.to ? run.from : `${run.to}..${run.from}`} ${run.text}`).join('\n');
}

const SKY_SCAN = 24;
/** Whether nothing solid but leaves stands over the head for SKY_SCAN blocks (the body is "on the surface"). */
export function underOpenSky(read: BlockReader, feet: Cell): boolean {
  for (let y = feet.y + 2; y <= feet.y + SKY_SCAN; y++) {
    const block = read(feet.x, y, feet.z);
    if (!block) return true;
    const symbol = symbolFor(block);
    if (isOpenSymbol(symbol) || symbol === '%' || symbol === 't' || symbol === 'h') continue;
    return false;
  }
  return true;
}

export interface LocalMapOptions {
  /** Half width of the layers (default 7: 15 x 15). */
  radius?: number;
  /** Half width of the surface grid (default 10: 21 x 21). */
  topRadius?: number;
  /** Force the drawing: layers, surface, or the body's choice (default: surface under the open sky). */
  mode?: 'auto' | 'layers' | 'surface';
  now?: number;
}

/**
 * The decision's map (the contract's format, 3): one header line, then in rock five layers (feet -2..+2, the top first): feet -1..+1
 * at 15 x 15 and feet ±2 at 11 x 11, with up to two more 11 x 11 layers on top where a hostile or a spawner is 3-6 above; under the
 * open sky the surface of 21 x 21 (symbol + height) and the three layers feet -1..+1 at 11 x 11. Last, the feet's column up and down
 * (`縦`). Pure but for `read`.
 *
 *   地図 v1 足=(201,45,277) x=194..208 z=270..284 方式=layers 上=北
 */
export function drawLocalMap(input: { feet: Cell; read: BlockReader; trail?: ReadonlySet<string>; creatures?: ReadonlyMap<string, string> }, options: LocalMapOptions = {}): string {
  const { feet, read } = input;
  const radius = options.radius ?? 7, topRadius = options.topRadius ?? 10;
  const surface = options.mode === 'surface' || (options.mode !== 'layers' && underOpenSky(read, feet));
  const draw: DrawOptions = { read, self: feet, trail: input.trail, creatures: input.creatures };
  const lines: string[] = [];
  const near = Math.min(radius, NEAR_RADIUS);
  const narrow = (yFrom: number, yTo: number) => drawLayers({ ...draw, minX: feet.x - near, maxX: feet.x + near, minZ: feet.z - near, maxZ: feet.z + near,
    yFrom, yTo, ranged: near !== radius });
  if (surface) {
    lines.push(`地図 v1 足=(${feet.x},${feet.y},${feet.z}) x=${feet.x - topRadius}..${feet.x + topRadius} z=${feet.z - topRadius}..${feet.z + topRadius} 方式=surface 上=北`);
    lines.push(drawTop({ ...draw, minX: feet.x - topRadius, maxX: feet.x + topRadius, minZ: feet.z - topRadius, maxZ: feet.z + topRadius,
      feetY: feet.y, top: feet.y + 12, bottom: feet.y - 12 }));
    lines.push(drawLayers({ ...draw, minX: feet.x - near, maxX: feet.x + near, minZ: feet.z - near, maxZ: feet.z + near, yFrom: feet.y - 1, yTo: feet.y + 1 }));
  } else {
    lines.push(`地図 v1 足=(${feet.x},${feet.y},${feet.z}) x=${feet.x - radius}..${feet.x + radius} z=${feet.z - radius}..${feet.z + radius} 方式=layers 上=北`);
    // Above the layers: the height of a hostile or a spawner 3–6 over the feet (run 26: the blazes and their spawner were 3–4 up, off the map).
    const above = threatLayers(read, feet, near, input.creatures);
    if (above) lines.push(narrow(above.from, above.to));
    // Run 25/26 scene replay (2026-10-21): the map was about 2,000 tokens, twice the design; the outer layers (feet ±2) are 11 x 11.
    lines.push(narrow(feet.y + 2, feet.y + 2));
    lines.push(drawLayers({ ...draw, minX: feet.x - radius, maxX: feet.x + radius, minZ: feet.z - radius, maxZ: feet.z + radius, yFrom: feet.y - 1, yTo: feet.y + 1 }));
    lines.push(narrow(feet.y - 2, feet.y - 2));
  }
  lines.push(...columnLines(read, feet));
  return lines.join('\n');
}

/** The half width of the layers away from the feet (feet ±2, and the layers added above): 11 x 11. */
const NEAR_RADIUS = 5;
/** How far the feet's column is told up and down (`縦`), and in how many runs at most. */
const COLUMN_SPAN = 16, COLUMN_RUNS = 4;

/**
 * The layers to add above the map: where a hostile's feet or a spawner is 3 to 6 over her feet within `near` across, the lowest such
 * height and the one over it (at most two layers, at most feet + 6). Null when there is none.
 */
export function threatLayers(read: BlockReader, feet: Cell, near: number, creatures?: ReadonlyMap<string, string>): { from: number; to: number } | null {
  let lowest = Infinity;
  for (const [key, mark] of creatures ?? []) {
    if (mark !== '!') continue;
    const [x, y, z] = key.split(',').map(Number);
    if (Math.abs(x - feet.x) <= near && Math.abs(z - feet.z) <= near && y - feet.y >= 3 && y - feet.y <= 6) lowest = Math.min(lowest, y);
  }
  for (let y = feet.y + 3; y <= feet.y + 6 && y < lowest; y++) {
    for (let x = feet.x - near; x <= feet.x + near && y < lowest; x++) {
      for (let z = feet.z - near; z <= feet.z + near; z++) {
        if (symbolFor(read(x, y, z)) === 'S') { lowest = y; break; }
      }
    }
  }
  if (!Number.isFinite(lowest)) return null;
  return { from: lowest, to: Math.min(lowest + 1, feet.y + 6) };
}

/**
 * The feet's column told up and down (`縦`): from the head's cell up and from the cell under the feet down, runs of the same symbol,
 * at most COLUMN_RUNS runs within COLUMN_SPAN cells (`…` when it goes on). Run 25: the furnace was seven up a shaft the map did not show.
 *
 *   縦 (201,277) 上: y=46〜51 .×6 / y=52 #
 *   縦 (201,277) 下: y=44 # / y=43〜40 .×4 / y=39 w
 */
export function columnLines(read: BlockReader, feet: Cell): string[] {
  const runs = (step: 1 | -1) => {
    const out: Array<{ from: number; to: number; symbol: string }> = [];
    let more = false;
    for (let i = 1; i <= COLUMN_SPAN; i++) {
      const y = step > 0 ? feet.y + i : feet.y - i;
      if (y < -64 || y > 319) break;
      const symbol = symbolFor(read(feet.x, y, feet.z));
      const last = out[out.length - 1];
      if (last && last.symbol === symbol) { last.to = y; continue; }
      if (out.length >= COLUMN_RUNS) { more = true; break; }
      out.push({ from: y, to: y, symbol });
    }
    if (!more && out.length) {
      const next = step > 0 ? out[out.length - 1].to + 1 : out[out.length - 1].to - 1;
      if (next >= -64 && next <= 319 && Math.abs(next - feet.y) > COLUMN_SPAN) more = true;
    }
    const text = out.map(run => run.from === run.to ? `y=${run.from} ${run.symbol}`
      : `y=${run.from}〜${run.to} ${run.symbol}×${Math.abs(run.to - run.from) + 1}`).join(' / ');
    return `${text}${more ? ' …' : ''}`;
  };
  return [`縦 (${feet.x},${feet.z}) 上: ${runs(1)}`, `縦 (${feet.x},${feet.z}) 下: ${runs(-1)}`];
}

// ===== The body's own map =====

/** What the body keeps for its map: the cells it walked, where its steps stopped, and the last drawing. */
interface MapMemory {
  walked: Map<string, number>;
  lastCell: string | null;
  stops: Map<string, MapStop>;
  /** A block changed near the body since the last drawing (a dig, a placement, a flow). */
  dirty: boolean;
  /** `key`: the feet, the mode and the dimension; `crowd`: the creatures' cells. They are told apart because a creature alone may redraw the map only once a second. */
  cache?: { key: string; crowd: string; at: number; text: string };
}
export interface MapStop {
  /** What stopped: the step's kind (walk, dig, place ...). */
  kind: string;
  from?: Cell;
  at: Cell;
  /** The reason in the contract's closed words (一歩ではない, 届かない ...). */
  reason: string;
  count: number;
  firstAt: number;
  lastAt: number;
}
const memories = new WeakMap<object, MapMemory>();
const TRAIL_MS = 60_000;
const TRAIL_MAX = 400;
const STOP_MS = 300_000;
const STOPS_SHOWN = 5;
/** Block changes within this many blocks of the feet make the next frame draw the map again. */
const DIRTY_RANGE = 12;

interface MapBody {
  entity?: { position?: Vec3; yaw?: number; onGround?: boolean } | null;
  entities?: Record<string, any>;
  blockAt?(position: Vec3, extraInfos?: boolean): any;
  on?(event: string, listener: (...args: any[]) => void): unknown;
  game?: { dimension?: unknown };
  registry?: any;
  [key: string]: any;
}

/** The body's map memory, made (and its trail and block watch started) on first use. Keyed by the native bot, also through a motor port. */
export function mapMemoryOf(bot: MapBody): MapMemory {
  const host = nativeActionHost(bot as object);
  let memory = memories.get(host);
  if (memory) return memory;
  const made: MapMemory = memory = { walked: new Map(), lastCell: null, stops: new Map(), dirty: true };
  memories.set(host, made);
  const record = () => {
    const position = bot.entity?.position;
    if (!position) return;
    const key = `${Math.floor(position.x)},${Math.floor(position.y + 1e-3)},${Math.floor(position.z)}`;
    if (key === made.lastCell) return;
    made.lastCell = key;
    made.walked.delete(key);
    made.walked.set(key, Date.now());
    if (made.walked.size > TRAIL_MAX) made.walked.delete(made.walked.keys().next().value as string);
  };
  const changed = (_old: unknown, block: { position?: Vec3 } | null) => {
    const at = bot.entity?.position, where = block?.position;
    if (!at || !where || Math.abs(where.x - at.x) > DIRTY_RANGE || Math.abs(where.z - at.z) > DIRTY_RANGE || Math.abs(where.y - at.y) > DIRTY_RANGE) return;
    made.dirty = true;
  };
  try { bot.on?.('physicsTick', () => { try { record(); } catch { /* a map must not stop the body */ } }); } catch { /* a probe body */ }
  try { bot.on?.('blockUpdate', (old: unknown, block: { position?: Vec3 } | null) => { try { changed(old, block); } catch { /* the same */ } }); } catch { /* a probe body */ }
  try { bot.on?.('respawn', () => { made.walked.clear(); made.lastCell = null; made.dirty = true; }); } catch { /* a probe body */ }
  // Run 47 (hold 8): after a restart and a login the first drawing came before the chunks did and stayed (all "?"): the chunks arriving, and a new login or spawn, draw it again.
  for (const event of ['chunkColumnLoad', 'chunkColumnUnload', 'spawn', 'login']) { try { bot.on?.(event, () => { made.dirty = true; made.cache = undefined; }); } catch { /* a probe body */ } }
  return made;
}

/** The cells walked in the last minute. */
export function walkedCells(bot: MapBody, now = Date.now()): Set<string> {
  const memory = mapMemoryOf(bot);
  const cells = new Set<string>();
  for (const [key, at] of memory.walked) {
    if (now - at > TRAIL_MS) memory.walked.delete(key); else cells.add(key);
  }
  return cells;
}

/** A step that stopped: counted per kind, place and reason (the body counts; whether to give up is the planner's). */
export function noteMapStop(bot: MapBody, stop: { kind: string; from?: Cell; at: Cell; reason: string }, now = Date.now()): MapStop {
  const memory = mapMemoryOf(bot);
  const key = `${stop.kind}|${stop.from ? cellKey(stop.from) : ''}|${cellKey(stop.at)}|${stop.reason}`;
  const entry = memory.stops.get(key) ?? { kind: stop.kind, from: stop.from, at: stop.at, reason: stop.reason, count: 0, firstAt: now, lastAt: now };
  entry.count++; entry.lastAt = now;
  memory.stops.delete(key); memory.stops.set(key, entry);
  for (const [other, value] of memory.stops) if (now - value.lastAt > STOP_MS) memory.stops.delete(other);
  return entry;
}

/** The recent stops, newest first, in the contract's form: "(201,45,277)→(201,48,277) 一歩ではない ×7 23秒前". */
export function recentStopLines(bot: MapBody, now = Date.now(), limit = STOPS_SHOWN): string[] {
  const memory = mapMemoryOf(bot);
  return [...memory.stops.values()].filter(stop => now - stop.lastAt <= STOP_MS).sort((a, b) => b.lastAt - a.lastAt).slice(0, limit)
    .map(stop => `${stop.from ? `(${cellKey(stop.from)})→` : ''}(${cellKey(stop.at)}) ${stop.reason}${stop.count > 1 ? ` ×${stop.count}` : ''} ${Math.round((now - stop.lastAt) / 1000)}秒前`);
}

/** A cell through `bot.blockAt`, as the drawer needs it: null for a cell not loaded. One Block (with light, biome, shapes) is built per call. */
function blockAtReader(bot: MapBody): BlockReader {
  return (x, y, z) => {
    let block: any;
    try { block = bot.blockAt?.(new Vec3(x, y, z), false); } catch { block = null; }
    if (!block) return null;
    const name = String(block.name);
    const out: MapBlock = { name, solid: block.boundingBox === 'block' };
    if (out.solid) { const top = topOfShapes(block.shapes); if (top !== undefined && top !== 1) out.top = top; }
    if (DOORLIKE.test(name)) {
      try { const open = block.getProperties?.()?.open; out.open = open === true || open === 'true'; } catch { out.open = false; }
      if (out.open) { const plates = platesOfShapes(block.shapes); if (plates) out.plates = plates; }
    }
    if (name === 'water' || name === 'lava' || name === 'end_portal_frame') {
      try {
        const properties = block.getProperties?.() ?? {};
        if (name === 'end_portal_frame') out.eye = properties.eye === true || properties.eye === 'true';
        else out.level = Number(properties.level ?? block.metadata ?? 0);
      } catch { out.level = Number(block.metadata ?? 0); }
    }
    return out;
  };
}

/** The top of a collision box's shapes (their highest y), or undefined when there are none. */
/** The edges (w, e, n, s) of a cell that a thin box of the shapes (half a block or less, along a whole edge) stands on. Empty string: none. */
export function platesOfShapes(shapes: unknown): string {
  if (!Array.isArray(shapes)) return '';
  let out = '';
  const add = (letter: string) => { if (!out.includes(letter)) out += letter; };
  for (const box of shapes) {
    if (!Array.isArray(box)) continue;
    const [x0 = 0, , z0 = 0, x1 = 0, , z1 = 0] = box as number[];
    if (z1 - z0 >= 0.9) { if (x0 <= 0.01 && x1 - x0 <= 0.5) add('w'); if (x1 >= 0.99 && x1 - x0 <= 0.5) add('e'); }
    if (x1 - x0 >= 0.9) { if (z0 <= 0.01 && z1 - z0 <= 0.5) add('n'); if (z1 >= 0.99 && z1 - z0 <= 0.5) add('s'); }
  }
  return out;
}
function topOfShapes(shapes: unknown): number | undefined {
  if (!Array.isArray(shapes) || !shapes.length) return undefined;
  let top = -Infinity;
  for (const shape of shapes) if (Array.isArray(shape) && Number.isFinite(shape[4])) top = Math.max(top, shape[4]);
  return Number.isFinite(top) ? top : undefined;
}
/** The same for a block state from the registry's collision shapes (what prismarine-block reads for a Block), without making a Block. */
function stateTop(registry: any, definition: any, stateId: number): number | undefined {
  try {
    const table = registry?.blockCollisionShapes;
    const id = table?.blocks?.[definition.name];
    if (id === undefined) return undefined;
    const shapeId = Array.isArray(id) ? id[stateId - (definition.minStateId ?? stateId)] ?? id[0] : id;
    return topOfShapes(table.shapes?.[shapeId]);
  } catch { return undefined; }
}

/** What the map knows of each block state, by state id (a state fixes the name, the box, a fluid's level, a frame's eye): one MapBlock shared by every cell of it. Per registry. */
const stateBlocks = new WeakMap<object, Map<number, MapBlock>>();

/**
 * The same reader over the world's chunks directly (run 27: 110-685 GCs a minute, up to 2.2 s; `bot.blockAt` built a Block, its light, its
 * biome and a Vec3 for each of ~1,000 to ~6,000 cells a draw, 7 MB). It asks the chunk column for the cell's state id with one reused
 * Vec3, and shares one MapBlock (with its symbol) per state id. A fluid or an end portal frame, whose level and eye are in the state, is
 * read through `blockAt` once per state id, as before. Null when the body has no world to read like this (a probe, a test).
 */
function stateIdReader(bot: MapBody, fallback: BlockReader): BlockReader | null {
  const world = bot.world, registry = bot.registry;
  if (!world || typeof world.getColumn !== 'function' || !registry?.blocksByStateId) return null;
  let known = stateBlocks.get(registry);
  if (!known) { known = new Map(); stateBlocks.set(registry, known); }
  const states = known;
  const inChunk = new Vec3(0, 0, 0);
  let column: any = null, columnX = Number.NaN, columnZ = Number.NaN;
  return (x, y, z) => {
    const cx = x >> 4, cz = z >> 4;
    if (cx !== columnX || cz !== columnZ) {
      try { column = world.getColumn(cx, cz); } catch { column = null; }
      columnX = cx; columnZ = cz;
    }
    if (!column) return null;
    inChunk.x = x & 15; inChunk.y = y; inChunk.z = z & 15;
    let stateId: number;
    try { stateId = column.getBlockStateId(inChunk); } catch { return fallback(x, y, z); }
    const hit = states.get(stateId);
    if (hit) return hit;
    const definition = registry.blocksByStateId[stateId];
    if (!definition) return fallback(x, y, z);
    const name = String(definition.name);
    // The fluids and the frame carry their level / eye in the state: read the way it always was, once.
    const made: MapBlock | null = name === 'water' || name === 'lava' || name === 'end_portal_frame' || DOORLIKE.test(name) ? fallback(x, y, z) : { name, solid: definition.boundingBox === 'block' };
    if (!made) return null;
    if (made.solid && made.top === undefined) { const top = stateTop(registry, definition, stateId); if (top !== undefined && top !== 1) made.top = top; }
    made.symbol = symbolFor(made);
    states.set(stateId, made);
    return made;
  };
}

/** A reader over a live body: null for a cell not loaded. */
export function bodyReader(bot: MapBody): BlockReader {
  const slow = blockAtReader(bot);
  return stateIdReader(bot, slow) ?? slow;
}

const ANIMAL_TYPES = new Set(['animal', 'passive', 'water_creature', 'ambient', 'water_ambient', 'axolotls', 'underground_water_creature']);
/** The creatures' feet cells within `range` of the feet: `!` a hostile, `m` an animal (players and items are not drawn). */
export function creatureCells(bot: MapBody, range = 12): Map<string, string> {
  const at = bot.entity?.position, cells = new Map<string, string>();
  if (!at) return cells;
  for (const entity of Object.values(bot.entities ?? {}) as any[]) {
    if (!entity?.position || entity === bot.entity || entity.type === 'player' || entity.name === 'item' || entity.name === 'experience_orb') continue;
    if (Math.abs(entity.position.x - at.x) > range || Math.abs(entity.position.z - at.z) > range || Math.abs(entity.position.y - at.y) > range) continue;
    const name = String(entity.name ?? '');
    const type = String(bot.registry?.entitiesByName?.[name]?.type ?? entity.type ?? '');
    const mark = type === 'hostile' || isLikelyHostileMobName(name) ? '!' : ANIMAL_TYPES.has(type) ? 'm' : null;
    if (!mark) continue;
    const key = `${Math.floor(entity.position.x)},${Math.floor(entity.position.y + 1e-3)},${Math.floor(entity.position.z)}`;
    if (cells.get(key) !== '!') cells.set(key, mark);
  }
  return cells;
}

/**
 * The feet cell of a body: the cell it stands in. r7 (runs 30, 31: walks in the fortress): on a block lower than a full one (a slab, a
 * stair's step, soul sand, farmland, a path, a chest, a carpet) the position is inside that block's own cell (y 64.5 on a slab at 64), and
 * the feet cell was taken as the slab's: the walk's start, probe path's start and "under the feet" were a cell too low, and a walk to the
 * cell on the slab was "not arrived" while the body stood there. The route search (mineflayer-pathfinder) takes the cell above such a block
 * for a body on the ground; so does this. In the air nothing changes.
 */
export function feetCell(bot: MapBody): Cell | null {
  const position = bot.entity?.position;
  if (!position) return null;
  const x = Math.floor(position.x), z = Math.floor(position.z);
  let y = Math.floor(position.y + 1e-3);
  if (position.y - y > 1e-3 && bot.entity?.onGround !== false && typeof bot.blockAt === 'function') {
    let block: any = null;
    try { block = bot.blockAt(new Vec3(x, y, z), false); } catch { block = null; }
    if (block?.boundingBox === 'block') y++;
  }
  return { x, y, z };
}

/**
 * The shortest time between two drawings of the map when only the blocks or the creatures changed (the contract: at most every 500 ms).
 * mb-llmc-cand: the feet moving to another cell draws it at once: a map kept for 500 ms put `@` up to two cells (sprinting) behind the
 * `position` and the marks' ways of the same frame, which are told from the feet of the moment.
 */
const MAP_MIN_MS = 500;
/** What the map is while the chunks round the body have not come (after a login): not a drawing of unknown cells. */
export const MAP_PENDING = '地図はまだ作り中（周りのチャンクを読み込み中）。view で周りを見るか、少し待ってから';
/** ... and when only the creatures moved (the feet, the blocks and the dimension are as drawn), at most every second: they move all the time. */
const CREATURE_MIN_MS = 1000;

/**
 * The decision's map for a live body. Drawn again at once when the feet moved to another cell; when a block changed near it, or the
 * creatures moved to other cells, at most every MAP_MIN_MS (every CREATURE_MIN_MS when only creatures moved); else the last drawing.
 * Null without a body.
 */
export function localMapFor(bot: MapBody, options: LocalMapOptions & { fresh?: boolean } = {}): string | null {
  const feet = feetCell(bot);
  if (!feet) return null;
  const memory = mapMemoryOf(bot);
  const now = options.now ?? Date.now();
  const cached = memory.cache;
  const key = `${cellKey(feet)}|${options.mode ?? 'auto'}|${String(bot.game?.dimension ?? '')}`;
  // Inside MAP_MIN_MS nothing else is looked at (the frame asks for the map several times a second): the feet on the cell drawn, the same mode.
  if (!options.fresh && cached && cached.key === key && now - cached.at < MAP_MIN_MS) return cached.text;
  const creatures = creatureCells(bot);
  const crowd = [...creatures].map(([cell, mark]) => `${cell}${mark}`).sort().join(';');
  if (!options.fresh && cached && cached.key === key && !memory.dirty && (cached.crowd === crowd || now - cached.at < CREATURE_MIN_MS)) return cached.text;
  // Run 47 (hold 8): a body that has no block yet round its feet (the chunks have not come) has no map to give: said as such, and not kept.
  const reader = bodyReader(bot);
  if (!reader(feet.x, feet.y, feet.z) && !reader(feet.x, feet.y - 1, feet.z)) { memory.dirty = true; memory.cache = undefined; return MAP_PENDING; }
  const text = drawLocalMap({ feet, read: reader, trail: walkedCells(bot, now), creatures }, options);
  memory.cache = { key, crowd, at: now, text };
  memory.dirty = false;
  return text;
}
