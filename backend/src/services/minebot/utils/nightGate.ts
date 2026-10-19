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
/** The gate closes this many seconds before dark: a descent started then is still under way when the night begins. */
export const DUSK_LEAD_SECONDS = 60;
/** The observation tells of the missing kit this long before dark, so that the planner can get it in daylight. */
export const KIT_NOTICE_SECONDS = 300;
/** Further down than this below the feet counts as going deeper (a block dug at the feet, a step down, is not). */
const DEEPER_MARGIN = 2;

export type KitPart = 'armor' | 'cooked_food' | 'bed';

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
  placeMemory?: { state?: { places?: Array<{ keep?: string; dimension?: string }> } };
  /** The lowest the body has stood below y 16 since the gate closed this night (see descentFloor). */
  nightGateAnchor?: { night: number; y: number };
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

/** True while the gate is closed by the clock (night, or dark within a minute). */
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
 * the night is near (five minutes) or here, with whether the gate is closed now.
 */
export function descentKitNotice(bot: GateBody): { missing: KitPart[]; gated: boolean } | undefined {
  const clock = nightClock(bot);
  if (!clock || clock.darkInSeconds > KIT_NOTICE_SECONDS) return undefined;
  const kit = descentKit(bot);
  return kit.missing.length ? { missing: kit.missing, gated: gateHours(clock) } : undefined;
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
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.name.endsWith('_wool')) continue;
    const color = item.name.slice(0, -'_wool'.length);
    counts.set(color, (counts.get(color) ?? 0) + (item.count ?? 1));
  }
  let best: { color: string; have: number } | null = null;
  for (const [color, have] of counts) if (!best || have > best.have) best = { color, have };
  return best ? { color: best.color, have: best.have, need: 3 } : undefined;
}
