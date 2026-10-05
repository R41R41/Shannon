import fs from 'fs';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { CONFIG } from '../config/MinebotConfig.js';
import { actionDelay } from '../execution/observedWait.js';

const log = createLogger('Minebot:Skill:buildAroundSelf');

/**
 * A plan of something built round the body from where it stands.
 *
 * `layers[layer][row]` is a row of cells along the columns, as in the plans `build-structure` reads; `anchor`
 * names the cell the body's feet are in. What a letter stands for is in `materials`: a block's name, or
 *   `@solid`     any whole building block carried (what is already a whole block there is left as it is),
 *   `@slab:top`  any slab carried, in the upper half of the cell,
 *   `@air`       nothing: what stands there is dug away,
 *   `@keep`      whatever is there.
 * `phases` gives the order letters are built in (lower first): a plan that is to close the body in at once
 * puts the few blocks that do so in its first phases. `then` names what a letter's cells become at the very
 * end, in place of what was first put there (the one whole block the first piece of roof stood on, turned into
 * a slab like the rest). It is kept to the fewest cells a plan can do with: taking a block out of its own wall
 * is slow without the tool for it and is refused while something hostile has a line through the gap, and a
 * cell left as it was first built costs only what it was meant to give. `landmark` names a cell that has to
 * hold a given block: the plan is turned about the body until it does, so that the same plan serves whichever
 * side of that block the body stands on.
 */
export interface AroundBlueprint {
  name: string;
  description: string;
  materials: Record<string, string>;
  phases?: Record<string, number>;
  then?: Record<string, string>;
  anchor: [number, number, number];
  landmark?: { char: string; block: string };
  layers: string[][];
  /** Said to the planner when the build is complete: what the thing is for and how it is used. */
  usage?: string;
}

/** The last thing built round the body (see utils/builtAround): where, and how much of it is not standing now. */
export interface BuiltAround { name: string; centre: Vec3; total: number; missing: () => number }

interface Cell { pos: Vec3; spec: string; phase: number; /** What this cell is to be in the end, when this entry is only what stands there first. */ becomes?: string }

/** Whole blocks a wall can be made of, in the order they are spent (what burns or falls last, or not at all). */
export const BUILDING_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'blackstone',
  'tuff', 'basalt', 'nether_bricks', 'stone_bricks', 'end_stone', 'dirt', 'netherrack'];
const REACH = 4.5;
/**
 * The cell the feet are in. A body on soul sand or mud stands at .875 of a block: floored, its feet were put in
 * the soul sand, the plan was laid one cell low and its lid went where the head was (lab, the soul sand edge
 * of the L77 fortress).
 */
export const feetCell = (position: Vec3) => new Vec3(Math.floor(position.x), Math.floor(position.y + 0.25), Math.floor(position.z));
const opensOnUse = (name: string) => PROTECTED_UTILITY_BLOCKS.has(name) || /_(door|trapdoor|fence_gate|button)$/.test(name) || name === 'lever';
/** The least time between two blocks put down (about seven a second). */
const PLACE_INTERVAL_MS = 150;
/** How far round the feet a landmark is looked for when the body is not yet beside it. */
const LANDMARK_SEARCH = 4;
/** How high a block has to stand in its cell to do as a wall or a floor (soul sand and mud: 0.875). */
const NEARLY_WHOLE = 0.8;
const SIDES: Array<[number, number, number]> = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];

/** The plan's cells in the world, for a body whose feet are at `feet`, turned a quarter `turns` times about it. */
export function cellsOf(plan: AroundBlueprint, feet: Vec3, turns: number): Cell[] {
  const [anchorCol, anchorLayer, anchorRow] = plan.anchor;
  const cells: Cell[] = [];
  plan.layers.forEach((layer, layerIndex) => layer.forEach((row, rowIndex) => [...row].forEach((char, colIndex) => {
    const spec = plan.materials[char];
    if (char === '.' || !spec) return;
    let dx = colIndex - anchorCol, dz = rowIndex - anchorRow;
    for (let turn = 0; turn < ((turns % 4) + 4) % 4; turn++) [dx, dz] = [-dz, dx];
    const pos = feet.offset(dx, layerIndex - anchorLayer, dz);
    const last = plan.then?.[char];
    cells.push({ pos, spec, phase: plan.phases?.[char] ?? 0, ...(last ? { becomes: last } : {}) });
    if (last) cells.push({ pos, spec: last, phase: Number.MAX_SAFE_INTEGER });
  })));
  return cells;
}

/** The quarter turn that puts the plan's landmark cell on a block of the landmark's kind, or null when none does. */
export function turnsForLandmark(plan: AroundBlueprint, feet: Vec3, nameAt: (pos: Vec3) => string | null): number | null {
  if (!plan.landmark) return 0;
  const [anchorCol, anchorLayer, anchorRow] = plan.anchor;
  for (let turns = 0; turns < 4; turns++) {
    let found = false, wrong = false;
    plan.layers.forEach((layer, layerIndex) => layer.forEach((row, rowIndex) => [...row].forEach((char, colIndex) => {
      if (char !== plan.landmark!.char) return;
      let dx = colIndex - anchorCol, dz = rowIndex - anchorRow;
      for (let turn = 0; turn < turns; turn++) [dx, dz] = [-dz, dx];
      if (nameAt(feet.offset(dx, layerIndex - anchorLayer, dz)) === plan.landmark!.block) found = true; else wrong = true;
    })));
    if (found && !wrong) return turns;
  }
  return null;
}

/**
 * Building a cover round the body from where it stands.
 *
 * The body could dig itself a shaft and close it, and could put up a structure from a plan by walking round
 * it. It could not do what a person under fire does: stay on the spot and wall themselves in, with the walls
 * where they want them. A plan says what goes where round the body; this puts it there, far and low before
 * near and high as the plan orders, each block against one already standing, without a step taken. What the
 * plans are for is not this skill's to know: they are files (saves/minecraft/structures), like the portal's.
 */
class BuildAroundSelf extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'build-around-self';
    this.description = '登録された設計を、いま立っている場所を中心に、その場から動かずに建てます（自分を囲う囲い・陣地）。slit_shelter はどこででも建てられる1マスの囲い（約16個、数秒。外から狙われず、隙間から隣の相手を殴れる）。'
      + '設計によっては特定のブロックの隣に立って呼ぶ必要があります（slit_cage はスポナーの隣・同じ高さ）。途中で中断されても、もう一度呼べば続きから建てます。'
      + '材料は持っている建築用ブロック（丸石など）と、設計が求めるハーフブロックなど';
    this.params = [
      { name: 'structureName', type: 'string', description: '設計の名前（例: slit_cage）。分からない名前を渡すと一覧を返します', required: true },
    ];
    this.maxDurationMs = 300_000;
  }

  private load(name: string): AroundBlueprint | null {
    try {
      const plan = JSON.parse(fs.readFileSync(`${CONFIG.STRUCTURES_DIR}/${name}.json`, 'utf-8')) as AroundBlueprint;
      return Array.isArray(plan.anchor) && Array.isArray(plan.layers) ? plan : null;
    } catch { return null; }
  }

  private available(): string[] {
    try {
      return fs.readdirSync(CONFIG.STRUCTURES_DIR).filter(file => file.endsWith('.json')).map(file => file.replace('.json', ''))
        .filter(name => this.load(name) !== null);
    } catch { return []; }
  }

  /** The nearest free cell beside a landmark within a few blocks of the feet, level with it: room for the body, ground under it. */
  private cellBesideLandmark(block: string, feet: Vec3): Vec3 | null {
    const free = (pos: Vec3) => this.bot.blockAt(pos)?.boundingBox === 'empty';
    let best: Vec3 | null = null;
    for (let dx = -LANDMARK_SEARCH; dx <= LANDMARK_SEARCH; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -LANDMARK_SEARCH; dz <= LANDMARK_SEARCH; dz++) {
      const at = feet.offset(dx, dy, dz);
      if (this.bot.blockAt(at)?.name !== block) continue;
      for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cell = at.offset(sx, 0, sz);
        if (!free(cell) || !free(cell.offset(0, 1, 0)) || this.bot.blockAt(cell.offset(0, -1, 0))?.boundingBox !== 'block') continue;
        if (!best || cell.distanceTo(feet) < best.distanceTo(feet)) best = cell;
      }
    }
    return best;
  }

  /** The plans that ask for nothing to be standing beside the body: they can be built wherever it is. */
  private anywhere(): string[] { return this.available().filter(name => !this.load(name)?.landmark); }

  /**
   * A block that does as a wall or a floor: one box over the whole cell from its foot to most of its height.
   * Soul sand and mud stand 14/16 high; taken for "not a whole block", every cell of soul sand in the plan was
   * dug out to be filled again, and a shelter on a soul sand valley's edge took 34 seconds to build nine cells
   * of (paid run L77v, under blaze fire). A fence or a slab is not one.
   */
  private whole(block: any): boolean {
    if (!block || block.boundingBox !== 'block') return false;
    const shapes = block.shapes;
    if (!Array.isArray(shapes)) return true;
    return shapes.length === 1 && shapes[0][0] === 0 && shapes[0][1] === 0 && shapes[0][2] === 0 && shapes[0][3] === 1
      && shapes[0][4] >= NEARLY_WHOLE && shapes[0][5] === 1;
  }

  /** Whether the cell holds what the plan wants there, read through `at` (by default the body this run moves). */
  private done(cell: Cell, at: (pos: Vec3) => any = pos => this.bot.blockAt(pos)): boolean {
    const block: any = at(cell.pos);
    if (cell.becomes && this.done({ pos: cell.pos, spec: cell.becomes, phase: cell.phase }, at)) return true;
    if (cell.spec === '@keep') return true;
    if (!block) return false;
    if (cell.spec === '@air') return block.boundingBox === 'empty';
    if (cell.spec === '@solid') return this.whole(block);
    if (cell.spec === '@slab:top') {
      return String(block.name).endsWith('_slab') && (block.getProperties?.().type === 'top' || block.shapes?.[0]?.[1] === 0.5);
    }
    return block.name === cell.spec;
  }

  private itemFor(spec: string): any | null {
    const items = this.bot.inventory.items();
    if (spec === '@solid') {
      for (const name of BUILDING_BLOCKS) { const item = items.find(entry => entry.name === name); if (item) return item; }
      return null;
    }
    if (spec === '@slab:top') return items.find(entry => entry.name.endsWith('_slab')) ?? null;
    return items.find(entry => entry.name === spec) ?? null;
  }

  private carried(spec: string): number {
    const items = this.bot.inventory.items();
    const matches = spec === '@solid' ? (name: string) => BUILDING_BLOCKS.includes(name) : spec === '@slab:top' ? (name: string) => name.endsWith('_slab') : (name: string) => name === spec;
    return items.filter(item => matches(item.name)).reduce((sum, item) => sum + item.count, 0);
  }

  private inBody(pos: Vec3): boolean {
    const at = this.bot.entity.position;
    const feet = feetCell(at);
    return pos.x === feet.x && pos.z === feet.z && (pos.y === feet.y || pos.y === feet.y + 1);
  }

  /** A block already standing to put this one against, and the face of it; for a slab, the block above first. */
  private reference(cell: Cell): { block: any; face: Vec3 } | null {
    const eyes = this.bot.entity.position.offset(0, 1.62, 0);
    const order = cell.spec === '@slab:top' ? [SIDES[5], ...SIDES.slice(1, 5), SIDES[0]] : SIDES;
    for (const [dx, dy, dz] of order) {
      const beside = cell.pos.offset(dx, dy, dz);
      if (this.inBody(beside)) continue;
      const block: any = this.bot.blockAt(beside);
      if (!block || block.boundingBox !== 'block') continue;
      // A click on a crafting table, a chest or a door opens it and places nothing (a shelter beside the crafting
      // table a planner had just set down could not close its last side).
      if (opensOnUse(String(block.name))) continue;
      const face = new Vec3(-dx, -dy, -dz);
      if (beside.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5).distanceTo(eyes) > REACH) continue;
      return { block, face };
    }
    return null;
  }

  /**
   * The cell the body is held up by. Standing at a drop, its middle can be over the open side while the edge
   * block still carries it: that column was taken for its own, the body was walked towards the middle of it,
   * the edge reflex stopped it every few seconds, and a shelter took 26 seconds for three cells (paid run L77z,
   * a 19-block drop). Of the columns its feet cover, the one with ground under it is the body's.
   */
  private standingCell(): Vec3 {
    const position = this.bot.entity.position;
    const feet = feetCell(position);
    const grounded = (cell: Vec3) => this.bot.blockAt(cell.offset(0, -1, 0))?.boundingBox === 'block';
    if (grounded(feet)) return feet;
    const covered: Vec3[] = [];
    for (const dx of [-0.3, 0.3]) for (const dz of [-0.3, 0.3]) {
      const cell = new Vec3(Math.floor(position.x + dx), feet.y, Math.floor(position.z + dz));
      if (!covered.some(other => other.equals(cell))) covered.push(cell);
    }
    const held = covered.filter(grounded).sort((a, b) => a.offset(0.5, 0, 0.5).distanceTo(position) - b.offset(0.5, 0, 0.5).distanceTo(position));
    return held[0] ?? feet;
  }

  /** Into the middle of the cell it builds round (by default the one it stands on): a step, by its own keys. */
  private async centre(cell: Vec3 = this.anchor ?? this.standingCell()): Promise<void> {
    if (typeof (this.bot as any).setControlState !== 'function') return;
    const deadline = Date.now() + 1500;
    try {
      while (Date.now() < deadline && !this.shouldInterrupt()) {
        const at = this.bot.entity.position;
        const gap = Math.hypot(cell.x + 0.5 - at.x, cell.z + 0.5 - at.z);
        if (gap <= 0.12) break;
        await this.bot.look(Math.atan2(-(cell.x + 0.5 - at.x), -(cell.z + 0.5 - at.z)), 0, true);
        this.bot.setControlState('forward', true);
        await actionDelay(this.bot, 50);
      }
    } finally { this.bot.setControlState('forward', false); }
  }

  private async clear(pos: Vec3): Promise<boolean> {
    const dig: any = this.bot.instantSkills.getSkill('dig-block-at');
    if (!dig) return false;
    try { await dig.run(pos.x, pos.y, pos.z, false); } catch { /* seen below */ }
    return this.bot.blockAt(pos)?.boundingBox === 'empty';
  }

  /** The cell the plan is built round. A blow can throw the body out of it, and nothing is placed from anywhere else. */
  private anchor: Vec3 | null = null;
  private lastPlacedAt = 0;

  private async backToAnchor(): Promise<boolean> {
    const anchor = this.anchor;
    if (!anchor) return true;
    const here = () => this.standingCell();
    if (!here().equals(anchor)) {
      const deadline = Date.now() + 4000;
      // Straight back by its own keys: it is a step or two, and a route would dig through what has just been built.
      while (Date.now() < deadline && !this.shouldInterrupt() && !here().equals(anchor)) {
        const at = this.bot.entity.position;
        await this.bot.look(Math.atan2(-(anchor.x + 0.5 - at.x), -(anchor.z + 0.5 - at.z)), 0, true);
        this.bot.setControlState('forward', true);
        this.bot.setControlState('jump', at.y < anchor.y - 0.1);
        await actionDelay(this.bot, 50);
      }
      this.bot.setControlState('forward', false);
      this.bot.setControlState('jump', false);
      if (!here().equals(anchor)) return false;
    }
    await this.centre();
    return true;
  }

  private async place(cell: Cell): Promise<boolean> {
    if (!(await this.backToAnchor())) return false;
    const existing: any = this.bot.blockAt(cell.pos);
    // Something that is not what is wanted and is in the way (a fence, a slab the wrong way up) comes out first.
    if (existing && existing.boundingBox !== 'empty' && !(await this.clear(cell.pos))) return false;
    const item = this.itemFor(cell.spec);
    const reference = this.reference(cell);
    if (!item || !reference) return false;
    try {
      await this.bot.equip(item, 'hand');
      // No faster than a quick hand: with the look turned at once the server took fourteen blocks in 0.7 seconds,
      // which no player places.
      const since = Date.now() - this.lastPlacedAt;
      if (since < PLACE_INTERVAL_MS) await actionDelay(this.bot, PLACE_INTERVAL_MS - since);
      this.lastPlacedAt = Date.now();
      const top = cell.spec === '@slab:top' && reference.face.y === 0;
      // The look is turned at once: a turn made over several ticks was most of the half second each block took,
      // and a body walling itself in has what it is hiding from on its way.
      await (this.bot as any)._placeBlockWithOptions(reference.block, reference.face, top ? { half: 'top', swingArm: 'right', forceLook: true } : { swingArm: 'right', forceLook: true });
    } catch { /* judged by what stands there */ }
    for (const deadline = Date.now() + 800; Date.now() < deadline && !this.done(cell);) await actionDelay(this.bot, 50);
    return this.done(cell);
  }

  async runImpl(structureName: string) {
    const plan = this.load(String(structureName ?? ''));
    if (!plan) {
      return { success: false, result: `設計「${structureName}」はありません。その場で建てられる設計: ${this.available().join('、') || 'なし'}`, failureType: 'invalid_input', recoverable: true };
    }
    for (const deadline = Date.now() + 2500; Date.now() < deadline && !this.bot.entity?.onGround;) await actionDelay(this.bot, 50);
    if (!this.bot.entity?.onGround) return { success: false, result: '足が地面に着いていません。立ってから呼んでください', failureType: 'not_ready', recoverable: true };
    this.anchor = null;
    let feet = this.standingCell();
    await this.centre(feet);
    // A body that has walked up to the landmark stands a step or two off the cell beside it ("1.4m" short, paid
    // run L77w), and was sent back to the planner for that while blazes were on it: ten seconds, and it died.
    // The step is taken here.
    if (plan.landmark && turnsForLandmark(plan, feet, pos => this.bot.blockAt(pos)?.name ?? null) === null) {
      const beside = this.cellBesideLandmark(plan.landmark.block, feet);
      if (beside) {
        try { await this.bot.instantSkills.getSkill('move-to')?.run(beside.x + 0.5, beside.y, beside.z + 0.5, 0, 'near'); } catch { /* judged by where it stands */ }
        feet = this.standingCell();
        await this.centre(feet);
      }
    }
    this.anchor = feet;
    const turns = turnsForLandmark(plan, feet, pos => this.bot.blockAt(pos)?.name ?? null);
    if (turns === null) {
      return { success: false, failureType: 'invalid_location', recoverable: true,
        result: `${plan.name} は、${plan.landmark!.block} の隣（東西南北のどれか、足が ${plan.landmark!.block} と同じ高さ）に立って呼ぶ設計です。いま隣に ${plan.landmark!.block} がありません。`
          + `recall-places や find-blocks で ${plan.landmark!.block} の位置を確かめ、その隣のマスへ move-to してから呼んでください。`
          + (this.anywhere().length ? `いまいる場所で身を守るなら、どこでも建てられる設計: ${this.anywhere().join('、')}` : '') };
    }
    // What the body stands on is a floor already, whatever its shape (fortress stairs, a slab): dug out to be
    // replaced, it would drop the body out of the plan.
    const cells = cellsOf(plan, feet, turns).filter(cell => !this.inBody(cell.pos) && !cell.pos.equals(feet.offset(0, -1, 0)));
    const total = cells.filter(cell => !cell.becomes).length;
    const lacking = ['@solid', '@slab:top', ...new Set(cells.map(cell => cell.spec).filter(spec => !spec.startsWith('@')))].map(spec => {
      const need = cells.filter(cell => cell.spec === spec && !this.done(cell)).length;   // what stands first and what it becomes are both carried
      return { spec, need, have: this.carried(spec) };
    }).filter(entry => entry.need > entry.have);
    if (lacking.length) {
      const say = (spec: string) => spec === '@solid' ? `建築用ブロック（${BUILDING_BLOCKS.slice(0, 5).join('・')} など）` : spec === '@slab:top' ? 'ハーフブロック（例: 丸石3個を作業台で横に並べて cobblestone_slab 6個）' : spec;
      return { success: false, failureType: 'missing_item', recoverable: true,
        result: `${plan.name} の材料が足りません: ${lacking.map(entry => `${say(entry.spec)} ${entry.have}/${entry.need}個`).join('、')}` };
    }
    // What was built, kept with the body: the planner is told while near it whether it still stands whole. A
    // pickup that dug through the cage's inner wall for a rod left it open on one side; the body did not know,
    // and an emergency a minute later had it chase a blaze out through the gap instead of closing it (paid run
    // L77aa).
    const kept = cells.filter(cell => !cell.becomes && cell.spec !== '@air' && cell.spec !== '@keep');
    // Read later through the body itself: the port this run moves it by is gone when the run is.
    const root = this.rootBot;
    (root as any).builtAround = {
      name: plan.name, centre: feet.clone(), total: kept.length,
      missing: () => kept.filter(cell => !this.done(cell, pos => root.blockAt(pos))).length,
    } satisfies BuiltAround;
    log.info(`🧱 ${plan.name} をその場で建て始める（${total}マス、うち未完了${cells.filter(cell => !cell.becomes && !this.done(cell)).length}）`);
    const failed = new Map<string, number>();
    const key = (cell: Cell) => `${cell.pos.x},${cell.pos.y},${cell.pos.z}`;
    // The phases in order, and then once more over all of them: a cell with nothing to put it against when its
    // turn came (a crafting table below, open air beside) may have something now that the rest stands.
    const phases = [...new Set(cells.map(cell => cell.phase))].sort((a, b) => a - b);
    for (const phase of [...phases, null]) {
      for (;;) {
        if (this.shouldInterrupt()) break;
        const open = cells.filter(cell => (phase === null || cell.phase === phase) && !this.done(cell) && (failed.get(key(cell)) ?? 0) < 2);
        if (!open.length) break;
        // Low before high, and of those the furthest first: a wall goes up from its foot, and what is furthest is
        // done while nothing nearer is in the way of the look.
        const eyes = this.bot.entity.position.offset(0, 1.62, 0);
        const ready = open.filter(cell => cell.spec === '@air' || this.reference(cell))
          .sort((a, b) => a.pos.y - b.pos.y || b.pos.distanceTo(eyes) - a.pos.distanceTo(eyes));
        const next = ready[0];
        if (!next) break;
        const ok = next.spec === '@air' ? await this.clear(next.pos) : await this.place(next);
        if (!ok) failed.set(key(next), (failed.get(key(next)) ?? 0) + 1);
      }
      if (this.shouldInterrupt()) break;
    }
    const left = cells.filter(cell => !cell.becomes && !this.done(cell));
    const built = total - left.length;
    if (!left.length) {
      log.info(`🧱 ${plan.name} 完成（${total}マス）`);
      return { success: true, result: `${plan.name} をその場に建てました（${total}マスすべて）。中央のマスは (${feet.x}, ${feet.y}, ${feet.z})。${plan.usage ?? ''}` };
    }
    const where = left.slice(0, 6).map(cell => `(${cell.pos.x},${cell.pos.y},${cell.pos.z})`).join(' ');
    return { success: false, failureType: this.shouldInterrupt() ? 'interrupted' : 'place_failed', recoverable: true,
      result: `${plan.name}: ${built}/${total}マスまで建てました。残り${left.length}マス（例: ${where}）。もう一度呼べば続きから建てます`
        + (this.shouldInterrupt() ? '（中断されました）' : '（置く面が無いか、手が届かないか、材料が尽きました）') };
  }
}

export default BuildAroundSelf;
