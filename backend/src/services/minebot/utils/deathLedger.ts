import { nativeActionHost } from '../execution/ActionExecution.js';

/**
 * Continue contracts (1, decision 4 of chapter 12): the deaths this body SAW, so that an `attack` at a creature that is already dead is "already" only on an observed death, and a
 * creature that merely went out of sight is never taken for a dead one.
 *
 * What is kept is the `entityDead` the body's own connection raised (it is the server's death animation of an entity the body can see), with the time, the dimension the body stood in
 * and the creature's id (and its kind and uuid, when it has them: a reused id must not stand for another creature). The ledger belongs to the connection: the host body object is made
 * at the login and entity ids mean something only inside it, so a new connection starts with none (and the `end` of this one empties it). A death is remembered for a short time
 * only, and only in the dimension it was seen in (a change of dimension sends the entities again).
 */

/** How long a seen death still counts for a creature the hand is asked to attack (30 seconds). PROVISIONAL (chapter 12, decision 4): the first value, to be tried in a real world. */
export const DEATH_MEMORY_MS = 30_000;
/** The most deaths kept (the oldest go first). */
const KEEP_MAX = 256;

export interface SeenDeath { id: number; at: number; dimension: string; name?: string; uuid?: string }

const dimensionOf = (bot: any): string => String(bot.game?.dimension ?? '').replace(/^minecraft:/u, '');

export class DeathLedger {
  private readonly deaths = new Map<string, SeenDeath>();
  private readonly onDead = (entity: any) => {
    const id = Number(entity?.id);
    if (!Number.isSafeInteger(id)) return;
    const dimension = dimensionOf(this.bot);
    const key = `${dimension}|${id}`;
    this.deaths.delete(key);
    this.deaths.set(key, { id, at: this.now(), dimension, ...(entity?.name ? { name: String(entity.name) } : {}), ...(typeof entity?.uuid === 'string' ? { uuid: entity.uuid } : {}) });
    if (this.deaths.size > KEEP_MAX) this.deaths.delete(this.deaths.keys().next().value!);
  };
  private readonly onEnd = () => { this.deaths.clear(); };

  constructor(private readonly bot: any, private readonly now: () => number = Date.now) {
    bot.on?.('entityDead', this.onDead);
    bot.on?.('end', this.onEnd);
  }

  /**
   * The death of creature `id` this connection saw in the dimension the body stands in now, within `withinMs`, or null. `who` (the creature as it stands in the world now, when it is still
   * listed) must be the same kind (and the same uuid when both have one): an id the server gave to another creature since is not this death.
   */
  seenDead(id: number, withinMs: number = DEATH_MEMORY_MS, who?: { name?: unknown; uuid?: unknown } | null): (SeenDeath & { agoMs: number }) | null {
    const seen = this.deaths.get(`${dimensionOf(this.bot)}|${id}`);
    if (!seen) return null;
    const agoMs = this.now() - seen.at;
    if (agoMs > withinMs || agoMs < 0) return null;
    if (who) {
      if (who.name && seen.name && String(who.name) !== seen.name) return null;
      if (typeof who.uuid === 'string' && seen.uuid && who.uuid !== seen.uuid) return null;
    }
    return { ...seen, agoMs };
  }

  dispose(): void {
    this.bot.removeListener?.('entityDead', this.onDead);
    this.bot.removeListener?.('end', this.onEnd);
    this.deaths.clear();
  }
}

const ledgers = new WeakMap<object, DeathLedger>();
/** The body's death ledger: made once per connection, at the body's start when it can (nativeBody), else at the first fight or attack that asks. */
export function deathLedgerOf(bot: any): DeathLedger {
  const host = nativeActionHost(bot) as object;
  let ledger = ledgers.get(host);
  if (!ledger) { ledger = new DeathLedger(host); ledgers.set(host, ledger); }
  return ledger;
}
