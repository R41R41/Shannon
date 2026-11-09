/**
 * Which tool to break a block with. Every dig path picked the fastest tool, or the one with the most durability
 * left: the iron pickaxe, made to reach the Nether, dug some three hundred stone blocks on the way and broke 21
 * minutes after it was crafted, then the stone and wooden ones went the same way, and the body was left in a
 * cave with no pickaxe for the last quarter of an hour (paid run L109).
 *
 * A use spends one point of the tool's durability, and a better tool is dearer to replace. So the choice is the
 * cheapest in time plus wear: the dig time, plus what one point of the tool costs, in seconds of digging it is
 * worth saving. A tier is used where the cheaper one cannot do the job (iron ore needs stone, diamond needs
 * iron) or is much slower; never just because it is the best in the bag.
 */

/** Seconds of digging one point of a tool's durability is worth, by what the tool is made of. */
const WEAR_COST_S: Array<[RegExp, number]> = [
  [/^netherite_/, 10],
  [/^diamond_/, 6],
  [/^iron_/, 1.5],
  [/^golden_/, 0.5],
  [/^stone_/, 0.1],
  [/^wooden_/, 0.02],
];

export interface ToolLike { type: number; name: string; maxDurability?: number; durabilityUsed?: number; nbt?: unknown }
export interface BlockLike {
  harvestTools?: Record<string, boolean> | null;
  digTime(type: number | null, creative: boolean, inWater: boolean, notOnGround: boolean, enchants: unknown[], effects: unknown): number;
}

export function wearCostSeconds(item: { name: string; maxDurability?: number } | null | undefined): number {
  if (!item || !(Number(item.maxDurability) > 0)) return 0;
  return WEAR_COST_S.find(([pattern]) => pattern.test(item.name))?.[1] ?? 0;
}

export function canHarvest(block: BlockLike, item: { type: number } | null | undefined): boolean {
  return !block.harvestTools || (!!item && !!block.harvestTools[String(item.type)]);
}

/** Time in seconds plus wear, for breaking the block with this item (null: the bare hand). */
function toolCost(block: BlockLike, item: ToolLike | null | undefined, effects: unknown = {}, enchants: unknown[] = []): number {
  let ms: number;
  try { ms = Number(block.digTime(item ? item.type : null, false, false, false, enchants, effects)); } catch { return Infinity; }
  if (!Number.isFinite(ms)) return Infinity;
  return ms / 1000 + wearCostSeconds(item);
}

/**
 * The item to break the block with, or null for the bare hand. `requireHarvest`: only items that make the block
 * drop (an ore wanted for its drop); otherwise the hand counts too (clearing a way).
 */
export function chooseTool<T extends ToolLike>(block: BlockLike, items: T[], options: { requireHarvest?: boolean; effects?: unknown } = {}): T | null {
  const pick = (pool: T[]) => {
    const candidates: Array<T | null> = [null, ...pool];
    let best: T | null = null;
    let bestCost = Infinity;
    for (const item of candidates) {
      if (options.requireHarvest && !canHarvest(block, item)) continue;
      const cost = toolCost(block, item, options.effects);
      if (cost < bestCost) { bestCost = cost; best = item; }
    }
    return { best, bestCost };
  };
  // A tool one or two uses from breaking is the last choice: the cheapest, it was picked again and again while an iron pickaxe
  // lay beside it, and a stair stopped on it five times as "durability 1" (run 17). It is still used when nothing else does the job.
  const sound = items.filter(item => !nearlyBroken(item));
  const byCost = (): T | null => {
    if (sound.length < items.length) {
      const first = pick(sound);
      if (first.best) return first.best;
      // The hand is the best of the sound choices: the worn tool only when it is far quicker (stone by hand is 7.5 s a block).
      if (Number.isFinite(first.bestCost)) {
        const any = pick(items);
        return any.best && any.bestCost < first.bestCost / 3 ? any.best : null;
      }
    }
    return pick(items).best;
  };
  const chosen = byCost();
  if (chosen || options.requireHarvest) return chosen;
  return farQuickerThanHand(block, sound, options.effects);
}

/** The hand is this many times slower than a tool: the tool is used, whatever its wear is priced at. */
export const HAND_FAR_SLOWER = 4;
/** Under this many uses left, the tool is kept for what only it can break (obsidian), and the hand clears the way as before. */
export const HAND_FAR_SLOWER_RESERVE = 64;
/**
 * end1109f22/f24 (Haiku, random worlds): with only the diamond pickaxe left, one use priced at 6 s made the bare hand (2 s) the
 * cheaper way through netherrack (0.1 s with the pickaxe, which then had some 1,500 uses left). Every Nether go dug by hand,
 * "掘 34" in 80 s with the pickaxe's uses unchanged, and the road search priced rock at seven times a step and ran out of time
 * (search_timeout) looking for open ground: the walk to the fortress took 1,174 and 2,330 s. Wear is weighed between tools;
 * a hand four times slower than a sound tool is not a saving.
 */
function farQuickerThanHand<T extends ToolLike>(block: BlockLike, tools: T[], effects: unknown): T | null {
  const hand = toolCost(block, null, effects);
  let best: T | null = null;
  let bestCost = Infinity;
  for (const tool of tools) {
    const left = usesLeft(tool);
    if (left !== null && left < HAND_FAR_SLOWER_RESERVE) continue;
    const time = toolCost(block, tool, effects) - wearCostSeconds(tool);
    if (!Number.isFinite(time) || !(time * HAND_FAR_SLOWER <= hand)) continue;
    const cost = time + wearCostSeconds(tool);
    if (cost < bestCost) { bestCost = cost; best = tool; }
  }
  return best;
}

/** Uses left before a tool breaks, or null when it does not wear (or nothing is known of it). */
/** The hardest block a body with no pickaxe digs by hand to get out: 1.6 (stone 1.5 is 7.5 s, netherrack 0.4 is 2 s; cobblestone 2, end stone 3, obsidian stay shut). */
export const HAND_DIG_MAX_HARDNESS = 1.6;
/**
 * Run 62 (03:46, the synthesis's #19): with no pickaxe and no block, the body stood in a Nether valley 16 below its gate and every way up
 * was a stair to carve in netherrack, which "needs a pickaxe" (it drops nothing by hand) and so was no way at all. To move, a block that
 * drops nothing by hand still breaks, in seconds: a body that carries no pickaxe may dig the soft ones (hardness at most
 * HAND_DIG_MAX_HARDNESS) to make its way. One with a pickaxe digs as before, with the pickaxe.
 */
export function handDigForWay(block: { harvestTools?: unknown; hardness?: number | null } | null | undefined, items: Array<{ name?: string }>): boolean {
  if (!block) return false;
  if (!block.harvestTools) return true;
  if (items.some(item => /_pickaxe$/u.test(String(item?.name ?? '')))) return false;
  const hardness = Number(block.hardness);
  return Number.isFinite(hardness) && hardness >= 0 && hardness <= HAND_DIG_MAX_HARDNESS;
}
export function usesLeft(item: { maxDurability?: number; durabilityUsed?: number } | null | undefined): number | null {
  if (!item || !(Number(item.maxDurability) > 0)) return null;
  return Math.max(0, Number(item.maxDurability) - Number(item.durabilityUsed ?? 0));
}
/** At most this many uses left: kept for when nothing else will do. */
export const NEARLY_BROKEN_USES = 2;
export function nearlyBroken(item: { maxDurability?: number; durabilityUsed?: number } | null | undefined): boolean {
  const left = usesLeft(item);
  return left !== null && left <= NEARLY_BROKEN_USES;
}

/**
 * Puts the choice into the pathfinder (breaking through on a walk) and mineflayer-tool (collectblock's
 * equipForBlock, which sorts by its getDigTime). Load after both plugins.
 */
export function installToolChoice(bot: any): void {
  if (bot.toolChoiceInstalled) return;
  bot.toolChoiceInstalled = true;
  if (bot.pathfinder) {
    bot.pathfinder.bestHarvestTool = (block: BlockLike) => {
      // A walk only needs the way open, but a block the hand cannot break in reasonable time still wants its tool.
      const items = bot.inventory.items() as ToolLike[];
      return chooseTool(block, items, { effects: bot.entity?.effects });
    };
  }
  if (bot.tool && typeof bot.tool.getDigTime === 'function') {
    bot.tool.getDigTime = (block: BlockLike, item: ToolLike | undefined) => toolCost(block, item ?? null, bot.entity?.effects) * 1000;
  }
}
