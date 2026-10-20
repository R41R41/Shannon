/**
 * A craft that a body reflex cut off after the piece had been made (run 21, craft-one iron_chestplate / iron_helmet).
 *
 * The floor's armour reflex looks for armour in the pack the moment it appears, so it takes the body (and cancels the running action)
 * as soon as the craft has put the piece there. The craft had worked and the reflex had worn the piece, but the command came back as
 * `interrupted_by_reflex`, and the planner threw away the rest of that response (two judgments lost). The skill cannot answer for itself:
 * its action is already cancelled when it would return. So the place that turns the cancel into a receipt (nativeBody) asks here
 * whether the thing the command was for is now so: in the pack, or worn in an armour or off-hand slot.
 */

type Slot = { name?: string; count?: number } | null | undefined;
interface CraftBody { inventory?: { items(): Array<{ name: string; count?: number }>; slots?: Slot[] } }

/** Armour (head, torso, legs, feet) and the off-hand. */
const WORN_SLOTS = [5, 6, 7, 8, 45];
/** The commands whose result is "this item now exists": the item is the first argument, the number wanted the second. */
const CRAFT_SKILLS = new Set(['craft-one']);

export interface CraftWitness { itemName: string; wanted: number; before: number }

/** How many of `itemName` the body has: carried, and worn. */
export function holdings(bot: CraftBody, itemName: string): { carried: number; worn: number } {
  let carried = 0, worn = 0;
  try {
    for (const item of bot.inventory?.items() ?? []) if (item.name === itemName) carried += item.count ?? 1;
    const slots = bot.inventory?.slots;
    if (slots) for (const index of WORN_SLOTS) if (slots[index]?.name === itemName) worn += slots[index]?.count ?? 1;
  } catch { /* an unreadable pack proves nothing */ }
  return { carried, worn };
}

/** Taken when a command starts: null unless it is a craft. */
export function craftWitness(bot: CraftBody, capability: string, args: readonly unknown[]): CraftWitness | null {
  if (!CRAFT_SKILLS.has(capability) || typeof args[0] !== 'string' || !args[0]) return null;
  const wanted = Math.max(1, Math.min(64, Math.floor(Number(args[1]) || 1)));
  const { carried, worn } = holdings(bot, args[0]);
  return { itemName: args[0], wanted, before: carried + worn };
}

/**
 * What to tell the planner when the craft was cut off by a reflex and the pack says it had worked, else null (the cut stands as a
 * failure). The craft counts as done when at least as many pieces were gained as were asked for.
 */
export function craftDoneDespiteCut(bot: CraftBody, witness: CraftWitness): { text: string; gained: number; worn: boolean } | null {
  const { carried, worn } = holdings(bot, witness.itemName);
  const gained = carried + worn - witness.before;
  if (gained < witness.wanted) return null;
  const where = worn > 0 && carried === 0 ? '体の反射が装備まで済ませています' : worn > 0 ? `うち${worn}個は体の反射が装備しました` : '持ち物に入っています';
  return { gained, worn: worn > 0,
    text: `${witness.itemName}を${gained}個クラフトできています（${where}）` };
}
