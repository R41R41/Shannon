import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { travelMovements } from '../utils/setMovements.js';
import { strandedOnHeight } from '../utils/descent.js';
const { goals } = pathfinder;

/** How long a check may plan, in slices that let the body's own ticks through between them. */
const PLAN_MS = 3000;

/**
 * 原子的スキル: 目的地までのパスが存在するかチェック。move-to と同じ移動の設定で経路を実際に計画する（移動はしない）。
 * 距離と高低差だけで「可能」と答えていた頃は、どこへも動けない体にも「可能」と言い、move-to の失敗が続いた（実走7）。
 */
class CheckPathTo extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'check-path-to';
    this.description = '指定座標までのパスが存在するかチェックします。move-to と同じ条件で経路を計画し（移動はしません）、到達可能・不可・判定できない（遠い/複雑）を返します。';
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
        description: 'Y座標',
        required: true,
      },
      {
        name: 'z',
        type: 'number',
        description: 'Z座標',
        required: true,
      },
    ];
  }

  async runImpl(x: number, y: number, z: number) {
    try {
      const currentPos = this.bot.entity.position;
      const distance =
        Math.floor(
          Math.sqrt(
            Math.pow(x - currentPos.x, 2) +
              Math.pow(y - currentPos.y, 2) +
              Math.pow(z - currentPos.z, 2)
          ) * 10
        ) / 10;

      // 距離が近すぎる場合
      if (distance < 1) {
        return {
          success: true,
          result: `目的地は現在地のすぐ近く（${distance}m）です`,
        };
      }

      // パスファインダーでパスを計算（実際には移動しない）
      const goal = new goals.GoalNear(x, y, z, 1);
      const pathfinder = (this.bot as any).pathfinder;
      if (!pathfinder?.getPathFromTo) {
        return { success: true, result: `目的地(${x}, ${y}, ${z})まで距離${distance}m、到達可能性: 判定できません（経路計画が使えない）` };
      }
      // The generator, not getPathTo: that one replaces the planner's live search, which a move in progress uses.
      const plan = pathfinder.getPathFromTo(travelMovements(this.bot), currentPos.clone(), goal, { timeout: PLAN_MS });
      const deadline = Date.now() + PLAN_MS;
      let step = plan.next();
      while (!step.done && step.value?.result?.status === 'partial' && Date.now() < deadline) {
        await new Promise(resolve => setImmediate(resolve));
        step = plan.next();
      }
      const result = step.value?.result;
      if (result?.status === 'success') {
        const moves = result.path ?? [];
        const dig = moves.reduce((n: number, move: any) => n + (move.toBreak?.length ?? 0), 0);
        const place = moves.reduce((n: number, move: any) => n + (move.toPlace?.length ?? 0), 0);
        return { success: true, result: `目的地(${x}, ${y}, ${z})まで距離${distance}m、到達可能性: 可能（経路${moves.length}歩`
          + `${dig ? `、掘る${dig}` : ''}${place ? `、置く${place}` : ''}）` };
      }
      if (result?.status === 'noPath') {
        let note = '';
        try {
          const perch = strandedOnHeight(this.bot as any);
          if (perch) note = '。高い所に取り残されています（周りはどこも4ブロックより深い落差）。climb-down で降りてから移動してください';
        } catch { /* world unreadable */ }
        return { success: true, result: `目的地(${x}, ${y}, ${z})まで距離${distance}m、到達可能性: 不可（move-to と同じ条件で経路がありません）${note}` };
      }
      return { success: true, result: `目的地(${x}, ${y}, ${z})まで距離${distance}m、到達可能性: 判定できません（${PLAN_MS / 1000}秒で計画が終わらない。遠いか地形が複雑）。`
        + '途中の地点へ分けて移動してください' };
    } catch (error: any) {
      return {
        success: false,
        result: `チェックエラー: ${error.message}`,
      };
    }
  }
}

export default CheckPathTo;
