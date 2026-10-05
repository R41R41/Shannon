import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { scanDryFootholds, spreadFootholds } from './findDryFootholds.js';
import { rankByRoute } from '../utils/routeEstimate.js';
import { setMovements } from '../utils/setMovements.js';
import { swimOntoBank, waterLevelUnderBody } from '../utils/exitWater.js';
import { holdsWater } from '../utils/waterBlocks.js';
import { waitForObservation } from '../execution/observedWait.js';

const log = createLogger('Minebot:Skill:leaveWater');

const TOWER_BLOCKS = new Set(['cobblestone', 'dirt', 'stone', 'netherrack', 'oak_planks', 'spruce_planks', 'birch_planks',
  'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'sand', 'gravel', 'sandstone']);
const FOOTHOLD_ATTEMPTS = 4;
const TOWER_ROUNDS = 4;
/** How far to look for a shore, how many places to ask the navigator about, and how far apart they must be. */
const SHORE_RADIUS = 48;
const ROUTE_SEPARATION = 6;
/**
 * Footing within this height of the floating body is a bank it can swim onto; anything else (a cliff top, a
 * cave under the lake) needs digging or building. The nearest few of each kind are put to the navigator, banks
 * first: taking the nearest in a straight line whatever its height chose a cliff top three times running (L32).
 */
const BANK_HEIGHT = 2;
/** Thinking time per place: a 30-block swim to a bank took the navigator about half a second (lab). */
const ROUTE_THINK_MS = 700;
const BANK_CANDIDATES = 4;
const OTHER_CANDIDATES = 3;
/** Steps are cut only into a wall the body is beside. */
const WALL_REACH = 3;
/** The floor a tower is built up from must be this close under the surface: the body has to sink to it and stack back up on one breath. */
const TOWER_MAX_DEPTH = 6;

/**
 * Out of the water onto dry footing, by whatever the place allows: climb a
 * bank at the waterline, walk or swim to nearby dry ground, cut steps into a
 * wall, or stack blocks up out of a shaft. These moves existed only inside the
 * suffocation emergency. Now that an idle body floats and breathes, that
 * emergency no longer fires in a pool, so the planner needs to be able to ask
 * for the same thing itself (a bot floated in a hole in the ice for a minute
 * with move-to failing, paid run L25).
 */
class LeaveWater extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'leave-water';
    this.description = '水に浮いている・浸かっている状態から乾いた足場へ上がる。水際の岸へ泳ぎ上がる、近くの乾いた足場へ移動する、'
      + '壁に段を掘る、手持ちのブロックを足元に積んで水面の上へ出る、を順に試す。池・川・水没した縦穴・氷の穴から出る時に使う。'
      + '足場は48ブロック以内から、実際にたどり着きやすい岸を選ぶ。その範囲に岸が無い広い水域では失敗するので、find-dry-footholds（radius 64まで）で岸を探して move-to する。';
    this.params = [];
  }

  private afloat(): boolean {
    return (this.bot.entity as any)?.isInWater === true || waterLevelUnderBody(this.bot as any) !== null;
  }

  async runImpl() {
    if (!this.bot.entity) return { success: false, result: 'Botの位置が不明です', failureType: 'not_ready', recoverable: true };
    if (!this.afloat()) return { success: true, result: '水の中にいません（すでに乾いた足場の上です）' };
    const tried: string[] = [];
    const out = (how: string) => {
      const here = this.bot.entity.position;
      log.info(`🏊 ${how}（現在: ${here.x.toFixed(1)}, ${here.y.toFixed(1)}, ${here.z.toFixed(1)}）`);
      return { success: true, result: `${how}。現在位置: (${here.x.toFixed(1)}, ${here.y.toFixed(1)}, ${here.z.toFixed(1)})` };
    };

    // 1. A bank right beside the body, at the waterline.
    const position = this.bot.entity.position;
    if (await swimOntoBank(this.bot as any, position.x, position.z) && !this.afloat()) return out('水際の岸へ泳ぎ上がりました');

    // 2. Dry footing in sight: go to the one the navigator can actually reach most cheaply (move-to climbs a
    // bank on arrival). The nearest in a straight line was a cliff top three times running while a bank the body
    // could swim onto lay further along the shore, and each failed trip carried the body somewhere else (L32):
    // every attempt looks again from where the body now is.
    const moveTo = this.bot.instantSkills.getSkill('move-to');
    const stairMine = this.bot.instantSkills.getSkill('stair-mine');
    const visited = new Set<string>();
    let sawFooting = false;
    for (let attempt = 0; attempt < FOOTHOLD_ATTEMPTS && moveTo; attempt++) {
      if (this.shouldInterrupt()) return { success: false, result: '中断されました', failureType: 'interrupted', recoverable: true };
      const seen = scanDryFootholds(this.bot as any, { radius: SHORE_RADIUS, maxVertical: 12, wide: true }).candidates;
      sawFooting ||= seen.length > 0;
      const untried = seen.filter(site => !visited.has(`${Math.floor(site.x)},${site.y},${Math.floor(site.z)}`));
      const fresh = [
        ...spreadFootholds(untried.filter(site => Math.abs(site.verticalDelta) <= BANK_HEIGHT), BANK_CANDIDATES, ROUTE_SEPARATION),
        ...spreadFootholds(untried.filter(site => Math.abs(site.verticalDelta) > BANK_HEIGHT), OTHER_CANDIDATES, ROUTE_SEPARATION)];
      if (!fresh.length) break;
      // The same movement settings move-to uses from the water, and the head kept up while the routes are thought through.
      if ((this.bot as any).pathfinder) setMovements(this.bot, false, true, true, true, true, true, 8, true, true, 4, 2);
      this.bot.setControlState('jump', true);
      // A route little longer than the straight line is as good as it gets: no need to think about the rest.
      const site = (await rankByRoute(this.bot as any, fresh, { timeoutMs: ROUTE_THINK_MS,
        goodEnough: (candidate, route) => route.cost <= 3 * candidate.distance + 10 }))[0];
      this.bot.setControlState('jump', false);
      visited.add(`${Math.floor(site.x)},${site.y},${Math.floor(site.z)}`);
      log.info(`🏊 足場候補${fresh.length}件のうち(${site.x.toFixed(1)}, ${site.y}, ${site.z.toFixed(1)})へ（経路${site.route?.reachable ? `コスト${site.route.cost.toFixed(0)}` : '未確定'}、直線${site.distance.toFixed(1)}m）`);
      const from = this.bot.entity.position.clone();
      const moved: any = await moveTo.run(site.x, site.y, site.z, 1.2, 'near');
      if (!this.afloat()) return out(`乾いた足場(${site.x.toFixed(1)}, ${site.y}, ${site.z.toFixed(1)})へ上がりました`);
      tried.push(`足場(${site.x.toFixed(1)}, ${site.y}, ${site.z.toFixed(1)})へ移動: ${String(moved?.result ?? '失敗').slice(0, 80)}`);
      const here = this.bot.entity.position;
      const remaining = Math.hypot(site.x - here.x, site.z - here.z);
      // Still closing in on it (a long swim outlasts one move): keep going to the same shore.
      if (remaining < Math.hypot(site.x - from.x, site.z - from.z) - 2) visited.delete(`${Math.floor(site.x)},${site.y},${Math.floor(site.z)}`);
      const hasPickaxe = this.bot.inventory.items().some(item => item.name.endsWith('_pickaxe'));
      if (stairMine && hasPickaxe && site.y > here.y && remaining <= WALL_REACH) {
        const dx = site.x - here.x, dz = site.z - here.z;
        const direction = Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 'east' : 'west') : (dz >= 0 ? 'south' : 'north');
        await stairMine.run(site.y, direction, 'cobblestone');
        if (!this.afloat()) return out(`${direction}の壁に段を掘って上がりました`);
        tried.push(`${direction}の壁に段を掘る: 水から出られず`);
      }
    }

    // 3. No footing in reach (a flooded shaft): stack blocks under the feet up past the water.
    // The body sinks while it places, so the height still to go is measured again after each lift.
    const tower = this.bot.instantSkills.getSkill('tower-up');
    const blocksLeft = () => this.bot.inventory.items().filter(item => TOWER_BLOCKS.has(item.name)).reduce((total, item) => total + item.count, 0);
    // Only from a floor the body can sink to and build back up from: over deep water there is nothing to stand
    // the first block on, and each try let the body sink further (five blocks under in L32).
    const floorDepth = () => {
      const feet = this.bot.entity.position.floored();
      for (let depth = 0; depth <= TOWER_MAX_DEPTH; depth++) {
        const below = this.bot.blockAt(feet.offset(0, -depth - 1, 0));
        if (!below) return null;
        if (below.boundingBox === 'block') return depth;
        if (!holdsWater(below)) return null;
      }
      return null;
    };
    if (!tower || blocksLeft() === 0) tried.push('足元に積めるブロックを持っていません');
    else if (floorDepth() === null) tried.push(`足元に積む: 水底が深い（${TOWER_MAX_DEPTH}ブロックより下）ので土台がありません`);
    else {
      let lifted = 0;
      for (let round = 0; round < TOWER_ROUNDS && blocksLeft() > 0 && !this.shouldInterrupt(); round++) {
        // Let the body land on what it just built: a lift started in mid-air finds nothing under the feet.
        if (round > 0) await waitForObservation(this.bot, () => this.bot.entity.onGround === true, 1500);
        const feet = this.bot.entity.position.floored();
        let depth = 0;
        while (depth < 10 && holdsWater(this.bot.blockAt(feet.offset(0, depth, 0)))) depth++;
        const height = Math.min(Math.max(depth, 1), blocksLeft());
        const stacked: any = await tower.run(height);
        lifted += height;
        if (!this.afloat()) return out(`足元にブロックを積んで水面の上へ出ました（${lifted}段）`);
        if (round === TOWER_ROUNDS - 1 || blocksLeft() === 0) tried.push(`足元に積む: ${String(stacked?.result ?? '失敗').slice(0, 80)}`);
      }
    }

    return { success: false, failureType: 'still_in_water', recoverable: true,
      result: `水から出られませんでした。${sawFooting ? '' : `${SHORE_RADIUS}ブロック以内の読み込み済み範囲に乾いた足場がありません。`}試したこと: ${tried.join(' / ') || 'なし'}。`
        + '呼吸は水面で確保できます。find-dry-footholds（radius 64まで）で岸を探して move-to するか、足場にするブロックを用意してください' };
  }
}

export default LeaveWater;
