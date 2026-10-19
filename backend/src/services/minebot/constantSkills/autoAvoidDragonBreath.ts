import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { toldVelocity } from '../utils/toldVelocity.js';
import { ConstantSkill, CustomBot } from '../types.js';

const log = createLogger('Minebot:Skill:autoAvoidDragonBreath');

/** How far the body goes from the danger. */
const FLEE_DISTANCE = 12;
/** A fireball that will land this near (horizontally) is fled from. */
const FIREBALL_REACH = 8;

type Hazard = { kind: 'fireball' | 'breath'; from: { position: Vec3 }; distance: number };

class AutoAvoidDragonBreath extends ConstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'auto-avoid-dragon-breath';
    this.description = 'エンドラのブレスを検知して避けます';
    this.interval = 1000; // より頻繁にチェック
    this.isLocked = false;
    this.priority = 12; // 高い優先度で実行
    this.status = true;
    this.containMovement = true;
  }

  /**
   * Where a cloud's field sits in its metadata, read from minecraft-data for the server's version: on 1.21.11 radius is 8
   * and particle 10 (the colour went into the particle in 1.20.5; the particle was 11 before). The particle is parsed,
   * `{ type: 'dragon_breath', ... }`.
   */
  private cloudIndex(key: 'particle' | 'radius', fallback: number): number {
    const keys = (this.bot as any).registry?.entitiesByName?.area_effect_cloud?.metadataKeys;
    const index = Array.isArray(keys) ? keys.indexOf(key) : -1;
    return index >= 0 ? index : fallback;
  }

  /** The danger this second, or null: only in the End, where the dragon's fireballs and breath are. */
  private hazard(): Hazard | null {
    const bot = this.bot as any;
    if (!String(bot.game?.dimension ?? '').includes('the_end') || !bot.entity?.position) return null;
    const botPos: Vec3 = bot.entity.position;
    // 1. ドラゴンの火の玉（dragon_fireball）: where it will land
    for (const fireball of Object.values(bot.entities ?? {}) as any[]) {
      if (fireball?.name !== 'dragon_fireball' || !fireball.position) continue;
      // The speed the server told of, not the library's: on 1.21.9 and later the library divides it by 8000 again,
      // and a ball it spawned is never given one at all (it stayed 0, so no ball was ever avoided). See toldVelocity.
      const velocity = (toldVelocity(bot, fireball.id) ?? fireball.velocity) as Vec3 | undefined;
      if (!velocity || velocity.y === 0) continue;
      const t = (botPos.y - fireball.position.y) / velocity.y;
      if (t <= 0) continue; // 既に通過済み or 上昇中
      // Away from where it will land: a ball still high overhead is more than 12 blocks off itself, and fleeing
      // from it would end at once with the body standing where the breath will spread.
      const landing = new Vec3(fireball.position.x + velocity.x * t, botPos.y, fireball.position.z + velocity.z * t);
      const distance = Math.hypot(landing.x - botPos.x, landing.z - botPos.z);
      if (distance < FIREBALL_REACH) return { kind: 'fireball', from: { position: landing }, distance };
    }
    // 2. ブレスの雲: the body inside it or at its edge (the cloud grows from 3 to 7 blocks)
    const particle = this.cloudIndex('particle', 10), radius = this.cloudIndex('radius', 8);
    const cloud = bot.nearestEntity?.((entity: any) => entity?.name === 'area_effect_cloud'
      && (entity.metadata?.[particle] as any)?.type === 'dragon_breath'
      && entity.position.distanceTo(botPos) <= Math.min(FLEE_DISTANCE, (Number(entity.metadata?.[radius]) || 6) + 2));
    return cloud ? { kind: 'breath', from: cloud, distance: cloud.position.distanceTo(botPos) } : null;
  }

  /** The breath does its harm in a second or two: a real danger takes the body from the task, as the other reflexes do. */
  protected override shouldPreempt(): boolean { return this.hazard() !== null; }

  /** Nothing near: not even the action is taken (it ran once a second, everywhere, for nothing). */
  override async run(...args: any[]): Promise<void> {
    if (this.status === false || this.hazard() === null) return;
    return super.run(...args);
  }

  async runImpl() {
    try {
      const hazard = this.hazard();
      if (!hazard) return;
      if (hazard.kind === 'fireball') log.warn('🐉 ドラゴンの火の玉を検知、回避行動を取ります');
      await this.bot.utils.runFromEntities(this.bot, [hazard.from as any], FLEE_DISTANCE);
    } catch (error: any) {
      log.error('エンドラのブレス回避中にエラー', error);
    }
  }
}

export default AutoAvoidDragonBreath;
