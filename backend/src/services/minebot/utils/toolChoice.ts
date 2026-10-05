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
export function toolCost(block: BlockLike, item: ToolLike | null | undefined, effects: unknown = {}, enchants: unknown[] = []): number {
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
  const candidates: Array<T | null> = [null, ...items];
  let best: T | null = null;
  let bestCost = Infinity;
  for (const item of candidates) {
    if (options.requireHarvest && !canHarvest(block, item)) continue;
    const cost = toolCost(block, item, options.effects);
    if (cost < bestCost) { bestCost = cost; best = item; }
  }
  return best;
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
