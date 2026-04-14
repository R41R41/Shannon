import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { gotoSafe } from '../utils/gotoSafe.js';

/**
 * 原子的スキル: ポータルに入って次元移動
 */
class EnterPortal extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'enter-portal';
    this.description = 'ポータルに入って次元移動します。';
    this.params = [
      {
        name: 'x',
        type: 'number',
        description: 'ポータルのX座標',
        required: true,
      },
      {
        name: 'y',
        type: 'number',
        description: 'ポータルのY座標',
        required: true,
      },
      {
        name: 'z',
        type: 'number',
        description: 'ポータルのZ座標',
        required: true,
      },
    ];
  }

  async runImpl(x: number, y: number, z: number) {
    try {
      // パラメータチェック
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return {
          success: false,
          result: '座標は有効な数値である必要があります',
        };
      }

      const pos = new Vec3(x, y, z);
      const block = this.bot.blockAt(pos);

      if (!block) {
        return {
          success: false,
          result: `座標(${x}, ${y}, ${z})にブロックが見つかりません`,
        };
      }

      // ポータルかチェック
      if (!block.name.includes('portal')) {
        return {
          success: false,
          result: `${block.name}はポータルではありません`,
        };
      }

      const currentDimension = String(this.bot.game.dimension);
      const dimensionName = currentDimension.includes('overworld')
        ? 'オーバーワールド'
        : currentDimension.includes('nether')
        ? 'ネザー'
        : currentDimension.includes('end')
        ? 'エンド'
        : '不明';

      // ポータルの位置に移動
      const pathfinder = require('mineflayer-pathfinder');
      const { goals } = pathfinder;
      const goal = new goals.GoalBlock(x, y, z);

      const moveResult = await gotoSafe(this.bot, goal, { timeoutMs: 20_000 });
      if (!moveResult.success) {
        return { success: false, result: `ポータルに到達できません（${moveResult.error}）` };
      }

      // 次元移動を待つ（最大30秒）
      return new Promise<{ success: boolean; result: string }>((resolve) => {
        const timeout = setTimeout(() => {
          resolve({
            success: false,
            result: `次元移動がタイムアウトしました（30秒以内に移動できませんでした）`,
          });
        }, 30000);

        const onSpawn = () => {
          clearTimeout(timeout);
          this.bot.removeListener('spawn', onSpawn);

          const newDimension = String(this.bot.game.dimension);
          const newDimensionName = newDimension.includes('overworld')
            ? 'オーバーワールド'
            : newDimension.includes('nether')
            ? 'ネザー'
            : newDimension.includes('end')
            ? 'エンド'
            : '不明';

          resolve({
            success: true,
            result: `${dimensionName}から${newDimensionName}に移動しました`,
          });
        };

        this.bot.once('spawn', onSpawn);
      });
    } catch (error: any) {
      return {
        success: false,
        result: `次元移動エラー: ${error.message}`,
      };
    }
  }
}

export default EnterPortal;
