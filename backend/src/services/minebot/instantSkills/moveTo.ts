import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { setMovements } from '../utils/setMovements.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';
import { gotoSafe } from '../utils/gotoSafe.js';
const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:moveTo');
/**
 * 原子的スキル: 指定座標に移動するだけ
 * goalType: 'near' (デフォルト) または 'xz' (XZ座標のみ、Y座標は自動調整)
 */
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
          '移動方式: "nearxz"=XZ座標の近く（Y自動。地上移動はこれを使え）, "near"=XYZ座標の近く（Yが正確にわかる場合のみ）, "xz"=XZ座標ぴったり, "y"=指定高さに移動。デフォルト: "nearxz"',
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

    log.debug(`ConstantSkillの状態 - autoFollow: ${originalAutoFollowStatus}, autoAvoid: ${originalAutoAvoidStatus}`);

    // 障害物ブロック情報（エラー時に返す）- tryの外で宣言
    const stuckBlockRef: { info: { x: number; y: number; z: number; name: string } | null } = { info: null };

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
      const needsY = goalType === 'near' || goalType === 'y';
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

      // 現在位置からの距離チェック
      const currentPos = this.bot.entity.position;
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
        isInWater ? 2 : 1, // digCost
        isInWater, // allowFreeMotion
        true,  // canSwim
        4,     // maxDropDown
        isInWater ? 2 : 10, // liquidCost: 水中では低め、陸上では水を強く回避
      );

      if (isInWater) {
        log.info('🏊 水中移動モード', 'cyan');
      }

      // ピッカクスがあれば自動装備（pathfinder がブロックを掘る際に使われる）
      const pickaxe = this.bot.inventory.items()
        .filter((item) => item.name.includes('pickaxe'))
        .sort((a, b) => {
          const tierOrder: Record<string, number> = { netherite: 5, diamond: 4, iron: 3, stone: 2, golden: 1, wooden: 0 };
          const tierA = Object.keys(tierOrder).find((t) => a.name.includes(t)) ?? '';
          const tierB = Object.keys(tierOrder).find((t) => b.name.includes(t)) ?? '';
          return (tierOrder[tierB] ?? -1) - (tierOrder[tierA] ?? -1);
        })[0];
      if (pickaxe) {
        try {
          await this.bot.equip(pickaxe, 'hand');
          log.debug(`⛏ ${pickaxe.name} を装備`);
        } catch { /* ignore equip failure */ }
      }

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

      const gotoResult = await gotoSafe(this.bot, goal, { timeoutMs: 30_000 });
      if (gotoResult.stuckBlock) stuckBlockRef.info = gotoResult.stuckBlock;
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

      log.debug(`✅ 移動完了確認: 実距離=${finalDistance.toFixed(1)}m, 許容=${range}m`);

      // 許容距離の2倍以上離れている場合は失敗とみなす（最低5m + 浮動小数点マージン）
      const acceptableDistance = Math.max(range * 2, 5) + 0.5;
      if (finalDistance > acceptableDistance) {
        log.warn(`⚠️ 到達確認失敗: 実距離=${finalDistance.toFixed(1)}m > 許容=${acceptableDistance}m (現在: ${finalPos.x.toFixed(1)}, ${finalPos.y.toFixed(1)}, ${finalPos.z.toFixed(1)})`);
        return {
          success: false,
          result: `移動したが目標地点に到達できませんでした（実距離: ${finalDistance.toFixed(1)}m、許容: ${acceptableDistance}m）。チャンク未ロード・地形障害・Y座標の大きな差の可能性があります`,
          failureType: 'position_verification_failed',
          recoverable: true,
        };
      }

      return {
        success: true,
        result: `${goalDescription}に移動しました（移動距離: ${distance.toFixed(1)}m、最終距離: ${finalDistance.toFixed(1)}m）`,
      };
    } catch (error: any) {
      // エラーメッセージを詳細化
      const errorMessage = error.message ? error.message.toLowerCase() : '';
      log.error(`❌ 移動エラー: ${error.message}`, error);

      let errorDetail = error.message;
      if (errorMessage.includes('no path')) {
        errorDetail =
          'パスが見つかりません（障害物、高低差が大きい、チャンク未ロードなど）';
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

      return {
        success: false,
        result: `移動失敗: ${errorDetail}${obstacleInfo}`,
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
