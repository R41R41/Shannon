import { Vec3 } from 'vec3';
import { cellText, guard, inventoryCount, stopped, wait, waitUntil, type StepContext, type StepOutcome } from './primitives/common.js';
import { pickup } from './primitives/pickup.js';

/**
 * Bartering gold with a piglin, as one exchange (S2, 2026-11-02).
 *
 * What the game does: a piglin that is an adult, is not already looking at gold, and is not angry takes a gold ingot from a right click, holds it
 * in its off hand for 120 ticks (six seconds) and then throws what it gives back toward the player (an item entity or several, most often iron
 * nuggets, obsidian, gravel, fire resistance; an ender pearl now and then). A piglin goes for a player who wears no gold armour; with one piece
 * of gold on, it leaves the player alone and trades. A baby takes no gold.
 *
 * What this reads, the way it is read in aibengineering/mine-ai-mcp (MIT, src/actions/barter/barter.ts): the ingot is spent when the pack's count
 * falls by one; the exchange is under way while the piglin's off hand (equipment slot 1) holds the ingot, and over when it does not; what comes
 * back is the item entities that appeared after the offer (their ids were not lying about before), and it is taken by their ids. This is written
 * afresh for this body: the hand waits for the piglin to finish before it gathers, and it never takes an item that lay about before the offer for
 * the piglin's answer (what it took "any item near" for did not wait out a piglin that was still looking at its gold).
 */

/** A piglin looks its gold over for six seconds; the answer is waited for this long (a little more, for lag) after the ingot is spent. */
export const BARTER_ANSWER_MS = 9_000;
/** The ingot is spent within this long of the right click (or the offer was not taken). */
export const BARTER_ACK_MS = 1_500;
/** What came back is given this long to appear after the piglin lets go of the gold. */
const RETURN_WAIT_MS = 800;
/** The piglin must be this near the eye for the right click to reach (the game's interaction range for an entity is 3 blocks). */
export const BARTER_REACH = 3.2;

interface Registry { entitiesByName?: Record<string, { metadataKeys?: string[] } | undefined> }

/** The off hand's item of a mob (equipment slot 1), or null. */
export function offHandOf(entity: any): string | null {
  const stack = entity?.equipment?.[1];
  return stack?.name ? String(stack.name) : null;
}
/** The piglin holds a gold ingot in its off hand: an exchange is under way. */
export const holdsIngot = (entity: any): boolean => offHandOf(entity) === 'gold_ingot';

/** The value of a named entity-data flag of a mob (true/false), or null when it cannot be read. */
function dataFlag(registry: Registry | null | undefined, entity: any, names: string[]): unknown {
  const keys = registry?.entitiesByName?.[String(entity?.name ?? '')]?.metadataKeys;
  if (!keys || !Array.isArray(entity?.metadata)) return null;
  for (const name of names) { const index = keys.indexOf(name); if (index >= 0) return entity.metadata[index]; }
  return null;
}
/** Whether the piglin is an adult: true, false (a baby), or null when the game's data does not say. */
export function isAdultPiglin(registry: Registry | null | undefined, entity: any): boolean | null {
  const baby = dataFlag(registry, entity, ['baby', 'is_baby']);
  return typeof baby === 'boolean' ? !baby : null;
}
/** Whether the piglin is angry at someone now (its mob flags' aggressive bit, 4), or null when it cannot be read. */
export function isAngryPiglin(registry: Registry | null | undefined, entity: any): boolean | null {
  const flags = dataFlag(registry, entity, ['mob_flags']);
  return typeof flags === 'number' ? (flags & 4) !== 0 : null;
}
/** Whether any of the body's four armour places holds a piece of gold. */
export function wearsGoldArmour(bot: any): boolean {
  return [5, 6, 7, 8].some(index => String(bot.inventory?.slots?.[index]?.name ?? '').startsWith('golden_'));
}

/** The ids of the item entities lying about now (the baseline an offer's answer is told from). */
export function itemIds(bot: any): Set<number> {
  const ids = new Set<number>();
  for (const entity of Object.values(bot.entities ?? {}) as any[]) if (entity?.name === 'item' || entity?.displayName === 'Item') ids.add(entity.id);
  return ids;
}
/** The item entities that were not lying about at the baseline, within `radius` of `near`, nearest first. */
export function itemsSince(bot: any, baseline: ReadonlySet<number>, near: Vec3, radius: number): any[] {
  return (Object.values(bot.entities ?? {}) as any[]).filter(entity => (entity?.name === 'item' || entity?.displayName === 'Item') && entity.position
    && !baseline.has(entity.id) && entity.position.distanceTo(near) <= radius).sort((a, b) => a.position.distanceTo(near) - b.position.distanceTo(near));
}
function stackName(entity: any): string {
  try { const stack = entity.getDroppedItem?.(); if (stack?.name) return `${stack.name}×${stack.count ?? 1}`; } catch { /* not yet */ }
  return `#${entity.id}`;
}

/**
 * One gold ingot to one piglin, the answer waited for, and what came back taken. The piglin is the planner's (the one it named); the hand
 * gives, waits and gathers, and says what happened to each: not taken (why), taken and what came back, what lies where it could not be taken.
 */
export async function barterWithPiglin(ctx: StepContext, piglin: any): Promise<StepOutcome> {
  const bot = ctx.bot;
  const at = { x: Math.floor(piglin.position.x), y: Math.floor(piglin.position.y), z: Math.floor(piglin.position.z) };
  const label = `ピグリン #${piglin.id}`;
  if (inventoryCount(bot, 'gold_ingot') < 1) return stopped(bot, 'missing_item', '金のインゴットを持っていない', at);
  const adult = isAdultPiglin(bot.registry, piglin);
  if (adult === false) return stopped(bot, 'not_adult', `${label} は子ども（子どものピグリンは金を受け取らない）`, at);
  if (isAngryPiglin(bot.registry, piglin) === true) {
    return stopped(bot, 'piglin_hostile', `${label} は怒っている（${wearsGoldArmour(bot) ? '金の防具は着ているが、殴られたか近くの仲間が怒った' : '金の防具を着ていない'}ので交換できない）`, at);
  }
  const distance = piglin.position.offset(0, (piglin.height ?? 1.9) / 2, 0).distanceTo(bot.entity.position.offset(0, 1.62, 0));
  if (distance > BARTER_REACH + (piglin.width ?? 0.6) / 2) return stopped(bot, 'out_of_reach', `${label} に届かない（目から ${distance.toFixed(1)}m。${BARTER_REACH}m まで近づく）`, at);
  // One that is still looking at gold takes no more: it is waited for (a piglin finishes in six seconds).
  if (holdsIngot(piglin)) {
    const finished = await waitUntil(ctx, () => !holdsIngot(bot.entities?.[piglin.id]) || !bot.entities?.[piglin.id], BARTER_ANSWER_MS, 100);
    if (!finished) return stopped(bot, 'piglin_busy', `${label} は前の金を見たまま（${BARTER_ANSWER_MS / 1000}秒待っても終わらない）`, at);
  }
  const baseline = itemIds(bot);
  const goldBefore = inventoryCount(bot, 'gold_ingot');
  const packBefore = new Map<string, number>();
  for (const item of bot.inventory?.items?.() ?? []) packBefore.set(item.name, (packBefore.get(item.name) ?? 0) + item.count);
  await guard(ctx, Promise.resolve(bot.lookAt(piglin.position.offset(0, (piglin.height ?? 1.9) * 0.8, 0), true)), 1000);
  try { await guard(ctx, Promise.resolve(bot.activateEntity(piglin)), 2000); } catch (error) {
    if (/Action interrupted/u.test(String((error as Error)?.message))) throw error;
  }
  const spent = await waitUntil(ctx, () => inventoryCount(bot, 'gold_ingot') < goldBefore, BARTER_ACK_MS, 50);
  if (!spent) {
    const now = bot.entities?.[piglin.id];
    const why = !now ? 'ピグリンが見えなくなった' : isAngryPiglin(bot.registry, now) === true ? 'ピグリンが怒っている' : holdsIngot(now) ? '前の金を見ている最中' : '子どもか、金を受け取れない状態';
    return stopped(bot, 'not_accepted', `${label} は金を受け取らなかった（${why}。金 ${goldBefore}個のまま）`, at);
  }
  // Six seconds of looking; over when the off hand lets go of the ingot (or the piglin is gone). A piglin whose off hand was never seen to hold it is waited out by the clock.
  let sawHold = holdsIngot(bot.entities?.[piglin.id]);
  const began = Date.now();
  const answered = await waitUntil(ctx, () => {
    const now = bot.entities?.[piglin.id];
    if (!now) return true;
    if (holdsIngot(now)) { sawHold = true; return false; }
    return sawHold || Date.now() - began >= 6_500;
  }, BARTER_ANSWER_MS, 100);
  await wait(ctx, RETURN_WAIT_MS);
  const drops = itemsSince(bot, baseline, bot.entity.position, 10);
  const names = drops.map(stackName);
  let got = '';
  if (drops.length) {
    const taken = await pickup(ctx, { ids: drops.map(entity => entity.id) });
    got = taken.text;
  }
  const gained: string[] = [];
  const packAfter = new Map<string, number>();
  for (const item of bot.inventory?.items?.() ?? []) packAfter.set(item.name, (packAfter.get(item.name) ?? 0) + item.count);
  for (const [name, count] of packAfter) { const more = count - (packBefore.get(name) ?? 0); if (more > 0 && name !== 'gold_ingot') gained.push(`${name}+${more}`); }
  const left = drops.filter(entity => bot.entities?.[entity.id]).map(stackName);
  const spentLine = `金 ${goldBefore}→${inventoryCount(bot, 'gold_ingot')}`;
  const base = `${label} に金を渡した（${spentLine}）: 受け取った ${gained.join(' ') || 'なし'}`;
  if (!answered) return { ok: false, reason: 'no_answer', code: 'piglin_no_answer', at, text: `${base}。${BARTER_ANSWER_MS / 1000}秒たっても ${label} は金を離さない` };
  if (!drops.length && !gained.length) return { ok: false, reason: 'nothing_returned', code: 'barter_nothing_returned', at, text: `${base}。ピグリンは金を離したが、投げた物が見えなかった（${cellText(at)} の近く。遠くへ投げたか、別の所に落ちた）` };
  return { ok: true, at, text: `${base}${left.length ? `。拾えず落ちている ${left.join(' ')}` : ''}${got && !gained.length ? `。${got}` : ''}${names.length ? `（出た物 ${names.join(' ')}）` : ''}` };
}
