import { Vec3 } from 'vec3';
import { atRoofCentre, endermanAngry, roofCellOccupied, type Cell3 } from './huntEnderman.js';
import { bodyReader } from './localMap.js';
import { blockInSight, eyeOf } from './probeTools.js';
import { reflexHeld } from './floorReflexes.js';
import { dig } from './primitives/dig.js';
import { cellText, guard, stopped, wait, type StepContext, type StepOutcome } from './primitives/common.js';

/** Only the body's own temporary block. Never bypass dig's visibility check or leave the protected centre cell. */
export async function removeRoofSupport(ctx: StepContext, anchor: Cell3, support: Cell3, live: any, buildDeadline: number): Promise<StepOutcome> {
  const bot = ctx.bot, until = Math.min(ctx.deadline, buildDeadline, Date.now() + 1_800);
  const sight = (p: Cell3) => blockInSight(bodyReader(bot), eyeOf(p), support);
  const failure = (why: string) => {
    const p = bot.entity.position, blocked = sight(p).between;
    const between = blocked.map(b => `${cellText(b.at)} ${b.name}`).join('、') || 'なし';
    return stopped(bot, 'not_visible', `${cellText(support)} の仮柱。${why}`
      + `（足 ${cellText(p)}、目の高さ ${p.y + 1.62}。間に ${between}）`, support);
  };
  const safe = () => {
    const read = bodyReader(bot), floor = read(anchor.x, anchor.y - 1, anchor.z);
    const free = (dy: number) => {
      const b = read(anchor.x, anchor.y + dy, anchor.z);
      return b?.solid === false && !b.top && !b.plates && !/lava|water|fire|portal|cobweb/u.test(b.name);
    };
    return !ctx.stop.aborted && !reflexHeld(bot) && !endermanAngry(bot.registry, live)
      && bot.entity.onGround === true && atRoofCentre(bot.entity.position, anchor)
      && floor?.solid && (floor.top ?? 1) === 1 && !/lava|water|magma|campfire/u.test(floor.name)
      && free(0) && free(1) && !roofCellOccupied(Object.values(bot.entities ?? {}), bot.entity.id, anchor)
      && [-1, 0, 1].every(dx => [-1, 0, 1].every(dz => read(anchor.x + dx, anchor.y + 2, anchor.z + dz)?.solid === true));
  };
  // Caps/other supports can hide the centre and face-centre samples used by dig. Test the same rays from nearby body positions.
  const p = bot.entity.position;
  const positions = [-0.16, 0, 0.16].flatMap(dx => [-0.16, 0, 0.16].map(dz => ({
    x: anchor.x + 0.5 + dx, y: anchor.y, z: anchor.z + 0.5 + dz,
  })));
  const to = positions.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z)).find(c => sight(c).visible);
  try {
    for (;;) {
      const at = bot.entity.position, read = bodyReader(bot);
      if (!safe()) {
        return failure('撤去の微動に必要な中央の床・立ち位置・非敵対を確認できない');
      }
      if (Date.now() >= until) return failure('既存の建築期限内に仮柱の見える位置へ寄れなかった');
      if (read(support.x, support.y, support.z)?.name !== 'cobblestone') return failure('撤去する仮柱が変化した');
      if (sight(at).visible) return await dig(ctx, { at: [support], collect: false });
      if (!to) return failure('中央の各軸±0.16mにも見える位置が無い。柱を残したまま戦闘へ進まない');
      const turned = await guard(ctx, Promise.resolve(bot.lookAt(new Vec3(to.x, at.y + 1.62, to.z), true)), 300);
      if (!turned || !safe() || Date.now() >= until) return failure('仮柱への向き直り中に立ち位置・非敵対・期限を確認できなくなった');
      bot.setControlState('sprint', false); bot.setControlState('jump', false);
      bot.setControlState('sneak', true); bot.setControlState('forward', true);
      try { await wait(ctx, 50); }
      finally { bot.setControlState('forward', false); bot.setControlState('sneak', false); }
    }
  } finally {
    for (const name of ['forward', 'sneak']) { try { bot.setControlState(name, false); } catch { /* lease ended */ } }
  }
}
