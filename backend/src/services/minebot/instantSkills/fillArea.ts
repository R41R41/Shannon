import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { gotoSafe } from '../utils/gotoSafe.js';

const { goals } = pathfinder;
/** How far a cell's centre may be from the body's feet for a placement (place-block-at refuses beyond five). */
const REACH = 4.2;

/**
 * 原子的スキル: エリアを特定ブロックで埋める
 */
class FillArea extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'fill-area';
    this.description =
      '指定した範囲を特定のブロックで埋めます（整地や簡単な建築に使用）。';
    this.params = [
      {
        name: 'x1',
        type: 'number',
        description: '開始X座標',
        required: true,
      },
      {
        name: 'y1',
        type: 'number',
        description: '開始Y座標',
        required: true,
      },
      {
        name: 'z1',
        type: 'number',
        description: '開始Z座標',
        required: true,
      },
      {
        name: 'x2',
        type: 'number',
        description: '終了X座標',
        required: true,
      },
      {
        name: 'y2',
        type: 'number',
        description: '終了Y座標',
        required: true,
      },
      {
        name: 'z2',
        type: 'number',
        description: '終了Z座標',
        required: true,
      },
      {
        name: 'blockName',
        type: 'string',
        description: '設置するブロック名',
        required: true,
      },
    ];
  }

  async runImpl(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    blockName: string
  ) {
    try {
      // パラメータチェック
      if (
        !Number.isFinite(x1) ||
        !Number.isFinite(y1) ||
        !Number.isFinite(z1) ||
        !Number.isFinite(x2) ||
        !Number.isFinite(y2) ||
        !Number.isFinite(z2)
      ) {
        return {
          success: false,
          result: '座標は有効な数値である必要があります',
        };
      }

      // ブロック数の計算
      const dx = Math.abs(x2 - x1) + 1;
      const dy = Math.abs(y2 - y1) + 1;
      const dz = Math.abs(z2 - z1) + 1;
      const totalBlocks = dx * dy * dz;

      // A bound on what is looked at; what is placed is bounded below by the cells that are empty.
      if (totalBlocks > 1000) {
        return {
          success: false,
          result: `範囲が大きすぎます（${totalBlocks}マス、最大1000マスまで）`,
        };
      }

      const held = () => this.bot.inventory.items().filter((entry) => entry.name === blockName).reduce((sum, entry) => sum + entry.count, 0);
      if (held() === 0) {
        return {
          success: false,
          result: `${blockName}を持っていません`,
        };
      }
      const placer = this.bot.instantSkills?.getSkill('place-block-at');
      if (!placer) return { success: false, result: 'place-block-at が使えません' };

      // 範囲の正規化
      const minX = Math.min(x1, x2);
      const maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2);
      const maxY = Math.max(y1, y2);
      const minZ = Math.min(z1, z2);
      const maxZ = Math.max(z1, z2);

      // What is to be filled is what is empty now: cells already holding a block need no item. The whole
      // range used to be counted against a single stack ("needs 75, has 64" with 126 in the pack and half
      // the range already stone), and a cell more than five blocks from where the body happened to stand
      // ended the fill with nothing placed (paid run L64: eleven calls, seven blocks).
      const open = (pos: Vec3) => { const block = this.bot.blockAt(pos); return !block || block.boundingBox !== 'block'; };
      const pending: Vec3[] = [];
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
        const pos = new Vec3(x, y, z);
        if (open(pos)) pending.push(pos);
      }
      const wanted = pending.length;
      if (wanted > 100) return { success: false, result: `埋める空きマスが多すぎます（${wanted}マス、1回に最大100マスまで）。範囲を分けてください` };
      if (wanted === 0) return { success: true, result: `範囲(${minX},${minY},${minZ})〜(${maxX},${maxY},${maxZ})は既に埋まっています` };

      let placedCount = 0, consecutiveFailures = 0;
      const failures = new Map<string, number>();
      const fail = (reason: string) => { failures.set(reason, (failures.get(reason) ?? 0) + 1); consecutiveFailures++; };
      const supported = (pos: Vec3) => [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
        .some(([dx, dy, dz]) => this.bot.blockAt(pos.offset(dx, dy, dz))?.boundingBox === 'block');
      // Lowest layer first, and within it the nearest cell that has something to be placed against: each
      // block laid is the support for the next.
      while (pending.length && held() > 0 && consecutiveFailures < 6 && !this.shouldInterrupt()) {
        const here = this.bot.entity.position;
        const lowest = Math.min(...pending.filter(supported).map((pos) => pos.y));
        const layer = pending.filter((pos) => pos.y === lowest && supported(pos));
        if (!layer.length) break; // nothing left that touches a block
        const next = layer.reduce((a, b) => (a.offset(0.5, 0.5, 0.5).distanceTo(here) <= b.offset(0.5, 0.5, 0.5).distanceTo(here) ? a : b));
        pending.splice(pending.indexOf(next), 1);
        if (next.offset(0.5, 0.5, 0.5).distanceTo(here) > REACH) {
          const moved = await gotoSafe(this.bot, new goals.GoalNear(next.x, next.y, next.z, 3), { timeoutMs: 8000 });
          if (this.shouldInterrupt()) break;
          if (next.offset(0.5, 0.5, 0.5).distanceTo(this.bot.entity.position) > 5) { fail(`届く所まで行けない（${moved.error ?? '未到達'}）`); continue; }
        }
        const outcome = await placer.run(blockName, next.x, next.y, next.z);
        if (outcome.success || !open(next)) { placedCount++; consecutiveFailures = 0; }
        else {
          const reason = String((outcome as { failureType?: string }).failureType ?? outcome.result).slice(0, 60);
          fail(reason);
          // Something stands in the cell that is not to be built over (a flower, a torch): not a sign that placing has stopped working.
          if (reason === 'target_occupied') consecutiveFailures--;
        }
      }

      const remaining = wanted - placedCount;
      const why = [...failures].map(([reason, times]) => `${reason}×${times}`).join('、');
      const range = `範囲: (${minX},${minY},${minZ})〜(${maxX},${maxY},${maxZ})`;
      if (remaining === 0) return { success: true, result: `${blockName}を${placedCount}個設置しました（${range}）` };
      const stopped = this.shouldInterrupt() ? '中断された' : held() === 0 ? `${blockName}が尽きた` : consecutiveFailures >= 6 ? '6回続けて置けなかった'
        : '残りは周りに支えになるブロックが無い（空中）';
      return {
        success: placedCount > 0,
        result: `${blockName}を${placedCount}個設置、残り${remaining}個は未設置（${stopped}${why ? `。${why}` : ''}）。${range}、残りの${blockName}: ${held()}個`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `エリア埋めエラー: ${error.message}`,
      };
    }
  }
}

export default FillArea;
