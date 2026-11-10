import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { actionDelay } from '../execution/observedWait.js';
import { BED_EXPLODES, bedExplodesHere, bedHalves, isBedName, leaveBed, SLEEP_LATE_MS, sleepPatiently } from '../utils/bedRules.js';
import { planBedSpot, walkableCells } from '../utils/bedSpot.js';
import { bodyInHazard, planBedApproach, planBedStand, whatHides, type BedStandBot } from '../utils/bedStand.js';
import { STAND_USE_REACH } from '../utils/workstationAccess.js';
import { hostileNear, PICKUP_SAFE_RANGE } from './craftOne.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:sleepInBed');

/** Blocks a placed block takes the place of (a bed can be set down on grass, not only in air). */
export const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
  'leaf_litter', 'snow', 'vine', 'glow_lichen', 'seagrass']);
/** The wider bed search: the steps of walk a stand may be from the body (run 21). */
const BED_WALK_STEPS = 10;
/** All the walks to a stand before the bed is set down, together (the hand has 45 s; the place and the sleep need about 20). */
const STAND_WALK_BUDGET_MS = 20_000;
/** The walk to a bed that is already there: a village bed can be most of sixteen blocks off. */
const BED_APPROACH_STEPS = 24;
const BED_APPROACH_CELLS = 3000;
/** Blocks put into a hole in the floor under a bed, in the order used (rock the body has to spare). */
const BED_FILLERS = ['cobblestone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'dirt', 'stone', 'deepslate', 'netherrack'];
export const isFreeCell =(block: { name?: string } | null | undefined) => !!block && REPLACEABLE.has(String(block.name));
/**
 * Foot cells where a bed did not come lately, by "x,y,z" with the time (end1109o11: the same cell was chosen four times in one night,
 * each failing the same way). Not chosen again for BED_SPOT_FAILED_MS.
 */
const failedBedSpots = new Map<string, number>();
const BED_SPOT_FAILED_MS = 10 * 60_000;
const spotKey = (cell: Vec3) => `${cell.x},${cell.y},${cell.z}`;
export function noteBedSpotFailed(cell: Vec3, now = Date.now()): void { failedBedSpots.set(spotKey(cell), now); }
export function bedSpotFailedLately(cell: Vec3, now = Date.now()): boolean {
  const at = failedBedSpots.get(spotKey(cell));
  return at !== undefined && now - at < BED_SPOT_FAILED_MS;
}
/** The other half of the bed block `block`: from its own state, else a bed cell beside it on the same level. */
function otherHalfOf(bot: { blockAt(pos: Vec3): any }, block: any): Vec3 | null {
  const cell = block.position as Vec3;
  const halves = bedHalves(block, cell);
  if (halves) return new Vec3(halves.other.x, halves.other.y, halves.other.z);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const beside = cell.offset(dx, 0, dz);
    if (isBedName(bot.blockAt(beside)?.name)) return beside;
  }
  return null;
}
/** The cells the body's box (0.6 wide, 1.8 high) is in: a block placed there is refused by the server. */
export function bodyCells(at: { x: number; y: number; z: number }): Vec3[] {
  const cells: Vec3[] = [];
  for (const dx of [-0.3, 0.3]) for (const dz of [-0.3, 0.3]) for (const dy of [0, 1, 1.79]) {
    const cell = new Vec3(Math.floor(at.x + dx), Math.floor(at.y + dy), Math.floor(at.z + dz));
    if (!cells.some(other => other.equals(cell))) cells.push(cell);
  }
  return cells;
}

/**
 * Why a bed is "obstructed" and what to do (o03: a bed set down in a hole one block high, then minutes of waiting beside it): the solid
 * cells over its two halves by coordinate, and the two ways out (dig them, or take the bed so the next sleep sets it down where the
 * space over it is open).
 */
export function obstructedAdvice(bot: { blockAt(pos: Vec3): { name?: string; boundingBox?: string } | null }, at: { x: number; y: number; z: number }): string | null {
  const foot = new Vec3(at.x, at.y, at.z);
  const other = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => foot.offset(dx, 0, dz))
    .find(cell => /_bed$/u.test(String(bot.blockAt(cell)?.name ?? '')));
  const shut = [foot, ...(other ? [other] : [])].map(cell => cell.offset(0, 1, 0)).filter(cell => bot.blockAt(cell)?.boundingBox === 'block');
  if (!shut.length) return null;
  const cells = shut.map(cell => `(${cell.x},${cell.y},${cell.z}) ${bot.blockAt(cell)?.name ?? '?'}`).join('・');
  return `ベッドの上がふさがっています（${cells}）。サーバーはベッドの 2 マスの真上が空いていないと寝かせない。`
    + `そのマスを dig して空けてから sleep するか、ベッドを dig takeOk collect=true で拾えば、次の sleep が上の空いた所に置いて寝る`;
}

/**
 * 原子的スキル: ベッドで寝る
 */
class SleepInBed extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'sleep-in-bed';
    this.description =
      'ベッドで眠ります（夜か雷雨の時だけ。ネザー・エンドでは爆発するので拒みます）。近くにベッドがない場合はインベントリのベッドを設置して眠ります。wakeUpをtrueにするとベッドから起きます。';
    this.params = [
      {
        name: 'wakeUp',
        type: 'boolean',
        description: 'trueの場合、ベッドから起きます。',
        default: false,
      },
      {
        name: 'isTakeBed',
        type: 'boolean',
        description:
          '既に寝ている村人がいた場合にベッドを奪うかどうか。デフォルトはfalse。',
        default: false,
      },
    ];
  }

  /**
   * Where a bed can be set down: the foot cell and the head cell beyond it (the bed lies the way the body faces when it places it, so the
   * head is the cell past the foot, away from the body), both free (air, or grass and the like that a placed block replaces) and on solid
   * ground, neither in a cell the body itself fills. Run 17 failed three times with "something may be standing in that cell" (its own
   * body) and once on a grass cell (D54). Run 6 (11/11): a spot behind two blocks of rock was chosen (the server takes a place across
   * rock) and the bed was out of reach to lie in: a spot has to be in sleep range, in use reach and in sight from a stand (utils/bedStand).
   * Without `walk` the stand is the cell the body is in; with it (cells the body can walk to) the nearest stand that has a spot, left in
   * `plannedStand` (null when it is where the body is).
   */
  findPlaceForBed(radius: number = 3, reach: number = STAND_USE_REACH, walk?: Map<string, number>): Vec3 | null {
    const plan = planBedStand(this.bot as unknown as BedStandBot, {
      radius, reach, walk, isFree: isFreeCell, skip: bedSpotFailedLately, bodyAt: bodyCells,
      skipStand: cell => this.failedStands.has(`${cell.x},${cell.y},${cell.z}`),
    });
    this.plannedStand = plan && !plan.here ? plan.stand : null;
    return plan?.foot ?? null;
  }

  /**
   * The same search over the cells the body can walk to in BED_WALK_STEPS steps or fewer (a cheap walk over standable cells, not the path
   * planner): the nearest stand with a spot. Run 21 found nothing in a rock passage's three blocks while a wider cave was a few steps off.
   */
  findWiderPlaceForBed(): Vec3 | null {
    let walk: Map<string, number>;
    try { walk = walkableCells(this.bot as any, this.bot.entity.position, BED_WALK_STEPS); } catch { return null; }
    return this.findPlaceForBed(3, STAND_USE_REACH, walk);
  }

  /** Stand cells a walk did not reach in this call: not chosen again (one unreachable stand would otherwise cost every attempt). */
  private failedStands = new Set<string>();

  /** The cell to walk to before the bed is set down (null: the body is in the right place). */
  private plannedStand: Vec3 | null = null;

  /** The foot cell and head cell of a spot being made, so the body faces the way the bed is to lie when it places it. */
  private plannedHead: Vec3 | null = null;

  /**
   * Makes a spot where there is none: rock cells over and in the bed's two cells are dug out and a hole in the floor is filled (utils/bedSpot
   * plans it, nearest and cheapest first). Returns the foot cell, or why not. Dangerous cells are never touched (liquid or fire beside a
   * cell to dig, goods and workstations, obsidian); a dig that is refused ends it with what was refused.
   */
  private async prepareBedSpot(): Promise<{ pos: Vec3 } | { failure: string; failureType: string }> {
    const items = this.bot.inventory.items();
    const hasPickaxe = items.some(item => item.name.endsWith('_pickaxe'));
    const fillers = items.filter(item => BED_FILLERS.includes(item.name)).reduce((sum, item) => sum + item.count, 0);
    const plan = planBedSpot(this.bot as any, this.bot.entity.position, { isFree: isFreeCell, hasPickaxe, fillers, body: bodyCells(this.bot.entity.position) });
    if (!plan) {
      return { failureType: 'no_bed_spot', failure: 'ベッドを設置できる適切な場所が見つかりませんでした（周囲8マスの歩ける所を探し、岩を掘って2×1の床を作る方法も試しましたが、'
        + `掘れる安全な場所がありません。${hasPickaxe ? '' : 'ツルハシを持っていません。'}${fillers > 0 ? '' : '床の穴を埋める石も持っていません。'}溶岩・水・設備のそばは掘りません）。開けた所へ移動してからもう一度試してください` };
    }
    for (const cell of plan.dig) {
      let dug: { success?: boolean; result?: unknown } = { success: false };
      try { dug = await this.callSkill('dig-block-at', cell.x, cell.y, cell.z, false); } catch (error) { if (this.shouldInterrupt()) throw error; }
      if (!dug.success) {
        return { failureType: 'bed_spot_prepare_failed', failure: `ベッドを置く場所を作ろうとして(${cell.x}, ${cell.y}, ${cell.z})を掘りましたが掘れませんでした（${String(dug.result ?? '').slice(0, 100)}）` };
      }
    }
    for (const cell of plan.fill) {
      const filler = this.bot.inventory.items().find(item => BED_FILLERS.includes(item.name));
      let placed: { success?: boolean; result?: unknown } = { success: false };
      if (filler) { try { placed = await this.callSkill('place-block-at', filler.name, cell.x, cell.y, cell.z); } catch (error) { if (this.shouldInterrupt()) throw error; } }
      if (!placed.success) {
        return { failureType: 'bed_spot_prepare_failed', failure: `ベッドの床になる穴(${cell.x}, ${cell.y}, ${cell.z})を埋められませんでした（${String(placed.result ?? '床を埋める石がありません').slice(0, 100)}）` };
      }
    }
    // What stands there now has to be what the plan wanted: two free cells with a floor under, and the air over them.
    const free = (cell: Vec3) => isFreeCell(this.bot.blockAt(cell));
    const floor = (cell: Vec3) => this.bot.blockAt(cell.offset(0, -1, 0))?.boundingBox === 'block';
    if (![plan.pos, plan.head].every(cell => free(cell) && floor(cell) && free(cell.offset(0, 1, 0)))) {
      return { failureType: 'bed_spot_prepare_failed', failure: `ベッドを置く場所(${plan.pos.x}, ${plan.pos.y}, ${plan.pos.z})を掘って整えましたが、まだ2×1の床になっていません` };
    }
    this.plannedHead = plan.head;
    log.info(`ベッドの置き場所を作りました: 掘る${plan.dig.length}・床を埋める${plan.fill.length}（${plan.pos.x}, ${plan.pos.y}, ${plan.pos.z}）`);
    return { pos: plan.pos };
  }

  /**
   * end1109o09: the act's sleep hand digs no spot (the head's call), but o09 waited out a whole night in a one-wide passage with a bed and a
   * pickaxe carried, because the line only said there was none. The same plan prepareBedSpot would dig is said as the hands that make it.
   */
  spotHands(): string {
    const items = this.bot.inventory.items();
    const hasPickaxe = items.some(item => item.name.endsWith('_pickaxe'));
    const filler = items.find(item => BED_FILLERS.includes(item.name));
    let plan: ReturnType<typeof planBedSpot> = null;
    try { plan = planBedSpot(this.bot as any, this.bot.entity.position, { isFree: isFreeCell, hasPickaxe, fillers: filler?.count ?? 0, body: bodyCells(this.bot.entity.position) }); } catch { plan = null; }
    if (!plan) return '。掘って作れる安全な所も周りに無い（開けた所へ動いてから sleep）';
    const cells = (list: Vec3[]) => list.map(cell => `${cell.x},${cell.y},${cell.z}`).join(' ');
    const hands = [plan.dig.length ? `「dig ${cells(plan.dig)}」` : '', plan.fill.length && filler ? `「place ${filler.name} ${cells(plan.fill)}」` : ''].filter(Boolean);
    return `。掘れば作れる: 手 ${hands.join('')} の後に「sleep」（掘る ${plan.dig.length}・埋める ${plan.fill.length}、数秒。`
      + `ベッドの足の側 (${plan.pos.x},${plan.pos.y},${plan.pos.z})・頭の側 (${plan.head.x},${plan.head.y},${plan.head.z})）。夜を穴で待つより速い`;
  }

  /**
   * The bed block this call set down, read at its foot cell (run 6: a library search within three blocks of the feet cell measures to the floored
   * body cell, and a bed 3.3 away "was not there"). Only that cell: the cell was free when it was chosen, so a bed there is the one just set
   * down. A bed a library search finds beside it may be another's (a village row, a villager's), and is never taken for it.
   */
  private bedPlacedAt(foot: Vec3): any | null {
    const direct = this.bot.blockAt(foot);
    return isBedName(direct?.name) ? direct : null;
  }

  /**
   * The bed set down at `at` goes back into the pack: dug with takeEquipment, and, when the drop is not collected, looked for once more.
   * `notTaken` is the words for when it is not (where it lies, and the hand that takes it).
   */
  private async takeBedBack(at: { x: number; y: number; z: number }, fallbackName: string): Promise<{ success: boolean; notTaken: string }> {
    const bedName = this.bot.blockAt(new Vec3(at.x, at.y, at.z))?.name ?? fallbackName;
    const bedsHeld = () => this.bot.inventory.items().filter(item => item.name === bedName).reduce((sum, item) => sum + item.count, 0);
    const bedsBefore = bedsHeld();
    let taken: { success: boolean; result: string };
    try { taken = await this.callSkill('dig-block-at', at.x, at.y, at.z, true, 'target', true); }
    catch (error: any) { taken = { success: false, result: String(error?.message ?? error) }; }
    // Dug but not in the pack (drop_not_collected): it lies there, and digging the spot again finds air. The drop appears a moment after
    // the block is gone, so it is looked for again once, here (run 25: the bed was left lying and the next night had none).
    if ((taken as { failureType?: string }).failureType === 'drop_not_collected' && bedsHeld() <= bedsBefore) {
      try {
        await actionDelay(this.bot, 600);
        await this.callSkill('pickup-nearest-item', bedName, 10);
      } catch (error: any) { if (this.shouldInterrupt()) throw error; }
      if (bedsHeld() > bedsBefore) taken = { success: true, result: 'ベッドを拾い直しました' };
    }
    const notTaken = (taken as { failureType?: string }).failureType === 'drop_not_collected'
      ? `ベッドは掘りましたが持ち物に入っていません（(${at.x}, ${at.y}, ${at.z}) の近くに落ちていれば pickup-nearest-item で拾えます）`
      : `ベッド(${at.x}, ${at.y}, ${at.z})を拾えませんでした（dig-block-at takeEquipment=true で拾えます）`;
    return { success: !!taken.success, notTaken };
  }

  /**
   * After a failure past the place (not found, too far, obstructed, monsters): the bed that is standing at `foot` is taken back, so the
   * pack is not left without one (run 6 lost its only bed that way). Words for the failure text; '' when no bed stands there. Not while
   * the body lies in it, and not with an enemy near (the bed is left, and where).
   */
  private async takeBedBackAfterFailure(foot: Vec3): Promise<string> {
    const placed = this.bedPlacedAt(foot);
    if (!placed || this.bot.isSleeping) return '';
    const at = placed.position ?? foot;
    if (hostileNear(this.bot as any, PICKUP_SAFE_RANGE)) return `敵が近いので、置いたベッド(${at.x}, ${at.y}, ${at.z})はそのままにした（後で dig-block-at takeEquipment=true で拾える）`;
    const taken = await this.takeBedBack(at, String(placed.name ?? ''));
    return taken.success ? '置いたベッドは拾い直した' : taken.notTaken;
  }

  /** The nearest hostile mob within eight blocks, if any. */
  private hostileWithinEight(): { name?: string; distance: number } | null {
    const hostileMobs = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'slime', 'phantom', 'blaze', 'ghast'];
    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || !entity.position) continue;
      const distance = entity.position.distanceTo(this.bot.entity.position);
      if (distance > 8) continue;
      const entityName = entity.name?.toLowerCase() || '';
      if (hostileMobs.some(mob => entityName.includes(mob))) return { name: entity.name, distance };
    }
    return null;
  }

  /**
   * Still asleep when the wait for morning ended (another player on the server is awake, so the night goes on): with `leaveIfNight` the body
   * gets up, so that it is not left lying in a bed it cannot act from (the act's sleep hand, utils/primitives/sleep). True when it is up.
   */
  private async getUpIfNight(leaveIfNight: boolean): Promise<boolean> {
    if (!leaveIfNight || !this.bot.isSleeping) return !this.bot.isSleeping;
    const woke = new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.bot.removeListener('wake', done); resolve(); }, 2000);
      const done = () => { clearTimeout(timer); resolve(); };
      this.bot.once('wake', done);
    });
    try { await leaveBed(this.bot as never); await woke; } catch (error: any) { log.warn(`起き上がれません: ${error?.message ?? error}`); }
    return !this.bot.isSleeping;
  }

  /**
   * `options.noDig` (the act's sleep hand): no spot is made by digging, and the walks to a bed or a spot cut no tunnel (rockTravel off). Where
   * there is no spot it says so (`no_bed_spot`); whether to dig one is the head's.
   */
  async runImpl(wakeUp?: boolean, isTakeBed?: boolean, options: { leaveIfNight?: boolean; noDig?: boolean } = {}) {
    try {
      // ベッドから起きる場合
      if (wakeUp) {
        if (this.bot.isSleeping) {
          await leaveBed(this.bot as never);
          return { success: true, result: 'ベッドから起きました' };
        } else {
          return { success: false, result: '現在寝ていません' };
        }
      }

      // A bed placed or used in the Nether or the End explodes.
      if (bedExplodesHere(this.bot)) return { success: false, result: BED_EXPLODES, failureType: 'bed_explodes', recoverable: true };

      // 時間チェック
      const timeOfDay = this.bot.time.timeOfDay;
      // 夜は12542～23459（雷雨の時は昼でも眠れる）
      // The library's own test for a storm (bed.js): rain with thunder.
      if ((timeOfDay < 12542 || timeOfDay > 23459) && !((this.bot as any).isRaining && (this.bot as any).thunderState > 0)) {
        return {
          success: false,
          result: '夜または雷雨の時にしか寝られません（現在の時間: ' + timeOfDay + '）。'
            + 'リスポーン地点を決めるだけなら、昼でも activate-block（blockName: bed）でベッドを右クリックすれば決まります',
          failureType: 'not_night', recoverable: true,
        };
      }

      // 敵が近くにいないかチェック
      const nearbyMobs = Object.values(this.bot.entities).filter((entity) => {
        if (!entity || !entity.position) return false;
        const dist = entity.position.distanceTo(this.bot.entity.position);
        if (dist > 8) return false;

        const hostileMobs = [
          'zombie', 'skeleton', 'creeper', 'spider', 'enderman',
          'witch', 'slime', 'phantom', 'blaze', 'ghast',
        ];

        const entityName = entity.name?.toLowerCase() || '';
        return hostileMobs.some((mob) => entityName.includes(mob));
      });

      if (nearbyMobs.length > 0) {
        const mob = nearbyMobs[0];
        const dist = mob.position.distanceTo(this.bot.entity.position).toFixed(1);
        return {
          success: false,
          result: `近くに敵がいるため寝られません（${mob.name}が${dist}m先にいます）`,
          failureType: 'hostile_near', recoverable: true,
        };
      }

      // まず近くにベッドがあるか探す
      // end1109o03 (11/9): the nearest village bed had a sleeping villager; the hand said only 「isTakeBed を true に」 (a word the head's
      // sleep hand does not have) three times while the night went by. A bed with nobody in it is chosen first; with only taken ones and a
      // bed carried, the carried one is placed (below); with neither, the stop says how to take one.
      const villagerIn = (block: any) => !isTakeBed && Object.values(this.bot.entities).some((entity: any) => entity?.name === 'villager'
        && entity.position?.distanceTo?.(block.position) < 2 && Number(entity.metadata?.[6]) === 2);
      const near = (this.bot.findBlocks?.({ matching: this.bot.isABed, maxDistance: 16, count: 12 }) ?? [])
        .map((position: any) => this.bot.blockAt(position)).filter((block): block is NonNullable<typeof block> => !!block);
      const free = near.filter((block: any) => !villagerIn(block));
      let bed = near.length ? (free[0] ?? null) : this.bot.findBlock({
        matching: this.bot.isABed,
        maxDistance: 16,
      });
      if (!bed && near.length && !this.bot.inventory.items().some((item) => isBedName(item.name))) {
        const p = near[0].position;
        return { success: false, failureType: 'bed_taken', recoverable: true,
          result: `16m 内のベッド ${near.length} 個は、どれも村人が寝ている（一番近いのは (${p.x},${p.y},${p.z})）。`
            + `そのベッドを dig takeOk collect=true で取れば 1 個になる（村人は起きる）。次の sleep の手が、持っているベッドを置いて寝る` };
      }

      // Run 6 (11/11): the nearest bed by straight line can be behind rock or a wall. A bed is slept in from a stand that is in sleep range,
      // in reach and in sight, which the body can walk to (utils/bedStand): the first bed that has one. None: the beds are said as facts and
      // the carried bed, if any, is set down below.
      let approach: { stand: Vec3; here: boolean } | null = null;
      let unreachable = '';
      if (bed && near.length) {
        const candidates = free.slice(0, 12);
        let walk: Map<string, number> | undefined;
        try { walk = walkableCells(this.bot as any, this.bot.entity.position, BED_APPROACH_STEPS, BED_APPROACH_CELLS); } catch { walk = undefined; }
        for (const block of candidates) {
          const plan = planBedApproach(this.bot as unknown as BedStandBot, block.position, otherHalfOf(this.bot, block), { walk });
          if (plan) { bed = block; approach = plan; break; }
        }
        if (!approach) {
          const p = candidates[0].position;
          const hides = whatHides(this.bot as unknown as BedStandBot, p);
          unreachable = `ベッド (${p.x},${p.y},${p.z}) は${hides ? `間に ${hides} があり` : ''}歩いて寄れない（寝る範囲で、見えて届く所に立てる場所へ ${BED_APPROACH_STEPS} 歩では行けない）`;
          bed = null;
        }
      }

      if (bed) {
        // すでにベッドがある場合は、そこに移動して寝る
        try {
          if (approach) {
            if (!approach.here) {
              this.bot.pathfinder.stop();
              const walked = await gotoSafe(this.bot, new goals.GoalBlock(approach.stand.x, approach.stand.y, approach.stand.z), { rockTravel: !options.noDig, timeoutMs: 15_000 });
              // From where the body stands now the bed has to be in range and in sight.
              if (!planBedApproach(this.bot as unknown as BedStandBot, bed.position, otherHalfOf(this.bot, bed))?.here) {
                return { success: false, failureType: 'no_bed_spot', recoverable: true,
                  result: `ベッド (${bed.position.x},${bed.position.y},${bed.position.z}) の寄れる所 (${approach.stand.x},${approach.stand.y},${approach.stand.z}) まで歩けませんでした${walked?.error ? `（${String(walked.error).slice(0, 80)}）` : ''}` };
              }
            }
          } else if (this.bot.entity.position.distanceTo(bed.position) > 3) {
            this.bot.pathfinder.stop();
            await gotoSafe(this.bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), { rockTravel: !options.noDig, timeoutMs: 15_000 });
          }

          // ベッドで寝ている村人を探す
          const villagers = Object.values(this.bot.entities).filter(
            (entity) =>
              entity.name === 'villager' &&
              entity.position.distanceTo(bed!.position) < 2
          );
          const sleepingVillager = villagers.find(
            (entity) => Number(entity.metadata[6]) === 2
          );

          if (sleepingVillager && isTakeBed) {
            // ベッドをアクティブにして村人を起こす
            try {
              await this.bot.activateBlock(bed);
            } catch (error: any) {
              log.warn(`村人起こしエラー: ${error.message}`);
            }
            // 村人が起きるまで少し待つ
            await actionDelay(this.bot, 500);
            bed = this.bot.findBlock({
              matching: this.bot.isABed,
              maxDistance: 8,
            });
          } else if (sleepingVillager && !isTakeBed) {
            return {
              success: false,
              result:
                `既に村人が寝ているベッドです（(${bed.position.x},${bed.position.y},${bed.position.z})）。dig takeOk collect=true で取れば 1 個になり（村人は起きる）、次の sleep の手が置いて寝る`,
            };
          }

          if (!bed) {
            return { success: false, result: 'ベッドが見つかりません' };
          }

          await sleepPatiently(this.bot as never, bed);

          // 起床を待つ
          const rested = await new Promise<{ success: boolean; result: string; nightPassed: boolean }>((resolve) => {
            const timeout = setTimeout(() => {
              this.bot.removeListener('wake', onWake);
              resolve({
                success: true,
                result: '既存のベッドで眠りました',
                nightPassed: false,
              });
            }, 10000);

            const onWake = () => {
              clearTimeout(timeout);
              this.bot.removeListener('wake', onWake);
              resolve({
                success: true,
                result: '既存のベッドで眠り、朝になりました',
                nightPassed: true,
              });
            };

            this.bot.once('wake', onWake);
          });
          if (!rested.nightPassed && options.leaveIfNight && await this.getUpIfNight(true)) {
            return { ...rested, result: `${rested.result}が、夜は明けませんでした（ほかに起きているプレイヤーがいます）。起き上がりました` };
          }
          return rested;
        } catch (error: any) {
          // エラーを詳細化して返す
          let errorDetail = error.message;
          if (error.message.includes('too far')) {
            errorDetail = 'ベッドが遠すぎます';
          } else if (error.message.includes('monsters')) {
            errorDetail = '近くに敵がいます';
          } else if (error.message.includes('occupied')) {
            errorDetail = 'ベッドは使用中です';
          } else if (error.message.includes('ふさがって')) {
            errorDetail = obstructedAdvice(this.bot as never, bed!.position) ?? errorDetail;
          }
          return {
            success: false,
            result: `ベッドで眠ることができませんでした: ${errorDetail}`,
          };
        }
      }

      // インベントリにベッドがあるか確認
      const bedItem = this.bot.inventory
        .items()
        .find((i) => isBedName(i.name));

      if (!bedItem) {
        if (unreachable) return { success: false, failureType: 'no_bed_spot', recoverable: true, result: `持っているベッドは無く、${unreachable}` };
        return {
          success: false,
          result:
            'インベントリにベッドがなく、周囲にもベッドが見つかりませんでした',
        };
      }

      // ベッドを設置できる場所を探す
      this.plannedHead = null;
      this.plannedStand = null;
      this.failedStands.clear();
      let placePos: Vec3 | null = null;
      let hidden = '';
      // A spot is used from a stand (sleep range, reach, sight: utils/bedStand), the body's own cell first, then the nearest walk (run 21: a
      // rock passage one block wide, a wider cave a few steps off). A stand off the body's cell is walked to and the spot read again from
      // there; a walk that did not arrive marks the spot and the next one is tried (three walks at most). Nothing is dug here.
      const walkStarted = Date.now();
      let walkedAny = false;
      for (let attempt = 0; attempt <= 3; attempt++) {
        placePos = this.findPlaceForBed() ?? this.findWiderPlaceForBed();
        const stand = this.plannedStand as Vec3 | null;
        if (!placePos || !stand) break;
        if (attempt === 3) { noteBedSpotFailed(placePos); hidden = whatHides(this.bot as unknown as BedStandBot, placePos); placePos = null; break; }
        // The walks share what is left of the hand's 45 s after the place, the wait to fall asleep and the wake (about 20 s): one budget.
        const walkLeft = STAND_WALK_BUDGET_MS - (Date.now() - walkStarted);
        if (walkLeft < 2_000) { hidden = ''; placePos = null; this.plannedStand = null; break; }
        this.bot.pathfinder.stop();
        const walked = await gotoSafe(this.bot, new goals.GoalBlock(stand.x, stand.y, stand.z), { rockTravel: !options.noDig, timeoutMs: Math.min(15_000, walkLeft) });
        walkedAny = true;
        const now = this.bot.entity.position;
        const arrived = Math.floor(now.x) === stand.x && Math.floor(now.y) === stand.y && Math.floor(now.z) === stand.z;
        if (!walked?.success && !arrived) { this.failedStands.add(`${stand.x},${stand.y},${stand.z}`); noteBedSpotFailed(placePos); hidden = whatHides(this.bot as unknown as BedStandBot, placePos); placePos = null; this.plannedStand = null; }
      }
      // A mob that came during the walks is a reason not to lie down (the digging path below checks the same).
      if (placePos && walkedAny) {
        const mob = this.hostileWithinEight();
        if (mob) return { success: false, result: `ベッドを置く場所へ歩く間に、近くに敵が来たため寝られません（${mob.name}が${mob.distance.toFixed(1)}m先にいます）`, failureType: 'hostile_near', recoverable: true };
      }
      if (!placePos && options.noDig) {
        const inHazard = bodyInHazard(this.bot as unknown as BedStandBot);
        return { success: false, failureType: 'no_bed_spot', recoverable: true,
          result: 'ベッドを置ける2×1の床（上が空き）が、立てる所から見えて届く範囲に無い（周り3マスにも、10歩で行ける所にも。掘って作ることはしない）'
            + (inHazard ? '。体が水・火の中にいて立てる足場がない（そこから出てから sleep）' : '')
            + (hidden ? `。選んだ置き場所は ${hidden} に遮られて見えなかった` : '')
            + (inHazard ? '' : this.spotHands()) };
      }
      if (!placePos) {
        const prepared = await this.prepareBedSpot();
        if ('failure' in prepared) return { success: false, result: prepared.failure, failureType: prepared.failureType, recoverable: true };
        // The digging took a while: a mob that came meanwhile is still a reason not to lie down.
        const mob = this.hostileWithinEight();
        if (mob) return { success: false, result: `ベッドを置く場所を作りましたが、近くに敵がいるため寝られません（${mob.name}が${mob.distance.toFixed(1)}m先にいます）`, failureType: 'hostile_near', recoverable: true };
        placePos = prepared.pos;
        // A spot that was just made is kept as it is (the cells were cleared for it): walked to if it is not within reach.
        if (this.bot.entity.position.distanceTo(placePos) > 3) {
          this.bot.pathfinder.stop();
          await gotoSafe(this.bot, new goals.GoalNear(placePos.x, placePos.y, placePos.z, 2), { rockTravel: !options.noDig, timeoutMs: 15_000 });
        }
      }

      // ベッドを手に持つ
      await this.bot.equip(bedItem, 'hand');
      // A spot that was made lies along the cells that were cleared: the body faces the head cell, so the bed is laid that way.
      const plannedHead = this.plannedHead as Vec3 | null;
      if (plannedHead && typeof this.bot.lookAt === 'function') {
        try { await this.bot.lookAt(plannedHead.offset(0.5, 0.5, 0.5), true); } catch { /* placed as the body stands */ }
      }

      // 設置場所の下のブロックを参照ブロックとして使用
      const referenceBlock = this.bot.blockAt(placePos.offset(0, -1, 0));
      if (!referenceBlock) {
        return {
          success: false,
          result: 'ベッドを設置するための参照ブロックが見つかりませんでした',
        };
      }

      const foot = placePos;
      try {
        // ベッドを設置
        try {
          await this.bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
        } catch (error: any) {
          // end1108g S9: on a slow server the bed came later than the place's 1.5 s (three sleeps failed, then a plain place and sleep worked).
          if (!/did not answer within|did not fire within/u.test(String(error?.message ?? error))) throw error;
          let late = false;
          for (let waited = 0; waited < SLEEP_LATE_MS && !late; waited += 250) {
            await actionDelay(this.bot, 250);
            late = !!this.bedPlacedAt(foot);
          }
          if (!late) { noteBedSpotFailed(foot); throw error; }
        }
        await actionDelay(this.bot, 500);

        // 設置したベッドを、置いたマスで探す（目からの距離では探さない: run 6 は 3.3 離れた斜めのマスを見つけられなかった）
        const placedBed = this.bedPlacedAt(foot);

        if (!placedBed) {
          noteBedSpotFailed(foot);
          return { success: false, result: `ベッドの設置に失敗しました（(${foot.x}, ${foot.y}, ${foot.z}) に置いたはずのベッドが見えません）` };
        }

        // ベッドで寝る
        await sleepPatiently(this.bot as never, placedBed);

        // 起床を待つ
        const slept = await new Promise<{ success: boolean; result: string; woke: boolean }>((resolve) => {
          const timeout = setTimeout(() => {
            this.bot.removeListener('wake', onWake);
            resolve({ success: true, result: 'ベッドを設置して眠りました', woke: false });
          }, 10000);

          const onWake = () => {
            clearTimeout(timeout);
            this.bot.removeListener('wake', onWake);
            resolve({ success: true, result: 'ベッドを設置して眠り、朝になりました', woke: true });
          };

          this.bot.once('wake', onWake);
        });
        // Woken: the bed this call set down goes back into the pack (run 17 left its only bed where it slept and came to the next
        // night without one). Not while still asleep: that would wake the body.
        const at = placedBed.position ?? foot;
        const nightPassed = slept.woke;
        // The night did not pass (another player is awake): with `leaveIfNight` the body gets up and takes its bed back all the same.
        if (!slept.woke && options.leaveIfNight && await this.getUpIfNight(true)) slept.result += 'が、夜は明けませんでした（ほかに起きているプレイヤーがいます）。起き上がりました';
        else if (!slept.woke || this.bot.isSleeping) return { success: slept.success, nightPassed, bedLeft: true, result: `${slept.result}。置いたベッドは(${at.x}, ${at.y}, ${at.z})にあります（起きたら dig-block-at takeEquipment=true で拾えます）` };
        if (hostileNear(this.bot as any, PICKUP_SAFE_RANGE)) {
          return { success: true, nightPassed, bedLeft: true, result: `${slept.result}。敵が近いので、ベッド(${at.x}, ${at.y}, ${at.z})はそのままにしました（後で dig-block-at takeEquipment=true で拾えます）` };
        }
        const taken = await this.takeBedBack(at, placedBed.name);
        return { success: true, nightPassed, bedLeft: !taken.success, result: `${slept.result}。${taken.success ? 'ベッドは拾い直しました' : taken.notTaken}` };
      } catch (error: any) {
        // Run 6: the bed was set down and the sleep failed, and the pack had no bed for the rest of the run. Whatever failed after the
        // place, the bed goes back into the pack (not while an enemy is near, and not while the body lies in it).
        if (this.shouldInterrupt()) throw error;
        const note = await this.takeBedBackAfterFailure(foot);
        if (!note) throw error;
        throw new Error(`${error?.message ?? error}。${note}`);
      }
    } catch (error: any) {
      return { success: false, result: `${error.message}` };
    }
  }
}

export default SleepInBed;
