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
    // First to the middle of the perch, with the edge guard still on: the step off is then always one block, and a
    // start near the far side no longer falls short of a pool one block wide (the lab's did, and took nine damage).
    const cell = this.bot.entity.position.floored();
    const middle = new Vec3(cell.x + 0.5, this.bot.entity.position.y, cell.z + 0.5);
    if (Math.hypot(this.bot.entity.position.x - middle.x, this.bot.entity.position.z - middle.z) > 0.12) {
      try {
        await this.bot.lookAt(middle.offset(0, 1.6, 0), true);
        this.bot.setControlState('forward', true);
        const centreDeadline = Date.now() + 1500, away = () => Math.hypot(this.bot.entity.position.x - middle.x, this.bot.entity.position.z - middle.z);
        // Stop at the middle, or as soon as a step carries the body past it.
        let last = away();
        while (Date.now() < centreDeadline && !this.shouldInterrupt() && last > 0.12) {
          await actionDelay(this.bot, 50);
          const now = away(); if (now > last) break; last = now;
        }
      } finally { this.bot.clearControlStates(); }
      await actionDelay(this.bot, 150);
    }
    const start = this.bot.entity.position.clone(), startY = start.y;
    const target = new Vec3(cell.x + chosen.dx + 0.5, Math.floor(startY), cell.z + chosen.dz + 0.5);
    log.info(`🪜 降下: ${chosen.via} 方向(${chosen.dx},${chosen.dz}) 落差${chosen.drop} 着地${chosen.landing}@Y${chosen.landingY} 想定ダメージ${chosen.damage}`);
    const guard = (this.rootBot as any).edgeGuard as { enabled: boolean } | undefined;
    const guarded = guard?.enabled ?? false;
    try {
      if (guard) guard.enabled = false;
      await this.bot.lookAt(target.offset(0, 1.6, 0), true);
      // The heading is held while the guard is off: a turned head would walk the body toward a column never checked.
      const { yaw, pitch } = this.bot.entity;
      this.bot.setControlState('sneak', false);
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('forward', true);
      // Off the edge: forward only until the body is over the chosen cell, then it drops (or slides down the vine).
      const stepDeadline = Date.now() + 2500;
      while (Date.now() < stepDeadline && !this.shouldInterrupt()) {
        const at = this.bot.entity.position;
        if (Math.hypot(at.x - target.x, at.z - target.z) < 0.35 || at.y < startY - 0.6) break;
        if (Math.abs(this.bot.entity.yaw - yaw) > 0.01) await this.bot.look(yaw, pitch, true);
        await actionDelay(this.bot, 50);
      }
      this.bot.setControlState('forward', false);
      // Momentum carries the body past the cell it stepped off into; a pool or a vine one block wide is then missed
      // and the edge beside it taken instead (the lab's pool cost nine health). Steer back over the cell while falling.
      // Facing (dx, dz), the left hand is (dz, -dx).
      const along = (at: Vec3) => (at.x - target.x) * chosen.dx + (at.z - target.z) * chosen.dz;
      const leftward = (at: Vec3) => (at.x - target.x) * chosen.dz - (at.z - target.z) * chosen.dx;
      const landDeadline = Date.now() + 12_000;
      while (Date.now() < landDeadline && !this.shouldInterrupt()) {
        const entity = this.bot.entity as any;
        if ((entity.onGround || entity.isInWater) && entity.position.y < startY - 0.6) break;
        const off = along(entity.position), side = leftward(entity.position);
        this.bot.setControlState('back', off > 0.1);
        this.bot.setControlState('forward', off < -0.1);
        this.bot.setControlState('right', side > 0.1);
        this.bot.setControlState('left', side < -0.1);
        if (Math.abs(this.bot.entity.yaw - yaw) > 0.01) await this.bot.look(yaw, pitch, true);
        await actionDelay(this.bot, 50);
      }
    } finally {
      this.bot.clearControlStates();
      if (guard) guard.enabled = guarded;
    }
    // The fall's damage reaches the body a moment after it lands, whether or not any was expected.
    const settle = Date.now() + (chosen.damage > 0 ? 1500 : 800);
    while (Date.now() < settle && (this.bot.health ?? health) >= health) await actionDelay(this.bot, 50);
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
