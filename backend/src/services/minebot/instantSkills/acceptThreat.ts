import { CustomBot, InstantSkill } from '../types.js';
import { engageFor } from '../utils/engagement.js';

const MAX_SECONDS = 300;

/**
 * The planner's word that it means to be among a kind of mob for a while.
 *
 * Something hostile in sight and in reach stops the task and takes the body away. A fight skill says for
 * itself that the exposure is meant, while it runs; nothing said so for the rest of what goes with a fight
 * taken on purpose: the walk up to a spawner, the standing beside it before the wall is up. Each of those was
 * stopped for the blazes the planner had come for (lab continuations L77k to L77r). This is where it says so,
 * for a time, and the time runs out by itself. What is left to stop it is the body's own state (health at
 * half or less, one great blow) and every kind not named.
 */
class AcceptThreat extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'accept-threat';
    this.description = 'これから指定した秒数のあいだ、指定した種類の相手が「近くに居る・当ててきた」だけでは緊急対応にしません（その相手のいる場所へ自分の意思で入っていく・そばで作業する時に、先に呼ぶ）。'
      + '体力が半分以下になった時・一撃で大きく削られた時と、指定していない種類の相手は、今まで通り緊急対応になります。時間が過ぎると自動で元に戻ります';
    this.params = [
      { name: 'kinds', type: 'string', description: '相手の種類。カンマ区切りで複数可（例: "blaze" や "blaze,wither_skeleton"）', required: true },
      { name: 'seconds', type: 'number', description: `続ける秒数（1〜${MAX_SECONDS}、デフォルト: 120）`, default: 120 },
    ];
  }

  async runImpl(kinds: string, seconds: number = 120) {
    const names = String(kinds ?? '').toLowerCase().split(',').map(name => name.trim()).filter(Boolean);
    if (!names.length) return { success: false, result: 'kinds に相手の種類を指定してください（例: "blaze"）', failureType: 'invalid_arguments', recoverable: true };
    const span = Math.max(1, Math.min(MAX_SECONDS, Math.floor(Number(seconds) || 120)));
    engageFor(this.rootBot, names, span * 1000);
    return { success: true, result: `これから${span}秒、${names.join('・')} が近くに居る・当ててきただけでは中断されません（体力が半分以下・大きな一撃・ほかの種類の相手では中断されます）` };
  }
}

export default AcceptThreat;
