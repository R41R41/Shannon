import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { setMovements } from '../utils/setMovements.js';
import { gotoSafe } from '../utils/gotoSafe.js';
const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:fleeFrom');

/**
 * 原子的スキル: エンティティから逃げる
 * GoalInvertを使用して対象から離れる方向に移動する
 */
class FleeFrom extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'flee-from';
    this.description =
      '指定したエンティティまたは座標から逃げます。安全な距離まで離れます。';
    this.params = [
      {
        name: 'target',
        type: 'string',
        description:
          '逃げる対象。エンティティ名（例: "zombie", "Player123"）または座標（例: "100,64,200"）',
      },
      {
        name: 'minDistance',
        type: 'number',
        description: '最低限離れる距離（ブロック数、デフォルト: 32）',
        default: 32,
      },
      {
        name: 'timeout',
        type: 'number',
        description: 'タイムアウト時間（ミリ秒、デフォルト: 10000=10秒）',
        default: 10000,
      },
      {
        name: 'entityName',
        type: 'string',
        description: '（非推奨）targetと同じ。後方互換性のため残しています。',
      },
    ];
  }

  async runImpl(
    target: string,
    minDistance: number = 32,
    timeout: number = 10000,
    entityName?: string // 後方互換性のため
  ) {
    try {
      // entityNameが渡された場合はtargetとして使用（後方互換性）
      const actualTarget = target || entityName;

      if (!actualTarget) {
        return {
          success: false,
          result: '逃げる対象を指定してください（target引数にエンティティ名または座標を指定）',
        };
      }

      // 対象の位置を取得
      const targetInfo = this.resolveTarget(actualTarget);

      if (!targetInfo) {
        return {
          success: false,
          result: `"${actualTarget}"が見つかりません`,
        };
      }

      const { position, name } = targetInfo;

      // 現在の距離を確認
      const currentDistance = this.bot.entity.position.distanceTo(position);

      if (currentDistance >= minDistance) {
        return {
          success: true,
          result: `既に${name}から十分離れています（距離: ${currentDistance.toFixed(
            1
          )}m）`,
        };
      }

      // pathfinderの移動設定（水を避ける）
      setMovements(
        this.bot,
        true, // allow1by1towers: 高い場所に逃げられる
        true, // allowSprinting: 逃げるときはダッシュ
        false, // allowParkour: 崖飛び越えを避ける
        true, // canOpenDoors
        false, // canDig: 逃げるときは掘らない（遅い）
        true, // dontMineUnderFallingBlock
        100, // digCost: 掘るコストを高く（避ける）
        false, // allowFreeMotion: 水中移動は遅いので避ける
        false, // canSwim: 水を避けて逃げる（水中は危険）
        2 // maxDropDown
      );

      log.info(`🏃 ${name}から逃走開始（目標距離: ${minDistance}ブロック以上）`);

      // GoalInvertを使用して逃げる方向に移動
      // GoalNearの逆で、指定位置から離れる
      const fleeGoal = new goals.GoalInvert(
        new goals.GoalNear(position.x, position.y, position.z, minDistance)
      );

      const fleeResult = await gotoSafe(this.bot, fleeGoal, {
        timeoutMs: timeout,
        stuckAbortCount: 4,
        checkDestinationSafety: false,
      });

      const finalDistance = this.bot.entity.position.distanceTo(position);
      const fled = finalDistance >= minDistance;

      if (!fleeResult.success && !fled) {
        return {
          success: false,
          result: `${name}からの逃走に失敗（距離: ${currentDistance.toFixed(1)}m → ${finalDistance.toFixed(1)}m, 原因: ${fleeResult.error ?? '不明'}）`,
        };
      }

      return {
        success: true,
        result: `${name}から逃げました（距離: ${currentDistance.toFixed(
          1
        )}m → ${finalDistance.toFixed(1)}m）`,
      };
    } catch (error: any) {
      // 移動を停止
      try {
        this.bot.pathfinder.stop();
      } catch {
        // 無視
      }

      let errorDetail = error.message;
      if (error.message.includes('No path')) {
        errorDetail = '逃げ道が見つかりません（囲まれているかもしれません）';
      } else if (error.message.includes('timeout')) {
        // タイムアウトでも部分的に逃げた可能性があるので確認
        const target = this.resolveTarget(arguments[0]);
        if (target) {
          const finalDistance = this.bot.entity.position.distanceTo(
            target.position
          );
          return {
            success: true,
            result: `逃走中にタイムアウト（現在の距離: ${finalDistance.toFixed(
              1
            )}m）`,
          };
        }
        errorDetail = '逃走がタイムアウトしました';
      }

      return {
        success: false,
        result: `逃走失敗: ${errorDetail}`,
      };
    }
  }

  /**
   * 対象を解決して位置を取得
   */
  private resolveTarget(
    target: string
  ): { position: Vec3; name: string } | null {
    // 座標形式（x,y,z）かチェック
    const coordMatch = target.match(/^(-?\d+),\s*(-?\d+),\s*(-?\d+)$/);
    if (coordMatch) {
      const x = parseInt(coordMatch[1]);
      const y = parseInt(coordMatch[2]);
      const z = parseInt(coordMatch[3]);
      return {
        position: new Vec3(x, y, z),
        name: `座標(${x}, ${y}, ${z})`,
      };
    }

    // エンティティを検索
    const entity = this.findEntity(target);
    if (entity && entity.position) {
      return {
        position: entity.position.clone(),
        name: entity.name || entity.username || target,
      };
    }

    return null;
  }

  /**
   * 名前でエンティティを検索
   */
  private findEntity(name: string): any | null {
    const lowerName = name.toLowerCase();

    // プレイヤーを検索
    const player = this.bot.players[name]?.entity;
    if (player) {
      return player;
    }

    // 部分一致でプレイヤーを検索
    for (const playerName of Object.keys(this.bot.players)) {
      if (playerName.toLowerCase().includes(lowerName)) {
        const p = this.bot.players[playerName]?.entity;
        if (p) return p;
      }
    }

    // エンティティ（モブなど）を検索
    const entities = Object.values(this.bot.entities) as any[];
    let closestEntity = null;
    let closestDistance = Infinity;

    for (const entity of entities) {
      if (!entity.position || entity === this.bot.entity) continue;

      const entityName = entity.name || entity.username || '';
      if (entityName.toLowerCase().includes(lowerName)) {
        const distance = entity.position.distanceTo(this.bot.entity.position);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestEntity = entity;
        }
      }
    }

    return closestEntity;
  }
}

export default FleeFrom;
