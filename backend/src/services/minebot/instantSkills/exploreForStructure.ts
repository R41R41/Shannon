import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { structureNearby, STRUCTURE_MARKERS } from './findStructure.js';
import { exploreHeading, exploreLegs, type Heading } from '../utils/explore.js';
import { sheepWool, WOOL_COLORS } from '../utils/nightGate.js';
import type { Vec3 } from 'vec3';

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
    this.description = '構造物（fortress=ネザー要塞、bastion=砦の遺跡、village=村、stronghold=要塞）か動物（sheep / cow / pig / chicken / rabbit / food_animals）を探して、指定の方角へ一区間（約48ブロック）ずつ進みます。'
      + '区間ごとに読み込み範囲の目印（動物なら見えている動物）を読み直し、見つかったら止まって座標を返します。道がなければ左右の方角へ切り替えます。'
      + 'ネザー要塞はネザーの中だけ。direction を省略すると、いま向いている方角へ進みます。羊は color で毛の色を指定できます（ベッドには同じ色が3個）。';
    this.params = [
      { name: 'structureType', type: 'string', description: 'fortress / bastion / village / stronghold、または動物 sheep / cow / pig / chicken / rabbit / food_animals', required: true },
      { name: 'direction', type: 'string', description: 'north / south / east / west（省略時は向いている方角）', required: false },
      { name: 'maxDistance', type: 'number', description: '進む距離の上限（ブロック、48〜400、既定240）', required: false },
      { name: 'color', type: 'string', description: '羊を探す時だけ: 毛の色（例 white、brown）。毛を刈られた羊は数えない', required: false },
    ];
    this.maxDurationMs = 300_000;
  }

  async runImpl(structureType: string, direction?: string, maxDistance?: number, color?: string) {
    const type = String(structureType ?? '').toLowerCase();
    const animals = ANIMAL_TARGETS[type];
    if (!STRUCTURE_MARKERS[type] && type !== 'village' && !animals) {
      return { success: false, result: `探せるもの: fortress, bastion, village, stronghold, ${Object.keys(ANIMAL_TARGETS).join(', ')}`, failureType: 'invalid_input', recoverable: false };
    }
    const woolColor = String(color ?? '').trim().toLowerCase().replace(/_wool$/, '');
    if (woolColor && !(WOOL_COLORS as readonly string[]).includes(woolColor)) {
      return { success: false, failureType: 'invalid_input', recoverable: false, result: `羊の色 ${woolColor} はありません（使える色: ${WOOL_COLORS.join(', ')}）` };
    }
    const heading = exploreHeading(direction, this.bot.entity.yaw);
    if (!heading) return { success: false, result: 'direction は north / south / east / west で指定してください', failureType: 'invalid_input', recoverable: false };
    const start = this.bot.entity.position.clone();
    if (animals) return this.exploreForAnimals(type, animals, woolColor, heading, maxDistance, start);
    const found0 = structureNearby(this.bot as any, type);
    if (found0) return { success: true, result: `${type}の痕跡（${found0.name}）は既に見えています: 座標(${found0.position.x}, ${found0.position.y}, ${found0.position.z})` };
    const legs = exploreLegs(heading, Math.max(48, Math.min(400, Math.round(maxDistance ?? 240))));
    // Blocked ahead: the left of the original heading, then its right; never back over covered ground.
    const sides = [heading.left, heading.right];
    let current: Heading = heading, travelled = 0;
    const tried: string[] = [];
    // Each leg may take a hand-dug move's full time: stop while there is still time to say what was covered.
    const deadline = Date.now() + this.maxDurationMs - 10_000;
    for (const leg of legs) {
      // A leg may take a whole move's time (two minutes when digging by hand): start one only when it fits.
      if (this.shouldInterrupt() || Date.now() > deadline - 125_000) break;
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
          + `ここから約${Math.round(this.bot.entity.position.distanceTo(found.position as Vec3))}m。探索 ${Math.round(travelled)}m（${tried.join(' → ')}）` };
      }
      // No way on (water, a cliff, the move refused): the next side of the original heading.
      if (!moved.success && step < 8) {
        const next = sides.shift();
        if (!next) break;
        current = next;
      } else if (current !== heading) current = heading; // round the obstacle, then on along the original heading
    }
    const end = this.bot.entity.position;
    return { success: false, failureType: 'target_not_found', recoverable: true,
      result: `${type}は見つかりませんでした。探索 ${Math.round(travelled)}m（${tried.join(' → ') || 'なし'}）、出発点から${Math.round(end.distanceTo(start))}m。`
        + '別の方角で続けるか、距離を伸ばしてください' };
  }

  /** The nearest animal of these kinds the body can see now (a sheep of the colour, not shorn), or null. */
  private animalInSight(kinds: string[], color: string): { name: string; position: Vec3; distance: number; color?: string } | null {
    const at = this.bot.entity.position;
    let best: { name: string; position: Vec3; distance: number; color?: string } | null = null;
    for (const entity of Object.values(this.bot.entities ?? {}) as any[]) {
      if (!entity?.position || !kinds.includes(entity.name)) continue;
      let woolColor: string | undefined;
      if (entity.name === 'sheep') {
        const wool = sheepWool(this.bot as any, entity);
        if (wool?.sheared || (color && wool?.color !== color)) continue;
        woolColor = wool?.color;
      } else if (color) continue;
      const distance = at.distanceTo(entity.position);
      if (!best || distance < best.distance) best = { name: entity.name, position: entity.position.floored(), distance, ...(woolColor ? { color: woolColor } : {}) };
    }
    return best;
  }

  /**
   * The search for animals: the same legs as for a structure, looking after each leg for the kind among what the body can see. Run 18
   * saw one sheep in thirty minutes (D1 to D6) and could make no bed; nothing would take it to look for more.
   */
  private async exploreForAnimals(type: string, kinds: string[], color: string, heading: Heading, maxDistance: number | undefined, start: Vec3) {
    const what = `${type === 'food_animals' ? '食料になる動物' : type}${color ? `（${color}）` : ''}`;
    const said = (found: NonNullable<ReturnType<ExploreForStructure['animalInSight']>>, travelled: number, tried: string[]) => ({ success: true,
      result: `${found.name}${found.color ? `（${found.color}）` : ''}を発見: 座標(${found.position.x}, ${found.position.y}, ${found.position.z})、ここから約${Math.round(found.distance)}m。`
        + (travelled ? `探索 ${Math.round(travelled)}m（${tried.join(' → ')}）。` : '')
        + `attack-continuously ${found.name}${found.color ? ` color=${found.color}` : ''} で狩れる` });
    const seen0 = this.animalInSight(kinds, color);
    if (seen0) return said(seen0, 0, []);
    const legs = exploreLegs(heading, Math.max(48, Math.min(400, Math.round(maxDistance ?? 240))));
    const sides = [heading.left, heading.right];
    let current: Heading = heading, travelled = 0;
    const tried: string[] = [];
    const deadline = Date.now() + this.maxDurationMs - 10_000;
    for (const leg of legs) {
      if (this.shouldInterrupt() || Date.now() > deadline - 125_000) break;
      const at = this.bot.entity.position;
      const x = Math.round(at.x + current.dx * leg), z = Math.round(at.z + current.dz * leg);
      const moved = await this.callSkill('move-to', x, Math.round(at.y), z, 6, 'nearxz');
      const step = Math.hypot(this.bot.entity.position.x - at.x, this.bot.entity.position.z - at.z);
      travelled += step;
      tried.push(`${current.name}${Math.round(step)}m`);
      const seen = this.animalInSight(kinds, color);
      if (seen) { log.info(`🧭 ${what} を発見: ${seen.name} (${seen.position.x}, ${seen.position.y}, ${seen.position.z})`); return said(seen, travelled, tried); }
      if (!moved.success && step < 8) {
        const next = sides.shift();
        if (!next) break;
        current = next;
      } else if (current !== heading) current = heading;
    }
    const end = this.bot.entity.position;
    return { success: false, failureType: 'target_not_found', recoverable: true,
      result: `${what}は見つかりませんでした。探索 ${Math.round(travelled)}m（${tried.join(' → ') || 'なし'}）、出発点から${Math.round(end.distanceTo(start))}m。`
        + '別の方角で続けるか、距離を伸ばしてください（羊は草地・平原に多い）' };
  }
}

/** The animals explore-for-structure looks for, by the word it is given. */
const ANIMAL_TARGETS: Record<string, string[]> = {
  sheep: ['sheep'], cow: ['cow', 'mooshroom'], pig: ['pig'], chicken: ['chicken'], rabbit: ['rabbit'],
  food_animals: ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'],
};

export default ExploreForStructure;
