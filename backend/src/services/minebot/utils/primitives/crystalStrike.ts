import { Vec3 } from 'vec3';
import { blastAt } from '../crystalBlast.js';
import { boxDistance, type Box } from '../dragonParts.js';
import { stopped, wait, type StepContext, type StepOutcome } from './common.js';

/**
 * attack at an end crystal: one blow, struck only when the blast it sets off would leave the body its health (`blastAt`: distance, how much of
 * the body is in its sight, difficulty and armour; enchantments, the shield and resistance are not counted, so the real blast is no worse than
 * the estimate says). At a blow's reach the blast is at its worst (two to three blocks: 40 to 60 health before armour), so this is for a body that
 * stands behind something (a block between it and the crystal's centre) or wears a great deal; otherwise it says what the blast would take
 * and leaves the choice (the bow from 13 blocks: shoot) to the planner. The crystal breaks on the blow and the client is told it is gone.
 */
const CRYSTAL_HIT_REACH = 3.0;
const GONE_WAIT_MS = 1500;
export const isCrystalTarget = (target: string | number | undefined): boolean => typeof target === 'string' && /^(minecraft:)?end_crystal$/iu.test(target.trim());

/** A crystal's box: 2 x 2 x 2 over its position. */
const crystalBox = (crystal: { position: Vec3 }): Box => ({ minX: crystal.position.x - 1, minY: crystal.position.y, minZ: crystal.position.z - 1, maxX: crystal.position.x + 1, maxY: crystal.position.y + 2, maxZ: crystal.position.z + 1 });

export async function strikeCrystal(ctx: StepContext, crystal: any): Promise<StepOutcome> {
  const bot = ctx.bot;
  const label = `end_crystal（id ${crystal.id}）`;
  const eye = new Vec3(bot.entity.position.x, bot.entity.position.y + 1.62, bot.entity.position.z);
  const reach = boxDistance(eye, crystalBox(crystal));
  if (reach > CRYSTAL_HIT_REACH) return stopped(bot, 'out_of_reach', `${label} に手が届かない（目から ${reach.toFixed(1)}m、${CRYSTAL_HIT_REACH}m まで）。遠くから壊すなら 13m 以上離れて shoot`);
  const centre = { x: crystal.position.x, y: crystal.position.y + 1, z: crystal.position.z };
  const blast = blastAt(bot, centre);
  if (!blast.safe) {
    return stopped(bot, 'blast_unsafe', `${label} を殴ると爆発が当たる見込み: 距離 ${blast.distance}m・見える割合 ${blast.seen}・素の被害 ${blast.raw}→防具後 ${blast.expected}（体力 ${blast.health}。`
      + `エンチャント・盾は数えない）。間に塞ぐブロックを置くか、13m 以上離れて shoot`);
  }
  const before = Number(bot.health ?? 20);
  let gone = false;
  const onGone = (entity: any) => { if (entity?.id === crystal.id) gone = true; };
  bot.on('entityGone', onGone);
  try {
    try { await bot.lookAt(new Vec3(centre.x, centre.y, centre.z), true); } catch { /* looked */ }
    bot.attack(crystal);
    for (const until = Date.now() + GONE_WAIT_MS; Date.now() < until && !gone;) await wait(ctx, 50);
  } finally { bot.removeListener('entityGone', onGone); }
  const lost = Math.max(0, Math.round((before - Number(bot.health ?? before)) * 10) / 10);
  const data = { crystal: { id: crystal.id, destroyed: gone, distance: blast.distance } };
  if (!gone) return { ...stopped(bot, 'time_up', `${label} を殴ったが壊れたのは見ていない（${GONE_WAIT_MS / 1000}秒）`), data };
  return { ok: true, data, text: `${label} を壊した（爆発まで ${blast.distance}m、見込み ${blast.expected}・実際に失った体力 ${lost}）` };
}
