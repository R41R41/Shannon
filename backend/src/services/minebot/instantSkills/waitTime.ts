import { CustomBot, InstantSkill } from '../types.js';
import { actionDelay } from '../execution/observedWait.js';

/**
 * 原子的スキル: 指定時間待機
 */
class WaitTime extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'wait-time';
    this.description = '指定されたミリ秒数待機します（1回は最長110秒。それより長く待つ時は、状況を見てから呼び直します）。'
      // Right after start-smelting the planner waited the batch out here, 30 to 110 seconds at a time, the body
      // standing still (paid runs L101, L102, once withdraw-from-furnace had stopped doing the waiting for it).
      + '待つ間は身体が止まり、何も進みません。かまどの精錬の完成を待つためには使わず、その間に採掘など次の作業を進めて、終わった頃に取り出します。';
    this.params = [
      {
        name: 'milliseconds',
        type: 'number',
        description: '待機時間（ミリ秒）',
        required: true,
      },
    ];
  }

  async runImpl(milliseconds: number) {
    try {
      // One action has a fixed time. Asked for three minutes, the wait ran into it at two and came back as a
      // failure ("timeout"), though it had waited as long as it could (paid run L77, in its shelter at night).
      const longest = Math.max(1000, (this.maxDurationMs || 120_000) - 10_000);
      const asked = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
      const waited = Math.min(asked, longest);
      await actionDelay(this.bot, waited);

      return {
        success: true,
        result: waited < asked
          ? `${Math.round(waited / 1000)}秒待機しました（1回の待機は最長${Math.round(longest / 1000)}秒。頼まれた${Math.round(asked / 1000)}秒には足りていません。まだ待つなら呼び直してください）`
          : `${milliseconds}ms待機しました`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `待機エラー: ${error.message}`,
      };
    }
  }
}

export default WaitTime;
