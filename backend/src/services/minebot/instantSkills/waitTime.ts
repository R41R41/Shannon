import { CustomBot, InstantSkill } from '../types.js';
import { actionDelay } from '../execution/observedWait.js';
import { backgroundJobs } from '../execution/backgroundJobs.js';
import { isSealedIn } from '../utils/shelter.js';
import { descentFloor, descentKit, bedWool, nightClock } from '../utils/nightGate.js';
import { nearestOres } from '../utils/loadedBlockScan.js';
import { RAW_FOOD } from '../constantSkills/autoEat.js';

/** A wait this short is never refused (a beat between two actions). */
const FREE_WAIT_MS = 5_000;
/** A furnace that is done within this long may be waited for: the body would only walk off and come straight back. */
const NEARLY_DONE_MS = 10_000;
/** At or below this health, with food to regenerate on, a wait heals the body and is let be. */
const HEALING_HEALTH = 10;
/** After the exposure guard refused a dig (a hostile right outside), waits are let be this long. */
const GUARD_WAIT_MS = 60_000;

/** Hurt and regenerating: a wait is what heals it (natural regeneration needs food 18). */
export function healingNow(bot: { health?: number; food?: number }): boolean {
  const health = Number(bot.health ?? 20), food = Number(bot.food ?? 20);
  return health <= HEALING_HEALTH && food >= 18;
}

/** A dig out was just refused for the hostile it would let in, and that refusal says to wait for it to go: a wait then is let be. */
export function guardAskedToWait(bot: object, now = Date.now()): boolean {
  const guard = (bot as { exposureDigGuard?: { lastAt?: number } }).exposureDigGuard;
  return !!guard?.lastAt && now - guard.lastAt < GUARD_WAIT_MS;
}

/**
 * What the body could do instead of waiting, from what it carries: a few short suggestions, the most useful first. `concrete` when
 * one of them is definite (an ore in reach by name and place, armour the ingots carried make).
 */
export function meanwhileWork(bot: any): { work: string[]; concrete: boolean } {
  const items: Array<{ name: string; count: number }> = (() => { try { return bot.inventory.items(); } catch { return []; } })();
  const count = (test: (name: string) => boolean) => items.filter(item => test(item.name)).reduce((sum, item) => sum + item.count, 0);
  const out: string[] = [];
  let concrete = false;
  try {
    const kit = descentKit(bot);
    if (kit.missing.includes('armor') && count(name => name === 'iron_ingot') >= 8) out.push('craft-one で iron_chestplate を作る');
    const wool = bedWool(bot);
    if (kit.missing.includes('bed') && (!wool || wool.have < 3)) out.push(`羊を狩って同じ色の羊毛を集める（attack-continuously の color）${wool ? `（いま ${wool.color} ${wool.have}/3）` : ''}`);
    if (kit.missing.includes('cooked_food') && count(name => RAW_FOOD.has(name)) === 0) out.push('動物を狩って食料を集める');
  } catch { /* the kit unknown: the generic work below */ }
  if (count(name => name.endsWith('_pickaxe')) > 0) {
    // The nearest ores by name and place, above the night gate's floor when it is closed: the planner can mine them at once.
    let floor = -Infinity;
    try { floor = descentFloor(bot)?.floor ?? -Infinity; } catch { floor = -Infinity; }
    const ores = nearestOres(bot, 32, floor);
    out.unshift(ores.length ? `mine-block で近くの${ores.join('・')}を掘る` : 'mine-block で石炭・鉄などを掘る');
    if (ores.length) concrete = true;
  }
  if (out.some(line => line.includes('iron_chestplate'))) concrete = true;
  if (count(name => name.endsWith('_log')) < 4) out.push('原木を集める');
  return { work: out.slice(0, 3), concrete };
}

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
      + '（かまどが動いている間・夜・縦穴の中では、ほかにできることがある限り、5秒を超える待ちは断ります。体力10以下で回復中なら待てます）。'
      // Common run 9 sheltered for the night and then waited here eight times, six and a half minutes, while the iron
      // pickaxe it needed next was a few blocks of digging away; L101-L103 lost their nights the same way.
      + '夜明けを待つためにも使いません。夜は避難した縦穴から横へ掘り進め、鉱石を探す・精錬する・作業台で作るなど、地下でできる用事を進めます'
      + '（防具（胸当てか、鉄以上の部位2つ）を着るまでは、夜に y16 より下へは降りられません。ベッドがあれば先に眠って夜を飛ばします）。';
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
   * A wait for a furnace, or a wait out of the night (in a shelter, or at night anywhere), is refused while there is something else
   * to do. Run 16 waited 70 s at its furnace right after start-smelting had said not to; run 17 waited 175 s at furnaces and 190 s in
   * its night shaft, a fifth of the run (the refusal, written then, never ran: see isCommandLevel). Not refused: a short wait, a
   * furnace done within ten seconds (and no night to wait out), a hurt body that is regenerating (health 10 or less and food 18 or
   * more: the wait heals it), or nothing else to do. What is said: what the wait was for, and what could be done instead (the
   * nearest ores, above the night gate's floor).
   */
  protected preflight(milliseconds: number) {
    const asked = Number(milliseconds);
    if (!(asked > FREE_WAIT_MS)) return null;
    const dimension = String(this.bot.game?.dimension ?? 'unknown');
    const jobs = backgroundJobs(this.bot).filter(job => job.status === 'waiting_external' && (job.dimension ?? dimension) === dimension);
    const furnaceWait = jobs.length > 0 && Math.min(...jobs.map(job => job.remainingEstimateMs)) > NEARLY_DONE_MS;
    // The night and the shaft are the overworld's: in the End a hollow to wait for the dragon in is a different matter.
    const clock = nightClock(this.bot as any);
    const overworld = String(this.bot.game?.dimension ?? 'overworld').includes('overworld');
    const night = !!clock && clock.darkInSeconds === 0;
    const sheltered = overworld && this.sheltered();
    if (!furnaceWait && !sheltered && !night) return null;
    if (this.healing()) return null;
    if (guardAskedToWait(this.bot)) return null;
    const { work: meanwhile, concrete } = this.otherWork();
    if (!meanwhile.length) return null;
    // Out of a night or a shaft only for something definite to do (an ore in reach, a piece of the night's kit), not for "gather logs".
    if (!furnaceWait && !concrete) return null;
    const why: string[] = [];
    if (furnaceWait) why.push(`かまどの仕事 ${jobs.map(job => `(${job.position.x},${job.position.y},${job.position.z})の${job.input}×${job.count} 残り約${Math.ceil(job.remainingEstimateMs / 1000)}秒`).join('、')}`);
    if (sheltered || night) why.push(`${night ? `夜（明けるまで約${clock!.lightInSeconds ?? 0}秒）` : '縦穴の中'}を待って過ごすこと`);
    return { success: false, failureType: 'wait_refused', recoverable: true,
      result: `待ちを断りました: ${why.join('、')}。その間にできること: ${meanwhile.join('、')}。`
        + (furnaceWait ? '終わった頃に withdraw-from-furnace で取り出す。' : '')
        + (sheltered ? '縦穴からは横へ掘って進めば、塞いだまま作業できる' : '') };
  }

  private sheltered(): boolean {
    try { return typeof this.bot.blockAt === 'function' && !!this.bot.entity && isSealedIn(this.bot as any); } catch { return false; }
  }

  private healing(): boolean { return healingNow(this.bot); }

  private otherWork(): { work: string[]; concrete: boolean } { return meanwhileWork(this.bot); }

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
