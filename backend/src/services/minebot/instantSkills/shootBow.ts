import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { CustomBot, InstantSkill } from '../types.js';
import { shouldRefuseAggressiveCombat } from '../utils/minebotToolPolicy.js';

const log = createLogger('Minebot:Skill:shootBow');

const BOW_ITEMS = ['bow', 'crossbow'];
const ARROW_ITEMS = ['arrow', 'spectral_arrow', 'tipped_arrow'];
const FULL_CHARGE_MS = 1200;
const CROSSBOW_CHARGE_MS = 1250;
const ARROW_FLIGHT_MIN_MS = 600;
const ARROW_FLIGHT_BUFFER_MS = 400;

const ARROW_GRAVITY = 0.05;
const ARROW_DRAG = 0.99;
const BOW_FULL_SPEED = 3.0;
const CROSSBOW_SPEED = 3.15;
const MAX_SIM_TICKS = 300;
const BINARY_SEARCH_ITERS = 50;
const CLOSE_ENOUGH = 0.05;
const COLLISION_STEP = 0.2;
const COLLISION_SKIP_NEAR_EYE = 1.5;
const AIM_ERROR_THRESHOLD = 4;
const HIGH_ARC_ERROR_THRESHOLD = 2.0;
const DEFAULT_ENTITY_HALF_WIDTH = 1.0;
const DEFAULT_ENTITY_HEIGHT = 2.0;
const ENTITY_HIT_MARGIN = 0.15;
const VEL_SAMPLE_MS = 200;
const LEAD_ITERATIONS = 2;
const MIN_TARGET_SPEED = 0.01;

interface TrajectoryCollision {
  blockPos: Vec3;
  blockName: string;
}

interface AimResult {
  aimPoint: Vec3;
  error: number;
  arcType: 'direct' | 'low' | 'high';
  collision?: TrajectoryCollision;
}

class ShootBow extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'shoot-bow';
    this.description =
      '弓またはクロスボウで指定した対象を射撃します。偏差撃ち・障害物迂回を自動で行います。弓と矢が必要。';
    this.params = [
      {
        name: 'targetName',
        type: 'string',
        description:
          '射撃対象の名前（プレイヤー名またはエンティティ種別。例: "guriko8670", "zombie", "cow"）',
        required: true,
      },
      {
        name: 'count',
        type: 'number',
        description: '射撃回数（デフォルト: 1）',
        default: 1,
      },
      {
        name: 'chargeSeconds',
        type: 'number',
        description: '弓のチャージ時間（秒）。1.0でフルチャージ。0.5で半チャージ（デフォルト: 1.0）',
        default: 1.0,
      },
      {
        name: 'maxDistance',
        type: 'number',
        description: '対象との最大距離（デフォルト: 64ブロック）',
        default: 64,
      },
    ];
  }

  /* ─── 2D ballistic simulation (horizontal distance vs vertical) ─── */

  private simArrow(
    pitch: number, speed: number, targetHDist: number,
    extraHV: number = 0, extraVV: number = 0,
  ): number | null {
    let hv = Math.cos(pitch) * speed + extraHV;
    let vv = Math.sin(pitch) * speed + extraVV;
    let h = 0;
    let v = 0;

    for (let t = 0; t < MAX_SIM_TICKS; t++) {
      const prevH = h;
      const prevV = v;

      h += hv;
      v += vv;
      hv *= ARROW_DRAG;
      vv *= ARROW_DRAG;
      vv -= ARROW_GRAVITY;

      if (h >= targetHDist) {
        if (h - prevH < 0.0001) return v;
        const frac = (targetHDist - prevH) / (h - prevH);
        return prevV + frac * (v - prevV);
      }

      if (hv < 0.0001) return null;
    }
    return null;
  }

  /** Estimate flight time (ticks) for the arrow to cover targetHDist horizontally. */
  private simArrowFlightTicks(
    pitch: number, speed: number, targetHDist: number,
    extraHV: number = 0,
  ): number {
    let hv = Math.cos(pitch) * speed + extraHV;
    let h = 0;
    for (let t = 0; t < MAX_SIM_TICKS; t++) {
      h += hv;
      hv *= ARROW_DRAG;
      if (h >= targetHDist) return t + 1;
      if (hv < 0.0001) return MAX_SIM_TICKS;
    }
    return MAX_SIM_TICKS;
  }

  /* ─── 3D trajectory collision detection using block.shapes ─── */

  /**
   * Simulate the full 3D arrow trajectory from an aimPoint and check
   * every sub-tick position against actual block collision shapes.
   * Returns the first collision found, or null if the path is clear.
   *
   * Mineflayer lookAt convention:
   *   yaw  = atan2(-delta.x, -delta.z)
   *   pitch = atan2(delta.y, groundDistance)   (positive = up)
   *   facing = (-sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch))
   */
  private checkTrajectoryCollision(
    aimPoint: Vec3,
    speed: number,
    targetPos: Vec3,
    entityHalfWidth: number = DEFAULT_ENTITY_HALF_WIDTH,
    entityHeight: number = DEFAULT_ENTITY_HEIGHT,
    botVel: Vec3 | null = null,
  ): TrajectoryCollision | null {
    const botPos = this.bot.entity.position;
    const eyeHeight = ((this.bot.entity as any).eyeHeight as number) ?? 1.62;
    const eyeX = botPos.x;
    const eyeY = botPos.y + eyeHeight;
    const eyeZ = botPos.z;

    const delta = aimPoint.minus(new Vec3(eyeX, eyeY, eyeZ));
    const yaw = Math.atan2(-delta.x, -delta.z);
    const groundDist = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
    const pitch = Math.atan2(delta.y, groundDist);

    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);

    let vx = -Math.sin(yaw) * cosPitch * speed;
    let vy = sinPitch * speed;
    let vz = -Math.cos(yaw) * cosPitch * speed;

    if (botVel) {
      const onGround = (this.bot.entity as any).onGround !== false;
      vx += botVel.x;
      vy += onGround ? 0 : botVel.y;
      vz += botVel.z;
    }

    let x = eyeX;
    let y = eyeY;
    let z = eyeZ;

    const targetHDistSq =
      (targetPos.x - eyeX) ** 2 + (targetPos.z - eyeZ) ** 2;
    const stopDistSq = (Math.sqrt(targetHDistSq) + 3) ** 2;

    // Entity hitbox: targetPos is entity CENTER, so base = center - height/2
    const hw = entityHalfWidth + ENTITY_HIT_MARGIN;
    const entityBaseY = targetPos.y - entityHeight * 0.5 - ENTITY_HIT_MARGIN;
    const entityTopY = targetPos.y + entityHeight * 0.5 + ENTITY_HIT_MARGIN;

    for (let t = 0; t < MAX_SIM_TICKS; t++) {
      const prevX = x;
      const prevY = y;
      const prevZ = z;

      x += vx;
      y += vy;
      z += vz;
      vx *= ARROW_DRAG;
      vy *= ARROW_DRAG;
      vz *= ARROW_DRAG;
      vy -= ARROW_GRAVITY;

      const stepDist = Math.sqrt(
        (x - prevX) ** 2 + (y - prevY) ** 2 + (z - prevZ) ** 2,
      );
      const numChecks = Math.max(Math.ceil(stepDist / COLLISION_STEP), 1);

      for (let s = 1; s <= numChecks; s++) {
        const frac = s / numChecks;
        const cx = prevX + (x - prevX) * frac;
        const cy = prevY + (y - prevY) * frac;
        const cz = prevZ + (z - prevZ) * frac;

        const distFromEyeSq =
          (cx - eyeX) ** 2 + (cy - eyeY) ** 2 + (cz - eyeZ) ** 2;
        if (distFromEyeSq < COLLISION_SKIP_NEAR_EYE ** 2) continue;

        // Arrow entered the target entity's hitbox → it hits the entity
        // before reaching any block behind/below it (e.g. bedrock under crystal)
        if (
          cx >= targetPos.x - hw && cx <= targetPos.x + hw &&
          cz >= targetPos.z - hw && cz <= targetPos.z + hw &&
          cy >= entityBaseY && cy <= entityTopY
        ) {
          return null;
        }

        const hit = this.pointCollidesWithBlock(cx, cy, cz);
        if (hit) return hit;
      }

      const currentDistSq = (x - eyeX) ** 2 + (z - eyeZ) ** 2;
      if (currentDistSq >= stopDistSq) break;
    }

    return null;
  }

  private pointCollidesWithBlock(
    wx: number,
    wy: number,
    wz: number,
  ): TrajectoryCollision | null {
    const bx = Math.floor(wx);
    const by = Math.floor(wy);
    const bz = Math.floor(wz);
    try {
      const block = this.bot.blockAt(new Vec3(bx, by, bz));
      if (!block || !block.shapes || block.shapes.length === 0) return null;

      const lx = wx - bx;
      const ly = wy - by;
      const lz = wz - bz;

      for (const s of block.shapes) {
        if (
          lx >= s[0] && lx <= s[3] &&
          ly >= s[1] && ly <= s[4] &&
          lz >= s[2] && lz <= s[5]
        ) {
          return { blockPos: new Vec3(bx, by, bz), blockName: block.name };
        }
      }
    } catch {
      /* chunk not loaded */
    }
    return null;
  }

  /* ─── Aim calculation with obstacle avoidance ─── */

  private binarySearchAimY(
    eyeY: number,
    hDist: number,
    vDist: number,
    speed: number,
    highArc: boolean,
    lowArcAimY?: number,
    extraHV: number = 0,
    extraVV: number = 0,
  ): { aimY: number; error: number } | null {
    let lo: number;
    let hi: number;

    if (!highArc) {
      lo = eyeY + vDist - 100;
      hi = eyeY + vDist + 200;
    } else {
      lo = (lowArcAimY ?? eyeY + vDist) + 5;
      hi = lo;
      for (let step = 10; step <= 500; step += 10) {
        const testY = lo + step;
        const p = Math.atan2(testY - eyeY, hDist);
        const hitV = this.simArrow(p, speed, hDist, extraHV, extraVV);
        if (hitV === null) {
          hi = testY;
          break;
        }
        hi = testY;
      }
      if (hi <= lo + 1) return null;
    }

    let bestAimY = (lo + hi) / 2;
    let bestErr = Infinity;

    for (let i = 0; i < BINARY_SEARCH_ITERS; i++) {
      const mid = (lo + hi) / 2;
      const pitch = Math.atan2(mid - eyeY, hDist);

      const hitV = this.simArrow(pitch, speed, hDist, extraHV, extraVV);
      if (hitV === null) {
        hi = mid;
        continue;
      }

      const err = hitV - vDist;

      if (Math.abs(err) < Math.abs(bestErr)) {
        bestErr = err;
        bestAimY = mid;
      }

      if (Math.abs(err) < CLOSE_ENOUGH) break;

      if (!highArc) {
        if (err < 0) lo = mid;
        else hi = mid;
      } else {
        if (err > 0) lo = mid;
        else hi = mid;
      }
    }

    const threshold = highArc ? HIGH_ARC_ERROR_THRESHOLD : AIM_ERROR_THRESHOLD;
    if (Math.abs(bestErr) > threshold) return null;

    return { aimY: bestAimY, error: bestErr };
  }

  private calcAimPoint(
    targetPos: Vec3,
    speed: number,
    entityHalfWidth: number = DEFAULT_ENTITY_HALF_WIDTH,
    entityHeight: number = DEFAULT_ENTITY_HEIGHT,
    botVel: Vec3 | null = null,
  ): AimResult | null {
    const botPos = this.bot.entity.position;
    const eyeHeight = ((this.bot.entity as any).eyeHeight as number) ?? 1.62;
    const eyeY = botPos.y + eyeHeight;
    let dx = targetPos.x - botPos.x;
    let dz = targetPos.z - botPos.z;
    let hDist = Math.sqrt(dx * dx + dz * dz);
    const vDist = targetPos.y - eyeY;

    if (hDist < 3 && (!botVel || botVel.norm() < 0.05)) {
      return { aimPoint: targetPos, error: 0, arcType: 'direct' };
    }

    let extraHV = 0;
    let extraVV = 0;
    let aimTargetX = targetPos.x;
    let aimTargetZ = targetPos.z;

    if (botVel && botVel.norm() > 0.005) {
      const yaw = Math.atan2(-dx, -dz);
      const aimDirX = -Math.sin(yaw);
      const aimDirZ = -Math.cos(yaw);

      extraHV = botVel.x * aimDirX + botVel.z * aimDirZ;

      const onGround = (this.bot.entity as any).onGround !== false;
      extraVV = onGround ? 0 : botVel.y;

      const perpDirX = -aimDirZ;
      const perpDirZ = aimDirX;
      const botVelPerp = botVel.x * perpDirX + botVel.z * perpDirZ;

      if (Math.abs(botVelPerp) > 0.005) {
        const effectiveHSpeed = speed + extraHV;
        const roughFlightTicks = effectiveHSpeed > 0.01
          ? Math.min(hDist / effectiveHSpeed, MAX_SIM_TICKS)
          : MAX_SIM_TICKS;
        const dragSum = (1 - Math.pow(ARROW_DRAG, roughFlightTicks)) / (1 - ARROW_DRAG);
        const lateralDrift = botVelPerp * dragSum;

        aimTargetX = targetPos.x - perpDirX * lateralDrift;
        aimTargetZ = targetPos.z - perpDirZ * lateralDrift;

        dx = aimTargetX - botPos.x;
        dz = aimTargetZ - botPos.z;
        hDist = Math.sqrt(dx * dx + dz * dz);

        const yaw2 = Math.atan2(-dx, -dz);
        const aimDirX2 = -Math.sin(yaw2);
        const aimDirZ2 = -Math.cos(yaw2);
        extraHV = botVel.x * aimDirX2 + botVel.z * aimDirZ2;
      }
    }

    const tryArc = (
      highArc: boolean,
      lowArcAimY?: number,
    ): AimResult | null => {
      const arc = this.binarySearchAimY(
        eyeY, hDist, vDist, speed, highArc, lowArcAimY, extraHV, extraVV,
      );
      if (!arc) return null;
      const aimPt = new Vec3(aimTargetX, arc.aimY, aimTargetZ);
      const collision = this.checkTrajectoryCollision(
        aimPt, speed, targetPos, entityHalfWidth, entityHeight, botVel,
      );
      if (!collision) {
        return { aimPoint: aimPt, error: arc.error, arcType: highArc ? 'high' : 'low' };
      }
      return { aimPoint: aimPt, error: arc.error, arcType: highArc ? 'high' : 'low', collision };
    };

    const low = tryArc(false);
    if (!low) return null;
    if (!low.collision) return low;

    log.info(
      `低弧軌道が ${low.collision.blockName} [${low.collision.blockPos.x},${low.collision.blockPos.y},${low.collision.blockPos.z}] に衝突 → 高弧を探索`,
    );

    const high = tryArc(true, low.aimPoint.y);
    if (high && !high.collision) {
      log.info(
        `高弧軌道で迂回成功: aimY=${high.aimPoint.y.toFixed(1)} err=${high.error.toFixed(2)}`,
      );
      return high;
    }
    if (high?.collision) {
      log.warn(
        `高弧軌道も ${high.collision.blockName} [${high.collision.blockPos.x},${high.collision.blockPos.y},${high.collision.blockPos.z}] に衝突`,
      );
    } else {
      log.warn('高弧解が見つからず（距離に対して速度不足の可能性）');
    }

    return low;
  }

  private async sampleTargetVelocity(
    findTarget: () => any | null,
    targetId: number,
  ): Promise<Vec3> {
    const t0 = findTarget();
    if (!t0 || t0.id !== targetId) return new Vec3(0, 0, 0);
    const startPos = t0.position.clone();
    await this.delay(VEL_SAMPLE_MS);
    const t1 = findTarget();
    if (!t1 || t1.id !== targetId) return new Vec3(0, 0, 0);
    const dt = VEL_SAMPLE_MS / 50;
    return new Vec3(
      (t1.position.x - startPos.x) / dt,
      (t1.position.y - startPos.y) / dt,
      (t1.position.z - startPos.z) / dt,
    );
  }

  async runImpl(
    targetName: string,
    count: number = 1,
    chargeSeconds: number = 1.0,
    maxDistance: number = 64,
  ) {
    try {
      const refuse = shouldRefuseAggressiveCombat(this.bot);
      if (refuse) return { success: false, result: refuse };
      if (!targetName) return { success: false, result: '射撃対象を指定してください' };

      const allItems = this.bot.inventory.items();
      const heldItem = this.bot.heldItem;

      const bowItem =
        allItems.find((i) => BOW_ITEMS.includes(i.name)) ??
        (heldItem && BOW_ITEMS.includes(heldItem.name) ? heldItem : null);

      if (!bowItem) {
        const itemNames = allItems.map((i) => i.name).join(', ');
        return {
          success: false,
          result: `弓またはクロスボウがありません (所持: ${itemNames || 'なし'})`,
        };
      }

      const isCrossbow = bowItem.name === 'crossbow';

      const hasArrows =
        allItems.some((i) => ARROW_ITEMS.includes(i.name)) ||
        this.bot.game.gameMode === 'creative';

      if (!hasArrows) {
        return { success: false, result: '矢がインベントリにありません' };
      }

      const targetLower = targetName.toLowerCase().trim();
      const findTarget = () =>
        this.bot.nearestEntity((entity) => {
          if (!entity?.position) return false;
          const dist = entity.position.distanceTo(this.bot.entity.position);
          if (dist > maxDistance) return false;
          const name = (entity.name ?? entity.username ?? '').toLowerCase();
          const username = (entity.username ?? '').toLowerCase();
          return name === targetLower || username === targetLower || name.includes(targetLower);
        });

      const target = findTarget();
      if (!target) {
        return {
          success: false,
          result: `${maxDistance}ブロック以内に "${targetName}" が見つかりません`,
        };
      }

      const equipItem = allItems.find((i) => i.name === bowItem.name);
      if (equipItem) {
        await this.bot.equip(equipItem, 'hand');
      }

      // Stabilize: stop all movement before shooting
      try { (this.bot as any).pathfinder?.stop?.(); } catch { /* ignore */ }
      this.bot.clearControlStates();
      this.bot.setControlState('sneak', true);

      // Sample target velocity during stabilization (doubles as stabilization delay)
      const targetVel = await this.sampleTargetVelocity(findTarget, target.id);
      const targetSpeed = Math.sqrt(targetVel.x ** 2 + targetVel.y ** 2 + targetVel.z ** 2);
      if (targetSpeed > MIN_TARGET_SPEED) {
        log.info(
          `ターゲット速度: (${targetVel.x.toFixed(3)}, ${targetVel.y.toFixed(3)}, ${targetVel.z.toFixed(3)}) ` +
          `${(targetSpeed * 20).toFixed(1)} m/s`,
        );
      }

      const initialDistance = target.position.distanceTo(this.bot.entity.position);
      const clampedCount = Math.min(Math.max(count, 1), 10);
      const chargeMs = isCrossbow
        ? CROSSBOW_CHARGE_MS
        : Math.min(Math.max(chargeSeconds * 1000, 200), FULL_CHARGE_MS);

      const chargeTicks = chargeMs / 50;
      const chargePower = Math.min(chargeTicks / 20, 1.0);
      const arrowSpeed = isCrossbow ? CROSSBOW_SPEED : chargePower * BOW_FULL_SPEED;

      let shotsLanded = 0;
      let destroyedCount = 0;
      let prevTargetId: number | undefined;

      for (let i = 0; i < clampedCount; i++) {
        if (this.shouldInterrupt()) {
          log.info(`射撃中断: ${shotsLanded}/${clampedCount}発で中断`);
          break;
        }

        const currentTarget = findTarget();
        if (!currentTarget) {
          if (prevTargetId !== undefined) destroyedCount++;
          log.info(`射撃対象消滅 — ${destroyedCount}体破壊`);
          break;
        }

        if (prevTargetId !== undefined && currentTarget.id !== prevTargetId) {
          destroyedCount++;
          log.info(`ID:${prevTargetId} 破壊確認 → 次ターゲット ID:${currentTarget.id}`);
        }
        prevTargetId = currentTarget.id;

        // Ensure bow is still equipped (auto-eat or other skills may have swapped it)
        if (this.bot.heldItem?.name !== bowItem.name) {
          const reEquip = this.bot.inventory.items().find((it) => it.name === bowItem.name);
          if (reEquip) {
            await this.bot.equip(reEquip, 'hand');
            await this.delay(50);
          } else {
            log.warn(`弓/クロスボウが失われました (${bowItem.name})`);
            break;
          }
        }

        const entityHeight = (currentTarget.height as number) ?? DEFAULT_ENTITY_HEIGHT;
        const entityWidth = (currentTarget.width as number) ?? DEFAULT_ENTITY_HALF_WIDTH * 2;
        const targetCenter = currentTarget.position.offset(0, entityHeight * 0.5, 0);

        const botVel = this.bot.entity.velocity.clone();
        const botSpeed = botVel.norm();

        // Lead prediction: aim where the target will be when the arrow arrives
        let aimCenter = targetCenter;
        let leadTicks = 0;
        if (targetSpeed > MIN_TARGET_SPEED) {
          const bp = this.bot.entity.position;
          const eh = ((this.bot.entity as any).eyeHeight as number) ?? 1.62;
          const eY = bp.y + eh;

          for (let iter = 0; iter < LEAD_ITERATIONS; iter++) {
            const adx = aimCenter.x - bp.x;
            const adz = aimCenter.z - bp.z;
            const aHDist = Math.sqrt(adx * adx + adz * adz);
            const aYaw = Math.atan2(-adx, -adz);
            const aDirX = -Math.sin(aYaw);
            const aDirZ = -Math.cos(aYaw);
            const bvAlong = botVel.x * aDirX + botVel.z * aDirZ;
            const roughPitch = Math.atan2(aimCenter.y - eY, aHDist);
            const flightTicks = this.simArrowFlightTicks(roughPitch, arrowSpeed, aHDist, bvAlong);
            const total = chargeTicks + flightTicks;
            aimCenter = targetCenter.offset(
              targetVel.x * total, targetVel.y * total, targetVel.z * total,
            );
            leadTicks = total;
          }
          log.info(
            `偏差撃ち: ${leadTicks.toFixed(0)}tick (${(leadTicks / 20).toFixed(1)}s) 先 → ` +
            `(${aimCenter.x.toFixed(1)}, ${aimCenter.y.toFixed(1)}, ${aimCenter.z.toFixed(1)})`,
          );
        }
        if (botSpeed > 0.01) {
          log.info(`自己速度: (${botVel.x.toFixed(3)}, ${botVel.y.toFixed(3)}, ${botVel.z.toFixed(3)})`);
        }

        const aim = this.calcAimPoint(
          aimCenter,
          arrowSpeed,
          entityWidth * 0.5,
          entityHeight,
          botVel,
        );

        if (!aim) {
          const d = currentTarget.position.distanceTo(this.bot.entity.position).toFixed(1);
          log.warn(`弾道計算: 到達不能 (距離=${d}m, 速度=${arrowSpeed.toFixed(2)})`);
          if (shotsLanded === 0) {
            return {
              success: false,
              result:
                `射撃対象に到達できる軌道がありません（距離: ${d}m）。` +
                `もっと近づくか、対象に見通しのある位置へ移動してください。`,
              failureType: 'unreachable' as const,
              recoverable: true,
            };
          }
          break;
        }

        if (aim.collision) {
          const c = aim.collision;
          const d = currentTarget.position.distanceTo(this.bot.entity.position).toFixed(1);
          log.warn(
            `弾道計算: 全軌道が ${c.blockName} [${c.blockPos.x},${c.blockPos.y},${c.blockPos.z}] に阻まれています`,
          );
          if (shotsLanded === 0) {
            return {
              success: false,
              result:
                `射撃軌道が ${c.blockName} (座標: ${c.blockPos.x},${c.blockPos.y},${c.blockPos.z}) に阻まれています（距離: ${d}m）。` +
                `低弧・高弧ともに障害物あり。射線が通る位置へ移動してください。`,
              failureType: 'blocked' as const,
              recoverable: true,
              obstacleBlock: c.blockName,
              obstaclePos: { x: c.blockPos.x, y: c.blockPos.y, z: c.blockPos.z },
            };
          }
          break;
        }

        const botPos = this.bot.entity.position;
        const eyeHeight = ((this.bot.entity as any).eyeHeight as number) ?? 1.62;
        const adx = aimCenter.x - botPos.x;
        const adz = aimCenter.z - botPos.z;
        const hDist = Math.sqrt(adx * adx + adz * adz);
        const vDist = aimCenter.y - (botPos.y + eyeHeight);
        const aimOffset = aim.aimPoint.y - aimCenter.y;

        log.info(
          `弾道計算[${aim.arcType}弧]: aimY=${aim.aimPoint.y.toFixed(1)} (offset=+${aimOffset.toFixed(1)}) ` +
          `err=${aim.error.toFixed(2)}m (h=${hDist.toFixed(1)} v=${vDist.toFixed(1)} spd=${arrowSpeed.toFixed(2)}` +
          `${leadTicks > 0 ? ` lead=${leadTicks.toFixed(0)}t` : ''}` +
          `${botSpeed > 0.01 ? ` botV=${botSpeed.toFixed(2)}` : ''})`,
        );

        if (isCrossbow) {
          await this.shootCrossbow(chargeMs, aim.aimPoint);
        } else {
          await this.shootRegularBow(chargeMs, aim.aimPoint);
        }

        // Log actual look direction after shooting for diagnostics
        const actualYawDeg = ((this.bot.entity.yaw * 180) / Math.PI).toFixed(1);
        const actualPitchDeg = ((this.bot.entity.pitch * 180) / Math.PI).toFixed(1);
        log.info(`射撃後のbot向き: yaw=${actualYawDeg}° pitch=${actualPitchDeg}°`);

        shotsLanded++;

        const flightWait = this.estimateFlightTimeMs(
          currentTarget.position.distanceTo(this.bot.entity.position),
          arrowSpeed,
        );

        if (i < clampedCount - 1) {
          await this.delay(flightWait);
        }
      }

      // Final destruction check — wait for the last arrow to land
      if (shotsLanded > 0) {
        const lastDist = target.position.distanceTo(this.bot.entity.position);
        const finalWait = this.estimateFlightTimeMs(lastDist, arrowSpeed);
        log.info(`着弾待機: ${finalWait}ms (距離=${lastDist.toFixed(1)}m, 速度=${arrowSpeed.toFixed(2)})`);
        await this.delay(finalWait);
        const remaining = findTarget();
        if (!remaining) {
          if (prevTargetId !== undefined) destroyedCount++;
        } else if (prevTargetId !== undefined && remaining.id !== prevTargetId) {
          destroyedCount++;
        }
      }

      // Release sneak after shooting
      this.bot.setControlState('sneak', false);

      const targetDisplay = target.username ?? target.name ?? targetName;
      const distStr = initialDistance.toFixed(1);
      const destroyNote =
        destroyedCount > 0
          ? `${destroyedCount}体破壊確認。`
          : `破壊未確認（矢が当たっていない可能性あり）。`;

      return {
        success: true,
        result:
          `${targetDisplay}に${shotsLanded}発射撃（距離: ${distStr}m, 武器: ${bowItem.name}）。` +
          destroyNote,
      };
    } catch (error: any) {
      this.bot.setControlState('sneak', false);
      return {
        success: false,
        result: `射撃エラー: ${error.message}`,
      };
    }
  }

  /**
   * Maintain aim at aimPoint during charge to counteract constant skills
   * (auto-face-nearest-entity etc.) that redirect the bot's gaze.
   * Uses bot.lookAt() exclusively — no manual yaw/pitch.
   */
  private async chargeWithAimLock(chargeMs: number, aimPoint: Vec3): Promise<void> {
    const AIM_INTERVAL = 50; // Re-aim every 50ms (every physics tick)
    let elapsed = 0;
    while (elapsed < chargeMs) {
      const wait = Math.min(AIM_INTERVAL, chargeMs - elapsed);
      await this.delay(wait);
      elapsed += wait;
      await this.bot.lookAt(aimPoint, true);
    }
  }

  private async shootRegularBow(chargeMs: number, aimPoint: Vec3): Promise<void> {
    await this.bot.lookAt(aimPoint, true);
    this.bot.activateItem(false);
    await this.chargeWithAimLock(chargeMs, aimPoint);
    // Final aim lock: look, wait 1 physics tick for server to register, then release
    await this.bot.lookAt(aimPoint, true);
    await this.delay(50);
    await this.bot.lookAt(aimPoint, true);
    this.bot.deactivateItem();
  }

  private async shootCrossbow(chargeMs: number, aimPoint: Vec3): Promise<void> {
    await this.bot.lookAt(aimPoint, true);
    this.bot.activateItem(false);
    await this.chargeWithAimLock(chargeMs, aimPoint);
    await this.bot.lookAt(aimPoint, true);
    await this.delay(50);
    await this.bot.lookAt(aimPoint, true);
    this.bot.deactivateItem();
    await this.delay(100);
    await this.bot.lookAt(aimPoint, true);
    this.bot.activateItem(false);
    await this.delay(50);
    await this.bot.lookAt(aimPoint, true);
    this.bot.deactivateItem();
  }

  private estimateFlightTimeMs(distance: number, arrowSpeed: number): number {
    const avgSpeed = arrowSpeed * 0.7;
    const flightTicks = avgSpeed > 0 ? distance / avgSpeed : 40;
    return Math.max(ARROW_FLIGHT_MIN_MS, flightTicks * 50 + ARROW_FLIGHT_BUFFER_MS);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default ShootBow;
