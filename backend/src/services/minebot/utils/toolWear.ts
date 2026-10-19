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

/** Below this many uses the last sound pickaxe is said to want a spare. */
const SPARE_WHEN_LEFT = 50;
/** A pickaxe with more uses than this counts as one that can still dig (a stair stops at 3). */
const SOUND_USES = 3;

/**
 * A spare pickaxe, said when one is wanted: none that can still dig, or only one with fewer than SPARE_WHEN_LEFT uses left. Says
 * what the pack can make one of (iron, cobblestone, planks; sticks from planks). Run 17 went down to y 4 with one pickaxe, 157
 * cobblestone in the pack, and stopped there worn out. Advice, not a craft done unasked: making one takes a crafting table, and the
 * planner may want the iron for armour. Empty when nothing is to be said.
 */
export function spareToolNote(bot: unknown): string {
  const items = (bot as WearBot | undefined)?.inventory?.items?.() ?? [];
  const pickaxes = items.filter(item => item.name.endsWith('_pickaxe'));
  const left = (item: { maxDurability?: number; durabilityUsed?: number }) =>
    typeof item.maxDurability === 'number' && item.maxDurability > 0 ? Math.max(0, item.maxDurability - (item.durabilityUsed ?? 0)) : Infinity;
  const sound = pickaxes.filter(item => left(item) > SOUND_USES);
  if (sound.length > 1 || (sound.length === 1 && left(sound[0]) >= SPARE_WHEN_LEFT)) return '';
  const count = (test: (name: string) => boolean) => items.filter(item => test(item.name)).reduce((sum, item) => sum + item.count, 0);
  const planks = count(name => name.endsWith('_planks')), sticks = count(name => name === 'stick');
  const handles = sticks >= 2 || planks >= 2 + 3;
  const options = [
    count(name => name === 'iron_ingot') >= 3 && handles ? 'iron_pickaxe（鉄3）' : '',
    count(name => ['cobblestone', 'cobbled_deepslate', 'blackstone'].includes(name)) >= 3 && handles
      ? `stone_pickaxe（丸石3。手持ちの丸石${count(name => ['cobblestone', 'cobbled_deepslate', 'blackstone'].includes(name))}個）` : '',
  ].filter(Boolean);
  const now = sound.length ? `${sound[0].name}の残りは${left(sound[0])}回` : '掘れるツルハシが無い';
  return `。予備のツルハシ: ${now}。${options.length ? `craft-one で ${options.join(' か ')} を作っておける（棒2本も要る）` : '材料（丸石3か鉄3、棒2）を集めて作っておく'}`;
}

/** Logs (and the nether's stems) are cut far faster with an axe. */
export function isWood(name: string): boolean { return /_(log|wood|stem|hyphae)$/.test(name); }

/**
 * An axe for the logs, said after logs were cut without one: what the pack can make one of (cobblestone, else planks; sticks from
 * planks). Run 17 cut seventeen logs by hand in 132 s; with a stone axe a log takes about a quarter of the time (the owner: cut a
 * few, make a stone axe, cut the rest with it). Advice only (an axe takes a crafting table). Empty when an axe is carried or none can
 * be made.
 */
export function axeAdviceNote(bot: unknown, logsCut: number): string {
  const items = (bot as WearBot | undefined)?.inventory?.items?.() ?? [];
  if (logsCut < AXE_ADVICE_FROM || items.some(item => item.name.endsWith('_axe'))) return '';
  const count = (test: (name: string) => boolean) => items.filter(item => test(item.name)).reduce((sum, item) => sum + item.count, 0);
  const planks = count(name => name.endsWith('_planks')), sticks = count(name => name === 'stick'), logs = count(isWood);
  const handles = sticks >= 2 || planks >= 2 + 3 || logs >= 1;
  const cobble = count(name => ['cobblestone', 'cobbled_deepslate', 'blackstone'].includes(name));
  const what = cobble >= 3 && handles ? 'stone_axe（丸石3・棒2）' : planks + logs * 4 >= 5 ? 'wooden_axe（板材3・棒2）' : '';
  return what ? `。斧が無く素手で伐りました（原木1本 約3秒。石の斧なら約0.8秒、木の斧なら約1.5秒）。craft-one ${what} を作ってから伐ると速い` : '';
}
/** From this many logs cut by hand, the axe is said. */
const AXE_ADVICE_FROM = 3;

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
