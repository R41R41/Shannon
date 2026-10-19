import { CustomBot, InstantSkill } from '../types.js';
import { actionDelay } from '../execution/observedWait.js';
import { backgroundJobs } from '../execution/backgroundJobs.js';
import { isSealedIn } from '../utils/shelter.js';
import { descentKit, bedWool } from '../utils/nightGate.js';
import { RAW_FOOD } from '../constantSkills/autoEat.js';

/** A wait this short is never refused (a beat between two actions). */
const FREE_WAIT_MS = 5_000;
/** A furnace that is done within this long may be waited for: the body would only walk off and come straight back. */
const NEARLY_DONE_MS = 10_000;
/** Hostile within this far: the wait may be about them, not about the furnace. */
const THREAT_RANGE = 16;

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
      + '待つ間は身体が止まり、何も進みません。かまどの精錬の完成を待つためには使わず、その間に採掘など次の作業を進めて、終わった頃に取り出します'
      + '（かまどが動いていて、ほかにできることがある間は、5秒を超える待ちは断ります）。'
      // Common run 9 sheltered for the night and then waited here eight times, six and a half minutes, while the iron
      // pickaxe it needed next was a few blocks of digging away; L101-L103 lost their nights the same way.
      + '夜明けを待つためにも使いません。夜は避難した縦穴から横へ掘り進め、鉱石を探す・精錬する・作業台で作るなど、地下でできる用事を進めます'
      + '（防具・焼いた食料・ベッドがそろうまでは、夜に y16 より下へは降りられません）。';
    this.params = [
      {
        name: 'milliseconds',
        type: 'number',
        description: '待機時間（ミリ秒）',
        required: true,
      },
    ];
  }

  /**
   * A wait for a furnace is refused while there is something else to do: run 16 waited 30 s and 40 s at its furnace right after
   * start-smelting had said not to (70 s of a 20-minute run). Not refused: a short wait, a furnace done within ten seconds, a body
   * shut in its shelter or with a hostile near (the wait may be about that), or nothing else to do. What is said: the furnace's
   * time left, and what could be done meanwhile.
   */
  protected preflight(milliseconds: number) {
    const asked = Number(milliseconds);
    if (!(asked > FREE_WAIT_MS)) return null;
    const dimension = String(this.bot.game?.dimension ?? 'unknown');
    const jobs = backgroundJobs(this.bot).filter(job => job.status === 'waiting_external' && (job.dimension ?? dimension) === dimension);
    if (!jobs.length) return null;
    const soonest = Math.min(...jobs.map(job => job.remainingEstimateMs));
    if (soonest <= NEARLY_DONE_MS) return null;
    if (this.sheltered() || this.threatNear()) return null;
    const meanwhile = this.otherWork();
    if (!meanwhile.length) return null;
    const furnaces = jobs.map(job => `(${job.position.x},${job.position.y},${job.position.z})の${job.input}×${job.count} 残り約${Math.ceil(job.remainingEstimateMs / 1000)}秒`).join('、');
    return { success: false, failureType: 'wait_refused', recoverable: true,
      result: `待ちを断りました: かまどの仕事 ${furnaces}。その間にできること: ${meanwhile.join('、')}。`
        + '終わった頃に withdraw-from-furnace で取り出す（どうしても完成を待つなら withdraw-from-furnace の waitForCompletion=true）' };
  }

  private sheltered(): boolean {
    try { return typeof this.bot.blockAt === 'function' && !!this.bot.entity && isSealedIn(this.bot as any); } catch { return false; }
  }

  private threatNear(): boolean {
    const at = this.bot.entity?.position;
    if (!at) return false;
    return Object.values(this.bot.entities ?? {}).some((entity: any) => entity && entity !== this.bot.entity && entity.position
      && this.bot.registry?.entitiesByName?.[entity.name]?.type === 'hostile' && entity.position.distanceTo(at) <= THREAT_RANGE);
  }

  /** What the body could do instead, from what it carries: a few short suggestions, the most useful first. */
  private otherWork(): string[] {
    const items = (() => { try { return this.bot.inventory.items(); } catch { return []; } })();
    const count = (test: (name: string) => boolean) => items.filter(item => test(item.name)).reduce((sum, item) => sum + item.count, 0);
    const out: string[] = [];
    try {
      const kit = descentKit(this.bot as any);
      if (kit.missing.includes('armor') && count(name => name === 'iron_ingot') >= 8) out.push('craft-one で iron_chestplate を作る');
      const wool = bedWool(this.bot as any);
      if (kit.missing.includes('bed') && (!wool || wool.have < 3)) out.push(`羊を狩って同じ色の羊毛を集める（attack-continuously の color）${wool ? `（いま ${wool.color} ${wool.have}/3）` : ''}`);
      if (kit.missing.includes('cooked_food') && count(name => RAW_FOOD.has(name)) === 0) out.push('動物を狩って食料を集める');
    } catch { /* the kit unknown: the generic work below */ }
    if (count(name => name.endsWith('_pickaxe')) > 0) out.push('mine-block で石炭・鉄などを掘る');
    if (count(name => name.endsWith('_log')) < 4) out.push('原木を集める');
    return out.slice(0, 3);
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
