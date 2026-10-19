/**
 * The body notices when a tool breaks in its hand. Nothing did: a single
 * ore-mining action wore out the stone pickaxe, carried on with the wooden one
 * until that broke too, and left the bot 19 blocks underground with no tool
 * and no way to make one (paid run L21; L13 stalled the same way). The server
 * announces a break (entity status 47..52); the item in that hand a moment
 * before names what was lost.
 */
const BREAK_STATUS: Record<number, 'hand' | 'off-hand' | 'armor'> = { 47: 'hand', 48: 'off-hand', 49: 'armor', 50: 'armor', 51: 'armor', 52: 'armor' };

/** `part`: what broke, the hand's tool, the off hand's (a shield) or a piece of armour. */
export interface ToolBreak { name: string; at: number; part?: 'hand' | 'off-hand' | 'armor' }

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

/**
 * A pickaxe with fewer uses left than this (or than a quarter of its whole) is one that may not see out the next mining order: run
 * 18 used 80 uses of an iron pickaxe on eleven iron ores in one mine-block (D24; 96 of a stone one on eleven ores, D11), and at D44
 * its iron, stone and wooden pickaxes broke one after another inside one order, with no word before of how little was left.
 */
const LOW_USES = 100;
const LOW_SHARE = 0.25;
/** A pickaxe with more uses than this counts as one that can still dig (a stair stops at 3). */
const SOUND_USES = 3;

type Worn = { name: string; maxDurability?: number; durabilityUsed?: number };
function usesLeft(item: Worn): number {
  return typeof item.maxDurability === 'number' && item.maxDurability > 0 ? Math.max(0, item.maxDurability - (item.durabilityUsed ?? 0)) : Infinity;
}
/**
 * Too worn to see out a mining order (see LOW_USES). A small tool (wooden 59, golden 32) is low only from three quarters of its whole
 * down, so that a new one is not "low" from the start; a diamond one from a quarter of its whole.
 */
export function pickaxeLow(item: Worn): boolean {
  const left = usesLeft(item), max = item.maxDurability ?? 0;
  return Number.isFinite(left) && left < Math.max(Math.min(LOW_USES, 0.75 * max), LOW_SHARE * max);
}

/** The pickaxe with the most uses left, and whether another one could take its place (one not low itself). */
function pickaxeState(items: Worn[]): { best: Worn | null; spare: boolean } {
  const pickaxes = items.filter(item => item.name.endsWith('_pickaxe')).sort((a, b) => usesLeft(b) - usesLeft(a));
  const best = pickaxes[0] ?? null;
  return { best, spare: pickaxes.slice(1).some(item => !pickaxeLow(item)) };
}

/**
 * A spare pickaxe, said when one is wanted: none that can still dig, or the best one low (pickaxeLow) with no other to take over.
 * Says what the pack can make one of (iron, cobblestone, planks; sticks from planks). Run 17 went down to y 4 with one pickaxe, 157
 * cobblestone in the pack, and stopped there worn out. Advice, not a craft done unasked: making one takes a crafting table, and the
 * planner may want the iron for armour. Empty when nothing is to be said.
 */
export function spareToolNote(bot: unknown): string {
  const items = (bot as WearBot | undefined)?.inventory?.items?.() ?? [];
  const { best, spare } = pickaxeState(items);
  if (best && (!pickaxeLow(best) || spare)) return '';
  const left = usesLeft;
  const sound = best && left(best) > SOUND_USES ? [best] : [];
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

/** Neither a table nor what makes one: no crafting_table, fewer than four planks, no log. */
function noTableKit(items: Array<{ name: string; count: number }>): boolean {
  const count = (test: (name: string) => boolean) => items.filter(item => test(item.name)).reduce((sum, item) => sum + item.count, 0);
  return count(name => name === 'crafting_table') === 0 && count(name => name.endsWith('_planks')) < 4 && count(isWood) === 0;
}

/**
 * The tool kit as the observation says it (`state.world.margin.toolKit`), only when something is short: the best pickaxe low with no
 * spare (or none at all), and no table nor the planks or log to make one. One line. Run 18 went from D28 to D43 with one plank and
 * no table or log (176 s back to its base when it needed the table), and from D44 to D49 with no pickaxe at all.
 */
export function toolKitNotice(bot: unknown): string | undefined {
  const items = (bot as WearBot | undefined)?.inventory?.items?.() ?? [];
  const parts: string[] = [];
  const { best, spare } = pickaxeState(items);
  if (!best) parts.push('つるはしが無い');
  else if (pickaxeLow(best) && !spare) {
    parts.push(`つるはしは${best.name}だけで残り${usesLeft(best)}/${best.maxDurability}（mine-block 1回で80〜100減ることがある）。予備に stone_pickaxe（丸石3・棒2）を1本持つ`);
  }
  if (noTableKit(items)) parts.push('作業台も板4枚も原木も無い（作業台が要る時は拠点まで戻ることになる。原木1本か作業台を持ち歩く）');
  return parts.length ? parts.join('。') : undefined;
}

/** Said when a craft used up the last log: what is left to make a table of. */
export function lastLogNote(bot: unknown): string {
  const items = (bot as WearBot | undefined)?.inventory?.items?.() ?? [];
  const planks = items.filter(item => item.name.endsWith('_planks')).reduce((sum, item) => sum + item.count, 0);
  const table = items.some(item => item.name === 'crafting_table');
  return `原木はこれで最後です（板材${planks}枚、作業台${table ? 'あり' : 'なし'}）。`
    + (table || planks >= 4 ? '' : '次に作業台が要る時のために、原木を集めるか板4枚を残しておく');
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
    const entry: ToolBreak = { name: name ?? (part === 'armor' ? '防具' : '手に持っていた道具'), at: Date.now(), part };
    if (part === 'hand') held = null; else if (part === 'off-hand') offhand = null;
    breaks.push(entry);
    if (breaks.length > 32) breaks.splice(0, breaks.length - 32);
    bot.emit('minebotToolBroke', entry);
  });
}

export function toolWearPlugin(bot: unknown): void { installToolWearMonitor(bot as WearBot); }
