import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { actionDelay } from '../execution/observedWait.js';

const { goals } = pathfinder;

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

      const nameOf = (dimension: string) => dimension.includes('overworld') ? 'オーバーワールド' : dimension.includes('nether') ? 'ネザー'
        : dimension.includes('end') ? 'エンド' : '不明';
      // The change of dimension is listened for before the walk: a body that steps into the portal on the way is carried off then,
      // and a listener put on afterwards waited 30 s for what had already happened (a ladder probe, 2026-10-20).
      let arrived = false;
      const onSpawn = () => { if (String(this.bot.game.dimension) !== currentDimension) arrived = true; };
      this.bot.on('spawn', onSpawn);
      try {
        // Into the bottom cell of the portal's column: one higher up has nothing to stand on.
        let foot = pos;
        while (this.bot.blockAt(foot.offset(0, -1, 0))?.name === 'nether_portal') foot = foot.offset(0, -1, 0);
        const inPortal = () => { const at = this.bot.entity.position.floored(); return this.bot.blockAt(at)?.name === 'nether_portal' || this.bot.blockAt(at.offset(0, 1, 0))?.name === 'nether_portal'; };
        const walk = async () => {
          try { return await gotoSafe(this.bot, new goals.GoalBlock(foot.x, foot.y, foot.z), { rockTravel: true, timeoutMs: 20_000 }); }
          catch (error) { if (this.shouldInterrupt()) throw error; return { success: false, error: String(error) }; }
        };
        const moveResult = await walk();
        if (!moveResult.success && !arrived && !inPortal()) {
          return { success: false, result: `ポータルに到達できません（${moveResult.error}）` };
        }
        // Four seconds in the portal take the body over; a busy server, more. 45 s, the body walked back in once if it came out.
        const deadline = Date.now() + 45_000;
        let rewalked = false;
        while (!arrived && Date.now() < deadline && !this.shouldInterrupt()) {
          await actionDelay(this.bot, 250);
          if (String(this.bot.game.dimension) !== currentDimension) arrived = true;
          if (!arrived && !rewalked && Date.now() > deadline - 30_000 && !inPortal()) { rewalked = true; await walk(); }
        }
        if (!arrived) return { success: false, result: '次元移動がタイムアウトしました（ポータルの中で45秒待っても移動しませんでした）' };
        return { success: true, result: `${dimensionName}から${nameOf(String(this.bot.game.dimension))}に移動しました` };
      } finally {
        this.bot.removeListener('spawn', onSpawn);
      }
    } catch (error: any) {
      return {
        success: false,
        result: `次元移動エラー: ${error.message}`,
      };
    }
  }
}

export default EnterPortal;
