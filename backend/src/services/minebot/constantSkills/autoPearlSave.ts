import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { ConstantSkill, CustomBot } from '../types.js';

const log = createLogger('Minebot:Skill:autoPearlSave');

const FALL_VELOCITY_THRESHOLD = -0.4;
const PEARL_TELEPORT_DAMAGE = 5;
const COOLDOWN_MS = 3000;
const GROUND_SCAN_DEPTH = 100;
const PLATFORM_SEARCH_RADIUS = 50;
const MIN_DAMAGE_THRESHOLD = 6;

/**
 * 落下死回避スキル（エンド専用）
 *
 * 高所から落下中にエンダーパールを地面に投げて着地する。
 * ディメンション移動時に BotEventHandler が自動ON/OFFする。
 * 実際の投擲処理は throw-pearl インスタントスキルに委譲。
 */
class AutoPearlSave extends ConstantSkill {
  private lastThrowTime: number = 0;
  private isThrowing: boolean = false;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'auto-pearl-save';
    this.description = '落下死しそうな時にエンダーパールを投げて着地する（エンド用）';
    this.interval = 100;
    this.status = true;
    this.priority = 11;
    this.containMovement = false;
    this.isCritical = true;
  }

  async runImpl() {
    try {
      if (this.isThrowing) return;
      if (Date.now() - this.lastThrowTime < COOLDOWN_MS) return;

      const dim = String(this.bot.game?.dimension ?? '');
      if (!dim.includes('the_end')) return;

      const pos = this.bot.entity.position;
      const vy = this.bot.entity.velocity.y;

      if (vy >= FALL_VELOCITY_THRESHOLD) return;

      const groundY = this.findGroundBelow(pos);
      const fallHeight = groundY !== null ? pos.y - groundY : Infinity;
      const predictedDamage =
        fallHeight === Infinity ? Infinity : Math.max(0, fallHeight - 3);

      const currentHealth = this.bot.health ?? 20;

      log.info(
        `🟣 落下検知 vy=${vy.toFixed(2)} Y=${pos.y.toFixed(1)} 地面Y=${groundY ?? 'null(奈落?)'} 落差=${fallHeight === Infinity ? '∞' : fallHeight.toFixed(1)} 予測ダメ=${predictedDamage === Infinity ? '∞' : Math.round(predictedDamage)} HP=${currentHealth}`,
      );

      if (
        predictedDamage !== Infinity &&
        predictedDamage < MIN_DAMAGE_THRESHOLD
      ) {
        log.info(`🟣 ダメージ${Math.round(predictedDamage)}は閾値${MIN_DAMAGE_THRESHOLD}未満 → スキップ`);
        return;
      }

      const targetPos = this.findThrowTarget(groundY);
      if (!targetPos) {
        log.warn('🟣 パール投擲先が見つかりません（奈落？ チャンク未読込？）');
        return;
      }

      this.isThrowing = true;
      try {
        const throwSkill = this.bot.instantSkills.getSkill('throw-pearl');
        if (!throwSkill) {
          log.error('🟣 throw-pearl スキルが見つかりません');
          return;
        }

        log.info(
          `🟣 投擲先: (${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)}) 落差=${fallHeight === Infinity ? '∞' : fallHeight.toFixed(1)}m HP=${currentHealth}`,
        );

        const result = await throwSkill.runImpl(
          targetPos.x,
          targetPos.y,
          targetPos.z,
        );

        if (result.success) {
          this.lastThrowTime = Date.now();
          log.info(
            `🟣 ★ エンダーパール投擲完了！ ★ ${result.result}`,
            'magenta',
          );
        } else {
          log.warn(`🟣 投擲失敗: ${result.result}`);
        }
      } finally {
        this.isThrowing = false;
      }
    } catch (error: any) {
      this.isThrowing = false;
      log.error(`🟣 runImpl エラー: ${error.message}`, error);
    }
  }

  /**
   * パールの着弾目標を決定する。
   * エンド島の中心方向に地面を探索する。
   */
  private findThrowTarget(groundYBelow: number | null): Vec3 | null {
    const curPos = this.bot.entity.position;

    const toCenterX = -curPos.x;
    const toCenterZ = -curPos.z;
    const horizDistToCenter = Math.sqrt(toCenterX ** 2 + toCenterZ ** 2);

    const dirX = horizDistToCenter > 2 ? toCenterX / horizDistToCenter : 1;
    const dirZ = horizDistToCenter > 2 ? toCenterZ / horizDistToCenter : 0;

    const distances = [10, 15, 20, 25, 30, 35, 40, 8, 5];
    for (const dist of distances) {
      const tx = Math.floor(curPos.x + dirX * dist);
      const tz = Math.floor(curPos.z + dirZ * dist);
      const gy = this.findGroundAt(tx, tz, curPos.y + 10);
      if (gy !== null) {
        return new Vec3(tx + 0.5, gy, tz + 0.5);
      }
    }

    if (groundYBelow !== null) {
      const offsetDist = Math.min(5, horizDistToCenter);
      return new Vec3(
        curPos.x + dirX * offsetDist,
        groundYBelow,
        curPos.z + dirZ * offsetDist,
      );
    }

    return this.findNearestPlatform(curPos);
  }

  private findGroundBelow(pos: Vec3): number | null {
    return this.findGroundAt(Math.floor(pos.x), Math.floor(pos.z), pos.y);
  }

  private findGroundAt(x: number, z: number, fromY: number): number | null {
    const startY = Math.floor(fromY) - 1;
    const minY = Math.max(0, startY - GROUND_SCAN_DEPTH);

    for (let y = startY; y >= minY; y--) {
      const block = this.bot.blockAt(new Vec3(x, y, z));
      if (block && block.boundingBox === 'block') {
        return y + 1;
      }
    }
    return null;
  }

  private findNearestPlatform(pos: Vec3): Vec3 | null {
    let bestDist = Infinity;
    let bestPos: Vec3 | null = null;

    for (let r = 3; r <= PLATFORM_SEARCH_RADIUS; r += 3) {
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 6) {
        const x = Math.floor(pos.x + Math.cos(angle) * r);
        const z = Math.floor(pos.z + Math.sin(angle) * r);
        const searchMinY = Math.max(0, Math.floor(pos.y) - 30);
        const searchMaxY = Math.floor(pos.y) + 5;

        for (let y = searchMaxY; y >= searchMinY; y--) {
          const block = this.bot.blockAt(new Vec3(x, y, z));
          if (block && block.boundingBox === 'block') {
            const surfacePos = new Vec3(x + 0.5, y + 1, z + 0.5);
            const dist = pos.distanceTo(surfacePos);
            if (dist < bestDist) {
              bestDist = dist;
              bestPos = surfacePos;
            }
            break;
          }
        }
      }
      if (bestPos) return bestPos;
    }
    return bestPos;
  }
}

export default AutoPearlSave;
