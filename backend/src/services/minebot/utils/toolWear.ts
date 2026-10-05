/**
 * The body notices when a tool breaks in its hand. Nothing did: a single
 * ore-mining action wore out the stone pickaxe, carried on with the wooden one
 * until that broke too, and left the bot 19 blocks underground with no tool
 * and no way to make one (paid run L21; L13 stalled the same way). The server
 * announces a break (entity status 47..52); the item in that hand a moment
 * before names what was lost.
 */
const BREAK_STATUS: Record<number, 'hand' | 'off-hand' | 'armor'> = { 47: 'hand', 48: 'off-hand', 49: 'armor', 50: 'armor', 51: 'armor', 52: 'armor' };

export interface ToolBreak { name: string; at: number }

interface WearBot {
  entity?: { id?: number };
  heldItem?: { name?: string; maxDurability?: number } | null;
  inventory?: { slots?: Array<{ name?: string } | null>; items?(): Array<{ name: string; count: number; maxDurability?: number; durabilityUsed?: number }> };
  toolBreaks?: ToolBreak[];
  _client?: { on(event: 'entity_status', listener: (packet: { entityId: number; entityStatus: number }) => void): unknown };
  on(event: 'physicsTick', listener: () => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
}

/** Tools still carried, with what is left of each: what a planner needs after a break. */
export function describeRemainingTools(bot: unknown): string {
  const items = (bot as WearBot | undefined)?.inventory?.items?.() ?? [];
  const tools = items.filter(item => typeof item.maxDurability === 'number' && item.maxDurability > 0)
    .map(item => `${item.name}（耐久 残り${Math.max(0, item.maxDurability! - (item.durabilityUsed ?? 0))}/${item.maxDurability}）`);
  return tools.length ? tools.join('、') : 'なし';
}

export function installToolWearMonitor(bot: WearBot): void {
  if (bot.toolBreaks) return;
  const breaks: ToolBreak[] = [];
  bot.toolBreaks = breaks;
  let held: string | null = null;
  let offhand: string | null = null;
  bot.on('physicsTick', () => {
    // Remember what the hands held: by the time the break is announced the slot is empty.
    // Only things that wear out can be what broke: with any held item remembered, a pickaxe that
    // broke just after the hand had passed over a sapling was reported as "dark_oak_sapling broke"
    // (paid run L55), and the planner was told the wrong thing was gone.
    if (bot.heldItem?.name && (bot.heldItem.maxDurability ?? 0) > 0) held = bot.heldItem.name;
    const off = bot.inventory?.slots?.[45] as { name?: string; maxDurability?: number } | null | undefined;
    if (off?.name && (off.maxDurability ?? 0) > 0) offhand = off.name;
  });
  bot._client?.on('entity_status', packet => {
    const part = BREAK_STATUS[packet.entityStatus];
    if (!part || packet.entityId !== bot.entity?.id) return;
    const name = part === 'hand' ? held : part === 'off-hand' ? offhand : null;
    const entry = { name: name ?? (part === 'armor' ? '防具' : '手に持っていた道具'), at: Date.now() };
    if (part === 'hand') held = null; else if (part === 'off-hand') offhand = null;
    breaks.push(entry);
    if (breaks.length > 32) breaks.splice(0, breaks.length - 32);
    bot.emit('minebotToolBroke', entry);
  });
}

export function toolWearPlugin(bot: unknown): void { installToolWearMonitor(bot as WearBot); }
