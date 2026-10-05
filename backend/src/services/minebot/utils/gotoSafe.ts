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
import { actionSignal, assertActionActive, reportActionProgress } from '../execution/ActionExecution.js';
import { actionDelay } from '../execution/observedWait.js';

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
  /** マクロスタック: この距離(ブロック)以上移動していなければ進捗なし。デフォルト 0.75 */
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
}

export interface GotoSafeResult {
  success: boolean;
  error?: string;
  stuckBlock?: { x: number; y: number; z: number; name: string };
  /** What the path executor was doing when an unfinished move ended (digging which block, placing, walking, searching). */
  activity?: string;
}

/** Shortest stretch of digging or placing without a step before it counts as going nowhere. */
const TERRAIN_WORK_MIN_MS = 8_000;
/** How long the executor may hold the body still while it neither walks nor works (a path search ends within five seconds). */
const IDLE_EXECUTOR_MS = 8_000;

/**
 * What the path executor is doing right now, in the planner's words. A move
 * that ran out of time said only that it had: thirty seconds on one spot left
 * no trace of whether the body was digging, placing or still searching (paid
 * run L52).
 */
export function describePathExecutor(bot: CustomBot): string {
  try {
    if (bot.pathfinder.isMining()) {
      const target = (bot as { targetDigBlock?: { name: string; position: { x: number; y: number; z: number } } | null }).targetDigBlock;
      return target ? `${target.name}(${target.position.x}, ${target.position.y}, ${target.position.z})を掘削中` : '経路上のブロックを掘削中';
    }
    if (bot.pathfinder.isBuilding()) return '足場ブロックの設置中';
    if (bot.pathfinder.isMoving()) return '経路上を移動中';
  } catch { /* described as searching below */ }
  return '経路を探索中';
}

/**
 * How long digging or placing may hold the body on one spot. Two blocks (feet
 * and head) can stand between the body and its next step, each as slow as the
 * tool in hand makes it, and a slow server stretches both.
 */
function terrainWorkAllowanceMs(bot: CustomBot): number {
  let digMs = 0;
  try {
    const target = (bot as { targetDigBlock?: unknown }).targetDigBlock;
    if (target && typeof bot.digTime === 'function') digMs = Number(bot.digTime(target as never)) || 0;
  } catch { /* the minimum stands */ }
  return Math.max(TERRAIN_WORK_MIN_MS, digMs * 4 + 3_000);
}

const sleep = (bot: CustomBot, ms: number) => actionDelay(bot, ms);

function stopPathfinderNow(bot: CustomBot): void {
  // stop() alone is deferred until a later path node. Set the request first,
  // then clear the goal so pathfinder consumes it synchronously; otherwise
  // that old stop can interrupt the next dig or cancel the next movement.
  try { bot.pathfinder.stop(); } catch { /* contain even a partial failure */ }
  try { bot.pathfinder.setGoal(null); } catch { /* best effort */ }
}

export async function gotoSafe(
  bot: CustomBot,
  goal: Goal,
  opts: GotoSafeOptions = {},
): Promise<GotoSafeResult> {
  assertActionActive(bot);
  const target = goal as unknown as Record<string, unknown>;
  reportActionProgress(bot, 'navigate', { goalType: goal.constructor.name,
    target: Object.fromEntries(['x', 'y', 'z', 'range'].filter(key => typeof target[key] === 'number')
      .map(key => [key, target[key]])) });
  const {
    timeoutMs = 30_000,
    checkIntervalMs = 500,
    microStuckCount = 3,
    macroCheckMs = 3_000,
    macroMinProgress = 0.75,
    stuckThreshold = 0.25,
    tryRecover = true,
    logStuck = true,
  } = opts;

  const macroAbort = opts.macroStuckAbort ?? opts.stuckAbortCount ?? 2;
  const maxRecovery = macroAbort * 3;

  const deadline = Date.now() + timeoutMs;
  let recoveryAttempt = 0;
  let stuckBlock: GotoSafeResult['stuckBlock'] | undefined;
  let activity: string | undefined;

  while (Date.now() < deadline) {
    assertActionActive(bot);
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
    assertActionActive(bot);

    stuckBlock = seg.stuckBlock ?? stuckBlock;

    activity = seg.activity ?? activity;

    if (seg.result === 'success') return { success: true };
    if (seg.result === 'no_path') return { success: false, error: 'no_path' };
    if (seg.result === 'timeout') return { success: false, error: 'timeout', stuckBlock, activity };

    if (!tryRecover) {
      return { success: false, error: 'stuck', stuckBlock, activity };
    }

    recoveryAttempt++;
    reportActionProgress(bot, 'recovery', { recoveryAttempt, stuckBlock, reason: seg.result }, false, 'blocked');
    if (logStuck) {
      const pos = bot.entity.position;
      log.warn(
        `⚠️ スタック → 脱出試行 #${recoveryAttempt}/${maxRecovery}` +
        ` @ (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`,
      );
    }

    if (recoveryAttempt >= maxRecovery) {
      if (logStuck) log.error(`❌ ${maxRecovery}回の脱出試行後も進捗なし → 移動中断`);
      return { success: false, error: 'stuck', stuckBlock, activity };
    }

    // pathfinder は segment 終了時に stop() 済み → 手動操作が上書きされない
    await doManualRecovery(bot, recoveryAttempt);
  }

  stopPathfinderNow(bot);
  return { success: false, error: 'timeout', stuckBlock, activity };
}

// ─── Segment: pathfinder.goto + 監視 ───────────────────────────

interface SegmentResult {
  result: 'success' | 'stuck' | 'no_path' | 'timeout';
  stuckBlock?: GotoSafeResult['stuckBlock'];
  activity?: string;
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
    const signal = actionSignal(bot);
    let settled = false;
    let monitorId: ReturnType<typeof setInterval> | null = null;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: SegmentResult) => {
      if (settled) return;
      settled = true;
      // Read before the executor is stopped: afterwards it is doing nothing.
      if (result.result === 'timeout' || result.result === 'stuck') result.activity ??= describePathExecutor(bot);
      if (result.result !== 'success') stopPathfinderNow(bot);
      if (monitorId) clearInterval(monitorId);
      if (timerId) clearTimeout(timerId);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = () => {
      finish({ result: 'no_path' });
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }

    // 全体タイムアウト
    timerId = setTimeout(() => {
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
    let terrainWorkState: 'mining' | 'building' | null = null;
    // Where the body stood when the current stretch of digging or placing began to hold it.
    let workAnchor: { x: number; y: number; z: number; at: number; allowanceMs: number } | null = null;
    // Where the body stood when the executor last had no path and no work.
    let idleAnchor: { x: number; y: number; z: number; at: number } | null = null;

    monitorId = setInterval(() => {
      if (settled) return;
      // A timer has no caller to catch for it. When the action this move belongs to has been cancelled,
      // the progress report below refuses with an error; thrown from here it ended the whole process
      // (paid run L39 stopped this way, a minute after crafting its diamond pickaxe).
      try { monitor(); } catch { abort(); }
    }, opts.checkIntervalMs);
    const monitor = () => {
      const pos = bot.entity.position;
      const now = Date.now();

      // Digging and scaffold placement intentionally keep the bot stationary.
      // Stopping pathfinder here cancels useful terrain work and makes vertical
      // cave exits look stuck. The segment's overall timeout still bounds it.
      const terrainWork = bot.pathfinder.isMining() ? 'mining'
        : bot.pathfinder.isBuilding() ? 'building' : null;
      if (terrainWork) {
        // Terrain work is not standing still, but it has to get the body somewhere: a block dug or
        // placed is followed by a step. An executor that held its building pose at a rim for a whole
        // move (paid run L50), or worked on one spot for thirty seconds (L52), was never called stuck,
        // because work was exempt from the checks below without any bound of its own.
        const held = workAnchor ? Math.hypot(pos.x - workAnchor.x, pos.y - workAnchor.y, pos.z - workAnchor.z) : Infinity;
        // The slowest block met on this spot sets the bound: a quick block after a slow one must not shrink it.
        const allowanceMs = Math.max(workAnchor?.allowanceMs ?? 0, terrainWorkAllowanceMs(bot));
        if (!workAnchor || held >= opts.macroMinProgress) workAnchor = { x: pos.x, y: pos.y, z: pos.z, at: now, allowanceMs: terrainWorkAllowanceMs(bot) };
        else if (now - workAnchor.at > (workAnchor.allowanceMs = allowanceMs)) {
          const activity = describePathExecutor(bot);
          if (opts.logStuck) log.warn(`⚠️ 地形作業が進まない — ${((now - workAnchor.at) / 1000).toFixed(0)}秒同じ場所（${activity}）`);
          finish({ result: 'stuck', stuckBlock: detectObstacle(bot, pos) ?? undefined, activity: `${activity}のまま${((now - workAnchor.at) / 1000).toFixed(0)}秒進まず` });
          return;
        }
        microCount = 0;
        lastPos = { x: pos.x, y: pos.y, z: pos.z };
        macroCheckPos = { ...lastPos };
        macroCheckTime = now;
        if (terrainWork !== terrainWorkState) {
          reportActionProgress(bot, 'navigate', { position: pos.toArray(), terrainWork }, true);
        }
        terrainWorkState = terrainWork;
        return;
      }
      terrainWorkState = null;
      workAnchor = null;

      // Neither walking a path nor working on the terrain: searching, which is over in seconds, or
      // wedged. The path library kept a position to step back to from one goal to the next and, while
      // the body could not reach it, computed no path at all; every check below asks for a path in
      // hand, so move after move ran its full time on one spot without a word (paid runs L46, L51,
      // L52; L51 was shot standing there).
      if (!bot.pathfinder.isMoving()) {
        const held = idleAnchor ? Math.hypot(pos.x - idleAnchor.x, pos.y - idleAnchor.y, pos.z - idleAnchor.z) : Infinity;
        if (!idleAnchor || held >= opts.macroMinProgress) idleAnchor = { x: pos.x, y: pos.y, z: pos.z, at: now };
        else if (now - idleAnchor.at > IDLE_EXECUTOR_MS) {
          const seconds = ((now - idleAnchor.at) / 1000).toFixed(0);
          if (opts.logStuck) log.warn(`⚠️ 経路の実行が始まらない — ${seconds}秒同じ場所（${describePathExecutor(bot)}）`);
          finish({ result: 'stuck', stuckBlock: detectObstacle(bot, pos) ?? undefined, activity: `${describePathExecutor(bot)}のまま${seconds}秒動かず` });
          return;
        }
      } else idleAnchor = null;

      // ── ミクロスタック: 短時間の位置停滞 ──
      const moved =
        Math.abs(pos.x - lastPos.x) +
        Math.abs(pos.y - lastPos.y) +
        Math.abs(pos.z - lastPos.z);
      if (moved >= opts.stuckThreshold) reportActionProgress(bot, 'navigate', {
        position: pos.toArray(), moved }, true);

      if (moved < opts.stuckThreshold && bot.pathfinder.isMoving()) {
        microCount++;
        if (microCount >= opts.microStuckCount) {
          const block = detectObstacle(bot, pos);
          finish({ result: 'stuck', stuckBlock: block ?? undefined });
          return;
        }
      } else {
        microCount = 0;
      }
      lastPos = { x: pos.x, y: pos.y, z: pos.z };

      // ── マクロスタック: 数秒スパンで実質的な進捗なし ──
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
          finish({ result: 'stuck', stuckBlock: block ?? undefined });
          return;
        }
        macroCheckPos = { x: pos.x, y: pos.y, z: pos.z };
        macroCheckTime = now;
      }
    };

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
  assertActionActive(bot);
  bot.clearControlStates();

  // These moves are made without looking: a hop forward, back or sideways to shake the body loose. Beside
  // lava that is how a body that was only stuck ended up in it: one hop off its footing, dead in 2.5
  // seconds (paid run L45, building a portal by a lava lake). There the body stays put and the route
  // is simply planned again.
  if (lethalGroundNearby(bot)) {
    log.warn('⚠️ 溶岩の近くなので、当てずっぽうの脱出動作はしない（経路を引き直す）');
    await sleep(bot, 300);
    return;
  }

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
      await sleep(bot, 400);
      break;
    case 1:
      bot.setControlState('back', true);
      bot.setControlState('jump', true);
      await sleep(bot, 500);
      break;
    case 2:
      bot.setControlState('left', true);
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);
      await sleep(bot, 500);
      break;
    case 3:
      bot.setControlState('right', true);
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);
      await sleep(bot, 500);
      break;
  }

  bot.clearControlStates();
  await sleep(bot, 100);
}

/** Lava or fire within a hop of the body: two blocks to any side, from three below the feet to head height. */
export function lethalGroundNearby(bot: Pick<CustomBot, 'entity' | 'blockAt'>): boolean {
  const feet = bot.entity?.position?.floored?.();
  if (!feet) return false;
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -3; dy <= 1; dy++) {
    let name: string | undefined;
    try { name = bot.blockAt(feet.offset(dx, dy, dz), false)?.name; } catch { return true; }
    if (name === 'lava' || name === 'fire' || name === 'soul_fire' || name === 'magma_block') return true;
  }
  return false;
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
      await sleep(bot, 600);
      bot.clearControlStates();
      await sleep(bot, 200);
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
    await sleep(bot, 1200 + attempt * 300);

    bot.clearControlStates();
    await sleep(bot, 200);

    // 脱出できたか確認 — まだ水流内ならもう一度ブロック設置を試みる
    if (isInFlowingWater(bot)) {
      const placed = await tryPlaceBlockUnderFeet(bot);
      if (placed) {
        log.info('🏊 水流脱出: 泳いだ先で足元にブロック設置');
        bot.setControlState('jump', true);
        await sleep(bot, 400);
        bot.clearControlStates();
      }
    }
    await sleep(bot, 100);
    return;
  }

  // ── 戦略3: 上方向に脱出 ──
  bot.setControlState('jump', true);
  await sleep(bot, 800);
  bot.clearControlStates();
  await sleep(bot, 100);
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
    assertActionActive(bot);
    await bot.lookAt(refBlock.position.offset(0.5, 1, 0.5));
    assertActionActive(bot);
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
