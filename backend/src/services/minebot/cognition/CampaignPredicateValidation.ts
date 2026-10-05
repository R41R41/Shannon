import type { CampaignGoalGraph } from './CampaignGoalGraph.js';

type ItemIndex = Record<string, unknown>;

function itemIndex(registry: unknown): ItemIndex | null {
  if (!registry || typeof registry !== 'object') return null;
  const items = (registry as { itemsByName?: unknown }).itemsByName;
  return items && typeof items === 'object' ? items as ItemIndex : null;
}

/** Inventory predicates name an exact item, never a category such as "food". */
export function unknownInventoryPredicateItems(predicates: unknown, registry: unknown): string[] {
  const items = itemIndex(registry);
  if (!items || !Array.isArray(predicates)) return [];
  return [...new Set(predicates
    .filter(predicate => predicate && typeof predicate === 'object'
      && ['inventory', 'produced'].includes((predicate as { kind?: unknown }).kind as string))
    .map(predicate => (predicate as { item?: unknown }).item)
    .filter((name): name is string => typeof name === 'string' && !Object.prototype.hasOwnProperty.call(items, name)))];
}

/**
 * Registry names closest to an unknown one, by the length of the words they
 * share (raw_beef shares "beef" with beef and cooked_beef), then by how few
 * words of their own they add. A bare rejection left the planner guessing the exact ID.
 */
export function similarItemNames(name: string, registry: unknown, limit = 4): string[] {
  const items = itemIndex(registry);
  if (!items) return [];
  const words = new Set(name.toLowerCase().split(/[_\s]+/).filter(Boolean));
  return Object.keys(items)
    .map(candidate => {
      const parts = candidate.split('_');
      const shared = parts.filter(part => words.has(part)).reduce((sum, part) => sum + part.length, 0);
      return { candidate, shared, unshared: parts.filter(part => !words.has(part)).length, extra: Math.abs(candidate.length - name.length) };
    })
    .filter(entry => entry.shared > 0)
    .sort((a, b) => b.shared - a.shared || a.unshared - b.unshared || a.extra - b.extra || a.candidate.localeCompare(b.candidate))
    .slice(0, limit).map(entry => entry.candidate);
}

/** Reject only names absent from this Bot's versioned native item registry. */
export function assertKnownInventoryPredicateItems(predicates: unknown, registry: unknown): void {
  const unknown = unknownInventoryPredicateItems(predicates, registry);
  if (!unknown.length) return;
  const hints = unknown.map(name => {
    const similar = similarItemNames(name, registry);
    return similar.length ? ` ${name}に近い登録ID: ${similar.join(', ')}` : '';
  }).join('');
  throw new Error(`GOAL_ITEM_UNKNOWN:${unknown.join(',')}: inventory/produced require exact Minecraft item IDs; use separate any-joined branches for alternatives${hints ? ` (${hints.trim()})` : ''}`);
}

type ItemPredicate = { kind: 'inventory' | 'produced'; item: string };

function itemPredicates(predicates: unknown): ItemPredicate[] {
  if (!Array.isArray(predicates)) return [];
  return predicates.filter((predicate): predicate is ItemPredicate => !!predicate && typeof predicate === 'object'
    && ['inventory', 'produced'].includes((predicate as { kind?: unknown }).kind as string)
    && typeof (predicate as { item?: unknown }).item === 'string');
}

const WOOD_OR_COLOR = /^(?:stripped_)?(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped|white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_/;
const TOOL_OR_ARMOR = /^(?:wooden|stone|iron|golden|diamond|netherite|leather|chainmail|copper)_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$/;
const EQUIVALENT_GROUPS = [['cobblestone', 'cobbled_deepslate', 'blackstone'], ['coal', 'charcoal']];
const CATEGORY_WORDS: Record<string, 'food' | RegExp> = {
  food: 'food', foods: 'food', meat: 'food',
  log: /_(?:log|stem)$/, logs: /_(?:log|stem)$/, wood: /_(?:log|stem|wood|hyphae)$/,
  planks: /_planks$/, ore: /(?:_ore$|^raw_)/,
};

/** raw_iron, iron_ore, deepslate_iron_ore and iron_ingot name one smelting material. */
function smeltingMaterial(name: string): string | null {
  const base = name.replace(/^deepslate_/, '');
  const match = base.match(/^raw_([a-z]+)$/) ?? base.match(/^([a-z]+)_(?:ore|ingot|nugget)$/);
  return match ? match[1] : null;
}

function isEdible(registry: unknown, name: string): boolean | null {
  const foods = registry && typeof registry === 'object'
    ? (registry as { foodsByName?: Record<string, unknown> }).foodsByName : undefined;
  return foods && typeof foods === 'object' ? Object.prototype.hasOwnProperty.call(foods, name) : null;
}

function dropNames(registry: unknown, block: string): string[] {
  const reg = registry as { blocksByName?: Record<string, { drops?: unknown[] }>; items?: Record<number, { name?: string }> } | null;
  const drops = reg?.blocksByName?.[block]?.drops;
  if (!Array.isArray(drops) || !reg?.items) return [];
  return drops.map(drop => {
    const id = typeof drop === 'number' ? drop : (drop as { drop?: number | { id?: number } })?.drop;
    const itemId = typeof id === 'number' ? id : id?.id;
    return typeof itemId === 'number' ? reg.items?.[itemId]?.name : undefined;
  }).filter((name): name is string => typeof name === 'string');
}

/**
 * Whether one item contract can be corrected into another without changing
 * what the node is for: a block's actual drop, the same smelting material,
 * another edible item, a wood/color variant, or a tool/armor tier. Returns
 * null when the registry cannot judge a legacy category name.
 */
function sameItemPurpose(registry: unknown, from: string, to: string): boolean | null {
  if (from === to) return true;
  const known = itemIndex(registry);
  if (known && !Object.prototype.hasOwnProperty.call(known, from)) {
    const category = CATEGORY_WORDS[from.toLowerCase()];
    if (category === 'food') return isEdible(registry, to);
    if (category) return category.test(to);
    return null;
  }
  if (isEdible(registry, from) === true && isEdible(registry, to) === true) return true;
  if (dropNames(registry, from).includes(to) || dropNames(registry, to).includes(from)) return true;
  const material = smeltingMaterial(from);
  if (material && material === smeltingMaterial(to)) return true;
  if (WOOD_OR_COLOR.test(from) && from.replace(WOOD_OR_COLOR, '') === to.replace(WOOD_OR_COLOR, '')) return true;
  const tool = from.match(TOOL_OR_ARMOR)?.[1];
  if (tool && tool === to.match(TOOL_OR_ARMOR)?.[1]) return true;
  return EQUIVALENT_GROUPS.some(group => group.includes(from) && group.includes(to));
}

/**
 * A native proof checks the fact, not the purpose, so revising "secure food"
 * from beef to logs would verify immediately. Item corrections must keep the
 * node's purpose; a different output belongs in a different node.
 */
export function assertRevisionPreservesItemPurpose(nodeId: string, before: unknown, after: unknown, registry: unknown): void {
  if (after === undefined) return;
  const previous = itemPredicates(before);
  const known = itemIndex(registry);
  if (!previous.length || !known) return;
  const next = itemPredicates(after);
  const knownPrevious = previous.filter(predicate => Object.prototype.hasOwnProperty.call(known, predicate.item));
  const unrelated = next.filter(candidate => !previous.some(predicate =>
    sameItemPurpose(registry, predicate.item, candidate.item) !== false));
  if (unrelated.length || (!next.length && knownPrevious.length)) {
    const from = previous.map(predicate => predicate.item).join(',');
    const to = next.length ? next.map(predicate => predicate.item).join(',') : '(no item)';
    throw new Error(`CAMPAIGN_REVISION_ITEM_PURPOSE_CHANGED:${nodeId}:${from}->${to}: `
      + 'reviseは同じ目的の品目訂正（鉱石→実ドロップ、別の食料、木材や色の種類違い、道具の材質違い）に限る。'
      + '目的が違う成果は別ノードとして作成し、このノードはblockedかabandonedにする。');
  }
}

/** Bounded, read-only diagnosis of legacy campaign predicates in the current frontier. */
export function unknownCampaignFrontierItems(
  campaign: CampaignGoalGraph,
  registry: unknown,
  activeId?: string,
): Array<{ nodeId: string; item: string }> {
  if (!itemIndex(registry)) return [];
  const { activePath, ready } = campaign.projection(activeId, 32);
  const frontier = [...activePath, ...ready];
  for (const readyNode of ready) {
    let parentId = readyNode.parentId;
    for (let depth = 0; parentId && depth < 16; depth++) {
      const parent = campaign.getNode(parentId);
      if (!parent) break;
      frontier.push(parent);
      parentId = parent.parentId;
    }
  }
  const seen = new Set<string>();
  const result: Array<{ nodeId: string; item: string }> = [];
  for (const node of frontier) {
    for (const item of unknownInventoryPredicateItems(node.postconditions, registry)) {
      const key = `${node.id}:${item}`;
      if (!seen.has(key)) { seen.add(key); result.push({ nodeId: node.id, item }); }
    }
  }
  return result;
}
