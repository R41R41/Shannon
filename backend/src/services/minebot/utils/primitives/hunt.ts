import { stopped, wait, type StepContext, type StepOutcome } from './common.js';
import { attack } from './attack.js';
import { pickup } from './pickup.js';
import { isDying } from './use.js';
import { withProgress } from './progressUnits.js';
import { deathLedgerOf } from '../deathLedger.js';
import { bodyReader } from '../localMap.js';
import { solidBetween } from '../probeTools.js';

/**
 * hunt: the food animals around the body, until none is left in the radius or `count` have fallen, and what they dropped (2026-11-11, owner request after run 5:
 * five cows took eight acts of one attack and one pickup each, three of them on ids already dead, one stopped on a cow behind a wall). The planner names the kinds
 * (`cow`, `pig,sheep`); the body takes the nearest adult of those within `range` of where the hunt began, strikes it with `attack` (the best weapon, the engagement rule,
 * swimming and the cannot-reach verdict all come with it), picks up what fell at the spot (by the drops' ids, not by a radius around the body), and goes on to the next
 * the moment the drops are in. An animal that cannot be reached is passed by (three in a row end the hand); a baby is left (it drops nothing, and the herd is what the
 * next hunt needs). No digging, no blocks laid, no waiting for anything: the only pause is up to DROP_WAIT_MS for a drop that has not shown yet after a kill.
 */
export interface HuntArgs { kinds?: string; count?: number; range?: number; seconds?: number }

/** The animals that are food (and leather, wool) by default. */
export const FOOD_KINDS: ReadonlySet<string> = new Set(['cow', 'mooshroom', 'pig', 'sheep', 'chicken', 'rabbit']);
/** Animals the registry calls so that are not hunted: pets and mounts (a hunt must not kill someone's wolf or horse) and those that hit back or are not food. They are fought with `fight`. */
const NOT_HUNTED: ReadonlySet<string> = new Set(['wolf', 'cat', 'ocelot', 'parrot', 'horse', 'donkey', 'mule', 'skeleton_horse', 'zombie_horse', 'llama', 'trader_llama', 'camel', 'camel_husk',
  'happy_ghast', 'strider', 'nautilus', 'zombie_nautilus', 'bee', 'polar_bear', 'panda', 'hoglin']);

const DEFAULT_RANGE = 32;
const DEFAULT_SECONDS = 60;
/** The most one animal may take (attack's own verdicts come sooner: cannot_reach after 5 s without closing in). */
const PER_ANIMAL_S = 12;
/** A kill needs this long on the clock left to be started. */
const MIN_START_MS = 1500;
/** The longest a drop that has not shown yet is waited for after a kill (it comes in the death's own tick; one that came later was seen 0.3 s after in run 5). */
const DROP_WAIT_MS = 1000;
/** Drops are looked for this near where the animal fell (it was followed, so they lie away from the body). */
const DROP_NEAR_M = 4;
const UNREACHABLE_IN_A_ROW = 3;
/** The last pick-up may run this long past the hunt's own seconds (what was already killed is not left lying), never past the act's own end. */
const SWEEP_EXTRA_MS = 8000;
/** The animals looked at for a wall in the way (the line is walked every 5 cm): the nearest few by cost. */
const SIGHT_CANDIDATES = 8;
/** Added to an animal's distance, in metres, for ordering only: per block of height above 2 m between it and the body, and per solid cell on the line to it (3 at most). */
const HEIGHT_COST_M = 3;
const WALL_COST_M = 6;

const clamp = (value: number, least: number, most: number) => Math.max(least, Math.min(most, value));
const isItem = (entity: any) => entity && (entity.name === 'item' || entity.displayName === 'Item');
const kindOf = (entity: any) => String(entity?.name ?? '').toLowerCase();

function packCounts(bot: any): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of (bot.inventory?.items?.() ?? []) as Array<{ name: string; count: number }>) out.set(item.name, (out.get(item.name) ?? 0) + item.count);
  return out;
}
function gainedText(bot: any, before: Map<string, number>): string {
  const gained: string[] = [];
  for (const [name, count] of packCounts(bot)) if (count > (before.get(name) ?? 0)) gained.push(`${name}+${count - (before.get(name) ?? 0)}`);
  return gained.slice(0, 6).join(' ') || 'なし';
}

/**
 * Whether the animal is a baby: the registry names the entity datum `baby` (index 16 on the 1.21.11 data for every ageable mob), read by name; true only when it reads true.
 * A datum that cannot be read counts as an adult (fail open: the hand then kills a baby rather than none).
 */
export function isBabyAnimal(bot: any, entity: any): boolean {
  const keys: string[] | undefined = bot.registry?.entitiesByName?.[kindOf(entity)]?.metadataKeys;
  const index = keys ? keys.indexOf('baby') : -1;
  return index >= 0 && Array.isArray(entity?.metadata) && entity.metadata[index] === true;
}

/** The kinds the planner wrote (`cow`, `pig,cow`, `minecraft:sheep`), or why they cannot be hunted. */
export function huntKinds(bot: any, text: unknown): { kinds: string[] } | { problem: string } {
  const words = String(text ?? '').split(/[\s,、，]+/u).map(word => word.trim().toLowerCase().replace(/^minecraft:/u, '')).filter(Boolean);
  if (!words.length) return { problem: 'target に食料の動物の種類（cow・pig・sheep・chicken・rabbit。カンマで複数: pig,cow）が要る' };
  const byName: Record<string, { type?: string } | undefined> = bot.registry?.entitiesByName ?? {};
  const kinds: string[] = [];
  for (const raw of words) {
    const word = !byName[raw] && raw.endsWith('s') && byName[raw.slice(0, -1)] ? raw.slice(0, -1) : raw;
    if (FOOD_KINDS.has(word)) { kinds.push(word); continue; }
    const type = byName[word]?.type;
    if (!type) return { problem: `${raw} は動物の名前ではない（例: cow・pig・sheep・chicken・rabbit）` };
    if (type === 'hostile') return { problem: `${raw} は敵。hunt は食料の動物だけ（敵は fight か attack）` };
    if (type !== 'animal') return { problem: `${raw} は食料の動物ではない（hunt は cow・pig・sheep・chicken・rabbit などの陸の動物）` };
    if (NOT_HUNTED.has(word)) return { problem: `${raw} は狩らない（飼い慣らせる動物・乗り物・反撃する動物。戦うなら fight）` };
    kinds.push(word);
  }
  return { kinds: [...new Set(kinds)] };
}

/** "cow 21m・pig 30m": the nearest of each animal kind within `radius`, for a hunt that found none of what was asked. */
function animalsSeen(bot: any, radius: number): string {
  const at = bot.entity?.position;
  if (!at) return '';
  const nearest = new Map<string, number>();
  for (const entity of Object.values(bot.entities ?? {}) as any[]) {
    if (!entity?.position || entity === bot.entity) continue;
    const type = bot.registry?.entitiesByName?.[kindOf(entity)]?.type;
    if (type !== 'animal') continue;
    const distance = entity.position.distanceTo(at);
    if (distance <= radius && distance < (nearest.get(kindOf(entity)) ?? Infinity)) nearest.set(kindOf(entity), distance);
  }
  return [...nearest.entries()].sort((a, b) => a[1] - b[1]).slice(0, 5).map(([name, distance]) => `${name} ${distance.toFixed(0)}m`).join('・');
}

export async function hunt(ctx0: StepContext, args: HuntArgs): Promise<StepOutcome> {
  const state = { kills: 0, count: args.count === undefined ? null as number | null : clamp(Math.round(Number(args.count)), 1, 64) };
  return withProgress(() => huntAround(ctx0, args, state), () => ({ unit: 'item', done: state.kills, left: state.count === null ? null : Math.max(0, state.count - state.kills) }));
}

async function huntAround(ctx0: StepContext, args: HuntArgs, state: { kills: number; count: number | null }): Promise<StepOutcome> {
  const bot = ctx0.bot;
  const startedAt = Date.now();
  const seconds = clamp(Number(args.seconds ?? DEFAULT_SECONDS), 5, 120);
  const range = clamp(Number(args.range ?? DEFAULT_RANGE), 4, 48);
  const ctx: StepContext = { ...ctx0, deadline: Math.min(ctx0.deadline, startedAt + seconds * 1000) };
  const parsed = huntKinds(bot, args.kinds);
  if ('problem' in parsed) return stopped(bot, 'invalid_input', `hunt 止まった invalid_input: ${parsed.problem}`);
  const kinds = new Set(parsed.kinds);
  const kindsText = parsed.kinds.join(',');
  const centre = bot.entity.position.clone();
  const packBefore = packCounts(bot);
  const ledger = deathLedgerOf(bot);

  /** Item entities that lay before the hunt or were already taken up as a drop: never this hunt's. */
  const known = new Set<number>((Object.values(bot.entities ?? {}) as any[]).filter(isItem).map(entity => entity.id));
  /** Where each animal of the kinds fell (the connection's death event), for finding what it dropped. */
  const fellAt = new Map<number, any>();
  const onDead = (entity: any) => { if (entity && kinds.has(kindOf(entity)) && entity.position) fellAt.set(entity.id, entity.position.clone()); };
  bot.on('entityDead', onDead);

  const killedBy = new Map<string, number>();
  /** Animals attack could not reach (a pen, a ledge): passed by for the whole hunt. */
  const passed: number[] = [];
  /** Animals that went out of sight or were not found: passed by until the next kill (they may be back in view then), told apart from the unreachable. */
  const lost = new Set<number>();
  const done = new Set<number>();
  /** Drops of this hunt's that are still lying: the ones not tried yet (the clock ran out first) and `gaveUp`. */
  const lying = new Set<number>();
  /** Drops a pick-up tried and did not take (in water, behind a wall, in a hole): the last pick-up does not walk to them again. */
  const gaveUp = new Set<number>();
  let unreachableRow = 0, fullStop = false, timeUp = false, babies = 0;
  let lastStop: StepOutcome | null = null;

  const live = (): any[] => {
    babies = 0;
    return (Object.values(bot.entities ?? {}) as any[]).filter(entity => {
      if (!entity?.position || entity === bot.entity || !kinds.has(kindOf(entity)) || done.has(entity.id)) return false;
      if (entity.position.distanceTo(centre) > range || isDying(bot, entity) || ledger.seenDead(entity.id, undefined, entity)) return false;
      if (isBabyAnimal(bot, entity)) { babies++; return false; }
      return true;
    });
  };
  /**
   * The next animal: the one that costs least to get to. The distance is the straight line; an animal high above or below the body, or with solid cells on the line to it
   * (a pen's fence, a cliff, a cave roof) is dearer, so the herd in the open is not passed over for a pen next to the body.
   */
  const nearestOf = (animals: any[]): any | null => {
    const at = bot.entity.position;
    const open = animals.filter(animal => !passed.includes(animal.id) && !lost.has(animal.id))
      .map(animal => ({ animal, cost: animal.position.distanceTo(at) + Math.max(0, Math.abs(animal.position.y - at.y) - 2) * HEIGHT_COST_M }));
    open.sort((a, b) => a.cost - b.cost);
    for (const entry of open.slice(0, SIGHT_CANDIDATES)) {
      const to = entry.animal.position;
      try { entry.cost += Math.min(3, solidBetween(bodyReader(bot), [at.x, at.y + 0.9, at.z], [to.x, to.y + 0.5, to.z]).length) * WALL_COST_M; } catch { /* no read: by distance */ }
    }
    open.sort((a, b) => a.cost - b.cost);
    return open[0]?.animal ?? null;
  };
  /** Drops of the animal that fell at `at`, not taken up yet. */
  const dropsNear = (at: any): any[] => (Object.values(bot.entities ?? {}) as any[]).filter(entity => isItem(entity) && entity.position && !known.has(entity.id) && entity.position.distanceTo(at) <= DROP_NEAR_M);

  /**
   * Takes up `ids` one at a time, the nearest to the body first, as long as the clock of `withCtx` runs (a drop not tried when it ends stays for the last pick-up).
   * A drop that was tried and still lies goes to `gaveUp`. 'full' when the pack had no room for one.
   */
  const takeUp = async (ids: number[], withCtx: StepContext): Promise<'ok' | 'full'> => {
    const pending = new Set(ids);
    let sawFull = false;
    while (pending.size && withCtx.deadline - Date.now() > 300) {
      for (const id of [...pending]) if (!bot.entities?.[id]) { pending.delete(id); lying.delete(id); }
      const from = bot.entity.position;
      const next = [...pending].map(id => bot.entities[id]).filter(entity => entity?.position).sort((a, b) => a.position.distanceTo(from) - b.position.distanceTo(from))[0];
      if (!next) break;
      pending.delete(next.id);
      const picked = await pickup(withCtx, { ids: [next.id] });
      if (bot.entities?.[next.id]) gaveUp.add(next.id); else lying.delete(next.id);
      if (!picked.ok && picked.reason === 'inventory_full') sawFull = true;
    }
    return sawFull ? 'full' : 'ok';
  };
  /** Picks up what the animal dropped where it fell: waits (at most DROP_WAIT_MS) only while none has shown. 'full' when the pack has no room. */
  const collect = async (at: any, waitForDrops: boolean, withCtx: StepContext): Promise<'ok' | 'full'> => {
    let drops = dropsNear(at);
    if (!drops.length && waitForDrops) {
      for (const until = Date.now() + DROP_WAIT_MS; !drops.length && Date.now() < until;) { await wait(withCtx, 100); drops = dropsNear(at); }
    }
    if (!drops.length) return 'ok';
    for (const drop of drops) { known.add(drop.id); lying.add(drop.id); }
    return takeUp(drops.map(drop => drop.id), withCtx);
  };

  try {
    for (;;) {
      if (state.count !== null && state.kills >= state.count) break;
      const target = nearestOf(live());
      if (!target) break;
      if (ctx.deadline - Date.now() < MIN_START_MS) { timeUp = true; break; }
      const remainingS = Math.max(1, (ctx.deadline - Date.now()) / 1000);
      const outcome = await attack(ctx, { target: target.id, until: 'dead', maxSeconds: Math.min(PER_ANIMAL_S, remainingS) });
      done.add(target.id);
      if (outcome.ok && outcome.goal !== 'already') {
        state.kills++; unreachableRow = 0; lost.clear();
        const name = kindOf(target);
        killedBy.set(name, (killedBy.get(name) ?? 0) + 1);
        const at = fellAt.get(target.id) ?? target.position?.clone?.() ?? bot.entity.position;
        // A rabbit may drop nothing: no wait for it, the next kill's pick-up or the last one takes it if it came.
        if (await collect(at, name !== 'rabbit', ctx) === 'full') { fullStop = true; break; }
        continue;
      }
      if (outcome.ok) continue;   // it was already dead (seen so): no kill of ours
      if (outcome.reason === 'cannot_reach' || outcome.reason === 'out_of_reach' || outcome.reason === 'time_up') {
        passed.push(target.id);
        if (++unreachableRow >= UNREACHABLE_IN_A_ROW) { lastStop = { ...outcome, reason: 'unreachable' }; break; }
        done.delete(target.id);   // it may come within reach later; it is not picked again by this hunt (passed), and is told at the end
        continue;
      }
      if (outcome.reason === 'target_lost' || outcome.reason === 'target_not_found') { done.delete(target.id); lost.add(target.id); continue; }
      lastStop = outcome;
      break;
    }
  } finally {
    bot.removeListener('entityDead', onDead);
  }

  // The last pick-up: what lies from the kills of this hunt that no pick-up tried yet (and drops that showed late), nearest first, one at a time. It may run a little past the hunt's seconds, never past the act's own end.
  const sweepCtx: StepContext = { ...ctx0, deadline: Math.min(ctx0.deadline, Math.max(ctx.deadline, Date.now() + SWEEP_EXTRA_MS)) };
  if (!fullStop) {
    const area = (Object.values(bot.entities ?? {}) as any[]).filter(entity => isItem(entity) && entity.position && !known.has(entity.id) && entity.position.distanceTo(centre) <= range + DROP_NEAR_M && [...fellAt.values()].some(at => entity.position.distanceTo(at) <= DROP_NEAR_M * 2));
    for (const drop of area) { known.add(drop.id); lying.add(drop.id); }
    for (const id of [...lying]) if (!bot.entities?.[id]) lying.delete(id);
    const untried = [...lying].filter(id => !gaveUp.has(id));
    if (untried.length && await takeUp(untried, sweepCtx) === 'full') fullStop = true;
  }

  const spent = ((Date.now() - startedAt) / 1000).toFixed(1);
  const killedText = [...killedBy.entries()].map(([name, n]) => `${name} ${n}`).join('・') || '0';
  const left = live();
  const leftText = left.length ? `、範囲内に残り ${left.length} 体（${[...new Set(left.map(kindOf))].join('・')}）` : '';
  const passedText = passed.length ? `、届かず飛ばした ${passed.length} 体（${passed.slice(0, 4).map(id => `#${id}`).join(' ')}）` : '';
  const lostText = lost.size ? `、見失った ${lost.size} 体（${[...lost].slice(0, 4).map(id => `#${id}`).join(' ')}）` : '';
  const babyText = babies ? `、子 ${babies} 体は倒さない` : '';
  const got = `拾った: ${gainedText(bot, packBefore)}`;
  const lyingText = lying.size ? `。拾えず落ちたまま ${lying.size} 個${gaveUp.size ? '（拾いに行ったが入らなかった物を含む）' : ''}` : '';
  const facts = `${killedText} 体倒した${state.count !== null ? `（count=${state.count}）` : ''}${passedText}${lostText}${leftText}${babyText}、${got}${lyingText}、${spent}秒`;
  const progress = { unit: 'item' as const, done: state.kills, left: state.count === null ? null : Math.max(0, state.count - state.kills) };

  if (fullStop) return { ...stopped(bot, 'full', `hunt 止まった full: 持ち物が満杯（${facts}）`), progress };
  if (timeUp) return { ...stopped(bot, 'limit_time', `hunt 止まった limit_time: ${seconds} 秒の上限（${facts}）`), progress };
  if (lastStop?.reason === 'unreachable') return { ...stopped(bot, 'unreachable', `hunt 止まった unreachable: ${UNREACHABLE_IN_A_ROW} 体続けて届かない（${facts}）。直近: ${lastStop.text}`, lastStop.at), progress };
  if (lastStop) return { ...stopped(bot, lastStop.reason ?? 'not_done', `hunt 止まった ${lastStop.reason ?? 'not_done'}: ${lastStop.text}（${facts}）`, lastStop.at), progress };
  if (!state.kills) {
    if (passed.length) return { ...stopped(bot, 'unreachable', `hunt 止まった unreachable: ${kindsText} は居るが全部届かない（${facts}）`), progress };
    if (lost.size) return { ...stopped(bot, 'target_lost', `hunt 止まった target_lost: ${kindsText} を見失った（${facts}）。近づいて出し直す`), progress };
    const seen = animalsSeen(bot, 48);
    return { ...stopped(bot, 'no_target', `hunt 止まった no_target: ${range}m 内に ${kindsText} の成体が居ない${babies ? `（子 ${babies} 体は倒さない）` : ''}。${seen ? `見えている動物: ${seen}（そちらへ短い go で寄って出し直す）` : '動物は見えていない（歩いて探す）'}`), progress };
  }
  // The loop ends with none left that it may still take: what is still in the radius is the unreachable, the lost and the babies, and it is said so.
  const ending = state.count !== null && state.kills >= state.count ? 'count に達した'
    : left.length ? `届く成体は倒した（残り ${left.length} 体は届かない・見失った）`
      : babies ? '成体はもういない（子だけ残る）' : `範囲 ${range}m にもういない`;
  return { ok: true, text: `hunt 済: ${ending}。${facts}`, progress };
}
