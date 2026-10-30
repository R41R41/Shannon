/**
 * Food as the planner weighs it (design mb-llm-centric 2.6): every piece carried is worth its hunger points plus the saturation it
 * gives (cooked mutton 6 + 9.6 = 15.6), and the body's own store is its food level plus its hidden saturation. Run 24 went into the
 * Nether with 47 points, run 25 with one raw chicken; the way past the Nether takes 160-200. The rate it goes at is measured here
 * (the drop of food + saturation over the last five minutes, meals left out).
 */
export interface FoodPoints {
  /** The points of everything edible carried (hunger + saturation), rounded to one decimal. */
  carried: number;
  /** "bread×3(33) cooked_mutton×2(31.2)": what makes that, best first. */
  items: string;
  /** The food level (0-20) and the hidden saturation. */
  hunger: number | null;
  saturation: number | null;
  /** Points spent in the last five minutes (food + saturation lost, meals not counted), when measured for a minute or more. */
  spentLast5Min?: number;
}

/** Points per item when the game's data does not say (hunger + saturation, vanilla 1.21). */
const FALLBACK: Record<string, [number, number]> = {
  apple: [4, 2.4], baked_potato: [5, 6], beef: [3, 1.8], beetroot: [1, 1.2], beetroot_soup: [6, 7.2], bread: [5, 6], carrot: [3, 3.6],
  chicken: [2, 1.2], cod: [2, 0.4], cooked_beef: [8, 12.8], cooked_chicken: [6, 7.2], cooked_cod: [5, 6], cooked_mutton: [6, 9.6],
  cooked_porkchop: [8, 12.8], cooked_rabbit: [5, 6], cooked_salmon: [6, 9.6], cookie: [2, 0.4], dried_kelp: [1, 0.6], golden_apple: [4, 9.6],
  enchanted_golden_apple: [4, 9.6], golden_carrot: [6, 14.4], melon_slice: [2, 1.2], mushroom_stew: [6, 7.2], mutton: [2, 1.2],
  porkchop: [3, 1.8], potato: [1, 0.6], pumpkin_pie: [8, 4.8], rabbit: [3, 1.8], rabbit_stew: [10, 12], rotten_flesh: [4, 0.8],
  salmon: [2, 0.4], sweet_berries: [2, 0.4], glow_berries: [2, 0.4], honey_bottle: [6, 1.2], tropical_fish: [1, 0.2],
};
const NOT_FOOD = new Set(['pufferfish', 'poisonous_potato', 'spider_eye', 'chorus_fruit', 'suspicious_stew']);

/** Vanilla nutrition used to recognise the 1.21.11 data generator's double saturation conversion. */
export function vanillaFoodNutrition(name: string): readonly [number, number] | null {
  return FALLBACK[name] ?? null;
}

interface FoodBody {
  food?: number; foodSaturation?: number;
  inventory?: { items?(): Array<{ name: string; count: number }> };
  registry?: { foodsByName?: Record<string, { foodPoints?: number; saturation?: number } | undefined> };
}

/** One item's points (hunger + saturation), 0 for what is not eaten. */
export function itemFoodPoints(bot: FoodBody, name: string): number {
  if (NOT_FOOD.has(name)) return 0;
  const food = bot.registry?.foodsByName?.[name];
  if (food && typeof food.foodPoints === 'number') return food.foodPoints + (typeof food.saturation === 'number' ? food.saturation : 0);
  const fallback = FALLBACK[name];
  return fallback ? fallback[0] + fallback[1] : 0;
}

const round = (value: number) => Math.round(value * 10) / 10;

interface Sample { at: number; store: number }
const samples = new WeakMap<object, Sample[]>();
const WINDOW_MS = 300_000;
const SAMPLE_GAP_MS = 5_000;

export function foodPointsOf(bot: FoodBody, now = Date.now()): FoodPoints {
  const totals = new Map<string, { count: number; points: number }>();
  for (const item of bot.inventory?.items?.() ?? []) {
    const each = itemFoodPoints(bot, item.name);
    if (each <= 0) continue;
    const entry = totals.get(item.name) ?? { count: 0, points: 0 };
    entry.count += item.count; entry.points += each * item.count;
    totals.set(item.name, entry);
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1].points - a[1].points);
  const carried = round(sorted.reduce((sum, [, entry]) => sum + entry.points, 0));
  const hunger = typeof bot.food === 'number' ? bot.food : null;
  const saturation = typeof bot.foodSaturation === 'number' ? round(bot.foodSaturation) : null;
  const result: FoodPoints = { carried, items: sorted.map(([name, entry]) => `${name}×${entry.count}(${round(entry.points)})`).join(' '), hunger, saturation };
  if (hunger !== null) {
    const list = samples.get(bot as object) ?? [];
    samples.set(bot as object, list);
    const store = hunger + (saturation ?? 0);
    if (!list.length || now - list[list.length - 1].at >= SAMPLE_GAP_MS) list.push({ at: now, store });
    while (list.length && now - list[0].at > WINDOW_MS) list.shift();
    if (list.length >= 2 && now - list[0].at >= 60_000) {
      let spent = 0;
      for (let i = 1; i < list.length; i++) spent += Math.max(0, list[i - 1].store - list[i].store);
      result.spentLast5Min = round(spent);
    }
  }
  return result;
}
