import type { BodyTaskContext } from './bodyControlContract.js';
import type { CutBy, LifeView, MadeIn } from './continueContract.js';

/**
 * The lapses (continue contracts, 2 and 5): a command was made by a decision that read a body, a connection, a head and a life; when any of them is
 * no longer the one now, the command is not run. Checked in this order (the first that applies is the reason), before the dependency table:
 *
 * 1. `connection_changed`: the `bodyBoot`, `connectionId` or `headBoot` the decision read is not the one now.
 * 2. `stale_life` (a death, `death`): the life number the command was made for is not the body's now.
 * 3. `dimension_changed`: the dimension generation (`dimensionSince`) the decision read is not the one now. Not checked for the command that is itself
 *    the one changing the dimension, after it began (its own hands stop at a change; contract 2).
 *
 * A command that moves the body without `context.life` (or, with it, without `madeIn`) is refused: `life_missing`. A body that is dead (`alive: false`) starts nothing: `not_alive`.
 */
export interface BodyNow { life: LifeView; bodyBoot: string; connectionId: string; headBoot: string | null }
export interface Lapse { code: Extract<CutBy, 'connection_changed' | 'stale_life' | 'death' | 'dimension_changed'> | 'life_missing' | 'not_alive'; why: string }

/** What a command carries to be checked: its context (life, headBoot, madeIn) and, for a queue item, the envelope's madeIn. */
export interface Madeness { life?: number; madeIn?: MadeIn; headBoot?: string }

export function madenessOf(context: BodyTaskContext | undefined, envelopeMadeIn?: MadeIn): Madeness {
  const carried = context as (BodyTaskContext & { life?: unknown; headBoot?: unknown; madeIn?: unknown }) | undefined;
  return {
    ...(typeof carried?.life === 'number' && Number.isFinite(carried.life) ? { life: carried.life } : {}),
    ...(typeof carried?.headBoot === 'string' ? { headBoot: carried.headBoot } : {}),
    madeIn: envelopeMadeIn ?? (carried?.madeIn && typeof carried.madeIn === 'object' ? carried.madeIn as MadeIn : undefined),
  };
}

/** The first lapse that applies, or null. `dimension` is whether the dimension generation counts (not for a hand of the command that changes it). */
export function lapseOf(made: Madeness, now: BodyNow, options: { dimension: boolean; requireLife?: boolean }): Lapse | null {
  if (options.requireLife !== false && (made.life === undefined || made.madeIn === undefined)) {
    return { code: 'life_missing', why: 'context.life と madeIn が無い命令は始めない（体を動かす命令は、読んだ観測の命の番号を持つ）' };
  }
  const read = made.madeIn;
  if (read) {
    if (read.bodyBoot !== now.bodyBoot || read.connectionId !== now.connectionId) {
      return { code: 'connection_changed', why: `体のつなぎが替わった（${read.connectionId} → ${now.connectionId}）。読んだ観測は前のつなぎの物` };
    }
  }
  const head = made.headBoot ?? read?.headBoot;
  if (head !== undefined && now.headBoot !== null && head !== now.headBoot) {
    return { code: 'connection_changed', why: `頭が起き直した（${head} → ${now.headBoot}）。前の頭の命令は始めない` };
  }
  const life = made.life ?? read?.life;
  if (life !== undefined && life !== now.life.life) {
    return { code: 'stale_life', why: `命の番号が違う（命令は ${life}、体は ${now.life.life}）。前の命の判断で作った命令は始めない` };
  }
  if (options.dimension && read && read.dimSince !== now.life.dimensionSince) {
    return { code: 'dimension_changed', why: `次元が替わった（世代 ${read.dimSince} → ${now.life.dimensionSince}）。前の次元の観測で作った命令は始めない` };
  }
  if (!now.life.alive) return { code: 'not_alive', why: '体は死んでいる（生き返るまで動かす命令は始めない）' };
  return null;
}
