import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { cellText, guard, inventoryCount, letGo, stopped, wait, waitUntil, type StepContext, type StepOutcome } from './primitives/common.js';
import { pickup } from './primitives/pickup.js';
import { goWith, walkMovements } from './primitives/walk.js';

const { goals } = pathfinder;

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
/** The right click reaches a creature whose box is this near the eye (the game's interaction range for an entity is 3 blocks, measured to the box). */
export const BARTER_REACH = 3;
/** A piglin that stands out of reach but within this many blocks is walked up to by the hand (it wanders between two exchanges); farther is the planner's `go`. */
export const BARTER_APPROACH = 8;
/** The walk up to a piglin takes at most this long. */
const APPROACH_MS = 5_000;
/** A piglin looks at its gold for six seconds; one that lets go earlier was stopped (hurt, or angered) and gives nothing back. */
const EARLY_RELEASE_MS = 4_000;

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

/** How far the nearest point of a creature's box is from a point (the game's reach is measured to the box, not to its middle). */
export function reachTo(from: { x: number; y: number; z: number }, entity: { position: { x: number; y: number; z: number }; width?: number; height?: number }): number {
  const half = (entity.width ?? 0.6) / 2, top = entity.height ?? 1.95;
  const dx = Math.max(entity.position.x - half - from.x, 0, from.x - (entity.position.x + half));
  const dy = Math.max(entity.position.y - from.y, 0, from.y - (entity.position.y + top));
  const dz = Math.max(entity.position.z - half - from.z, 0, from.z - (entity.position.z + half));
  return Math.hypot(dx, dy, dz);
}
const eyeOf = (bot: any): Vec3 => bot.entity.position.offset(0, 1.62, 0);

/** Steps up to a piglin that stands out of reach (a few tries: it walks on while the body does). Stops where the walk ends; the caller measures again. */
async function stepUp(ctx: StepContext, piglin: any): Promise<void> {
  const bot = ctx.bot;
  const navigator = bot.pathfinder;
  const previous = navigator?.movements;
  const until = Math.min(ctx.deadline, Date.now() + APPROACH_MS);
  try {
    navigator?.setMovements(walkMovements(bot, false));
    for (let tries = 0; tries < 3 && Date.now() < until; tries++) {
      const now = bot.entities?.[piglin.id];
      if (!now || reachTo(eyeOf(bot), now) <= BARTER_REACH - 0.4) break;
      const gone = await goWith(ctx, new goals.GoalNear(now.position.x, now.position.y, now.position.z, 1.8), Math.max(500, until - Date.now()), { opened: [], leaves: 0 });
      letGo(bot);
      if (gone.timedOut || gone.stuck || gone.error) break;
    }
  } finally { try { if (previous) navigator.setMovements(previous); } catch { /* kept */ } }
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
  if (inventoryCount(bot, 'gold_ingot') < 1) return stopped(bot, 'missing_item', '金のインゴットを持っていない（金を用意してから）', at);
  const adult = isAdultPiglin(bot.registry, piglin);
  if (adult === false) return stopped(bot, 'not_adult', `${label} は子ども（子どものピグリンは金を受け取らない）。大人の個体へ`, at);
  if (isAngryPiglin(bot.registry, piglin) === true) {
    return stopped(bot, 'piglin_hostile', `${label} は怒っている（${wearsGoldArmour(bot) ? '金の防具は着ているが、殴られたか近くの仲間が怒った' : '金の防具を着ていない'}ので交換できない）。離れて落ち着くのを待つか、別の個体へ`, at);
  }
  let distance = reachTo(eyeOf(bot), piglin);
  if (distance > BARTER_REACH && piglin.position.distanceTo(bot.entity.position) <= BARTER_APPROACH) {
    await stepUp(ctx, piglin);
    const now = bot.entities?.[piglin.id];
    if (!now) return stopped(bot, 'target_not_found', `${label} が見えなくなった`, at);
    piglin = now;
    distance = reachTo(eyeOf(bot), piglin);
  }
  if (distance > BARTER_REACH) {
    const far = piglin.position.distanceTo(bot.entity.position);
    return stopped(bot, 'out_of_reach', `${label} に届かない（${far.toFixed(1)}m 先、体から ${distance.toFixed(1)}m。${far > BARTER_APPROACH ? `${BARTER_APPROACH}m までなら手が歩いて近づく。` : '近づけなかった。'}go で ${BARTER_REACH}m 内へ）`, at);
  }
  // One that is still looking at gold takes no more: it is waited for (a piglin finishes in six seconds).
  if (holdsIngot(piglin)) {
    const finished = await waitUntil(ctx, () => !holdsIngot(bot.entities?.[piglin.id]) || !bot.entities?.[piglin.id], BARTER_ANSWER_MS, 100);
    if (!finished) return stopped(bot, 'piglin_busy', `${label} は前の金を見たまま（${BARTER_ANSWER_MS / 1000}秒待っても終わらない）。もう一度か、別の個体へ`, at);
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
    return stopped(bot, 'not_accepted', `${label} は金を受け取らなかった（${why}。金 ${goldBefore}個のまま）。もう一度か、別の個体へ`, at);
  }
  // Six seconds of looking; over when the off hand lets go of the ingot (or the piglin is gone). A piglin whose off hand was never seen to hold it is waited out by the clock.
  let sawHold = holdsIngot(bot.entities?.[piglin.id]);
  const began = Date.now();
  let releasedAt = 0;
  const answered = await waitUntil(ctx, () => {
    const now = bot.entities?.[piglin.id];
    if (!now) return true;
    if (holdsIngot(now)) { sawHold = true; return false; }
    if (sawHold || Date.now() - began >= 6_500) { releasedAt = Date.now(); return true; }
    return false;
  }, BARTER_ANSWER_MS, 100);
  const heldMs = (releasedAt || Date.now()) - began;
  const angryNow = isAngryPiglin(bot.registry, bot.entities?.[piglin.id]) === true;
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
  if (!answered) return { ok: false, reason: 'no_answer', code: 'piglin_no_answer', at, text: `${base}。${BARTER_ANSWER_MS / 1000}秒たっても ${label} は金を離さない。もう一度呼ぶか、別の個体へ` };
  if (!drops.length && !gained.length) {
    // A piglin that is hurt or angered while it looks at the gold keeps it and throws nothing; one that let go after its six seconds threw something that is not to be seen.
    const cut = sawHold && heldMs < EARLY_RELEASE_MS;
    const why = cut || angryNow
      ? `金を ${(heldMs / 1000).toFixed(1)}秒で手放した${angryNow ? '。ピグリンは怒っている（殴られたか、近くの敵や仲間に気を取られた）' : ''}。見終わる前に手放すと何も返さない。別の個体へ`
      : `金を離したが、投げた物が見えなかった（${cellText(at)} の近く。遠くへ投げたか、別の所に落ちた）。周りを pickup で探す`;
    return { ok: false, reason: 'nothing_returned', code: 'barter_nothing_returned', at, text: `${base}。${why}` };
  }
  return { ok: true, at, text: `${base}${left.length ? `。拾えず落ちている ${left.join(' ')}` : ''}${got && !gained.length ? `。${got}` : ''}${names.length ? `（出た物 ${names.join(' ')}）` : ''}` };
}

/** At most this many piglins are given an ingot in one round (they look at it at once: three in six seconds, not one). */
export const BARTER_AT_ONCE = 3;
/** A round's piglins: adult, calm, not looking at gold already, within reach of the eye; the nearest first. Pure, for the tests. */
export function barterRound(bot: any, already: ReadonlySet<number> = new Set()): any[] {
  const eye = eyeOf(bot);
  return (Object.values(bot.entities ?? {}) as any[]).filter(entity => entity?.name === 'piglin' && entity.position && entity.isValid !== false && !already.has(entity.id)
    && isAdultPiglin(bot.registry, entity) !== false && isAngryPiglin(bot.registry, entity) !== true && !holdsIngot(entity) && reachTo(eye, entity) <= BARTER_REACH)
    .sort((a, b) => reachTo(eye, a) - reachTo(eye, b)).slice(0, BARTER_AT_ONCE);
}

/**
 * `use item=gold_ingot target=piglin count=N` (S6, 2026-11-04): up to N ingots in one hand. Each round gives one ingot to each calm adult piglin within reach
 * (up to BARTER_AT_ONCE; the named one is walked up to first when none is in reach), waits until all of them let go (six seconds, all at once), and takes by
 * id what was thrown back. Rounds go on until N are given, the gold is out, no piglin takes one, the body is hurt, or the time is up.
 * Why: the seed's barter sequence is fixed (loot table random_sequence; on c1 the first 24 ingots give 9 pearls, 44 give 13), and one ingot per act put a
 * head's turn and a six-second wait between every two of them. The single exchange (barterWithPiglin) is unchanged and is what count=1 does.
 */
export async function barterMany(ctx: StepContext, first: any, count: number): Promise<StepOutcome> {
  const bot = ctx.bot;
  const wanted = Math.max(1, Math.min(64, Math.floor(count)));
  if (wanted === 1) return barterWithPiglin(ctx, first);
  if (inventoryCount(bot, 'gold_ingot') < 1) return stopped(bot, 'missing_item', '金のインゴットを持っていない（金を用意してから）');
  const goldAtStart = inventoryCount(bot, 'gold_ingot');
  const packBefore = new Map<string, number>();
  for (const item of bot.inventory?.items?.() ?? []) packBefore.set(item.name, (packBefore.get(item.name) ?? 0) + item.count);
  const hpAtStart = Number(bot.health ?? 20);
  let given = 0, rounds = 0, refused = 0, why = '';
  const left: string[] = [];
  const at = { x: Math.floor(first.position.x), y: Math.floor(first.position.y), z: Math.floor(first.position.z) };
  while (given < wanted) {
    if (Date.now() + BARTER_ANSWER_MS + 2_000 > ctx.deadline) { why = '時間切れ'; break; }
    if (inventoryCount(bot, 'gold_ingot') < 1) { why = '金が尽きた'; break; }
    if (Number(bot.health ?? 20) < hpAtStart - 2) { why = `体力が減った（${hpAtStart}→${Number(bot.health ?? 20).toFixed(1)}）`; break; }
    let round = barterRound(bot);
    if (!round.length) {
      // None in reach: the named one (or the nearest calm adult) within BARTER_APPROACH is walked up to, once per round.
      const near = (bot.entities?.[first.id] && isAngryPiglin(bot.registry, bot.entities[first.id]) !== true ? bot.entities[first.id] : null)
        ?? (Object.values(bot.entities ?? {}) as any[]).filter(e => e?.name === 'piglin' && e.position && isAdultPiglin(bot.registry, e) !== false && isAngryPiglin(bot.registry, e) !== true)
          .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
      if (near && near.position.distanceTo(bot.entity.position) <= BARTER_APPROACH) { await stepUp(ctx, near); round = barterRound(bot); }
      if (!round.length) {
        // One still looking at gold is waited for (it takes another when it is done).
        const busy = (Object.values(bot.entities ?? {}) as any[]).some(e => e?.name === 'piglin' && holdsIngot(e) && reachTo(eyeOf(bot), e) <= BARTER_REACH + 1);
        if (busy) { await waitUntil(ctx, () => barterRound(bot).length > 0, BARTER_ANSWER_MS, 100); round = barterRound(bot); }
      }
      if (!round.length) { why = `届く所（${BARTER_REACH}m）に金を受け取れるピグリンがいない（${BARTER_APPROACH}m 内の大人で怒っていない個体を探した）。go で寄るか、別の群れへ`; break; }
    }
    rounds++;
    const baseline = itemIds(bot);
    const taking: any[] = [];
    for (const piglin of round.slice(0, wanted - given)) {
      const before = inventoryCount(bot, 'gold_ingot');
      if (before < 1) break;
      await guard(ctx, Promise.resolve(bot.lookAt(piglin.position.offset(0, (piglin.height ?? 1.9) * 0.8, 0), true)), 1000);
      try { await guard(ctx, Promise.resolve(bot.activateEntity(piglin)), 2000); } catch (error) {
        if (/Action interrupted/u.test(String((error as Error)?.message))) throw error;
      }
      if (await waitUntil(ctx, () => inventoryCount(bot, 'gold_ingot') < before, BARTER_ACK_MS, 50)) { given++; taking.push(piglin); }
      else refused++;
    }
    if (!taking.length) { if (refused >= 3) { why = 'ピグリンが金を受け取らなかった（3 回）。子どもか、怒っているか、前の金を見ている'; break; } continue; }
    // All of them look at once: over when none of them holds the ingot (or it is gone), or the answer's time is up.
    const began = Date.now();
    await waitUntil(ctx, () => taking.every(p => !bot.entities?.[p.id] || !holdsIngot(bot.entities[p.id])) && Date.now() - began >= 1_000, BARTER_ANSWER_MS, 100);
    await wait(ctx, RETURN_WAIT_MS);
    const drops = itemsSince(bot, baseline, bot.entity.position, 10);
    if (drops.length) await pickup(ctx, { ids: drops.map(entity => entity.id) });
    for (const entity of drops) if (bot.entities?.[entity.id]) left.push(stackName(entity));
  }
  const packAfter = new Map<string, number>();
  for (const item of bot.inventory?.items?.() ?? []) packAfter.set(item.name, (packAfter.get(item.name) ?? 0) + item.count);
  const gained: string[] = [];
  for (const [name, count] of packAfter) { const more = count - (packBefore.get(name) ?? 0); if (more > 0 && name !== 'gold_ingot') gained.push(`${name}+${more}`); }
  const pearls = Math.max(0, inventoryCount(bot, 'ender_pearl') - (packBefore.get('ender_pearl') ?? 0));
  const text = `ピグリンに金を ${given}/${wanted} 個渡した（${rounds} 回に分けて、一度に最大 ${BARTER_AT_ONCE} 体。金 ${goldAtStart}→${inventoryCount(bot, 'gold_ingot')}）: `
    + `受け取った ${gained.join(' ') || 'なし'}（パール +${pearls}）${left.length ? `。拾えず落ちている ${left.slice(0, 6).join(' ')}` : ''}${why ? `。止めた理由: ${why}` : ''}`;
  const progress = { unit: 'item' as const, done: given, left: Math.max(0, wanted - given) };
  if (!given) return { ...stopped(bot, why.startsWith('届く所') ? 'out_of_reach' : 'not_accepted', text, at), progress };
  return { ok: true, at, text, progress };
}
