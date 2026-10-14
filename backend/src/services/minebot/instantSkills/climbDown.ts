import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { actionDelay } from '../execution/observedWait.js';
import { descentAllowance, planDescent } from '../utils/descent.js';

const log = createLogger('Minebot:Skill:climbDown');

/**
 * 原子的スキル: 高い所から降りる。経路探索は4ブロックより深い落差を降りないので、木の枝や柱の上に取り残された体は
 * move-to がすべて「パスが見つかりません」になる（共通 FCA の実走7）。ツタ・はしごを伝う、水に飛び込む、
 * 落下ダメージの最も小さい縁から飛び降りる、の順で選ぶ。崖際の守り（edgeGuard）はこの一歩のあいだだけ外す。
 */
class ClimbDown extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'climb-down';
    this.description = '高い所（木の上・柱の上・崖の途中）から下へ降ります。move-to が「パスが見つかりません」になり、周りが4ブロックより深い落差しかない時に使います。'
      + 'ツタやはしごがあれば伝って降り、なければ水への飛び込み、次に落下ダメージが最も小さい縁から飛び降ります。'
      + '降りたあとに体力が8（ハート4つ）より下がる落下はしません。maxDamage で受けてよいダメージをさらに小さくできます。';
    this.params = [
      { name: 'maxDamage', type: 'number', description: '受けてよい落下ダメージの上限（省略時は体力-8）', required: false },
    ];
    this.maxDurationMs = 20_000;
  }

  async runImpl(maxDamage?: number) {
    const health = this.bot.health ?? 20;
    const options = planDescent(this.bot as any).filter(option => option.landingY < Math.floor(this.bot.entity.position.y) - 1);
    if (!options.length) {
      return { success: false, result: '降りられる縁がありません（周りが壁か、下が溶岩・未読み込み・64ブロックより深い）。dig-block-at で横を開けるか、別の方向を探してください', failureType: 'no_descent', recoverable: true };
    }
    const allowance = descentAllowance(health, maxDamage);
    // Never a fall that could kill if a vine is missed on the way down.
    const usable = options.filter(option => option.damage <= allowance && option.worstDamage < health - 1);
    const best = options[0];
    if (!usable.length) {
      return { success: false, failureType: 'descent_too_high', recoverable: true,
        result: `一番ましな縁でも${best.drop}ブロックの落下で約${best.damage}のダメージ（体力${health}、受けてよいのは${allowance}まで）。`
          + '体力を回復するか、ブロックを置いて段を作るか、別の方向へ移ってから試してください' };
    }
    const chosen = usable[0];
    const start = this.bot.entity.position.clone(), startY = start.y;
    const target = new Vec3(Math.floor(start.x) + chosen.dx + 0.5, Math.floor(startY), Math.floor(start.z) + chosen.dz + 0.5);
    log.info(`🪜 降下: ${chosen.via} 方向(${chosen.dx},${chosen.dz}) 落差${chosen.drop} 着地${chosen.landing}@Y${chosen.landingY} 想定ダメージ${chosen.damage}`);
    const guard = (this.rootBot as any).edgeGuard as { enabled: boolean } | undefined;
    const guarded = guard?.enabled ?? false;
    try {
      if (guard) guard.enabled = false;
      await this.bot.lookAt(target.offset(0, 1.6, 0), true);
      this.bot.setControlState('sneak', false);
      this.bot.setControlState('forward', true);
      // Off the edge: forward only until the body is over the chosen cell, then it drops (or slides down the vine).
      const stepDeadline = Date.now() + 2500;
      while (Date.now() < stepDeadline && !this.shouldInterrupt()) {
        const at = this.bot.entity.position;
        if (Math.hypot(at.x - target.x, at.z - target.z) < 0.35 || at.y < startY - 0.6) break;
        await actionDelay(this.bot, 50);
      }
      this.bot.setControlState('forward', false);
      // Momentum carries the body past the cell it stepped off into; a pool or a vine one block wide is then missed
      // and the edge beside it taken instead (the lab's pool cost nine health). Steer back over the cell while falling.
      const along = (at: Vec3) => (at.x - target.x) * chosen.dx + (at.z - target.z) * chosen.dz;
      const landDeadline = Date.now() + 12_000;
      while (Date.now() < landDeadline && !this.shouldInterrupt()) {
        const entity = this.bot.entity as any;
        if ((entity.onGround || entity.isInWater) && entity.position.y < startY - 0.6) break;
        const off = along(entity.position);
        this.bot.setControlState('back', off > 0.1);
        this.bot.setControlState('forward', off < -0.1);
        await actionDelay(this.bot, 50);
      }
    } finally {
      this.bot.clearControlStates();
      if (guard) guard.enabled = guarded;
    }
    // The fall's damage reaches the body a moment after it lands.
    if (chosen.damage > 0) {
      const settle = Date.now() + 1500;
      while (Date.now() < settle && (this.bot.health ?? health) >= health) await actionDelay(this.bot, 50);
    }
    const end = this.bot.entity.position, healthAfter = this.bot.health ?? health;
    const fell = startY - end.y;
    if (fell < 0.6) {
      return { success: false, failureType: 'descent_blocked', recoverable: true,
        result: `縁から降りられませんでした（現在: ${end.x.toFixed(1)}, ${end.y.toFixed(1)}, ${end.z.toFixed(1)}）。足場か縁の形を確かめてください` };
    }
    return { success: true,
      result: `${fell.toFixed(1)}ブロック降りました（${chosen.via === 'climbable' ? 'ツタ・はしごを伝って' : chosen.via === 'water' ? '水へ' : '飛び降りて'}、`
        + `着地 ${chosen.landing}、体力 ${health}→${healthAfter}）。現在: ${end.x.toFixed(1)}, ${end.y.toFixed(1)}, ${end.z.toFixed(1)}` };
  }
}

export default ClimbDown;
