/**
 * The night gate: no going down into the deep (below y 16) at nightfall or at night without the kit to live through it.
 *
 * Run 16 (2026-10-19) went down for diamonds at dusk with no armour, no cooked food and no bed, met a zombie at y -7 in a
 * cave and died there. The planner had been told everything (the clock, the inventory); it went anyway. So the body says
 * no at the tool, as a person would stop at the top of the stairs: what is missing, and what to do instead.
 *
 * What it refuses: a move whose goal is below y 16 (move-to with a goal height, stair-mine, dig-block-at, and mine-block's
 * targets down there). Already below y 16, only going further down is refused (a goal more than two blocks below the feet):
 * the way back up, or along, is never shut. Escapes and shelters (dig-shelter, build-around-self, tower-up, climb-down,
 * flee-from) are never gated. Only in the overworld: elsewhere the clock says nothing of mobs.
 *
 * The kit: armour (a chestplate of any kind, or two pieces of iron or better), two portions of cooked food (or bread and
 * the like), and a bed (carried, or a respawn bed already set). Worn and carried both count: carried armour is put on by
 * the floor's armour reflex.
 */

export const NIGHT_GATE_Y = 16;
/** Nightfall (monsters spawn under the sky) and morning, in ticks of the day. */
const NIGHTFALL_TICK = 13000;
const MORNING_TICK = 23000;
/**
 * The gate closes this many seconds before dark: a descent started then is still under way when the night begins. It was 60; run 17
 * went down to y 4 with no bed 260 and 168 seconds before dark, and was still down there at nightfall (the owner, 2026-10-20).
 */
export const DUSK_LEAD_SECONDS = 300;
/** The observation tells of the missing kit this long before dark, so that the planner can get it in daylight. */
export const KIT_NOTICE_SECONDS = 600;
/** Further down than this below the feet counts as going deeper (a block dug at the feet, a step down, is not). */
const DEEPER_MARGIN = 2;

export type KitPart = 'armor' | 'cooked_food' | 'bed';

/**
 * Food that the fire makes several times better (raw mutton 2, cooked 6): eaten only when there is nothing else and it cannot wait.
 * Run 16 ate raw mutton four times and raw chicken twice with a furnace and eleven coal in hand (rotten flesh and pufferfish have
 * their own rules where food is chosen). Kept here, beside the cooked food the night gate counts, so the observation can read it
 * without the skills (constantSkills/autoEat re-exports it).
 */
export const RAW_FOOD: ReadonlySet<string> = new Set(['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato']);
/** Raw meat counted towards cooking a batch (a potato is not worth a furnace's attention on its own). */
const RAW_MEAT = [...RAW_FOOD].filter(name => name !== 'potato');
/** From this many pieces of raw meat the observation says where they can be cooked. */
export const COOK_RAW_FROM = 3;

const PREPARED_FOOD = new Set(['bread', 'baked_potato', 'pumpkin_pie', 'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'golden_carrot']);
/** Food that needs no fire (cooked meat and fish, bread and the like): what the night is lived through on. */
export function isPreparedFood(name: string): boolean { return name.startsWith('cooked_') || PREPARED_FOOD.has(name); }
const PIECES = ['_helmet', '_chestplate', '_leggings', '_boots'];
const IRON_OR_BETTER = ['iron_', 'diamond_', 'netherite_'];

interface GateItem { name: string; count?: number }
export interface GateBody {
  entity?: { position: { x: number; y: number; z: number } };
  time?: { timeOfDay?: number; day?: number; age?: number | bigint };
  game?: { dimension?: unknown };
  inventory?: { items?(): GateItem[]; slots?: Array<GateItem | null | undefined> };
  placeMemory?: { state?: { places?: Array<{ keep?: string; dimension?: string }> };
    recall?(kind?: string, limit?: number): Array<{ position: { x: number; y: number; z: number }; distance: number }> };
  /** The lowest the body has stood below y 16 since the gate closed this night (see descentFloor). */
  nightGateAnchor?: { night: number; y: number };
  /** Furnaces at work on a batch the body put in (start-smelting). */
  activeFurnaces?: Array<{ pos: { x: number; y: number; z: number }; item: string; readyAt: number }>;
}

function carried(bot: GateBody): GateItem[] {
  const items = (() => { try { return bot.inventory?.items?.() ?? []; } catch { return []; } })();
  // Worn armour lives in the player window's slots 5-8, not in items().
  const slots = bot.inventory?.slots;
  const worn = Array.isArray(slots) ? [5, 6, 7, 8].map(slot => slots[slot]).filter((item): item is GateItem => !!item?.name) : [];
  return [...items, ...worn];
}

export interface DescentKit {
  missing: KitPart[];
  cookedFood: number;
  /** The armour pieces worn or carried, by name. */
  armor: string[];
  bed: boolean;
}

/** What the body has of the kit, and what is missing. */
export function descentKit(bot: GateBody): DescentKit {
  const items = carried(bot);
  const armor = items.filter(item => PIECES.some(piece => item.name.endsWith(piece))).map(item => item.name);
  const strong = armor.filter(name => IRON_OR_BETTER.some(material => name.startsWith(material)));
  const armored = armor.some(name => name.endsWith('_chestplate')) || strong.length >= 2;
  const cookedFood = items.filter(item => isPreparedFood(item.name)).reduce((sum, item) => sum + (item.count ?? 1), 0);
  let bed = items.some(item => item.name.endsWith('_bed'));
  if (!bed) {
    try { bed = (bot.placeMemory?.state?.places ?? []).some(place => place.keep === 'respawn' && String(place.dimension ?? 'overworld').includes('overworld')); }
    catch { /* no memory: a carried bed only */ }
  }
  const missing: KitPart[] = [];
  if (!armored) missing.push('armor');
  if (cookedFood < 2) missing.push('cooked_food');
  if (!bed) missing.push('bed');
  return { missing, cookedFood, armor, bed };
}

export interface NightClock { darkInSeconds: number; lightInSeconds?: number }
/** The overworld's clock as the gate reads it, or null (another dimension, or no clock). */
export function nightClock(bot: GateBody): NightClock | null {
  const dimension = String(bot.game?.dimension ?? 'overworld');
  if (!dimension.includes('overworld')) return null;
  const raw = bot.time?.timeOfDay;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const tick = ((raw % 24000) + 24000) % 24000;
  if (tick < NIGHTFALL_TICK) return { darkInSeconds: Math.round((NIGHTFALL_TICK - tick) / 20) };
  if (tick < MORNING_TICK) return { darkInSeconds: 0, lightInSeconds: Math.round((MORNING_TICK - tick) / 20) };
  // Dawn: the sun is up and the monsters burn or go under.
  return { darkInSeconds: Math.round((24000 - tick + NIGHTFALL_TICK) / 20) };
}

/** True while the gate is closed by the clock (night, or dark within DUSK_LEAD_SECONDS). */
export function gateHours(clock: NightClock | null): boolean {
  return !!clock && clock.darkInSeconds <= DUSK_LEAD_SECONDS;
}

/**
 * The lowest goal height allowed now, with what is missing, or null when nothing is gated (day, kit complete, not the overworld).
 * On the surface the floor is y 16; below it, two blocks under where the body stood when the gate first closed on it underground
 * this night (`nightGateAnchor`, kept on the body), or the feet if they are lower now: no deeper, but along and up are free.
 * Measured from the feet alone, two blocks at a time would have gone all the way down, one call after another.
 */
export function descentFloor(bot: GateBody): { floor: number; kit: DescentKit; clock: NightClock; underground: boolean } | null {
  const clock = nightClock(bot);
  if (!gateHours(clock)) return null;
  const kit = descentKit(bot);
  if (!kit.missing.length) return null;
  const feet = bot.entity?.position?.y;
  if (typeof feet !== 'number' || !Number.isFinite(feet)) return null;
  const feetY = Math.floor(feet);
  const underground = feetY < NIGHT_GATE_Y;
  if (!underground) return { floor: NIGHT_GATE_Y, kit, clock: clock!, underground };
  const night = nightNumber(bot);
  let anchor = bot.nightGateAnchor;
  if (!anchor || anchor.night !== night) anchor = bot.nightGateAnchor = { night, y: feetY };
  // Below that already (a fall, a cave floor walked down to): along and up from where it stands, never further down.
  return { floor: Math.min(anchor.y - DEEPER_MARGIN, feetY), kit, clock: clock!, underground };
}

/** Which night this is: the day count (a night lies within one day of the clock, which turns at sunrise). */
function nightNumber(bot: GateBody): number {
  const day = Number(bot.time?.day);
  if (Number.isFinite(day)) return day;
  const age = Number(bot.time?.age);
  return Number.isFinite(age) ? Math.floor(age / 24000) : 0;
}

function clockText(clock: NightClock): string {
  return clock.darkInSeconds > 0 ? `暗くなるまで約${clock.darkInSeconds}秒` : `夜（明けるまで約${clock.lightInSeconds ?? 0}秒）`;
}
function missingText(kit: DescentKit): string {
  return kit.missing.map(part => part === 'armor' ? '防具（胸当てか、鉄以上の部位2つ）'
    : part === 'cooked_food' ? `焼いた食料（2個以上。いま${kit.cookedFood}個）` : 'ベッド').join('、');
}
function nextText(kit: DescentKit, underground: boolean): string {
  const how = kit.missing.map(part => part === 'armor' ? '鉄インゴット8個で iron_chestplate'
    : part === 'cooked_food' ? '生肉は start-smelting で焼ける' : '同じ色の羊毛3個と板材3個で bed');
  return (underground
    ? '今の高さで横へ掘るか、上へ戻る（stair-mine で上へ、move-to で y16 以上）。'
    : '地上（y16以上）でできることを進めるか、dig-shelter で夜を越す。')
    + `用意: ${how.join('、')}。敵が近い時は build-around-self か dig-shelter（この断りは備えがそろうまで続く）`;
}

/**
 * What the gate says when it refuses `what` (a tool, with its goal). The form agreed with the API (mb-head, 2026-10-19):
 * `failureType` night_unprepared (the API's retry class prepare_first), and the text ends in "足りない: " with the missing parts as
 * the words armor, cooked_food, bed, comma-separated: the API adds its own fixed next step for each word.
 */
export function nightGateRefusal(gate: NonNullable<ReturnType<typeof descentFloor>>, what: string): { success: false; failureType: 'night_unprepared'; recoverable: true; result: string } {
  const where = gate.underground ? `y${gate.floor}より下（今より深く）` : 'y16より下（地下深く）';
  return { success: false, failureType: 'night_unprepared', recoverable: true,
    result: `夜の深い所は備えがそろうまで断る（夜の門）。${clockText(gate.clock)}で、${where}へ降りる${what}を断りました。`
      + `備え: ${missingText(gate.kit)}が無い。次の手: ${nextText(gate.kit, gate.underground)}。足りない: ${gate.kit.missing.join(', ')}` };
}

/** The refusal for a goal at `targetY`, or null when that goal is allowed. */
export function nightGateFor(bot: GateBody, targetY: number, what: string): ReturnType<typeof nightGateRefusal> | null {
  if (!Number.isFinite(targetY)) return null;
  let gate: ReturnType<typeof descentFloor> = null;
  try { gate = descentFloor(bot); } catch { return null; }
  if (!gate || targetY >= gate.floor) return null;
  return nightGateRefusal(gate, what);
}

/**
 * The observation's word on the kit (`state.world.margin.descentKit`): said only in the overworld, when something is missing and
 * the night is near (KIT_NOTICE_SECONDS) or here, with whether the gate is closed now.
 */
export function descentKitNotice(bot: GateBody): { missing: KitPart[]; gated: boolean } | undefined {
  const clock = nightClock(bot);
  if (!clock || clock.darkInSeconds > KIT_NOTICE_SECONDS) return undefined;
  const kit = descentKit(bot);
  return kit.missing.length ? { missing: kit.missing, gated: gateHours(clock) } : undefined;
}

/** A furnace remembered this far off is still worth walking back to for a batch of meat. */
const COOK_FURNACE_RANGE = 64;
const FURNACE_COBBLE = ['cobblestone', 'cobbled_deepslate', 'blackstone'];

/**
 * Raw meat to be cooked (`state.world.margin.cookRaw`), from COOK_RAW_FROM pieces: where it can be cooked now (a remembered furnace
 * not at work on a batch, with the fuel carried), or what stands in the way (every furnace busy, none known, no fuel). Run 16
 * carried raw mutton and chicken past its furnace and eleven coal, and ate them raw. One line, under 150 characters.
 */
export function cookRawNotice(bot: GateBody, now = Date.now()): string | undefined {
  let items: GateItem[] = [];
  try { items = bot.inventory?.items?.() ?? []; } catch { items = []; }
  const count = (test: (name: string) => boolean) => items.filter(item => test(item.name)).reduce((sum, item) => sum + (item.count ?? 1), 0);
  const raw = RAW_MEAT.map(name => [name, count(item => item === name)] as const).filter(([, n]) => n > 0);
  const total = raw.reduce((sum, [, n]) => sum + n, 0);
  if (total < COOK_RAW_FROM) return undefined;
  const head = `生肉 ${raw.map(([name, n]) => `${name}×${n}`).join('・')}`;
  const coal = count(name => name === 'coal' || name === 'charcoal');
  const wood = count(name => name.endsWith('_planks') || name.endsWith('_log'));
  if (!coal && !wood) return `${head} → 燃料が無い（石炭・木炭・板材）`;
  const fuel = coal ? `coal×${coal}` : `板材・原木×${wood}`;
  let furnaces: Array<{ position: { x: number; y: number; z: number }; distance: number }> = [];
  try { furnaces = [...(bot.placeMemory?.recall?.('furnace', 3) ?? []), ...(bot.placeMemory?.recall?.('smoker', 1) ?? [])]
    .filter(place => place.distance <= COOK_FURNACE_RANGE).sort((a, b) => a.distance - b.distance); } catch { furnaces = []; }
  const job = (p: { x: number; y: number; z: number }) => (bot.activeFurnaces ?? []).find(f => f.pos.x === p.x && f.pos.y === p.y && f.pos.z === p.z && f.readyAt > now);
  const at = (p: { x: number; y: number; z: number }) => `(${p.x},${p.y},${p.z})`;
  const free = furnaces.find(place => !job(place.position));
  if (free) return `${head} → 空いているかまど${at(free.position)} ${Math.round(free.distance)}m で焼ける（start-smelting、燃料 ${fuel}）`;
  const cobble = count(name => FURNACE_COBBLE.includes(name));
  if (!furnaces.length) return `${head} → かまどが無い（丸石8個で craft-one furnace、手持ち${cobble}個）`;
  const busy = job(furnaces[0].position)!;
  return `${head} → かまど${at(furnaces[0].position)}は ${busy.item} を精錬中（残り約${Math.ceil((busy.readyAt - now) / 1000)}秒）。2個目のかまどを置けば今すぐ焼ける（丸石8個、手持ち${cobble}個）`;
}

/** Wool colours by the sheep's metadata number (the low four bits). */
export const WOOL_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan',
  'purple', 'blue', 'brown', 'green', 'red', 'black'] as const;

/**
 * How far the carried wool goes towards a bed (`state.world.margin.bedWool`): the colour of which most is carried, how many, of
 * the three one bed takes. Said only while no bed is carried and some wool is: three of mixed colours make no bed (run 16).
 */
export function bedWool(bot: GateBody): { color: string; have: number; need: 3 } | undefined {
  const items = carried(bot);
  if (items.some(item => item.name.endsWith('_bed'))) return undefined;
  let best: { color: string; have: number } | null = null;
  for (const [color, have] of woolByColor(items)) if (!best || have > best.have) best = { color, have };
  return best ? { color: best.color, have: best.have, need: 3 } : undefined;
}

/** A sheep's wool, from its metadata (the `wool` byte: colour in the low four bits, shorn at 0x10), or null when unknown. */
export function sheepWool(bot: { registry?: any }, entity: { metadata?: unknown[] }): { color: string; sheared: boolean } | null {
  const keys: string[] | undefined = bot.registry?.entitiesByName?.sheep?.metadataKeys;
  const index = Array.isArray(keys) && keys.includes('wool') ? keys.indexOf('wool') : 17;
  const value = entity.metadata?.[index];
  if (typeof value !== 'number') return null;
  return { color: WOOL_COLORS[value & 0x0f], sheared: (value & 0x10) !== 0 };
}

/** Wool carried, by colour (white_wool → white). */
export function woolByColor(items: Array<{ name: string; count?: number }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.name.endsWith('_wool')) continue;
    const color = item.name.slice(0, -'_wool'.length);
    counts.set(color, (counts.get(color) ?? 0) + (item.count ?? 1));
  }
  return counts;
}

/**
 * The wool after a sheep hunt, as one sentence for the result: a bed can be made now (three of a colour, none carried), or the
 * colours do not make one and how many of which are still wanted. Empty when no wool is carried, or a bed is.
 */
export function woolStatusLine(items: Array<{ name: string; count?: number }>): string {
  if (items.some(item => item.name.endsWith('_bed'))) return '';
  const wool = [...woolByColor(items).entries()].sort((a, b) => b[1] - a[1]);
  if (!wool.length) return '';
  const [color, have] = wool[0];
  if (have >= 3) return `羊毛: ${color} ${have}/3 → craft-one ${color}_bed でベッドを作れる`;
  const now = wool.map(([c, n]) => `${c} ${n}`).join('・');
  return `羊毛: ${now} → 同じ色があと${3 - have}個（${color}。attack-continuously color=${color}）`;
}
