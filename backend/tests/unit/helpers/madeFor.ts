import type { BodyObservation } from '../../../src/services/minebot/integration/commonFca/bodyControlContract.js';
import type { Dim, MadeIn } from '../../../src/services/minebot/integration/commonFca/continueContract.js';

/**
 * What a decision "read" when it made a command (continue contracts 2 and 5): the life number, the dimension and its generation, the body's
 * start-up and connection ids, the head's start-up id and the observation's number. A command that moves the body (a skill that is not a reader, or
 * a reflex) carries it, or the body does not start it (`life_missing`). The tests take it from the body's own observation, as the head does.
 *
 * - `madeFor(body)` -> `{ life, headBoot, madeIn }` for a command's `context` (a queue item carries `madeIn` in its envelope too).
 * - `madeCommand(body, command)` -> the command with `context.life/headBoot/madeIn` (and, when it has a queue envelope, `queue.madeIn` and a default `queue.queue`).
 *
 * `connectionId` is the body's own (`state.bodyRun.connectionId`): empty for a NativeCommonFcaBody that has no control loop; the loop's id once
 * the loop is bound to it. A fake observer that has no `life`/`bodyRun` must be given what it lacks in `options`.
 */
export interface MadeOptions {
  /** The head's start-up id the command was made for (default 'hb-test'; the body compares it only after a reply has told it a head). */
  headBoot?: string;
  /** The connection the decision read, when the observation has none (a loop's id). */
  connectionId?: string;
  bodyBoot?: string;
  life?: number;
  dim?: Dim;
  dimSince?: string;
  obsSeq?: number;
}
export interface Made { life: number; headBoot: string; madeIn: MadeIn }
type Observes = { observe(): BodyObservation };

export function madeFor(body: Observes, options: MadeOptions = {}): Made {
  const observation = body.observe();
  const state = observation.state as Record<string, any>;
  const life = options.life ?? state.life?.life;
  const dim = options.dim ?? state.life?.dimension;
  const dimSince = options.dimSince ?? state.life?.dimensionSince;
  const bodyBoot = options.bodyBoot ?? state.bodyRun?.bodyBoot;
  const connectionId = options.connectionId ?? state.bodyRun?.connectionId;
  if (typeof life !== 'number' || !dim || typeof dimSince !== 'string' || typeof bodyBoot !== 'string' || typeof connectionId !== 'string') {
    throw new Error('madeFor: the observation has no state.life / state.bodyRun; give them in the options');
  }
  const headBoot = options.headBoot ?? 'hb-test';
  return { life, headBoot, madeIn: { life, dim, dimSince, bodyBoot, connectionId, headBoot, obsSeq: options.obsSeq ?? observation.sequence } };
}

/** The command with what its decision read: `context.life`, `context.headBoot`, `context.madeIn`, and for a queue item `queue.madeIn` (and `queue.queue` if it has none). */
export function madeCommand<T extends { context?: any; queue?: any }>(body: Observes, command: T, options: MadeOptions = {}): T {
  const made = madeFor(body, options);
  const queue = command.queue ? { queue: 'q-test', madeIn: made.madeIn, ...command.queue } : undefined;
  return { ...command, context: { ...command.context, life: made.life, headBoot: made.headBoot, madeIn: made.madeIn }, ...(queue ? { queue } : {}) };
}
