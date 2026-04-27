import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { ConstantSkill, CustomBot } from '../types.js';
const log = createLogger('Minebot:Skill:autoAvoidDragonBreath');

const CLOUD_DANGER_RADIUS = 6;
const FIREBALL_DETECT_RANGE = 60;
const TRACE_STEP = 0.5;
const TRACE_MAX_BLOCKS = 120;
const FLEE_DISTANCE = 10;
const FLEE_DISTANCE_TETHERED = 4;
const FLEE_TIMEOUT_MS = 3000;
const FLEE_COOLDOWN_MS = 800;
const DIRECTION_CANDIDATES = 12;
const DRAGON_HEAD_OFFSET = 4;
const DRAGON_HEAD_CONE_LENGTH = 8;

const FOUNTAIN_TETHER_RADIUS = 8;
const GOAL_ATTRACTION_RATIO = 0.5;
const GOAL_PROGRESS_WEIGHT = 2.0;

class AutoAvoidDragonBreath extends ConstantSkill {
  private lastFleeTime = 0;
  private tickCount = 0;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'auto-avoid-dragon-breath';
    this.description =
      'エンドラの火の玉の着弾地点を予測し、ドラゴンブレスの滞留範囲から自動回避します';
    this.interval = 100;
    this.isLocked = false;
    this.priority = 12;
    this.isCritical = true;
    this.status = true;
    this.containMovement = true;
  }

  private isBedBombActive(): boolean {
    return !!(this.bot as any)._bedBombActive;
  }

  async runImpl() {
    try {
      if (this.bot.game.dimension !== 'the_end') return;

      this.tickCount++;
      if (this.tickCount % 100 === 1) {
        const entityTypes = new Map<string, number>();
        for (const e of Object.values(this.bot.entities)) {
          const n = e.name ?? 'unknown';
          entityTypes.set(n, (entityTypes.get(n) ?? 0) + 1);
        }
        const summary = [...entityTypes.entries()]
          .filter(([n]) => n.includes('dragon') || n.includes('fireball') || n.includes('area_effect') || n.includes('cloud'))
          .map(([n, c]) => `${n}:${c}`)
          .join(', ') || 'none';
        log.info(`🐉 heartbeat tick=${this.tickCount} entities=[${summary}]`);
      }

      if (Date.now() - this.lastFleeTime < FLEE_COOLDOWN_MS) return;

      const botPos = this.bot.entity.position;
      const pathfinderMoving = !!(this.bot.pathfinder as any)?.isMoving?.();
      const { clouds, urgent } = this.collectDangerZonesSplit(botPos);

      const dangers = pathfinderMoving ? urgent : [...clouds, ...urgent];
      if (dangers.length === 0) return;

      const nearestDist = this.nearestDangerHDist(botPos, dangers);
      if (nearestDist > CLOUD_DANGER_RADIUS) return;

      const tethered = this.isBedBombActive();
      const fleeDist = tethered ? FLEE_DISTANCE_TETHERED : FLEE_DISTANCE;

      const allDangers = [...clouds, ...urgent];
      const goalPos = pathfinderMoving ? this.getPathfinderGoalPos() : null;
      const target = this.findSafeFleeTarget(botPos, allDangers, fleeDist, tethered, goalPos);
      if (!target) return;

      const skippedInfo = pathfinderMoving && clouds.length > 0
        ? `, pf-routing-around-${clouds.length}clouds` : '';
      log.info(
        `🐉 回避(${dangers.length}zones, nearest=${nearestDist.toFixed(1)}m${tethered ? ', tethered' : ''}${pathfinderMoving ? ', pf-active' : ''}${skippedInfo}${goalPos ? `, goal=(${goalPos.x.toFixed(0)},${goalPos.z.toFixed(0)})` : ''}): → (${target.x.toFixed(1)}, ${target.z.toFixed(1)})`,
      );

      this.lastFleeTime = Date.now();

      if (pathfinderMoving) {
        try { this.bot.pathfinder.stop(); } catch { /* ignore */ }
        log.info('🐉 パスファインダーを一時停止して緊急回避（gotoSafe retry で再開）');
      }

      try {
        await this.bot.lookAt(new Vec3(target.x, botPos.y + 1.6, target.z));
      } catch { /* ignore */ }
      this.bot.setControlState('forward', true);
      this.bot.setControlState('sprint', true);
      this.bot.setControlState('jump', true);

      await new Promise<void>(r => setTimeout(r, 400));

      this.bot.setControlState('forward', false);
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('jump', false);
    } catch (error: any) {
      log.error('エンドラ回避エラー', error);
    }
  }

  /**
   * danger を clouds（パスファインダーが迂回処理）と urgent（火の玉のみ・即時回避）に分離。
   * - clouds: 残留ブレス + ドラゴン頭部正面コーン → exclusionAreasStep で迂回
   * - urgent: 火の玉着弾予測 → パスファインダーを止めて即座に直接回避
   */
  private collectDangerZonesSplit(botPos: Vec3): { clouds: Vec3[]; urgent: Vec3[] } {
    const clouds: Vec3[] = [];
    const urgent: Vec3[] = [];

    for (const entity of Object.values(this.bot.entities)) {
      if (entity.name === 'area_effect_cloud') {
        clouds.push(entity.position);
      }
    }

    const fireballs = Object.values(this.bot.entities).filter(
      (e) =>
        e.name === 'dragon_fireball' &&
        e.position.distanceTo(botPos) < FIREBALL_DETECT_RANGE,
    );
    for (const fb of fireballs) {
      const vel = (fb as any).velocity as Vec3 | undefined;
      if (!vel || vel.norm() < 0.01) continue;
      const landing = this.traceFireballLanding(fb.position, vel);
      if (landing) {
        urgent.push(landing);
        const hDist = Math.sqrt(
          (landing.x - botPos.x) ** 2 + (landing.z - botPos.z) ** 2,
        );
        if (hDist < CLOUD_DANGER_RADIUS) {
          log.warn(
            `🐉 火の玉着弾予測: (${landing.x.toFixed(1)}, ${landing.y.toFixed(1)}, ${landing.z.toFixed(1)}) 距離=${hDist.toFixed(1)}m`,
          );
        }
      }
    }

    const dragon = this.bot.nearestEntity(e => e.name === 'ender_dragon');
    if (dragon) {
      const dx = Math.abs(dragon.position.x);
      const dz = Math.abs(dragon.position.z);
      const hDist = Math.sqrt(dx * dx + dz * dz);
      const phase = dragon.metadata?.[16];
      const isNearFountain = hDist < 20 && dragon.position.y < 100;
      const isPerchRelated = typeof phase === 'number' && phase >= 2 && phase <= 5;

      if (isNearFountain || isPerchRelated) {
        const yaw = dragon.yaw ?? 0;
        const headX = dragon.position.x - Math.sin(yaw) * DRAGON_HEAD_OFFSET;
        const headZ = dragon.position.z + Math.cos(yaw) * DRAGON_HEAD_OFFSET;
        const headY = dragon.position.y;
        clouds.push(new Vec3(headX, headY, headZ));

        const faceDirX = -Math.sin(yaw);
        const faceDirZ = Math.cos(yaw);
        for (let step = 1; step <= 3; step++) {
          clouds.push(new Vec3(
            headX + faceDirX * step * (DRAGON_HEAD_CONE_LENGTH / 3),
            headY,
            headZ + faceDirZ * step * (DRAGON_HEAD_CONE_LENGTH / 3),
          ));
        }
      }
    }

    return { clouds, urgent };
  }

  private nearestDangerHDist(botPos: Vec3, dangers: Vec3[]): number {
    let min = Infinity;
    for (const d of dangers) {
      const hDist = Math.sqrt((d.x - botPos.x) ** 2 + (d.z - botPos.z) ** 2);
      if (hDist < min) min = hDist;
    }
    return min;
  }

  private isPositionSafe(pos: Vec3, dangers: Vec3[]): boolean {
    for (const d of dangers) {
      const hDist = Math.sqrt((pos.x - d.x) ** 2 + (pos.z - d.z) ** 2);
      if (hDist < CLOUD_DANGER_RADIUS) return false;
    }
    return true;
  }

  /**
   * パスファインダーの現在の目的地座標を取得。
   * 目的地がない/取得できない場合は null。
   */
  private getPathfinderGoalPos(): Vec3 | null {
    try {
      const goal = (this.bot.pathfinder as any)?.goal;
      if (!goal) return null;
      const x = goal.x as number | undefined;
      const z = goal.z as number | undefined;
      if (typeof x !== 'number' || typeof z !== 'number') return null;
      const y = (goal.y as number | undefined) ?? this.bot.entity.position.y;
      return new Vec3(x, y, z);
    } catch {
      return null;
    }
  }

  /**
   * ブレスを避けつつ、goalPos があればその方向にバイアスをかけた安全な逃走先を見つける。
   * tethered=true の場合、噴水中心から FOUNTAIN_TETHER_RADIUS 以上離れる候補は除外。
   */
  private findSafeFleeTarget(
    botPos: Vec3,
    dangers: Vec3[],
    fleeDist: number,
    tethered: boolean,
    goalPos?: Vec3 | null,
  ): Vec3 | null {
    let repX = 0;
    let repZ = 0;
    for (const d of dangers) {
      const ddx = botPos.x - d.x;
      const ddz = botPos.z - d.z;
      const dist = Math.sqrt(ddx * ddx + ddz * ddz);
      const weight = 1 / (dist * dist + 0.5);
      if (dist > 0.1) {
        repX += (ddx / dist) * weight;
        repZ += (ddz / dist) * weight;
      }
    }

    if (goalPos) {
      const toGoalX = goalPos.x - botPos.x;
      const toGoalZ = goalPos.z - botPos.z;
      const toGoalLen = Math.sqrt(toGoalX * toGoalX + toGoalZ * toGoalZ);
      if (toGoalLen > 1) {
        const repLen = Math.sqrt(repX * repX + repZ * repZ);
        const attractWeight = repLen * GOAL_ATTRACTION_RATIO;
        repX += (toGoalX / toGoalLen) * attractWeight;
        repZ += (toGoalZ / toGoalLen) * attractWeight;
      }
    }

    const repLen = Math.sqrt(repX * repX + repZ * repZ);
    let baseAngle: number;
    if (repLen < 0.001) {
      baseAngle = Math.random() * Math.PI * 2;
    } else {
      baseAngle = Math.atan2(repZ, repX);
    }

    const candidates: Array<{ pos: Vec3; score: number }> = [];
    const step = (Math.PI * 2) / DIRECTION_CANDIDATES;
    for (let i = 0; i < DIRECTION_CANDIDATES; i++) {
      const sign = i % 2 === 0 ? 1 : -1;
      const offset = Math.ceil(i / 2) * step;
      const angle = baseAngle + sign * offset;
      const tx = botPos.x + Math.cos(angle) * fleeDist;
      const tz = botPos.z + Math.sin(angle) * fleeDist;

      if (tethered) {
        const distFromFountain = Math.sqrt(tx * tx + tz * tz);
        if (distFromFountain > FOUNTAIN_TETHER_RADIUS) continue;
      }

      const pos = new Vec3(tx, botPos.y, tz);
      if (!this.isPositionSafe(pos, dangers)) continue;

      let score = DIRECTION_CANDIDATES - i;
      if (goalPos) {
        const distToGoal = Math.sqrt(
          (tx - goalPos.x) ** 2 + (tz - goalPos.z) ** 2,
        );
        const botDistToGoal = Math.sqrt(
          (botPos.x - goalPos.x) ** 2 + (botPos.z - goalPos.z) ** 2,
        );
        const progress = botDistToGoal - distToGoal;
        score += progress * GOAL_PROGRESS_WEIGHT;
      }

      candidates.push({ pos, score });
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0].pos;
    }

    if (tethered) {
      const toFountainAngle = Math.atan2(-botPos.z, -botPos.x);
      const tx = Math.cos(toFountainAngle) * 2;
      const tz = Math.sin(toFountainAngle) * 2;
      return new Vec3(tx, botPos.y, tz);
    }

    return new Vec3(
      botPos.x + Math.cos(baseAngle) * fleeDist * 2,
      botPos.y,
      botPos.z + Math.sin(baseAngle) * fleeDist * 2,
    );
  }

  private traceFireballLanding(origin: Vec3, vel: Vec3): Vec3 | null {
    const speed = vel.norm();
    const dx = (vel.x / speed) * TRACE_STEP;
    const dy = (vel.y / speed) * TRACE_STEP;
    const dz = (vel.z / speed) * TRACE_STEP;

    let x = origin.x;
    let y = origin.y;
    let z = origin.z;

    for (let d = 0; d < TRACE_MAX_BLOCKS; d += TRACE_STEP) {
      x += dx;
      y += dy;
      z += dz;

      if (y < 0) return null;

      try {
        const block = this.bot.blockAt(
          new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)),
        );
        if (block && block.boundingBox === 'block') {
          return new Vec3(x, Math.floor(y) + 1, z);
        }
      } catch {
        /* chunk not loaded */
      }
    }
    return null;
  }
}

export default AutoAvoidDragonBreath;
