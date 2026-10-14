import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { structureNearby, STRUCTURE_MARKERS } from './findStructure.js';
import { exploreHeading, exploreLegs, type Heading } from '../utils/explore.js';

const log = createLogger('Minebot:Skill:exploreForStructure');

/**
 * 原子的スキル: 構造物を探して進む。find-structure は読み込み済みの範囲しか見ないので、見つからなければ「ここには
 * まだない」だけが分かる。要塞もネザー要塞も、探しに出なければ見つからない（旧 Minebot は計画器が探索を指示していた）。
 * 一区間ずつ進み、区間ごとに目印のブロックを読み直す。道がなければ横の方角へ切り替える。
 */
class ExploreForStructure extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'explore-for-structure';
    this.description = '構造物（fortress=ネザー要塞、bastion=砦の遺跡、village=村、stronghold=要塞）を探して、指定の方角へ一区間（約48ブロック）ずつ進みます。'
      + '区間ごとに読み込み範囲の目印を読み直し、見つかったら止まって座標を返します。道がなければ左右の方角へ切り替えます。'
      + 'ネザー要塞はネザーの中だけ。direction を省略すると、いま向いている方角へ進みます。';
    this.params = [
      { name: 'structureType', type: 'string', description: 'fortress / bastion / village / stronghold', required: true },
      { name: 'direction', type: 'string', description: 'north / south / east / west（省略時は向いている方角）', required: false },
      { name: 'maxDistance', type: 'number', description: '進む距離の上限（ブロック、48〜400、既定240）', required: false },
    ];
    this.maxDurationMs = 300_000;
  }

  async runImpl(structureType: string, direction?: string, maxDistance?: number) {
    const type = String(structureType ?? '').toLowerCase();
    if (!STRUCTURE_MARKERS[type] && type !== 'village') {
      return { success: false, result: `探せる構造物: fortress, bastion, village, stronghold`, failureType: 'invalid_input', recoverable: false };
    }
    const heading = exploreHeading(direction, this.bot.entity.yaw);
    if (!heading) return { success: false, result: 'direction は north / south / east / west で指定してください', failureType: 'invalid_input', recoverable: false };
    const start = this.bot.entity.position.clone();
    const found0 = structureNearby(this.bot as any, type);
    if (found0) return { success: true, result: `${type}の痕跡（${found0.name}）は既に見えています: 座標(${found0.position.x}, ${found0.position.y}, ${found0.position.z})` };
    const legs = exploreLegs(heading, Math.max(48, Math.min(400, Math.round(maxDistance ?? 240))));
    // Blocked ahead: the left of the original heading, then its right; never back over covered ground.
    const sides = [heading.left, heading.right];
    let current: Heading = heading, travelled = 0;
    const tried: string[] = [];
    // Each leg may take a hand-dug move's full time: stop while there is still time to say what was covered.
    const deadline = Date.now() + this.maxDurationMs - 20_000;
    for (const leg of legs) {
      if (this.shouldInterrupt() || Date.now() > deadline - 30_000) break;
      const at = this.bot.entity.position;
      const x = Math.round(at.x + current.dx * leg), z = Math.round(at.z + current.dz * leg);
      const moved = await this.callSkill('move-to', x, Math.round(at.y), z, 6, 'nearxz');
      const step = Math.hypot(this.bot.entity.position.x - at.x, this.bot.entity.position.z - at.z);
      travelled += step;
      tried.push(`${current.name}${Math.round(step)}m`);
      const found = structureNearby(this.bot as any, type);
      if (found) {
        try { (this.bot as any).placeMemory?.remember(type, found.position, { note: found.name }); } catch { /* memory is optional */ }
        log.info(`🧭 ${type} を発見: ${found.name} (${found.position.x}, ${found.position.y}, ${found.position.z})`);
        return { success: true, result: `${type}の痕跡（${found.name}）を発見: 座標(${found.position.x}, ${found.position.y}, ${found.position.z})、`
          + `ここから約${Math.round(this.bot.entity.position.distanceTo(found.position))}m。探索 ${Math.round(travelled)}m（${tried.join(' → ')}）` };
      }
      // No way on (water, a cliff, the move refused): the next side of the original heading.
      if (!moved.success && step < 8) {
        const next = sides.shift();
        if (!next) break;
        current = next;
      }
    }
    const end = this.bot.entity.position;
    return { success: false, failureType: 'target_not_found', recoverable: true,
      result: `${type}は見つかりませんでした。探索 ${Math.round(travelled)}m（${tried.join(' → ') || 'なし'}）、出発点から${Math.round(end.distanceTo(start))}m。`
        + '別の方角で続けるか、距離を伸ばしてください' };
  }
}

export default ExploreForStructure;
