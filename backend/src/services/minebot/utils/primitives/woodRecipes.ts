/**
 * Run 59 leg 2: planks are made from any log or wood of their kind (the game's recipe takes the tag `#oak_logs`: the log, the wood and
 * both stripped forms), but the recipes the library gives for `oak_planks` name only `oak_log`. With 4 stripped oak logs in the pack the
 * body said "missing: oak_log×1" for a crafting table and for planks, and the planner put off the shield for want of planks it held.
 * The recipes of `<kind>_planks` are given again with each other form of the same kind in place of the one they name.
 */
const FORMS = (kind: string): string[] => [`${kind}_log`, `stripped_${kind}_log`, `${kind}_wood`, `stripped_${kind}_wood`,
  `${kind}_stem`, `stripped_${kind}_stem`, `${kind}_hyphae`, `stripped_${kind}_hyphae`];

/** A copy of the recipe with every `from` item id put as `to` (its shape, its ingredients and its delta). */
function swapped(recipe: any, from: number, to: number): any {
  const copy = Object.assign(Object.create(Object.getPrototypeOf(recipe)), recipe);
  const swap = (entry: any) => (entry && entry.id === from ? { ...entry, id: to } : entry);
  if (Array.isArray(recipe.inShape)) copy.inShape = recipe.inShape.map((row: any[]) => row.map(swap));
  if (Array.isArray(recipe.outShape)) copy.outShape = recipe.outShape.map((row: any[]) => row.map(swap));
  if (Array.isArray(recipe.ingredients)) copy.ingredients = recipe.ingredients.map(swap);
  if (Array.isArray(recipe.delta)) copy.delta = recipe.delta.map(swap);
  return copy;
}

/** The recipes of `item`, and for planks the same recipes made from each other form of their wood the library left out. */
export function withWoodForms(bot: any, item: string, recipes: readonly any[]): any[] {
  const kind = /^([a-z_]+)_planks$/u.exec(item)?.[1];
  if (!kind) return [...recipes];
  const byName = bot.registry?.itemsByName ?? {};
  const ids = FORMS(kind).map(name => byName[name]?.id).filter((id): id is number => typeof id === 'number');
  const takes = (recipe: any, id: number) => (recipe.delta ?? []).some((entry: any) => entry?.id === id && entry.count < 0);
  const out = [...recipes];
  for (const recipe of recipes) {
    const from = ids.find(id => takes(recipe, id));
    if (from === undefined) continue;
    for (const to of ids) if (!out.some(known => takes(known, to))) out.push(swapped(recipe, from, to));
  }
  return out;
}
