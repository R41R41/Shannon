import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { actionDelay } from '../execution/observedWait.js';
import { lavaToThrowInto, liquidNearPit, planDumpPit, type DumpPitPlan } from '../utils/dumpPit.js';
import { isThrowable } from '../utils/inventoryTidy.js';
import { holdClutterTidy } from '../utils/inventoryRoom.js';
import { nativeActionHost } from '../execution/ActionExecution.js';
import { realTurn } from '../utils/realTurn.js';
import { newItemEntities, noteSelfDropped, type DroppedLike } from '../utils/selfDropped.js';

const log = createLogger('Minebot:Skill:dropItem');

/** What covers a dump pit again, in the order tried (a kind that is spare anyway). */
const CAP_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'dirt', 'netherrack', 'deepslate', 'stone'];
/** The item thrown into a pit needs this long to fall before the floor is put back over it. */
const PIT_FALL_MS = 800;
/** ...and is waited for this much longer, at most, when a stack is still in the air. */
const PIT_FALL_MAX_MS = 1500;

const AIR = new Set(['air', 'cave_air', 'void_air']);

/** 捨てたあとに退く距離（ブロック）— 自動ピックアップ半径から外す */
const RETREAT_AFTER_TOSS_BLOCKS = 6;
/**
 * A dropped item is picked up from within a block of the body (1.3 with the item's own width), and not for its first two seconds on the
 * ground. The body ends this far from where it threw: run 21 stood 2.5 off in a narrow place and took 401 of 400 cobblestone back.
 */
const PICKUP_CLEARANCE_BLOCKS = 3.5;
/** A thrown item lying this close (blocks, level) to the body is within its pickup reach. */
const PICKUP_REACH_BLOCKS = 1.8;
/** How far from where it threw the body looks for a place to stand when the usual retreat spots all failed (steps of a walk). */
const FAR_SPOT_STEPS = 12;
const PICKUP_DELAY_MS = 2000;
/** The places the body walks back to after a throw, and how far (level) they are looked for. */
const WORK_SITES = new Set(['furnace', 'blast_furnace', 'smoker', 'crafting_table', 'chest', 'barrel']);
const WORK_SITE_RADIUS = 8;
/** An item thrown into lava is given this long to burn before it is looked for. */
const LAVA_BURN_MS = 900;
const PIT_SEARCH_RADIUS = 10;
/** With nowhere to walk to, a throw needs this many open cells ahead to land out of reach. */
const MIN_THROW_OPEN = 3;
const MIN_PIT_DEPTH = 3;
/** Most cells the search for a pit reads (the whole circle of radius 10 reads about 9 000 at worst; nearer columns come first). */
const PIT_SEARCH_MAX_READS = 6_000;
/** The longest digging a hole for one throw may take, all its cells together. */
const DUMP_PIT_DIG_MS = 30_000;
/** Columns of the pit search, nearest first. */
const PIT_OFFSETS: Array<[number, number]> = (() => {
  const offsets: Array<[number, number]> = [];
  for (let dx = -PIT_SEARCH_RADIUS; dx <= PIT_SEARCH_RADIUS; dx++) {
    for (let dz = -PIT_SEARCH_RADIUS; dz <= PIT_SEARCH_RADIUS; dz++) if (dx * dx + dz * dz <= PIT_SEARCH_RADIUS * PIT_SEARCH_RADIUS) offsets.push([dx, dz]);
  }
  return offsets.sort((a, b) => (a[0] ** 2 + a[1] ** 2) - (b[0] ** 2 + b[1] ** 2));
})();
/**
 * Throws under way on each native bot. drop-item is never run inside itself: run 22's tidy went drop-item, its pit through
 * dig-block-at, that dig's tidy, drop-item again... without end.
 */
const dropsUnderWay = new WeakMap<object, number>();

/**
 * Several kinds in one throw (run 24: dirt, granite, diorite, andesite and cobblestone thrown away in five calls, 36 s, before the descent to
 * the diamonds): `itemName` as a list, "dirt:35,granite:27,diorite" -- a kind with no count is all of it. Null for a single kind (the
 * ordinary call, with `count`).
 */
export function parseDropList(itemName: string): Array<{ name: string; count: number | null }> | null {
  if (!/[,:]/u.test(itemName)) return null;
  const merged = new Map<string, number | null>();
  for (const part of itemName.split(',')) {
    const [rawName, rawCount] = part.split(':').map(piece => piece.trim());
    if (!rawName) continue;
    const count = rawCount === undefined || rawCount === '' ? null : Math.max(0, Math.floor(Number(rawCount)));
    if (count !== null && !Number.isFinite(count)) continue;
    const before = merged.get(rawName);
    merged.set(rawName, before === undefined ? count : before === null || count === null ? null : before + count);
  }
  return [...merged].map(([name, count]) => ({ name, count }));
}

function isAirBlock(block: { name: string } | null): boolean {
  return !!block && AIR.has(block.name);
}

function canStandAt(bot: CustomBot, sx: number, sy: number, sz: number): boolean {
  const feet = bot.blockAt(new Vec3(sx, sy, sz));
  const head = bot.blockAt(new Vec3(sx, sy + 1, sz));
  const below = bot.blockAt(new Vec3(sx, sy - 1, sz));
  if (!feet || !head || !below) return false;
  if (!isAirBlock(feet) || !isAirBlock(head)) return false;
  return !isAirBlock(below);
}

/** For each of eight directions from the eyes, how many cells (five at most) are open along the line: where a throw can carry. */
function openLines(bot: CustomBot): number[] {
  const here = bot.entity.position;
  return Array.from({ length: 8 }, (_, index) => {
    const ux = Math.cos(index * Math.PI / 4), uz = Math.sin(index * Math.PI / 4);
    let open = 0;
    while (open < 5 && isAirBlock(bot.blockAt(new Vec3(Math.floor(here.x + ux * (open + 1)), Math.floor(here.y + 1.62), Math.floor(here.z + uz * (open + 1)))))) open++;
    return open;
  });
}

interface PitDropPlan {
  standX: number;
  standY: number;
  standZ: number;
  lookX: number;
  lookY: number;
  lookZ: number;
  distSq: number;
}

/**
 * 横に隣接した縦穴（連続する空気が MIN_PIT_DEPTH 以上）を探し、縁に立って下を覗く捨て先を返す。
 */
function findAdjacentPitDropPlan(bot: CustomBot): PitDropPlan | null {
  const bp = bot.entity.position;
  const bx = Math.floor(bp.x);
  const by = Math.floor(bp.y);
  const bz = Math.floor(bp.z);

  let best: PitDropPlan | null = null;
  let bestDist = Infinity;
  // Bounded: at most PIT_SEARCH_MAX_READS cells, nearest columns first, and none once the columns are farther than the best rim found.
  let reads = 0;
  const blockAt = (at: Vec3) => { reads++; return bot.blockAt(at); };

  for (const [dx, dz] of PIT_OFFSETS) {
    {
      if (reads > PIT_SEARCH_MAX_READS) break;
      // A rim is one cell from its pit: a pit farther than the best rim found plus one cannot give a nearer rim.
      if (best && Math.sqrt(dx * dx + dz * dz) - 2 > Math.sqrt(bestDist)) break;
      const px = bx + dx;
      const pz = bz + dz;

      // A pit is open at the level of the feet and goes down from there. The open air over ordinary ground
      // beside the body (feet, head and one more cell) is three cells of air too, and so is a cave under a
      // solid floor; both were taken for pits. The item was "dropped into a pit" onto the ground one block
      // away and walked back into the pack two seconds later (paid run L64).
      if (!isAirBlock(blockAt(new Vec3(px, by + 1, pz)))) continue;
      let depth = 0;
      while (depth < 14 && isAirBlock(blockAt(new Vec3(px, by - depth, pz)))) depth++;
      // `depth` counts the feet-level cell and those under it: the item comes to rest depth-1 below the feet.
      if (depth - 1 < MIN_PIT_DEPTH) continue;
      const topY = by;

      const adj = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const;
      for (const [ox, oz] of adj) {
        const sx = px + ox;
        const sz = pz + oz;
        if (!canStandAt(bot, sx, by, sz)) continue;

        const cx = sx + 0.5;
        const cz = sz + 0.5;
        const distSq = (bp.x - cx) ** 2 + (bp.z - cz) ** 2;
        if (distSq < bestDist) {
          bestDist = distSq;
          best = {
            standX: sx,
            standY: by,
            standZ: sz,
            lookX: px + 0.5,
            // A throw leaves the eyes with 0.3 of speed along the look and 0.1 up. Aimed 70 degrees down (the middle of the hole's depth) it
            // came to rest on the rim, short of the hole, and was picked up again about half the time (lab, 2026-10-20); aimed 55 degrees
            // down (1.4 down for the 1.0 across) it falls in the hole's middle whatever the random spread of the throw.
            lookY: topY + 1.62 - 1.43,
            lookZ: pz + 0.5,
            distSq,
          };
        }
      }
    }
  }
  return best;
}

/**
 * 原子的スキル: インベントリ内のアイテムをドロップ
 * 足元ですぐ拾い直さないよう、近くの穴の縁へ移動して下向きに捨てるか、捨てた直後に離れる。
 */
class DropItem extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'drop-item';
    this.description =
      'インベントリから指定アイテムを指定数捨てます（複数スタックにまたがってもよい）。近くに穴があればそこへ、無ければ開けた向きへ投げてから反対側へ離れ、拾い直していないことを確かめて結果を返します。捨てた物は数分で消えます。残したい物は deposit-to-container でチェストに預けてください。'
      + '何種類も捨てる時は1回にまとめます（itemName に "dirt:35,granite:27,diorite" のように「名前:数」をコンマでつなぐ。数を省いた物は全部。穴を掘る・歩いて離れるのは1回だけ）。';
    this.params = [
      {
        name: 'itemName',
        type: 'string',
        description: 'ドロップするアイテム名。複数をまとめて捨てる時は "dirt:35,granite:27,diorite"（数を省くと全部。このとき count は使わない）',
        required: true,
      },
      {
        name: 'count',
        type: 'number',
        description: 'ドロップする数量（デフォルト: 1）',
        default: 1,
      },
    ];
  }

  /** Places a few blocks off where the body can stand, nearer first, on its level or a step or two off it: ground is seldom flat. */
  private retreatSpots(bot: CustomBot): Array<[number, number, number]> {
    const from = bot.entity.position;
    const baseY = Math.floor(from.y);
    const spots: Array<[number, number, number]> = [];
    // The heap lies on the far side of the throw from the way the body walks off. Walking off towards the furnace, table, chest or bed
    // nearby keeps the way to it clear of the heap (run 23: 38 dirt thrown away at +639, fetched on the walk back to the furnace, and thrown
    // again at +668, 14 s): within each distance the spots nearest to such a place come first.
    const site = this.workSiteNear(bot);
    for (const distance of [RETREAT_AFTER_TOSS_BLOCKS, RETREAT_AFTER_TOSS_BLOCKS - 2]) {
      const tier: Array<[number, number, number]> = [];
      for (const [ux, uz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        const scale = ux && uz ? Math.SQRT1_2 : 1;
        const tx = Math.floor(from.x + ux * distance * scale), tz = Math.floor(from.z + uz * distance * scale);
        for (const dy of [0, 1, -1, 2, -2]) if (canStandAt(bot, tx, baseY + dy, tz)) { tier.push([tx, baseY + dy, tz]); break; }
      }
      if (site) tier.sort((a, b) => Math.hypot(a[0] + 0.5 - site.x, a[2] + 0.5 - site.z) - Math.hypot(b[0] + 0.5 - site.x, b[2] + 0.5 - site.z));
      spots.push(...tier);
    }
    return spots;
  }

  /** The nearest furnace, table, chest or bed within eight blocks (level), or null: the places the body goes back to after a throw. */
  private workSiteNear(bot: CustomBot): Vec3 | null {
    const here = bot.entity.position.floored();
    let best: { at: Vec3; distance: number } | null = null;
    for (let dx = -WORK_SITE_RADIUS; dx <= WORK_SITE_RADIUS; dx++) {
      for (let dz = -WORK_SITE_RADIUS; dz <= WORK_SITE_RADIUS; dz++) {
        for (const dy of [-1, 0, 1]) {
          const at = here.offset(dx, dy, dz);
          const name = bot.blockAt(at)?.name ?? '';
          if (!WORK_SITES.has(name) && !name.endsWith('_bed')) continue;
          const distance = Math.hypot(dx, dz);
          if (!best || distance < best.distance) best = { at, distance };
        }
      }
    }
    return best?.at ?? null;
  }

  /** Walks to one of the spots, away from where the item was thrown. True when it got clear of the place it threw from. */
  private async retreatTo(bot: CustomBot, spots: Array<[number, number, number]>, fromX: number, fromZ: number): Promise<boolean> {
    const moveTo = bot.instantSkills?.getSkill('move-to');
    const clear = () => Math.hypot(bot.entity.position.x - fromX, bot.entity.position.z - fromZ) >= PICKUP_CLEARANCE_BLOCKS;
    if (!moveTo) return clear();
    for (const [tx, ty, tz] of spots.slice(0, 5)) {
      try {
        bot.pathfinder?.stop();
        await moveTo.run(tx, ty, tz, 1, 'near');
      } catch {
        /* the next one */
      }
      if (clear()) return true;
      if (this.shouldInterrupt()) return false;
    }
    log.info('退避用の move-to がすべて不成立でした');
    return clear();
  }

  /**
   * Places to stand at least `minDistance` blocks (level) from where something was thrown, found by a walk over standable cells from the
   * body, fewest steps first. The usual retreat spots are eight points on a circle; in a winding tunnel none of them is standable, and the
   * body stayed beside the heap (run 21: 401 of 400 picked up again).
   */
  private farSpots(fromX: number, fromZ: number, minDistance: number): Array<[number, number, number]> {
    const start = this.bot.entity.position;
    const sx = Math.floor(start.x), sy = Math.floor(start.y), sz = Math.floor(start.z);
    const seen = new Set<string>([`${sx},${sy},${sz}`]);
    let frontier: Array<[number, number, number]> = [[sx, sy, sz]];
    const found: Array<[number, number, number]> = [];
    for (let step = 0; step < FAR_SPOT_STEPS && frontier.length && found.length < 4; step++) {
      const next: Array<[number, number, number]> = [];
      for (const [x, y, z] of frontier) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          for (const dy of [0, 1, -1]) {
            const nx = x + dx, ny = y + dy, nz = z + dz;
            const key = `${nx},${ny},${nz}`;
            if (seen.has(key) || !canStandAt(this.bot, nx, ny, nz)) continue;
            seen.add(key);
            next.push([nx, ny, nz]);
            if (Math.hypot(nx + 0.5 - fromX, nz + 0.5 - fromZ) >= minDistance && found.length < 4) found.push([nx, ny, nz]);
            break;
          }
        }
      }
      frontier = next;
    }
    return found;
  }

  /** Item entities of this kind that appeared since the throw, remembered as the body's own (no pickup goes back for them). */
  private noteThrown(itemName: string, lyingBefore: Set<number>): DroppedLike[] {
    const fresh = newItemEntities(this.bot as any, lyingBefore, itemName);
    noteSelfDropped(this.bot, itemName, fresh);
    return fresh;
  }

  /** Whether a thrown item lies within the body's pickup reach. */
  private strayNearBody(fresh: DroppedLike[]): boolean {
    const here = this.bot.entity.position;
    return fresh.some((entity: any) => entity.position && Math.hypot(entity.position.x - here.x, entity.position.z - here.z) < PICKUP_REACH_BLOCKS
      && entity.position.y > here.y - 1.2 && entity.position.y < here.y + 2.2);
  }

  /**
   * Throws `count` of the kind. Tools do not stack, and bot.toss takes them in slot order: asked to throw three of five stone pickaxes it
   * threw the first three, the good ones included. The most worn go first, the best are kept (run 21 carried five stone pickaxes).
   */
  private async tossItems(itemName: string, type: number, count: number): Promise<void> {
    const bot = this.bot as any;
    const stacks = this.bot.inventory.items().filter(entry => entry.name === itemName);
    const single = Number(bot.registry?.itemsByName?.[itemName]?.stackSize) === 1 || /_(pickaxe|axe|shovel|hoe|sword)$/.test(itemName);
    if (single && typeof bot.tossStack === 'function' && stacks.length > count) {
      const left = (entry: any) => entry.maxDurability > 0 ? entry.maxDurability - (entry.durabilityUsed ?? 0) : Infinity;
      for (const entry of [...stacks].sort((a, b) => left(a) - left(b)).slice(0, count)) await bot.tossStack(entry);
      return;
    }
    await this.bot.toss(type, null, count);
  }

  /** Free slots in the pack, or null when the pack cannot say. */
  private freeSlots(): number | null {
    const inventory = this.bot.inventory as { emptySlotCount?: () => number };
    return typeof inventory.emptySlotCount === 'function' ? inventory.emptySlotCount() : null;
  }

  /** What the throw did to the pack's free slots, for the result: a slot is freed only when a whole stack is gone. */
  private slotsNote(before: number | null): string {
    const after = this.freeSlots();
    if (before === null || after === null) return '';
    const freed = after - before;
    return freed > 0 ? `${freed}スロット空いた（空き${before}→${after}マス）。` : `空きスロットは増えていません（空き${after}マスのまま。スタックが残っているため）。`;
  }

  /**
   * In a tunnel, a stair or a shaft there is nowhere to walk away from a thrown item, and it lands within reach (run 20: "too narrow"
   * for 49 tuff, the rest of the reply never run). A hole is dug beside the body instead (utils/dumpPit): three below the feet, so what
   * is thrown in rests out of reach, and its floor cell is put back afterwards. Only where the open lines from the eyes say the place is
   * shut in (at most two of the eight ways open three cells), with a pickaxe that is not itself being thrown, and when digging the hole
   * is safe. Returns the plan once the hole is open, or null with nothing dug (or a part-dug hole left, harmless).
   */
  private async digDumpPit(kinds: Array<{ name: string; count: number }>): Promise<DumpPitPlan | null> {
    if (openLines(this.bot).filter(open => open >= MIN_THROW_OPEN).length > 2) return null;
    const items = this.bot.inventory.items();
    const pickaxes = items.filter(entry => entry.name.endsWith('_pickaxe'));
    // The pickaxes among what is thrown: one is always kept to dig the hole with.
    const thrown = kinds.filter(kind => kind.name.endsWith('_pickaxe'))
      .reduce((sum, kind) => sum + Math.min(kind.count, pickaxes.filter(entry => entry.name === kind.name).reduce((total, entry) => total + entry.count, 0)), 0);
    if (pickaxes.reduce((sum, entry) => sum + entry.count, 0) - thrown < 1) return null;
    if (!this.bot.instantSkills?.getSkill('dig-block-at')) return null;
    const plan = planDumpPit(this.bot as any, this.bot.entity.position.floored());
    if (!plan) return null;
    // At most MAX_PIT_DIGS cells (planDumpPit) and DUMP_PIT_DIG_MS in all, with a real turn of the event loop before each dig.
    const until = Date.now() + DUMP_PIT_DIG_MS;
    for (const cell of plan.dig) {
      await realTurn();
      if (this.shouldInterrupt() || Date.now() > until) return null;
      let dug: { success?: boolean } = { success: false };
      try { dug = await this.callSkill('dig-block-at', cell.x, cell.y, cell.z, false); } catch (error) { if (this.shouldInterrupt()) throw error; return null; }
      if (!dug.success) { log.info(`投げ込み用の穴を掘れませんでした(${cell.x},${cell.y},${cell.z})`); return null; }
    }
    return plan;
  }

  /**
   * Waits until no dropped item is left above the floor of the pit (they take about a second to arrive from the throw). A block put
   * over the pit while a stack was still falling pushed it out on top, where the body took it back (lab, 2026-10-20).
   */
  private async itemsHaveFallen(plan: DumpPitPlan, lyingBefore: Set<number>): Promise<boolean> {
    await actionDelay(this.bot, PIT_FALL_MS);
    const deadline = Date.now() + PIT_FALL_MAX_MS;
    for (;;) {
      const above = Object.values((this.bot as any).entities ?? {}).some((entity: any) => entity?.position && (entity.name === 'item' || entity.displayName === 'Item')
        && !lyingBefore.has(entity.id)
        && Math.abs(entity.position.x - (plan.column.x + 0.5)) < 2 && Math.abs(entity.position.z - (plan.column.z + 0.5)) < 2
        && entity.position.y > plan.column.feetY - 1.2);
      if (!above) return true;
      if (Date.now() >= deadline || this.shouldInterrupt()) return false;
      await actionDelay(this.bot, 100);
    }
  }

  /** New dropped items lying in the pit, below the floor level: what was thrown, seen at rest out of reach. */
  private itemsInPit(plan: DumpPitPlan, lyingBefore: Set<number>, names: string[]): number {
    return Object.values((this.bot as any).entities ?? {}).filter((entity: any) => entity?.position && (entity.name === 'item' || entity.displayName === 'Item')
      && !lyingBefore.has(entity.id) && names.includes(entity.getDroppedItem?.()?.name)
      && Math.abs(entity.position.x - (plan.column.x + 0.5)) < 0.9 && Math.abs(entity.position.z - (plan.column.z + 0.5)) < 0.9
      && entity.position.y <= plan.column.feetY - 2).length;
  }

  /** Puts a spare block back in the floor cell of a dump pit once what was thrown has fallen (the tunnel keeps its floor). */
  private async coverDumpPit(plan: DumpPitPlan, names: string[], lyingBefore: Set<number>): Promise<string> {
    if (!plan.cap) return '';
    if (!(await this.itemsHaveFallen(plan, lyingBefore))) return '穴は開けたままです（投げた物がまだ落ち切っていない）。';
    const held = (name: string) => this.bot.inventory.items().filter(entry => entry.name === name).reduce((sum, entry) => sum + entry.count, 0);
    const block = CAP_BLOCKS.find(name => held(name) > 0 && (!names.includes(name) || held(name) > 1));
    if (!block) return '穴の床は塞げませんでした（置ける石を持っていない）。';
    try {
      const placed = await this.callSkill('place-block-at', block, plan.cap.x, plan.cap.y, plan.cap.z);
      return placed.success ? `穴の床に${block}を置いて塞ぎました。` : '穴の床は塞げませんでした（床は空いたままです）。';
    } catch (error) { if (this.shouldInterrupt()) throw error; return ''; }
  }

  async runImpl(itemName: string, count: number = 1) {
    // Never inside another throw (see dropsUnderWay): refused at once, and the tidy that asked stops there.
    const native = nativeActionHost(this.bot as object);
    if ((dropsUnderWay.get(native) ?? 0) > 0) {
      log.warn(`drop-item ${itemName}×${count} は別の drop-item の途中なので断りました（片づけの入れ子）`);
      return { success: false, failureType: 'already_dropping', recoverable: true,
        result: `${itemName}は捨てませんでした（別の捨てる作業の途中です）` };
    }
    dropsUnderWay.set(native, (dropsUnderWay.get(native) ?? 0) + 1);
    // The pit this digs goes through dig-block-at, whose cheap tidy check must not start a second throw inside this one.
    const release = holdClutterTidy(this.bot);
    try {
      await realTurn();
      // Several kinds in one call ("dirt:35,granite:27"): the first is thrown as the ordinary call would, the others from the same place at
      // once -- one pit, one walk away, one wait for the pickup delay.
      const list = parseDropList(String(itemName));
      let extras: Array<{ name: string; type: number; count: number }> = [];
      if (list) {
        const kinds: Array<{ name: string; type: number; count: number }> = [];
        for (const entry of list) {
          const have = this.bot.inventory.items().filter((i) => i.name === entry.name);
          const total = have.reduce((sum, i) => sum + i.count, 0);
          const wanted = entry.count === null ? total : Math.min(entry.count, total);
          if (have.length && wanted > 0) kinds.push({ name: entry.name, type: have[0].type, count: wanted });
        }
        if (!kinds.length) return { success: false, result: `インベントリに${list.map(entry => entry.name).join('・')}がありません` };
        itemName = kinds[0].name; count = kinds[0].count; extras = kinds.slice(1);
      }
      const allNames = [itemName, ...extras.map(extra => extra.name)];
      const stacks = this.bot.inventory.items().filter((i) => i.name === itemName);
      const item = stacks[0];

      if (!item) {
        return {
          success: false,
          result: `インベントリに${itemName}がありません`,
        };
      }

      // As many as asked for, over as many stacks as it takes (it used to stop at the first stack: asked to drop
      // 74 granite, it dropped the 10 of one stack).
      const dropCount = Math.min(count, stacks.reduce((sum, i) => sum + i.count, 0));
      const moveTo = this.bot.instantSkills?.getSkill('move-to');
      const slotsBefore = this.freeSlots();

      // No pit to hand and the place shut in: one is dug (see digDumpPit), before the item is taken in hand. Beside lava or water no
      // hole is used or dug (utils/dumpPit liquidNearPit): the throw is made walking away (run 22 tidied beside the lava it worked).
      const liquid = liquidNearPit(this.bot as any, this.bot.entity.position.floored());
      // Lava within a throw: what is thrown into it is gone, and cannot be picked up again (run 23: a heap of 176 thrown away and
      // fetched back after every obsidian dug, 4-6 s each). Only a spare kind that is thrown to be rid of (selfDropped's table).
      const eyes = this.bot.entity.position.offset(0, 1.62, 0);
      const intoLava = liquid && allNames.every(name => isThrowable(name)) ? lavaToThrowInto(this.bot as any, eyes) : null;
      if (liquid && intoLava) log.info(`溶岩(${intoLava.x},${intoLava.y},${intoLava.z})が近いので、${allNames.join('・')}は溶岩へ投げ込んで消します`);
      else if (liquid) log.info(`${liquid}が近いので穴には捨てず、離れて捨てます`);
      let pit = liquid ? null : findAdjacentPitDropPlan(this.bot);
      let dugPit: DumpPitPlan | null = null;
      if (!pit && !liquid) {
        dugPit = await this.digDumpPit([{ name: itemName, count: dropCount }, ...extras]);
        if (dugPit) pit = findAdjacentPitDropPlan(this.bot);
      }

      // The stack in hand is looked up again: digging the pit may have moved things about in the pack.
      const inHand = this.bot.inventory.items().find((entry) => entry.name === itemName) ?? item;
      await this.bot.equip(inHand, 'hand').catch(() => {});

      let mode: 'pit' | 'retreat' | 'lava' = intoLava ? 'lava' : 'retreat';

      if (pit && moveTo) {
        try {
          this.bot.pathfinder?.stop();
          const near = await moveTo.run(pit.standX, pit.standY, pit.standZ, 1, 'near');
          if (near.success) {
            await this.bot.lookAt(new Vec3(pit.lookX, pit.lookY, pit.lookZ));
            await actionDelay(this.bot, 120);
            mode = 'pit';
          }
        } catch (e: any) {
          // A cancelled action must not fall through to toss (not motor-fenced).
          if (this.shouldInterrupt()) throw e;
          log.warn(`穴縁への移動に失敗: ${e.message}`);
        }
      }

      const heldOf = (name: string) => this.bot.inventory.items().filter((i) => i.name === name).reduce((sum, i) => sum + i.count, 0);
      const held = () => heldOf(itemName);
      const before = held();
      const extrasBefore = extras.map(extra => heldOf(extra.name));
      const noteAll = () => allNames.flatMap(name => this.noteThrown(name, lyingBefore));
      // With no pit: the item is thrown one way and the body walks the other. The way to walk is chosen first
      // (somewhere it can stand), the throw is level and straight away from it, and the walk keeps to that side.
      let spots: Array<[number, number, number]> = [];
      if (mode === 'lava' && intoLava) {
        // Level with the lava's top, at the middle of the cell: the throw carries about three blocks and falls into it.
        await this.bot.lookAt(new Vec3(intoLava.x + 0.5, intoLava.y + 1, intoLava.z + 0.5), true);
      } else if (mode === 'retreat') {
        spots = this.retreatSpots(this.bot);
        if (spots.length) {
          const here = this.bot.entity.position;
          const [sx, , sz] = spots[0];
          const wayX = sx + 0.5 - here.x, wayZ = sz + 0.5 - here.z, length = Math.hypot(wayX, wayZ) || 1;
          await this.bot.lookAt(new Vec3(here.x - (wayX / length) * 4, here.y + 1.62, here.z - (wayZ / length) * 4), true);
          spots = spots.filter(([x, , z]) => (x + 0.5 - here.x) * wayX + (z + 0.5 - here.z) * wayZ > 0);
        } else {
          // Nowhere to walk to: the throw itself has to carry the item out of reach. It goes level along the
          // longest open line there is from the eyes (a thrown item lands three blocks or so off; the body picks
          // up from within one). Thrown wherever the body happened to be looking, it fell at its feet.
          const here = this.bot.entity.position;
          let best: { x: number; z: number; open: number } | null = null;
          openLines(this.bot).forEach((open, index) => {
            if (!best || open > best.open) best = { x: Math.cos(index * Math.PI / 4), z: Math.sin(index * Math.PI / 4), open };
          });
          // Shut in (a 1x1 shaft, a tunnel's end): whatever is thrown lands within reach and walks back into the pack two seconds
          // later. Said before throwing, not after (run 17 threw a stone pickaxe in its shaft and picked it up again).
          const line = best as { x: number; z: number; open: number } | null;
          const openAhead = line?.open ?? 0;
          if (!line || openAhead < MIN_THROW_OPEN) {
            return { success: false, failureType: 'no_room_to_drop', recoverable: true,
              result: `ここは狭く、${itemName}を捨てても1ブロック以内に落ちて拾い直します（投げられる空きは${openAhead}マス）。`
                + '捨てずに持っておくか、開けた所（3マス以上の空き）へ出てから捨ててください' };
          }
          await this.bot.lookAt(new Vec3(here.x + line.x * 4, here.y + 1.62, here.z + line.z * 4), true);
        }
      }
      const lyingBefore = new Set<number>(Object.values((this.bot as any).entities ?? {}).filter((entity: any) => entity?.name === 'item' || entity?.displayName === 'Item')
        .map((entity: any) => entity.id));
      // Where the throw is made from (the rim of a pit, not the place the order began): the body must end this far from here.
      const tossX = this.bot.entity.position.x;
      const tossZ = this.bot.entity.position.z;
      await this.tossItems(itemName, item.type, dropCount);
      for (const extra of extras) { if (this.shouldInterrupt()) break; await this.tossItems(extra.name, extra.type, extra.count); }
      await actionDelay(this.bot, 80);
      let fresh = noteAll();
      log.info(`投げました: ${[`${itemName}×${dropCount}`, ...extras.map(extra => `${extra.name}×${extra.count}`)].join('・')}（モード ${mode}${dugPit ? '・掘った穴' : ''}、いま所持 ${held()}、位置 ${this.bot.entity.position.toString()}）`);

      const tossedAt = Date.now();
      // A pit dug for the throw is covered once the item has fallen into it (before the pickup delay is out, so the wait is not longer).
      let coverNote = '';
      let sealed = false;
      if (mode === 'pit' && dugPit) {
        coverNote = await this.coverDumpPit(dugPit, allNames, lyingBefore);
        // Seen at rest three blocks down and the floor put back over them: nothing can pick them up, the two seconds need not be waited.
        sealed = coverNote.includes('塞ぎました') && this.itemsInPit(dugPit, lyingBefore, allNames) > 0;
      }
      // Into lava: given a moment to burn. What is gone from the world cannot be picked up; what lies there still (it landed on the rim)
      // is dealt with as a stray at a pit's rim is, below.
      if (mode === 'lava') {
        await actionDelay(this.bot, LAVA_BURN_MS);
        fresh = noteAll();
        sealed = fresh.length === 0;
      } else fresh = noteAll();
      let away = true;
      if (mode === 'retreat') away = await this.retreatTo(this.bot, spots, tossX, tossZ);
      // At the rim of a pit that is not sealed, an item that landed on the rim (not in the hole) is within reach: the body walks off before
      // its two seconds are out, as it does without a pit. In the hole it is three blocks down, out of reach.
      else if (!sealed && this.strayNearBody(fresh)) {
        const strays = fresh as any[];
        const apart = (spot: [number, number, number]) => Math.min(...strays.map(entity => entity.position ? Math.hypot(entity.position.x - spot[0] - 0.5, entity.position.z - spot[2] - 0.5) : Infinity));
        spots = this.retreatSpots(this.bot).sort((a, b) => apart(b) - apart(a));
        away = await this.retreatTo(this.bot, spots, tossX, tossZ);
      }
      // The usual spots all failed (a winding tunnel): any standable cell far enough from the heap will do.
      if (!away && !sealed && !this.shouldInterrupt()) away = await this.retreatTo(this.bot, this.farSpots(tossX, tossZ, PICKUP_CLEARANCE_BLOCKS + 0.5), tossX, tossZ);
      fresh = noteAll();
      // A thrown item can be picked up again after two seconds. What the pack holds after that is the result.
      if (!sealed) await actionDelay(this.bot, Math.max(0, PICKUP_DELAY_MS + 400 - (Date.now() - tossedAt)));
      noteAll();
      const backs = [{ name: itemName, back: Math.max(0, held() - (before - dropCount)) },
        ...extras.map((extra, index) => ({ name: extra.name, back: Math.max(0, heldOf(extra.name) - (extrasBefore[index] - extra.count)) }))].filter(entry => entry.back > 0);
      const back = backs.reduce((sum, entry) => sum + entry.back, 0);
      const thrownText = [`${itemName}を${dropCount}個`, ...extras.map(extra => `${extra.name}を${extra.count}個`)].join('・');
      const leftText = extras.length ? [itemName, ...extras.map(extra => extra.name)].map(name => `${name}${heldOf(name)}`).join('・') : `${held()}個`;
      if (back > 0) log.info(`拾い直し: ${itemName} ${back}個（モード ${mode}、近くの落とし物: ${Object.values((this.bot as any).entities ?? {}).filter((entity: any) => entity?.name === 'item')
        .map((entity: any) => `${entity.getDroppedItem?.()?.name ?? '?'}@${entity.position.x.toFixed(1)},${entity.position.y.toFixed(1)},${entity.position.z.toFixed(1)}`).join(' ')}）`);
      if (back > 0) {
        return {
          success: false,
          failureType: 'picked_up_again',
          recoverable: true,
          result:
            (extras.length ? `${thrownText}捨てましたが、${backs.map(entry => `${entry.name}${entry.back}個`).join('・')}を拾い直しました（現在${leftText}）。`
              : `${itemName}を${dropCount}個捨てましたが、${back}個を拾い直しました（現在${held()}個）。`) +
            (away ? '' : '捨てた場所から離れられませんでした（周りに立てる場所が見つからない）。') +
            '落とし物は1ブロック以内にいると拾います。開けた場所へ出てから捨てるか、チェストに入れてください。' +
            this.slotsNote(slotsBefore),
        };
      }
      return {
        success: true,
        result: (mode === 'pit'
          ? (dugPit ? `${thrownText}、狭い所だったので横に深さ3の穴を掘って捨てました（残り${leftText}）。${coverNote}`
            : `${thrownText}、近くの穴へ捨てました（残り${leftText}）。`)
          : mode === 'lava' && sealed ? `${thrownText}、近くの溶岩へ投げ込んで消しました（残り${leftText}）。拾い直す物は残っていません。`
          : `${thrownText}捨て、その場から離れました（残り${leftText}）。`) + this.slotsNote(slotsBefore),
      };
    } catch (error: any) {
      return {
        success: false,
        result: `ドロップエラー: ${error.message}`,
      };
    } finally {
      release();
      dropsUnderWay.set(native, Math.max(0, (dropsUnderWay.get(native) ?? 1) - 1));
    }
  }
}

export default DropItem;
