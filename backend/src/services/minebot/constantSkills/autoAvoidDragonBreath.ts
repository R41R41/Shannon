import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { toldVelocity } from '../utils/toldVelocity.js';
import { ConstantSkill, CustomBot } from '../types.js';

const log = createLogger('Minebot:Skill:autoAvoidDragonBreath');

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
   * Where a cloud's particle sits in its metadata, read from minecraft-data for the server's version: 10 on 1.21.11
   * (radius 8, waiting 9, particle 10, since the colour went into the particle in 1.20.5; it was 11 before).
   * The value is the parsed particle, `{ type: 'dragon_breath', ... }`.
   */
  private particleIndex(): number {
    const keys = (this.bot as any).registry?.entitiesByName?.area_effect_cloud?.metadataKeys;
    const index = Array.isArray(keys) ? keys.indexOf('particle') : -1;
    return index >= 0 ? index : 10;
  }

  async runImpl() {
    try {
      // Dragon fireballs and their breath are only in the End.
      if (!String((this.bot as any).game?.dimension ?? '').includes('the_end')) return;
      // ---------------------------
      // 1. ドラゴンの火の玉（dragon_fireball）を回避
      // ---------------------------
      const botPos = this.bot.entity.position.clone();
      const fireballs = Object.values(this.bot.entities).filter(
        (e) => e.name === 'dragon_fireball'
      );

      for (const fireball of fireballs) {
        // The speed the server told of, not the library's: on 1.21.9 and later the library divides it by 8000 again,
        // and a ball it spawned is never given one at all (it stayed 0, so no ball was ever avoided). See toldVelocity.
        const velocity = (toldVelocity(this.bot as any, fireball.id) ?? (fireball as any).velocity) as Vec3 | undefined;
        if (!velocity) continue;

        // bot の高さに到達するまでの時間 t を計算 (単位: tick)
        // velocity.y が 0 または bot より上に向かう場合は無視
        if (velocity.y === 0) continue;
        const t = (botPos.y - fireball.position.y) / velocity.y;
        if (t <= 0) continue; // 既に通過済み or 上昇中

        // 予測衝突位置を算出
        const predictedPos = new Vec3(
          fireball.position.x + velocity.x * t,
          botPos.y, // 同じ高さに合わせる
          fireball.position.z + velocity.z * t
        );

        const horizontalDistance = Math.sqrt(
          Math.pow(predictedPos.x - botPos.x, 2) +
            Math.pow(predictedPos.z - botPos.z, 2)
        );

        // 8 ブロック以内に着弾する見込みなら回避
        if (horizontalDistance < 8) {
          log.warn('🐉 ドラゴンの火の玉を検知、回避行動を取ります');
          // Away from where it will land: a ball still high overhead is more than 12 blocks off itself, and fleeing
          // from it would end at once with the body standing where the breath will spread.
          await this.bot.utils.runFromEntities(this.bot, [{ position: predictedPos } as any], 12);
          // 危険は一度回避したら他の火の玉は無視 (過剰反応防止)
          break;
        }
      }

      // ---------------------------
      // エンドラのブレスエフェクトを検索
      const particle = this.particleIndex();
      const dragonBreath = this.bot.nearestEntity(
        (entity) =>
          entity.name === 'area_effect_cloud' &&
          entity.position.distanceTo(this.bot.entity.position) <= 8 &&
          (entity.metadata?.[particle] as any)?.type === 'dragon_breath'
      );

      if (!dragonBreath) {
        return;
      }

      // ブレスの位置を取得
      const breathPos = dragonBreath.position;
      const botPos2 = this.bot.entity.position;

      // ブレスからの距離を計算
      const distance = botPos2.distanceTo(breathPos);

      // ブレスが近すぎる場合（8ブロック以内）
      if (distance < 8) {
        await this.bot.utils.runFromEntities(this.bot, [dragonBreath], 12);
      }
    } catch (error: any) {
      log.error('エンドラのブレス回避中にエラー', error);
    }
  }
}

export default AutoAvoidDragonBreath;
