import pkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { CustomBot, ResponseType } from '../types.js';
import { gotoSafe } from './gotoSafe.js';
const { goals } = pkg;

const log = createLogger('Minebot:Goal');

export class GoalDistanceEntity {
  bot: CustomBot;
  timeout: number;
  constructor(bot: CustomBot) {
    this.bot = bot;
    this.timeout = 10 * 1000;
  }
  async run(entityId: number, distance: number): Promise<ResponseType> {
    const entity = this.bot.entities[entityId];
    if (!entity || !entity.position || !entity.velocity) {
      log.debug(`エンティティの位置情報が取得できません: ${entity}`);
      return {
        success: false,
        result: 'エンティティの位置情報が取得できません',
      };
    }
    // entityの速度を考慮して目標地点を計算
    const entitySpeedX = entity.velocity.x;
    const entitySpeedZ = entity.velocity.z;
    const botSpeed = 2;
    const adjustedTarget = this.calcTargetPositionWithVelocity(
      this.bot.entity.position.x,
      this.bot.entity.position.z,
      entity.position.x,
      entity.position.z,
      entitySpeedX,
      entitySpeedZ,
      distance,
      botSpeed
    );
    try {
      log.debug(`target: ${entity.name} x=${adjustedTarget.x} z=${adjustedTarget.z}`);
      if (isNaN(adjustedTarget.x) || isNaN(adjustedTarget.z)) {
        return {
          success: false,
          result: 'ゴールに到達できませんでした',
        };
      }
      const result = await gotoSafe(this.bot, new goals.GoalXZ(adjustedTarget.x, adjustedTarget.z), { timeoutMs: this.timeout });
      return result.success
        ? { success: true, result: 'ゴールに到達しました' }
        : { success: false, result: `ゴールに到達できませんでした（${result.error}）` };
    } catch (error) {
      log.error('Error in run', error);
      return { success: false, result: 'ゴールに到達できませんでした' };
    }
  }

  calcTargetPositionWithVelocity(
    botX: number,
    botZ: number,
    entityX: number,
    entityZ: number,
    entitySpeedX: number,
    entitySpeedZ: number,
    distance: number,
    botSpeed: number
  ): Vec3 {
    const dx = entityX - botX;
    const dz = entityZ - botZ;
    const vx = entitySpeedX;
    const vz = entitySpeedZ;
    log.debug(`dx=${dx} dz=${dz} vx=${vx} vz=${vz}`);

    // 速度がほぼ0なら現在位置を使う
    if (
      (Math.abs(vx) < 0.1 && Math.abs(vz) < 0.1) ||
      vx === undefined ||
      vz === undefined
    ) {
      // bot→entityのベクトルを計算
      const dx = botX - entityX;
      const dz = botZ - entityZ;
      const len = Math.sqrt(dx * dx + dz * dz);

      // 距離が0の場合は適当にX方向に逃がす
      if (len < 0.1) {
        return new Vec3(entityX + distance, 0, entityZ);
      }

      // 距離が正ならentityから離れる、負なら近づく
      const ratio = distance / len;
      return new Vec3(entityX + dx * ratio, 0, entityZ + dz * ratio);
    }

    const a = botSpeed * botSpeed - (vx * vx + vz * vz);
    const b = 2 * (dx * vx + dz * vz);
    const c = dx * dx + dz * dz - distance * distance;
    const D = b * b - 4 * a * c;
    if (D < 0 || Math.abs(a) < 0.1) {
      // 解なし、またはa=0で解けない場合は現在のentity位置を使う
      return new Vec3(entityX, 0, entityZ);
    }
    const t1 = (-b + Math.sqrt(D)) / (2 * a);
    const t2 = (-b - Math.sqrt(D)) / (2 * a);
    // tは正の値のみを採用
    const t = Math.max(t1, t2, 0);
    const ex = entityX + vx * t;
    const ez = entityZ + vz * t;
    const ddx = ex - botX;
    const ddz = ez - botZ;
    const len = Math.sqrt(ddx * ddx + ddz * ddz);
    if (len < 0.1 || distance < 0.1) {
      return new Vec3(botX, 0, botZ);
    }
    const ratio = distance / len;
    return new Vec3(botX + ddx * ratio, 0, botZ + ddz * ratio);
  }
}
