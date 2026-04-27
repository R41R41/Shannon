import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { SkillParam, SkillResult } from '../types/skillParams.js';

const log = createLogger('Minebot:Skill:throwPearl');

const PEARL_SPEED = 1.5; // blocks/tick
const PEARL_GRAVITY = 0.03; // blocks/tick²
const PEARL_DRAG = 0.99; // 毎ティック速度に乗算

/**
 * 指定座標にエンダーパールを投擲するインスタントスキル。
 *
 * Minecraft のパール物理（毎 tick: 重力→ドラッグ→位置更新）を解析解で逆算し、
 * ボットの現在速度（慣性）も考慮した正確な投擲方向を算出する。
 *
 * mineflayer の activateItem() が use_item パケットの rotation を {0,0} に
 * ハードコードする問題を回避するため、look/use_item パケットを直接送信する。
 */
class ThrowPearl extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'throw-pearl';
    this.description =
      'エンダーパールを指定座標に投げてテレポート移動する。「パールを投げて来て」「エンダーパールで移動して」等の指示にはこのスキルを使うこと。軌道計算は自動。';
    this.params = [
      {
        name: 'x',
        type: 'number',
        description: '目標X座標',
        required: true,
      },
      {
        name: 'y',
        type: 'number',
        description: '目標Y座標（着弾面の高さ）',
        required: true,
      },
      {
        name: 'z',
        type: 'number',
        description: '目標Z座標',
        required: true,
      },
    ] as SkillParam[];
    this.isToolForLLM = true;
    this.maxDurationMs = 10_000;
  }

  async runImpl(x: number, y: number, z: number): Promise<SkillResult> {
    const targetPos = new Vec3(x, y, z);

    // パールを探す
    const allItems = this.bot.inventory.items();
    const pearl = allItems.find((i) => i.name === 'ender_pearl');
    if (!pearl) {
      return {
        success: false,
        result: `エンダーパールを持っていません（所持: ${allItems.length}個）`,
        failureType: 'material_missing',
      };
    }

    // パールを装備
    this.bot.deactivateItem();

    const hotbarStart = 36;
    const hotbarEnd = 45;
    const slots = this.bot.inventory.slots;
    let equipped = false;
    for (let i = hotbarStart; i < hotbarEnd; i++) {
      const slot = slots[i];
      if (slot && slot.name === 'ender_pearl') {
        this.bot.setQuickBarSlot(i - hotbarStart);
        equipped = true;
        break;
      }
    }
    if (!equipped) {
      await this.bot.equip(pearl, 'hand');
    }

    // 軌道計算
    const eyePos = this.bot.entity.position.offset(
      0,
      (this.bot.entity as any).eyeHeight ?? 1.62,
      0,
    );
    const vel = this.bot.entity.velocity;
    const bot = this.bot;
    const blockChecker: BlockChecker = (bx, by, bz) => {
      const block = bot.blockAt(new Vec3(bx, by, bz));
      if (!block) return undefined;
      return block.boundingBox === 'block' ? 'block' : 'empty';
    };
    const aim = computeAimDirection(eyePos, targetPos, vel, blockChecker);
    const { yaw, pitch, notchYaw, notchPitch, flightTicks } = aim;

    this.bot.entity.yaw = yaw;
    this.bot.entity.pitch = pitch;

    const hDist = Math.sqrt(
      (targetPos.x - eyePos.x) ** 2 + (targetPos.z - eyePos.z) ** 2,
    );
    const simResult = simulatePearl(eyePos, yaw, pitch, vel, targetPos);
    log.info(
      `🟣 投擲: target=(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}) hDist=${hDist.toFixed(1)} pitch=${notchPitch.toFixed(1)}°(${notchPitch > 0 ? '下' : '上'}) vel=[${vel.x.toFixed(2)},${vel.z.toFixed(2)}] T=${flightTicks} err=${simResult.error.toFixed(2)}m`,
    );

    // look パケットを直接送信
    const botAny = this.bot as any;
    botAny._client.write('look', {
      yaw: Math.fround(notchYaw),
      pitch: Math.fround(notchPitch),
      onGround: this.bot.entity.onGround,
      flags: {
        onGround: this.bot.entity.onGround,
        hasHorizontalCollision: undefined,
      },
    });

    // use_item パケットを直接送信（mineflayer の rotation:{0,0} バグ回避）
    if (botAny.supportFeature('useItemWithOwnPacket')) {
      botAny._client.write('use_item', {
        hand: 0,
        sequence: 0,
        rotation: {
          x: Math.fround(notchYaw),
          y: Math.fround(notchPitch),
        },
      });
    } else {
      this.bot.activateItem();
    }

    const remaining = this.bot.inventory
      .items()
      .filter((i) => i.name === 'ender_pearl')
      .reduce((sum, i) => sum + i.count, 0);

    log.info(
      `🟣 ★ パール投擲完了 ★ 距離=${hDist.toFixed(1)}m T=${flightTicks}ticks 残り=${remaining}個`,
    );

    const lowWarning =
      remaining <= 1
        ? `\n⚠️ エンダーパール残り${remaining}個！落下死回避用に最低1個は確保すること`
        : '';

    return {
      success: true,
      result: `エンダーパールを (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) に投擲しました（推定${flightTicks}tick後着弾、水平距離${hDist.toFixed(1)}m）残りパール: ${remaining}個${lowWarning}`,
    };
  }
}

/**
 * ボットの速度（慣性）とパールの物理を考慮した投擲方向を算出する。
 *
 * Minecraft のパール物理（毎 tick）:
 *   1. pos   += vel        (位置更新 — 現在の速度でフル移動)
 *   2. vel   *= 0.99       (ドラッグ — 次 tick 用に減速)
 *   3. vel.y -= 0.03       (重力   — 次 tick 用に加速)
 *
 * tick-by-tick シミュレーションで pitch を探索し、
 * 目標に最も近く着弾する角度を求める。
 * プレイヤー速度による横方向ドリフトも yaw 補正で対応。
 */
/**
 * blockAt callback type for collision detection.
 * Returns the block's bounding box type ('block', 'empty', or undefined).
 */
type BlockChecker = (x: number, y: number, z: number) => 'block' | 'empty' | undefined;

export function computeAimDirection(
  eyePos: Vec3,
  target: Vec3,
  playerVel: Vec3,
  blockAt?: BlockChecker,
): {
  yaw: number;
  pitch: number;
  notchYaw: number;
  notchPitch: number;
  flightTicks: number;
} {
  const dx = target.x - eyePos.x;
  const dz = target.z - eyePos.z;
  const hDist = Math.sqrt(dx * dx + dz * dz);

  // yaw: プレイヤー速度による横ドリフトを補正
  const yaw = computeCorrectedYaw(dx, dz, hDist, playerVel);

  // pitch: シミュレーションで最適角度を探索
  // 粗探索: -60° ～ +85° を 2°刻み
  let bestPitch = 0;
  let bestErr = Infinity;
  let bestTicks = 20;

  for (let deg = -60; deg <= 85; deg += 2) {
    const pitch = (deg * Math.PI) / 180;
    const sim = simulatePearl(eyePos, yaw, pitch, playerVel, target, blockAt);
    if (sim.error < bestErr) {
      bestErr = sim.error;
      bestPitch = pitch;
      bestTicks = sim.ticks;
    }
  }

  // 精密探索: 最良角度の前後 ±3° で三分探索
  let lo = bestPitch - (3 * Math.PI) / 180;
  let hi = bestPitch + (3 * Math.PI) / 180;
  for (let i = 0; i < 20; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const s1 = simulatePearl(eyePos, yaw, m1, playerVel, target, blockAt);
    const s2 = simulatePearl(eyePos, yaw, m2, playerVel, target, blockAt);
    if (s1.error < s2.error) {
      hi = m2;
      if (s1.error < bestErr) {
        bestErr = s1.error;
        bestPitch = m1;
        bestTicks = s1.ticks;
      }
    } else {
      lo = m1;
      if (s2.error < bestErr) {
        bestErr = s2.error;
        bestPitch = m2;
        bestTicks = s2.ticks;
      }
    }
  }

  const notchYaw = (180 / Math.PI) * (Math.PI - yaw);
  const notchPitch = (-bestPitch) * (180 / Math.PI);

  return { yaw, pitch: bestPitch, notchYaw, notchPitch, flightTicks: bestTicks };
}

/**
 * プレイヤー速度による横方向ドリフトを補正した yaw を算出。
 * v0_horiz = PEARL_SPEED * aimDir_horiz + playerVel_horiz が
 * 目標方向を向くように yaw を調整する。
 */
function computeCorrectedYaw(
  dx: number,
  dz: number,
  hDist: number,
  playerVel: Vec3,
): number {
  const pvx = playerVel.x;
  const pvz = playerVel.z;

  if (hDist < 0.01) return Math.atan2(-dx, -dz);

  // 速度補正が不要な場合（静止時）
  const pvHorizSq = pvx * pvx + pvz * pvz;
  if (pvHorizSq < 0.001) return Math.atan2(-dx, -dz);

  // cos(pitch)≈0.9 と仮定した水平成分
  const h = PEARL_SPEED * 0.9;

  // 二次方程式: k²·hDist² - 2k·(dx·pvx+dz·pvz) + (pvx²+pvz²-h²) = 0
  const A = hDist * hDist;
  const B = dx * pvx + dz * pvz;
  const C = pvHorizSq - h * h;
  const disc = B * B - A * C;

  if (disc < 0) return Math.atan2(-dx, -dz);

  const sqrtDisc = Math.sqrt(disc);
  const k = (B + sqrtDisc) / A; // 正の解を選択

  if (k <= 0) return Math.atan2(-dx, -dz);

  const sinYaw = (pvx - k * dx) / h;
  const cosYaw = (pvz - k * dz) / h;

  if (Math.abs(sinYaw) > 1 || Math.abs(cosYaw) > 1) {
    return Math.atan2(-dx, -dz);
  }

  return Math.atan2(sinYaw, cosYaw);
}

/**
 * 指定 yaw/pitch でパールを投げた場合の軌道をシミュレーションし、
 * 目標への最接近距離を返す。
 */
const COLLISION_PENALTY = 1000;

function simulatePearl(
  eyePos: Vec3,
  yaw: number,
  pitch: number,
  playerVel: Vec3,
  target: Vec3,
  blockAt?: BlockChecker,
): { error: number; ticks: number } {
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);

  let vx = PEARL_SPEED * (-Math.sin(yaw) * cosP) + playerVel.x;
  let vy = PEARL_SPEED * sinP + playerVel.y;
  let vz = PEARL_SPEED * (-Math.cos(yaw) * cosP) + playerVel.z;

  let x = eyePos.x;
  let y = eyePos.y;
  let z = eyePos.z;
  let bestScore = Infinity;
  let bestTick = 1;

  const tgtBx = Math.floor(target.x);
  const tgtBy = Math.floor(target.y);
  const tgtBz = Math.floor(target.z);

  for (let t = 0; t < 100; t++) {
    // Minecraft tick order: position → drag → gravity
    x += vx;
    y += vy;
    z += vz;
    vx *= PEARL_DRAG;
    vy *= PEARL_DRAG;
    vz *= PEARL_DRAG;
    vy -= PEARL_GRAVITY;

    // Block collision check (every 2 ticks to limit perf cost)
    if (blockAt && (t & 1) === 0) {
      const bx = Math.floor(x);
      const by = Math.floor(y);
      const bz = Math.floor(z);
      if (!(bx === tgtBx && by === tgtBy && bz === tgtBz)) {
        const bb = blockAt(bx, by, bz);
        if (bb === 'block') {
          return { error: COLLISION_PENALTY, ticks: t + 1 };
        }
      }
    }

    const dist = Math.sqrt(
      (x - target.x) ** 2 + (y - target.y) ** 2 + (z - target.z) ** 2,
    );
    const timePenalty = t > 30 ? (t - 30) * 0.5 : 0;
    const score = dist + timePenalty;

    if (score < bestScore) {
      bestScore = score;
      bestTick = t + 1;
    }

    if (y < target.y - 50) break;
    if (t > 10 && dist > bestScore * 3) break;
  }

  return { error: bestScore, ticks: bestTick };
}

export default ThrowPearl;
