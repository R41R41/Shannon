import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { ConstantSkill, CustomBot } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { setMovements } from '../utils/setMovements.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:autoSeekLand');

const IDLE_COOLDOWN_MS = 30_000;
const SEEK_COOLDOWN_MS = 60_000;
const LAND_SEARCH_RADIUS = 48;
const MOVE_TIMEOUT_MS = 20_000;

class AutoSeekLand extends ConstantSkill {
  private lastSeekTime = 0;
  private isSeeking = false;
  private lastBusyTime = Date.now();

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'auto-seek-land';
    this.description = 'タスク非実行中に水中にいたら自動で陸地に移動する';
    this.interval = 1000;
    this.status = true;
    this.priority = 1;
    this.containMovement = true;
  }

  async runImpl() {
    const controlState = this.bot.minebotControlState;
    const isBusy = controlState && controlState !== 'idle';

    if (isBusy || this.bot.executingSkill) {
      this.lastBusyTime = Date.now();
      return;
    }

    if (this.isSeeking) return;

    const idleSinceBusy = Date.now() - this.lastBusyTime;
    if (idleSinceBusy < IDLE_COOLDOWN_MS) return;

    if (Date.now() - this.lastSeekTime < SEEK_COOLDOWN_MS) return;

    const isInWater = (this.bot.entity as any)?.isInWater;
    if (!isInWater) return;

    const landPos = this.findNearestLand();
    if (!landPos) {
      log.warn('🏝️ 近くに陸地が見つかりません');
      this.lastSeekTime = Date.now();
      return;
    }

    const dist = this.bot.entity.position.distanceTo(landPos);
    log.info(`🏝️ 水中で待機中 → 陸地へ移動 (${landPos.x.toFixed(0)}, ${landPos.y.toFixed(0)}, ${landPos.z.toFixed(0)}) 距離${dist.toFixed(0)}m`);

    this.isSeeking = true;
    this.lastSeekTime = Date.now();

    try {
      setMovements(this.bot, false, true, true, true, false, true, 1, true, true, 4, 1);
      const goal = new goals.GoalNear(landPos.x, landPos.y, landPos.z, 2);
      await gotoSafe(this.bot, goal, {
        timeoutMs: MOVE_TIMEOUT_MS,
        stuckAbortCount: 4,
        logStuck: false,
      });
      log.info('🏝️ 陸地に到着');
    } catch (err) {
      log.warn(`🏝️ 陸地への移動失敗: ${err}`);
    } finally {
      this.isSeeking = false;
    }
  }

  private findNearestLand(): Vec3 | null {
    const botPos = this.bot.entity.position;
    const bx = Math.floor(botPos.x);
    const by = Math.floor(botPos.y);
    const bz = Math.floor(botPos.z);

    let bestDist = Infinity;
    let bestPos: Vec3 | null = null;

    for (let r = 2; r <= LAND_SEARCH_RADIUS; r += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        for (let dz = -r; dz <= r; dz += 2) {
          if (Math.abs(dx) < r - 1 && Math.abs(dz) < r - 1) continue;

          const x = bx + dx;
          const z = bz + dz;

          for (let y = by - 4; y <= by + 8; y++) {
            try {
              const block = this.bot.blockAt(new Vec3(x, y, z));
              if (!block || block.boundingBox !== 'block') continue;
              if (block.name.includes('water') || block.name.includes('lava')) continue;

              const above1 = this.bot.blockAt(new Vec3(x, y + 1, z));
              const above2 = this.bot.blockAt(new Vec3(x, y + 2, z));
              if (!above1 || !above2) continue;
              if (above1.name !== 'air' || above2.name !== 'air') continue;

              const dist = Math.sqrt(dx * dx + dz * dz);
              if (dist < bestDist) {
                bestDist = dist;
                bestPos = new Vec3(x + 0.5, y + 1, z + 0.5);
              }
            } catch {
              continue;
            }
          }
        }
      }

      if (bestPos && bestDist <= r + 1) break;
    }

    return bestPos;
  }
}

export default AutoSeekLand;
