import { currentAction } from '../execution/ActionExecution.js';
import type { InventoryEvent } from '../integration/commonFca/continueContract.js';

/**
 * The body's own account of what changed in the pack (continue contracts, 3), told as events with a reason, so that the head's ledger does not have
 * to guess from two counts why something is gone (run 43: the planks went into a furnace as fuel, and the table could not be made).
 *
 * - A hand's changes: the act takes the pack before a hand and after it (`trackPack`), and the hand's kind says the reason (`HAND_REASONS`): what is
 *   placed is `placed`, what a dig or a walk picks up is `picked`, what `mine` takes is `mined`, a meal is `food`, what goes in a furnace is `ingredient`
 *   and `fuel`, what is thrown is `thrown`. `craft` and `make` say theirs themselves (they know the intermediate pieces: the planks made for the sticks).
 *   Whatever the reflexes did meanwhile is taken off first, so that a meal a reflex ate in the middle of the hand is told once, as the reflex's.
 * - A reflex's changes (a meal, armour put on): seen where they happen (`consume` and `equip` of the armour slots, called from outside any command's
 *   hand), told with their own ids as the body event `inventory.changed`, once. They never ride in a receipt.
 * Nothing here chooses or refuses anything: it counts.
 */
export type PackReason = InventoryEvent['reason'];
type EventDraft = Omit<InventoryEvent, 'id' | 'obsSeq' | 'deliverySeq'>;

interface PackBody {
  inventory?: { items?(): Array<{ name: string; count: number }> };
  consume?: (...args: any[]) => Promise<unknown>;
  equip?: (item: any, destination: string, ...rest: any[]) => Promise<unknown>;
  heldItem?: { name?: string } | null;
  emit?: (event: string, ...args: any[]) => unknown;
  nextObsSeq?: () => number;
}

/** The pack by name, summed. */
export function packCounts(bot: PackBody): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of bot.inventory?.items?.() ?? []) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  return counts;
}

/* ----- what the reflexes changed (seen at the source) ----- */
const reflexTotals = new WeakMap<object, Map<string, number>>();
const reflexSeq = new WeakMap<object, number>();
const idSources = new WeakMap<object, () => string>();
/** The id prefix of the events outside a command (`reflex:<connection>`); set by the control body, which knows the connection. */
export function setReflexEventPrefix(bot: object, prefix: () => string): void { idSources.set(bot, prefix); }
export function reflexTotalsOf(bot: object): Map<string, number> { return new Map(reflexTotals.get(bot) ?? []); }
function noteReflex(bot: PackBody, item: string, count: number, reason: PackReason): void {
  const totals = reflexTotals.get(bot) ?? new Map<string, number>();
  reflexTotals.set(bot, totals);
  totals.set(item, (totals.get(item) ?? 0) + count);
  const seq = (reflexSeq.get(bot) ?? 0) + 1;
  reflexSeq.set(bot, seq);
  const prefix = idSources.get(bot)?.() ?? 'reflex:-';
  try { bot.emit?.('minebotInventoryChanged', { id: `${prefix}:${seq}`, item, count, reason, obsSeq: bot.nextObsSeq?.() ?? 0 }); } catch { /* a notice never changes what happened */ }
}

const ARMOUR_SLOTS = new Set(['head', 'torso', 'legs', 'feet']);
/**
 * Taps the native `consume` and the armour `equip`: a call made by a reflex (a safety lease's action, or none at all) is told as the reflex's
 * (`reflex_eat`, `reflex_armor`). A call made inside a command's hand is that hand's, counted from its pack (`trackPack`).
 */
export function installPackTap(bot: PackBody): void {
  if ((bot as { packTapped?: boolean }).packTapped) return;
  (bot as { packTapped?: boolean }).packTapped = true;
  const byReflex = () => { const action = currentAction(bot as object); return !action || action.safetyLease; };
  if (typeof bot.consume === 'function') {
    const consume = bot.consume.bind(bot);
    bot.consume = async (...args: any[]) => {
      const held = bot.heldItem?.name;
      const reflex = byReflex();
      const result = await consume(...args);
      if (reflex && held) noteReflex(bot, held, -1, 'reflex_eat');
      return result;
    };
  }
  if (typeof bot.equip === 'function') {
    const equip = bot.equip.bind(bot);
    bot.equip = async (item: any, destination: string, ...rest: any[]) => {
      const reflex = byReflex() && ARMOUR_SLOTS.has(destination) && typeof item?.name === 'string';
      const result = await equip(item, destination, ...rest);
      if (reflex) noteReflex(bot, item.name, -1, 'reflex_armor');
      return result;
    };
  }
}

/* ----- what a hand changed ----- */
export interface HandReasons {
  gain?: PackReason;
  /** The reason of a loss, by the item's name (the fuel of a smelt is not its ingredient). */
  loss?: PackReason | ((item: string) => PackReason | null);
}
/** A hand's pack, before it: the changes are told once, when it is over (also when it was cut: the changes up to the cut are real). */
export function trackPack(bot: PackBody): { finish(reasons: HandReasons, record: (event: EventDraft) => void): void } {
  const before = packCounts(bot), reflexBefore = reflexTotalsOf(bot);
  let finished = false;
  return {
    finish(reasons, record) {
      if (finished) return;
      finished = true;
      const after = packCounts(bot), reflexNow = reflexTotalsOf(bot);
      const names = new Set([...before.keys(), ...after.keys()]);
      for (const name of [...names].sort()) {
        // What the reflexes did in the meantime is theirs, not the hand's.
        const reflex = (reflexNow.get(name) ?? 0) - (reflexBefore.get(name) ?? 0);
        const delta = (after.get(name) ?? 0) - (before.get(name) ?? 0) - reflex;
        if (delta === 0) continue;
        const reason = delta > 0 ? reasons.gain : typeof reasons.loss === 'function' ? reasons.loss(name) : reasons.loss;
        record({ item: name, count: delta, reason: reason ?? 'unexplained' });
      }
    },
  };
}

/**
 * The reasons by the hand's kind. Kinds that say their own (craft, make) are not here. A kind that is not here has none: whatever it changes is told as
 * `unexplained` (the body does not guess).
 */
export function handReasons(hand: { do: string; fuel?: string; item?: string; op?: string }): HandReasons | null {
  switch (hand.do) {
    case 'place': case 'pillarUp': return { loss: 'placed' };
    case 'dig': return { gain: 'picked' };
    case 'pickup': return { gain: 'picked' };
    case 'walk': case 'go': case 'attack': case 'fight': case 'wait': return { gain: 'picked', loss: 'placed' };
    case 'vertical': return { gain: 'picked', loss: 'placed' };
    case 'mine': return { gain: 'mined' };
    case 'eat': return { loss: 'food' };
    case 'drop': return { loss: 'thrown' };
    case 'furnace': return { gain: 'smelted', loss: name => (hand.fuel && name === hand.fuel) ? 'fuel' : 'ingredient' };
    case 'smelt': return { gain: 'smelted', loss: name => (hand.fuel && name === hand.fuel) ? 'fuel' : 'ingredient' };
    case 'obsidian': case 'portal': return { gain: 'picked', loss: 'placed' };
    default: return null;
  }
}
/** The hands whose primitive tells its own events. */
export const SELF_COUNTING = new Set(['craft', 'make']);
