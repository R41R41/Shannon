import pathfinder, { type Move } from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { setMovements } from '../utils/setMovements.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';
import { swimOntoBank, waterLevelUnderBody } from '../utils/exitWater.js';
import { forcedMoves } from '../utils/motionRecorder.js';
import { nativeActionHost } from '../execution/ActionExecution.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { GoalReachBlock, DIG_REACH } from '../utils/blockInteractionReach.js';
import { blocksAlong, keepCheapTool } from '../utils/toolStock.js';
const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:moveTo');

/** How many digs the body's guards have refused so far (lava, and hostiles that would be let in). */
function digRefusals(bot: unknown): { lava: number; threat: number } {
  const body = bot as { lavaDigGuard?: { refused: number }; exposureDigGuard?: { refused: number } };
  return { lava: body.lavaDigGuard?.refused ?? 0, threat: body.exposureDigGuard?.refused ?? 0 };
}
/** The reason of a dig refused since `before`, if there was one. */
function digRefusalSince(bot: unknown, before: { lava: number; threat: number }): string | null {
  const body = bot as { lavaDigGuard?: { refused: number; last?: string }; exposureDigGuard?: { refused: number; last?: string } };
  if ((body.exposureDigGuard?.refused ?? 0) > before.threat && body.exposureDigGuard?.last) return body.exposureDigGuard.last;
  if ((body.lavaDigGuard?.refused ?? 0) > before.lava && body.lavaDigGuard?.last) return body.lavaDigGuard.last;
  return null;
}
/**
 * 原子的スキル: 指定座標に移動するだけ
 * goalType: 'near' (デフォルト) または 'xz' (XZ座標のみ、Y座標は自動調整)
 */
/** Metres per second assumed when sizing a move's time: slower than swimming, so only real delay runs it out. */
const SLOWEST_TRAVEL_SPEED = 1.5;
/** The same for a move that starts in the water: a body swimming a route made 24m in 28s (paid run L32). */
const SLOWEST_SWIM_SPEED = 0.7;

class MoveTo extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'move-to';
    this.description =
      '指定された座標に移動します。goalTypeで移動方式を選択できます。';
    this.params = [
      {
        name: 'x',
        type: 'number',
        description: 'X座標',
        required: true,
      },
      {
        name: 'y',
        type: 'number',
        description: 'Y座標（goalType="xz"の場合は無視されます）',
        required: true,
      },
      {
        name: 'z',
        type: 'number',
        description: 'Z座標',
        required: true,
      },
      {
        name: 'range',
        type: 'number',
        description: '目標地点からの許容距離（デフォルト: 2）',
        default: 2,
      },
      {
        name: 'goalType',
        type: 'string',
        description:
          '移動方式: "nearxz"=XZ座標の近く（Y自動）, "near"=XYZ座標の近く, "block"=指定ブロックを掘れる立ち位置（Y自動・最大5.1m）, "xz"=XZ座標ぴったり, "y"=指定高さに移動。デフォルト: "nearxz"',
        default: 'nearxz',
      },
    ];
  }

  async runImpl(
    x: number,
    y: number,
    z: number,
    range: number = 2,
    goalType: string = 'nearxz'
  ) {
    // move-to実行中は、移動系のConstantSkillを一時的に無効化
    const autoFollow = this.bot.constantSkills.getSkill('auto-follow');
    const autoAvoid = this.bot.constantSkills.getSkill('auto-avoid-projectile-range');
    const originalAutoFollowStatus = autoFollow?.status ?? false;
    const originalAutoAvoidStatus = autoAvoid?.status ?? false;
    // A pickaxe is equipped for digging on the way; the item the caller chose
    // (bucket, food, sword, flint and steel) must be back in hand on arrival.
    const heldBeforeMove = this.bot.heldItem?.name ?? null;

    log.debug(`ConstantSkillの状態 - autoFollow: ${originalAutoFollowStatus}, autoAvoid: ${originalAutoAvoidStatus}`);

    // 障害物ブロック情報（エラー時に返す）- tryの外で宣言
    const stuckBlockRef: { info: { x: number; y: number; z: number; name: string } | null } = { info: null };
    let executorActivity: string | null = null;
    const refusalsBefore = digRefusals(this.bot);
    // How far the goal was at the start, for an honest account when the move ends early.
    let startDistance: number | null = null;
    const correctionsAtStart = forcedMoves(nativeActionHost(this.bot)).count;
    const remaining = () => {
      const now = this.bot.entity.position;
      return goalType === 'y' ? Math.abs(y - now.y)
        : goalType === 'xz' || goalType === 'nearxz' ? Math.hypot(x - now.x, z - now.z)
        : Math.sqrt((x - now.x) ** 2 + (y - now.y) ** 2 + (z - now.z) ** 2);
    };

    try {
      // ConstantSkillを一時無効化
      if (autoFollow) {
        autoFollow.status = false;
      }
      if (autoAvoid) {
        autoAvoid.status = false;
      }

      // パラメータの妥当性チェック
      if (!Number.isFinite(x) || !Number.isFinite(z)) {
        return {
          success: false,
          result: 'X/Z座標は有効な数値である必要があります',
          failureType: 'invalid_input',
          recoverable: false,
        };
      }

      // Y座標が必要なgoalTypeの場合のみチェック
      const needsY = goalType === 'near' || goalType === 'y' || goalType === 'block';
      if (needsY) {
        if (!Number.isFinite(y)) {
          return {
            success: false,
            result: 'Y座標は有効な数値である必要があります',
            failureType: 'invalid_input',
            recoverable: false,
          };
        }

        // Y座標の範囲チェック（-64～320）
        if (y < -64 || y > 320) {
          return {
            success: false,
            result: `Y座標が範囲外です（${y}）。-64～320の範囲で指定してください`,
            failureType: 'invalid_input',
            recoverable: false,
          };
        }
      }

      if (goalType === 'block' && (!Number.isFinite(range) || range <= 0)) {
        return { success: false, result: 'block の許容距離は正の数で指定してください', failureType: 'invalid_input', recoverable: false };
      }

      // 現在位置からの距離チェック
      const currentPos = this.bot.entity.position;
      // Where the body stood when the move was asked for (the position object itself moves with the body).
      const startedFrom = currentPos.clone();
      let distance: number;

      switch (goalType) {
        case 'xz':
        case 'nearxz':
          // XZ平面での距離
          distance = Math.sqrt(
            Math.pow(x - currentPos.x, 2) + Math.pow(z - currentPos.z, 2)
          );
          break;
        case 'y':
          // 高さの差
          distance = Math.abs(y - currentPos.y);
          break;

        case 'near':
        default:
          // 3D距離
          distance = Math.sqrt(
            Math.pow(x - currentPos.x, 2) +
            Math.pow(y - currentPos.y, 2) +
            Math.pow(z - currentPos.z, 2)
          );
          break;
      }

      startDistance = distance;
      if (distance > 1000) {
        return {
          success: false,
          result: `目的地が遠すぎます（${distance.toFixed(
            0
          )}m）。1000m以内にしてください`,
          failureType: 'distance_too_far',
          recoverable: true,
        };
      }

      // A walk that will tunnel takes, for each block it breaks, the cheapest tool carried; if that is a dear one
      // and a cheaper one can be made from the bag, it is made first (utils/toolStock; the iron pickaxe of L111).
      if (distance > range) {
        const toward = goalType === 'y' ? { x: currentPos.x, y, z: currentPos.z }
          : goalType === 'xz' || goalType === 'nearxz' ? { x, y: currentPos.y, z } : { x, y, z };
        await keepCheapTool(this.bot as any, blocksAlong(this.bot as any, startedFrom, toward),
          (skill, ...args) => this.callSkill(skill, ...args));
      }

      // pathfinderの移動設定を最適化
      // 水中にいる場合はallowFreeMotionとcanSwimを有効化
      const isInWater = (this.bot.entity as any)?.isInWater || false;

      setMovements(
        this.bot,
        false, // allow1by1towers
        true,  // allowSprinting
        true,  // allowParkour
        true,  // canOpenDoors
        true,  // canDig
        true,  // dontMineUnderFallingBlock
        isInWater ? 8 : 10, // prefer existing routes; still tunnel when necessary
        isInWater, // allowFreeMotion
        true,  // canSwim
        4,     // maxDropDown
        isInWater ? 2 : 10, // liquidCost: 水中では低め、陸上では水を強く回避
      );

      if (isInWater) {
        log.info('🏊 水中移動モード', 'cyan');
      }

      // No pickaxe is put in hand here: the pathfinder equips, for each block it breaks, the tool that is cheapest
      // in time and wear (utils/toolChoice). Holding the best pickaxe from the start spent the iron one (L111).

      // goalTypeに応じてGoalを選択
      let goal;
      let goalDescription: string;

      switch (goalType) {
        case 'xz':
          // XZ座標のみ（Y座標は自動調整）
          goal = new goals.GoalXZ(x, z);
          goalDescription = `XZ座標(${x}, ${z})`;
          break;

        case 'nearxz':
          // XZ座標の近く（範囲指定）
          goal = new goals.GoalNearXZ(x, z, range);
          goalDescription = `XZ座標(${x}, ${z})の${range}ブロック以内`;
          break;

        case 'y':
          // 指定高さに移動
          goal = new goals.GoalY(y);
          goalDescription = `高さY=${y}`;
          break;

        case 'block':
          goal = new GoalReachBlock(x, y, z, Math.min(range, DIG_REACH));
          goalDescription = `ブロック(${x}, ${y}, ${z})を掘れる立ち位置`;
          break;

        case 'near':
        default:
          // デフォルト: GoalNear（XYZ座標の近くに移動）
          goal = new goals.GoalNear(x, y, z, range);
          goalDescription = `座標(${x}, ${y}, ${z})`;
          break;
      }

      log.info(`🚶 移動開始: ${goalDescription} (現在: ${currentPos.x.toFixed(1)}, ${currentPos.y.toFixed(1)}, ${currentPos.z.toFixed(1)} / 距離: ${distance.toFixed(1)}m)`);

      // 移動前にコントロール状態をリセット（前のタスクの残りを消す）
      this.bot.clearControlStates();
      this.bot.stopDigging();

      // Time in proportion to the way: a fixed 30s cut a 63m walk that was
      // still advancing 18m short and called it "no path" (paid run L18).
      // Standing still is caught by the stuck check, not by this bound.
      // Without a pickaxe the way may have to be dug by hand, several seconds a block: the time the walk alone
      // would take cut such a move off after its second block (lab, in the world of paid run L73), so it gets
      // the whole of what a move may take. Standing still is still caught by the stuck check.
      const handDigging = !this.bot.inventory.items().some(item => item.name.includes('pickaxe'));
      const longestMs = Math.max(30_000, (this.maxDurationMs || 120_000) - 10_000);
      const travelBudgetMs = handDigging ? longestMs
        : Math.min(Math.max(30_000, (distance / (isInWater ? SLOWEST_SWIM_SPEED : SLOWEST_TRAVEL_SPEED)) * 1000), longestMs);
      const travelStartedAt = Date.now();
      let gotoResult = await gotoSafe(this.bot, goal, { timeoutMs: travelBudgetMs });
      // Still in the water and not there: the pathfinder plans no step up out
      // of a liquid. Climb the bank at the waterline, then travel on from land.
      if (waterLevelUnderBody(this.bot as any) !== null && !this.shouldInterrupt()
        && (!gotoResult.success || !goal.isEnd(this.bot.entity.position.floored() as unknown as Move))
        && await swimOntoBank(this.bot as any, x, z)) {
        log.info('🏊 水際の岸へ泳ぎ上がった。陸から移動を続ける');
        gotoResult = await gotoSafe(this.bot, goal, { timeoutMs: Math.max(5_000, travelBudgetMs - (Date.now() - travelStartedAt)) });
      }
      if (gotoResult.stuckBlock) stuckBlockRef.info = gotoResult.stuckBlock;
      if (!gotoResult.success) executorActivity = gotoResult.activity ?? null;
      if (!gotoResult.success) {
        throw new Error(
          gotoResult.error === 'stuck' ? 'スタック検出による移動中断'
          : gotoResult.error === 'timeout' ? '移動タイムアウト'
          : gotoResult.error === 'no_path' ? 'no path found'
          : gotoResult.error ?? 'movement_failed',
        );
      }

      // 到達確認: pathfinder が success を返しても実際に到達していない場合がある
      const finalPos = this.bot.entity.position;
      let finalDistance: number;
      switch (goalType) {
        case 'xz':
        case 'nearxz':
          finalDistance = Math.sqrt(
            Math.pow(x - finalPos.x, 2) + Math.pow(z - finalPos.z, 2)
          );
          break;
        case 'y':
          finalDistance = Math.abs(y - finalPos.y);
          break;
        case 'near':
        default:
          finalDistance = Math.sqrt(
            Math.pow(x - finalPos.x, 2) +
            Math.pow(y - finalPos.y, 2) +
            Math.pow(z - finalPos.z, 2)
          );
          break;
      }

      // GoalNear/GoalNearXZ/GoalXZ/GoalY は目標と足元のブロック座標で
      // isEnd を判定する。pathfinder の success だけを信用したり、固定の
      // 5m 猶予を与えたりすると range=1 でも 4m 離れた位置を成功にしてしまう。
      // pathfinder の型は Move 全体を要求するが、これらの goal 実装が参照するのは
      // x/y/z のみ。実行時と同じ足元ブロック座標を渡す。
      const reachedGoal = goal.isEnd(finalPos.floored() as unknown as Move);
      log.debug(`移動完了確認: 実距離=${finalDistance.toFixed(1)}m, goal.isEnd=${reachedGoal}`);
      if (!reachedGoal) {
        log.warn(`⚠️ 到達確認失敗: 実距離=${finalDistance.toFixed(1)}m, 目標=${goalDescription} (現在: ${finalPos.x.toFixed(1)}, ${finalPos.y.toFixed(1)}, ${finalPos.z.toFixed(1)})`);
        // A move that ends where it began was not a move. The route planner hands back an empty route when it
        // finds no step it can take from where the body stands, and that was reported as "moved, but did not
        // arrive" with guesses about chunks: a body in a pit was told so thirty times (paid run L73).
        if (finalPos.distanceTo(startedFrom) < 0.5) {
          let why = '';
          try {
            const refusal = digRefusalSince(this.bot, refusalsBefore);
            if (refusal) why = `経路上の掘削を断りました: ${refusal}`;
            else {
              const items = this.bot.inventory.items();
              const noPickaxe = !items.some(item => item.name.includes('pickaxe'));
              why = 'ここから踏み出せる一歩が見つかりません（周りが塞がっている、または囲まれた穴の中）。'
                + (noPickaxe ? 'つるはしが無いので、硬いブロックは素手で掘ることになります（1個数秒）。' : '')
                + 'get-blocks-in-area で周囲を確かめ、dig-block-at（collect=false）で一方向を開けるか、ブロックを置いて登ってください';
            }
          } catch { /* the plain statement stands */ }
          return {
            success: false,
            result: `その場から動けませんでした（現在: ${finalPos.x.toFixed(1)}, ${finalPos.y.toFixed(1)}, ${finalPos.z.toFixed(1)}、目標まで${finalDistance.toFixed(1)}m）。${why}`,
            failureType: 'no_route_from_here',
            recoverable: true,
          };
        }
        return {
          success: false,
          result: `移動したが${goalType === 'block' ? '採掘可能な立ち位置' : '指定した目標範囲'}に到達できませんでした（実距離: ${finalDistance.toFixed(1)}m、現在: ${finalPos.x.toFixed(1)}, ${finalPos.y.toFixed(1)}, ${finalPos.z.toFixed(1)}）。チャンク未ロード・地形障害・Y座標の大きな差の可能性があります`,
          failureType: 'position_verification_failed',
          recoverable: true,
        };
      }

      return {
        success: true,
        result: finalPos.distanceTo(startedFrom) < 0.5
          ? `既に${goalDescription}にいます（動いていません。目標まで${finalDistance.toFixed(1)}m）`
          : `${goalDescription}に移動しました（移動距離: ${finalPos.distanceTo(startedFrom).toFixed(1)}m、最終距離: ${finalDistance.toFixed(1)}m）`,
      };
    } catch (error: any) {
      // エラーメッセージを詳細化
      const errorMessage = error.message ? error.message.toLowerCase() : '';
      log.error(`❌ 移動エラー: ${error.message}`, error);

      let errorDetail = error.message;
      if (errorMessage.includes('no path')) {
        errorDetail =
          'パスが見つかりません（障害物、高低差が大きい、チャンク未ロードなど）';
        // Without a pickaxe the route planner does not dig stone, and a body shut in by stone then has no
        // route to anywhere, at once. Said only as "no path", a planner whose pickaxe had broken in a tunnel
        // tried six destinations before digging out by hand (paid run L56).
        try {
          if (!this.bot.inventory.items().some(item => item.name.includes('pickaxe'))) {
            errorDetail += '。つるはしを持っていないため、石などの硬いブロックは素手で掘ることになります（1個数秒、何も手に入りません）。硬いブロックに囲まれている場合は、dig-block-at（collect=false）で一方向を開けるか、つるはしを作ってください';
          }
        } catch { /* inventory unreadable: the plain reason stands */ }
      } else if (errorMessage.includes('スタック検出')) {
        errorDetail =
          '数秒間同じ場所から動けませんでした（障害物やスタックの可能性があります）';
      } else if (
        errorMessage.includes('timeout') ||
        errorMessage.includes('decide path to goal') ||
        errorMessage.includes('took to long')
      ) {
        errorDetail =
          '経路計算または移動がタイムアウトしました（地形が複雑、経路探索に失敗、または到達困難の可能性があります）';
      } else if (errorMessage.includes('stop') || errorMessage.includes('abort')) {
        errorDetail =
          '移動が中断されました（他のスキルまたはイベントによって停止された可能性があります）';
      }

      // 障害物ブロック情報があれば追加
      let obstacleInfo = '';
      if (stuckBlockRef.info) {
        obstacleInfo = PROTECTED_UTILITY_BLOCKS.has(stuckBlockRef.info.name)
          ? `。重要設備ブロック: ${stuckBlockRef.info.name} at (${stuckBlockRef.info.x}, ${stuckBlockRef.info.y}, ${stuckBlockRef.info.z})。破壊せず、迂回・別地点への移動・再計画を検討してください`
          : `。障害物ブロック: ${stuckBlockRef.info.name} at (${stuckBlockRef.info.x}, ${stuckBlockRef.info.y}, ${stuckBlockRef.info.z})。dig-block-atで破壊を検討してください`;
      }

      // What the body actually did: a move that ran out of time after covering
      // most of the way is not the same failure as one that never found a path.
      let progress = '';
      let advanced = 0;
      const pushedBack = forcedMoves(nativeActionHost(this.bot)).count - correctionsAtStart;
      try {
        if (startDistance !== null && this.bot.entity) {
          const left = remaining();
          const here = this.bot.entity.position;
          advanced = startDistance - left;
          progress = `。目標までの距離: ${startDistance.toFixed(1)}m → ${left.toFixed(1)}m（現在: ${here.x.toFixed(1)}, ${here.y.toFixed(1)}, ${here.z.toFixed(1)}）`
            + (advanced >= Math.max(3, startDistance * 0.25) ? '。目標へ近づいているので、同じ目標で再実行すれば続きから進めます' : '')
            + (pushedBack >= 3 ? `。この移動中にサーバーが位置を${pushedBack}回戻しました（進もうとした先を通れないと判定されています）` : '');
        }
      } catch { /* position unknown */ }
      // What the executor was busy with when the move ended: the planner can act on "digging X" or
      // "placing scaffolding", not on a bare time-out.
      if (executorActivity) progress += `。停止時の作業: ${executorActivity}`;
      try {
        if (executorActivity?.includes('掘削') && !this.bot.inventory.items().some(item => item.name.includes('pickaxe'))) {
          progress += '（つるはしが無いので素手で掘り進んでいます。1個に数秒かかります。同じ目標で再実行すれば続きから進みます）';
        }
      } catch { /* inventory unreadable */ }
      // A dig on the route that the body's guards refused (lava behind it, a shut-out mob behind it): the reason
      // is the planner's to act on, and the route executor only knows "dig error".
      const refusal = digRefusalSince(this.bot, refusalsBefore);
      if (refusal) progress += `。経路上の掘削を断りました: ${refusal}`;
      const timedOut = errorMessage.includes('timeout') || errorMessage.includes('タイムアウト')
        || errorMessage.includes('decide path to goal') || errorMessage.includes('took to long');
      if (timedOut && advanced >= Math.max(3, (startDistance ?? 0) * 0.25)) {
        return { success: false, result: `移動未完了: 制限時間内に着きませんでした${progress}${obstacleInfo}`,
          failureType: 'movement_incomplete', recoverable: true };
      }

      return {
        success: false,
        result: `移動失敗: ${errorDetail}${progress}${obstacleInfo}`,
        failureType: errorMessage.includes('no path')
          ? 'path_not_found'
          : errorMessage.includes('スタック検出')
            ? 'stuck'
            : errorMessage.includes('timeout') || errorMessage.includes('decide path to goal') || errorMessage.includes('took to long')
              ? 'path_not_found'
              : errorMessage.includes('stop') || errorMessage.includes('abort')
                ? 'interrupted'
                : 'movement_failed',
        recoverable: true,
      };
    } finally {
      if (heldBeforeMove && this.bot.heldItem?.name !== heldBeforeMove) {
        const previous = this.bot.inventory.items().find(item => item.name === heldBeforeMove);
        if (previous) {
          try { await this.bot.equip(previous, 'hand'); } catch { /* the move result stands */ }
        }
      }
      // ConstantSkillを元の状態に戻す
      if (autoFollow) {
        autoFollow.status = originalAutoFollowStatus;
      }
      if (autoAvoid) {
        autoAvoid.status = originalAutoAvoidStatus;
      }
    }
  }
}

export default MoveTo;
