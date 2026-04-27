/**
 * pathfinder.goto のスタック検出付きラッパー。
 *
 * 核心: 回復試行時は pathfinder を一旦停止してから手動操作を行う。
 * pathfinder が動いたままだと毎ティック control state を上書きするため
 * jump 等の手動操作がキャンセルされてしまう。
 *
 * 構成:
 *   1. gotoSafe        — リトライループ (回復→再開を繰り返す)
 *   2. runGotoSegment   — pathfinder.goto + ミクロ/マクロスタック監視
 *   3. doManualRecovery — pathfinder 停止中に手動でジャンプ/移動
 */

import { Vec3 } from 'vec3';
import type { CustomBot } from '../types/CustomBot.js';
import type { Goal } from '../types/CustomBot.js';
import { createLogger } from '../../../utils/logger.js';
import { getWaterLevel } from './waterLevel.js';

const log = createLogger('Minebot:gotoSafe');

export interface GotoSafeOptions {
  /** 全体タイムアウト (ms)。デフォルト 30000 */
  timeoutMs?: number;
  /** ミクロスタック判定のチェック間隔 (ms)。デフォルト 500 */
  checkIntervalMs?: number;
  /** ミクロスタック: 回復試行を行う連続検出回数。デフォルト 3 */
  microStuckCount?: number;
  /** マクロスタック: 進捗なし判定で中断するまでの回数。デフォルト 2 (≈6秒) */
  macroStuckAbort?: number;
  /** マクロスタック: 進捗チェックの間隔 (ms)。デフォルト 3000 */
  macroCheckMs?: number;
  /** マクロスタック: この距離(ブロック)以上移動していなければ進捗なし。デフォルト 1.5 */
  macroMinProgress?: number;
  /** ミクロスタック判定の移動閾値（ブロック）。デフォルト 0.25 */
  stuckThreshold?: number;
  /** スタック脱出試行を行うか。デフォルト true */
  tryRecover?: boolean;
  /** スタック検出時に経路再計算を試みるか。デフォルト true (後方互換) */
  retryPath?: boolean;
  /** スタック検出時にログを出すか。デフォルト true */
  logStuck?: boolean;
  /** 後方互換: 旧 stuckAbortCount → macroStuckAbort にマップ */
  stuckAbortCount?: number;
  /** 移動先の安全性チェック（lava/magma/ドラゴンブレス）。デフォルト true */
  checkDestinationSafety?: boolean;
}

export interface GotoSafeResult {
  success: boolean;
  error?: string;
  stuckBlock?: { x: number; y: number; z: number; name: string };
  unsafeReason?: string;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const DANGER_BLOCKS = new Set([
  'lava', 'flowing_lava', 'magma_block', 'fire', 'soul_fire',
]);

function extractGoalPosition(goal: Goal): { x: number; y?: number; z: number } | null {
  const g = goal as any;
  if (g.goal) return extractGoalPosition(g.goal);
  if (typeof g.x === 'number' && typeof g.z === 'number') {
    return { x: g.x, y: typeof g.y === 'number' ? g.y : undefined, z: g.z };
  }
  if (g.entity?.position) {
    const p = g.entity.position;
    return { x: p.x, y: p.y, z: p.z };
  }
  return null;
}

function isGoalInverted(goal: Goal): boolean {
  return !!(goal as any).goal;
}

function checkDestinationBlocks(
  bot: CustomBot,
  x: number, y: number, z: number,
): string | null {
  const bx = Math.floor(x);
  const bz = Math.floor(z);
  const by = Math.floor(y);
  for (let dy = -1; dy <= 2; dy++) {
    try {
      const block = bot.blockAt(new Vec3(bx, by + dy, bz));
      if (block && DANGER_BLOCKS.has(block.name)) {
        return `${block.name} at (${bx}, ${by + dy}, ${bz})`;
      }
    } catch { /* chunk not loaded */ }
  }
  return null;
}

function checkDestinationDragonBreath(
  bot: CustomBot,
  x: number, y: number, z: number,
): string | null {
  const checkPos = new Vec3(x, y, z);
  for (const entity of Object.values(bot.entities)) {
    if (
      entity.name === 'area_effect_cloud' &&
      entity.position.distanceTo(checkPos) <= 4
    ) {
      return `dragon breath at (${entity.position.x.toFixed(1)}, ${entity.position.y.toFixed(1)}, ${entity.position.z.toFixed(1)})`;
    }
  }
  return null;
}

export async function gotoSafe(
  bot: CustomBot,
  goal: Goal,
  opts: GotoSafeOptions = {},
): Promise<GotoSafeResult> {
  const {
    timeoutMs = 30_000,
    checkIntervalMs = 500,
    microStuckCount = 3,
    macroCheckMs = 3_000,
    macroMinProgress = 1.5,
    stuckThreshold = 0.25,
    tryRecover = true,
    logStuck = true,
    checkDestinationSafety = true,
  } = opts;

  if (checkDestinationSafety && !isGoalInverted(goal)) {
    const pos = extractGoalPosition(goal);
    if (pos) {
      const y = pos.y ?? bot.entity.position.y;
      const blockDanger = checkDestinationBlocks(bot, pos.x, y, pos.z);
      if (blockDanger) {
        log.warn(`⚠️ 移動先が危険: ${blockDanger}`);
        return { success: false, error: 'unsafe_destination', unsafeReason: blockDanger };
      }
      if (bot.game.dimension !== 'the_end') {
        const breathDanger = checkDestinationDragonBreath(bot, pos.x, y, pos.z);
        if (breathDanger) {
          log.warn(`⚠️ 移動先が危険: ${breathDanger}`);
          return { success: false, error: 'unsafe_destination', unsafeReason: breathDanger };
        }
      }
    }
  }

  const macroAbort = opts.macroStuckAbort ?? opts.stuckAbortCount ?? 2;
  const maxRecovery = macroAbort * 3;

  const deadline = Date.now() + timeoutMs;
  let recoveryAttempt = 0;
  let stuckBlock: GotoSafeResult['stuckBlock'] | undefined;

  while (Date.now() < deadline) {
    const remainMs = deadline - Date.now();
    if (remainMs <= 0) break;

    const seg = await runGotoSegment(bot, goal, {
      checkIntervalMs,
      microStuckCount,
      stuckThreshold,
      macroCheckMs,
      macroMinProgress,
      timeoutMs: remainMs,
      logStuck,
    });

    stuckBlock = seg.stuckBlock ?? stuckBlock;

    if (seg.result === 'success') return { success: true };
    if (seg.result === 'no_path') return { success: false, error: 'no_path' };
    if (seg.result === 'timeout') return { success: false, error: 'timeout', stuckBlock };

    if (!tryRecover) {
      return { success: false, error: 'stuck', stuckBlock };
    }

    recoveryAttempt++;
    if (logStuck) {
      const pos = bot.entity.position;
      log.warn(
        `⚠️ スタック → 脱出試行 #${recoveryAttempt}/${maxRecovery}` +
        ` @ (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`,
      );
    }

    if (recoveryAttempt >= maxRecovery) {
      if (logStuck) log.error(`❌ ${maxRecovery}回の脱出試行後も進捗なし → 移動中断`);
      return { success: false, error: 'stuck', stuckBlock };
    }

    // pathfinder は segment 終了時に stop() 済み → 手動操作が上書きされない
    await doManualRecovery(bot, recoveryAttempt);
  }

  try { bot.pathfinder.stop(); } catch { /* ignore */ }
  return { success: false, error: 'timeout', stuckBlock };
}

// ─── Segment: pathfinder.goto + 監視 ───────────────────────────

interface SegmentResult {
  result: 'success' | 'stuck' | 'no_path' | 'timeout';
  stuckBlock?: GotoSafeResult['stuckBlock'];
}

function runGotoSegment(
  bot: CustomBot,
  goal: Goal,
  opts: {
    checkIntervalMs: number;
    microStuckCount: number;
    stuckThreshold: number;
    macroCheckMs: number;
    macroMinProgress: number;
    timeoutMs: number;
    logStuck: boolean;
  },
): Promise<SegmentResult> {
  return new Promise<SegmentResult>((resolve) => {
    let settled = false;
    let monitorId: ReturnType<typeof setInterval> | null = null;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: SegmentResult) => {
      if (settled) return;
      settled = true;
      if (monitorId) clearInterval(monitorId);
      if (timerId) clearTimeout(timerId);
      resolve(result);
    };

    // 全体タイムアウト
    timerId = setTimeout(() => {
      try { bot.pathfinder.stop(); } catch { /* ignore */ }
      finish({ result: 'timeout' });
    }, opts.timeoutMs);

    // 監視ステート
    const startPos = {
      x: bot.entity.position.x,
      y: bot.entity.position.y,
      z: bot.entity.position.z,
    };
    let lastPos = { ...startPos };
    let microCount = 0;
    let macroCheckPos = { ...startPos };
    let macroCheckTime = Date.now();

    monitorId = setInterval(() => {
      if (settled) return;
      const pos = bot.entity.position;

      // ── ミクロスタック: 短時間の位置停滞 ──
      const moved =
        Math.abs(pos.x - lastPos.x) +
        Math.abs(pos.y - lastPos.y) +
        Math.abs(pos.z - lastPos.z);

      if (moved < opts.stuckThreshold && bot.pathfinder.isMoving()) {
        microCount++;
        if (microCount >= opts.microStuckCount) {
          const block = detectObstacle(bot, pos);
          try { bot.pathfinder.stop(); } catch { /* ignore */ }
          finish({ result: 'stuck', stuckBlock: block ?? undefined });
          return;
        }
      } else {
        microCount = 0;
      }
      lastPos = { x: pos.x, y: pos.y, z: pos.z };

      // ── マクロスタック: 数秒スパンで実質的な進捗なし ──
      const now = Date.now();
      if (now - macroCheckTime >= opts.macroCheckMs) {
        const macroMoved = Math.sqrt(
          (pos.x - macroCheckPos.x) ** 2 +
          (pos.y - macroCheckPos.y) ** 2 +
          (pos.z - macroCheckPos.z) ** 2,
        );
        if (macroMoved < opts.macroMinProgress && bot.pathfinder.isMoving()) {
          if (opts.logStuck) {
            log.warn(
              `⚠️ マクロスタック — ` +
              `${(opts.macroCheckMs / 1000).toFixed(0)}秒で` +
              `${macroMoved.toFixed(1)}m移動（閾値${opts.macroMinProgress}m）`,
            );
          }
          const block = detectObstacle(bot, pos);
          try { bot.pathfinder.stop(); } catch { /* ignore */ }
          finish({ result: 'stuck', stuckBlock: block ?? undefined });
          return;
        }
        macroCheckPos = { x: pos.x, y: pos.y, z: pos.z };
        macroCheckTime = now;
      }
    }, opts.checkIntervalMs);

    // pathfinder.goto 本体
    bot.pathfinder.goto(goal).then(() => {
      finish({ result: 'success' });
    }).catch((err: Error) => {
      if (settled) return;
      const msg = err?.message?.toLowerCase() ?? '';
      if (
        msg.includes('no path') ||
        msg.includes('decide path') ||
        msg.includes('took to long')
      ) {
        finish({ result: 'no_path' });
      } else if (
        msg.includes('stop') ||
        msg.includes('abort') ||
        msg.includes('interrupt')
      ) {
        finish({ result: 'stuck' });
      } else {
        finish({ result: 'no_path' });
      }
    });
  });
}

// ─── 手動回復 (pathfinder 停止中に実行) ───────────────────────

async function doManualRecovery(
  bot: CustomBot,
  attempt: number,
): Promise<void> {
  bot.clearControlStates();

  // 水流に流されているか判定
  if (isInFlowingWater(bot)) {
    await doWaterFlowEscape(bot, attempt);
    return;
  }

  const phase = ((attempt - 1) % 4);
  switch (phase) {
    case 0:
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);
      await sleep(400);
      break;
    case 1:
      bot.setControlState('back', true);
      bot.setControlState('jump', true);
      await sleep(500);
      break;
    case 2:
      bot.setControlState('left', true);
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);
      await sleep(500);
      break;
    case 3:
      bot.setControlState('right', true);
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);
      await sleep(500);
      break;
  }

  bot.clearControlStates();
  await sleep(100);
}

/** 足元が水流ブロック（level !== 0）かどうか */
function isInFlowingWater(bot: CustomBot): boolean {
  const pos = bot.entity.position;
  for (const dy of [0, -1]) {
    const block = bot.blockAt(pos.offset(0, dy, 0));
    if (!block || block.name !== 'water') continue;
    const level = getWaterLevel(block);
    if (level > 0) return true;
  }
  return false;
}

/** ブロックを置けるアイテム名 */
const PLACEABLE_ESCAPE = [
  'cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'netherrack',
  'deepslate', 'granite', 'diorite', 'andesite', 'tuff',
  'sandstone', 'oak_planks', 'spruce_planks', 'birch_planks',
];

/**
 * 水流脱出（3段階）:
 *  1. 足元にブロックを置いて水上に出る（最も確実）
 *  2. 近くの乾いた地面に向かって泳ぐ（長めにスプリント）
 *  3. 上方向にジャンプして脱出
 */
async function doWaterFlowEscape(bot: CustomBot, attempt: number): Promise<void> {
  // ── 戦略1: 足元にブロックを置いて水上に出る ──
  if (attempt <= 2) {
    const placed = await tryPlaceBlockUnderFeet(bot);
    if (placed) {
      log.info('🏊 水流脱出: 足元にブロック設置 → 水上へ');
      bot.setControlState('jump', true);
      await sleep(600);
      bot.clearControlStates();
      await sleep(200);
      return;
    }
  }

  // ── 戦略2: 最寄りの乾いた地面へ泳ぐ ──
  const pos = bot.entity.position;
  const escapeTarget = findNearestDryOrSource(bot, pos);

  if (escapeTarget) {
    log.info(
      `🏊 水流脱出: (${escapeTarget.x},${escapeTarget.y},${escapeTarget.z}) に向かう`,
    );
    try {
      await bot.lookAt(new Vec3(escapeTarget.x + 0.5, escapeTarget.y, escapeTarget.z + 0.5));
    } catch { /* ignore */ }

    // 水流に対抗するため長めに保持
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);
    bot.setControlState('sprint', true);
    await sleep(1200 + attempt * 300);

    bot.clearControlStates();
    await sleep(200);

    // 脱出できたか確認 — まだ水流内ならもう一度ブロック設置を試みる
    if (isInFlowingWater(bot)) {
      const placed = await tryPlaceBlockUnderFeet(bot);
      if (placed) {
        log.info('🏊 水流脱出: 泳いだ先で足元にブロック設置');
        bot.setControlState('jump', true);
        await sleep(400);
        bot.clearControlStates();
      }
    }
    await sleep(100);
    return;
  }

  // ── 戦略3: 上方向に脱出 ──
  bot.setControlState('jump', true);
  await sleep(800);
  bot.clearControlStates();
  await sleep(100);
}

/**
 * 現在位置の足元にブロックを設置して水上に出る。
 * スニーク → 真下を向く → 足元のブロックに設置。
 */
async function tryPlaceBlockUnderFeet(bot: CustomBot): Promise<boolean> {
  const placeItem = bot.inventory.items().find(i => PLACEABLE_ESCAPE.includes(i.name));
  if (!placeItem) return false;

  const feetPos = bot.entity.position.floored();
  const belowBlock = bot.blockAt(feetPos.offset(0, -1, 0));
  if (!belowBlock) return false;

  // 足元が固体ブロックなら設置不要
  if (belowBlock.boundingBox === 'block' && belowBlock.name !== 'water' && belowBlock.name !== 'lava') {
    return false;
  }

  // 足元が水ならその下の固体ブロックを探す
  let refBlock = null;
  for (let dy = -1; dy >= -4; dy--) {
    const b = bot.blockAt(feetPos.offset(0, dy, 0));
    if (b && b.boundingBox === 'block' && b.name !== 'water' && b.name !== 'lava') {
      refBlock = b;
      break;
    }
  }

  if (!refBlock) return false;

  try {
    await bot.equip(placeItem, 'hand');
    await bot.lookAt(refBlock.position.offset(0.5, 1, 0.5));
    await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
    return true;
  } catch {
    return false;
  }
}

/**
 * 周囲で水流でない安全な着地点を探す。
 * 優先順位: (1) 乾いた地面（固体ブロックの上が空気）、(2) 水源ブロック
 */
function findNearestDryOrSource(
  bot: CustomBot,
  center: { x: number; y: number; z: number },
): { x: number; y: number; z: number } | null {
  const cx = Math.floor(center.x);
  const cy = Math.floor(center.y);
  const cz = Math.floor(center.z);
  const SEARCH = 4;

  let bestDry: { x: number; y: number; z: number; dist: number } | null = null;
  let bestSource: { x: number; y: number; z: number; dist: number } | null = null;

  for (let dx = -SEARCH; dx <= SEARCH; dx++) {
    for (let dz = -SEARCH; dz <= SEARCH; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const bx = cx + dx;
        const by = cy + dy;
        const bz = cz + dz;
        const dist = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        if (dist === 0) continue;

        const block = bot.blockAt(new Vec3(bx, by, bz));
        if (!block) continue;

        // 乾いた地面: 固体ブロックの上が空気
        if (block.boundingBox === 'block' && block.name !== 'water' && block.name !== 'lava') {
          const above = bot.blockAt(new Vec3(bx, by + 1, bz));
          if (above && (above.name === 'air' || above.name === 'cave_air')) {
            if (!bestDry || dist < bestDry.dist) {
              bestDry = { x: bx, y: by + 1, z: bz, dist };
            }
          }
        }

        // 水源（level=0）
        if (block.name === 'water') {
          const level = getWaterLevel(block);
          if (level === 0) {
            if (!bestSource || dist < bestSource.dist) {
              bestSource = { x: bx, y: by, z: bz, dist };
            }
          }
        }
      }
    }
  }

  if (bestDry) return { x: bestDry.x, y: bestDry.y, z: bestDry.z };
  if (bestSource) return { x: bestSource.x, y: bestSource.y, z: bestSource.z };
  return null;
}

// ─── 障害物検出 ────────────────────────────────────────────────

function detectObstacle(
  bot: CustomBot,
  pos: { x: number; y: number; z: number },
): GotoSafeResult['stuckBlock'] | null {
  try {
    const yaw = bot.entity.yaw;
    const fwd = { x: -Math.sin(yaw), z: Math.cos(yaw) };
    const blockAtFeet = bot.blockAt(bot.entity.position.offset(fwd.x, 0, fwd.z));
    const blockAtHead = bot.blockAt(bot.entity.position.offset(fwd.x, 1, fwd.z));
    const target = blockAtFeet?.name !== 'air' ? blockAtFeet : blockAtHead;
    if (target && target.name !== 'air' && target.name !== 'water' && target.name !== 'flowing_water') {
      return {
        x: Math.floor(target.position.x),
        y: Math.floor(target.position.y),
        z: Math.floor(target.position.z),
        name: target.name,
      };
    }
  } catch { /* ignore */ }
  return null;
}
