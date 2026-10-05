import { InstantSkill, type CustomBot } from '../types.js';
import { backgroundJobs } from '../execution/backgroundJobs.js';

export default class GetBackgroundJobs extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'get-background-jobs';
    this.description = '精錬などの待機中の仕事と推定残り時間を取得。時刻は完了の証明ではない。待機中は素材を消費し合わない別の準備を進め、取り出しで結果を確認する。';
  }
  async runImpl() {
    return { success: true, result: JSON.stringify({ jobs: backgroundJobs(this.bot) }) };
  }
}
