/**
 * The places the body has seen, kept after they are out of sight.
 *
 * What the planner could find was what lay in the chunks the server had sent at that moment (80 blocks). A
 * pool of water it had drunk from, a lava lake it had walked past, the furnace it had left behind: once out
 * of range they did not exist, and it searched for them again (paid run L74 looked for the same water seven
 * times; L26 walked 88 blocks back for a furnace it could no longer name the place of). A person keeps a map
 * in the head, and it is not a copy of the world: it is a list of places worth knowing, each with what is
 * there and where. This is that list. It holds no blocks, only sightings merged into places.
 *
 * Pure data: nothing here reads the game. The body's side (what counts as a sighting) is
 * `services/minebot/utils/placeMemory.ts`.
 */
export interface PlacePosition { x: number; y: number; z: number }

export interface Place {
  id: string;
  /** What is there, in the game's own words where it has them: water, lava, village, furnace, diamond_ore, death. */
  kind: string;
  dimension: string;
  position: PlacePosition;
  /** How much of it was seen together (blocks of a vein, open cells of a pool), when that means something. */
  count?: number;
  note?: string;
  /**
   * Why the place is never let go for room: `base` the first crafting table, bed or furnace the body set down in a
   * dimension, `respawn` the bed it last set its respawn point at, `portal` a portal it went through (with its pair).
   */
  keep?: PlaceKeep;
  firstSeenAt: number;
  lastSeenAt: number;
}
export type PlaceKeep = 'base' | 'respawn' | 'portal';

/** What a death left behind, kept as one record (the place of kind `death` is only where). */
export interface DeathRecord {
  at: number;
  dimension: string;
  position: PlacePosition;
  /** The server's death message, as said in the chat ("Shannon was slain by Zombie"). */
  cause?: string;
  /** What was carried and worn just before, most first; empty when nothing was lost (keepInventory). */
  lost: Array<{ name: string; count: number }>;
  /** How long the body has been near enough for the dropped items to age (they last 5 minutes of that). */
  nearMs: number;
  /** The body went back and found nothing there any more (picked up, or gone). */
  cleared?: boolean;
}

export interface PlaceMemoryState {
  version: 1;
  places: Place[];
  /** The last few deaths, newest last. */
  deaths?: DeathRecord[];
  /**
   * The ground the body has had in view, per dimension, as chunk columns ("cx,cz"). Not what is in them: only
   * that they were seen, so that "which way have I not been" has an answer.
   */
  seen?: Record<string, string[]>;
  /** The biome of each chunk column seen, per dimension ("cx,cz" → biome), read at its middle (see noteBiome). */
  biomes?: Record<string, Record<string, string>>;
}
export interface Sighting { kind: string; dimension: string; position: PlacePosition; count?: number; note?: string; keep?: PlaceKeep }
export interface RecalledPlace extends Place { distance: number; direction: string }

export const emptyPlaceMemory = (): PlaceMemoryState => ({ version: 1, places: [] });

/**
 * Places kept at most; beyond it the kind with the most places gives one up: the one furthest off and longest unseen.
 * Ore, water and lava filled all 1,500 within half an hour of a run (run 15: water 210, lava 67, the rest ore), and
 * the oldest of the crowded kind went first, which near the body was the pool it had just walked past.
 */
export const MAX_PLACES = 1500;
/**
 * Kinds that are never given up for room: the ones a long journey comes back to (portals, villages, structures, the
 * blaze spawner of a fortress). Only being found gone removes them.
 */
export const KEPT_KINDS: ReadonlySet<string> = new Set(['nether_portal', 'end_portal_frame', 'village', 'fortress', 'bastion', 'stronghold', 'spawner',
  'ruined_portal', 'igloo', 'shipwreck']);
/** The newest deaths' places are kept too (the items lie there for a while). */
export const KEPT_DEATHS = 5;
/** Deaths kept as records. */
export const MAX_DEATHS = 5;
/** In weighing what to give up: a minute unseen counts as much as this many blocks off; another dimension, as far as this. */
const BLOCKS_PER_MINUTE = 16, OTHER_DIMENSION = 1000;

const distance = (a: PlacePosition, b: PlacePosition) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * How near two sightings of a kind are to be one place. A lake is one place, not one per cell seen; a furnace
 * is exactly where it stands.
 */
export function mergeRadius(kind: string): number {
  if (kind === 'village' || kind === 'fortress' || kind === 'bastion' || kind === 'stronghold') return 96;
  // A ruined portal (its netherrack, crying obsidian and scattered frame), a cave's hollow, a shipwreck, an igloo: one place each.
  if (kind === 'ruined_portal' || kind === 'cave') return 24;
  if (kind === 'shipwreck' || kind === 'cave_entrance') return 16;
  if (kind === 'igloo') return 12;
  if (kind === 'obsidian') return 8;
  // One portal is one place: its cells (2×3 and up) and the twelve frames round an end portal.
  if (kind === 'nether_portal') return 4;
  if (kind === 'end_portal_frame') return 8;
  if (kind === 'water' || kind === 'lava') return 24;
  if (kind.endsWith('_ore') || kind === 'ancient_debris') return 8;
  if (kind === 'death') return 4;
  return 1.5;
}

export function compassDirection(from: { x: number; z: number }, to: { x: number; z: number }): string {
  const names = ['東', '南東', '南', '南西', '西', '北西', '北', '北東'];
  const angle = Math.atan2(to.z - from.z, to.x - from.x); // +x east, +z south
  return names[((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8];
}

/** The places of each kind, for merging many sightings at once (see indexPlaces); kept up to date by rememberPlace. */
export type PlaceIndex = Map<string, Place[]>;
export function indexPlaces(state: PlaceMemoryState): PlaceIndex {
  const index: PlaceIndex = new Map();
  for (const place of state.places) (index.get(place.kind) ?? index.set(place.kind, []).get(place.kind)!).push(place);
  return index;
}

function nearestOfKind(state: PlaceMemoryState, sighting: Sighting, radius: number, index?: PlaceIndex): Place | null {
  let best: Place | null = null;
  let bestDistance = Infinity;
  for (const place of index ? index.get(sighting.kind) ?? [] : state.places) {
    if (place.kind !== sighting.kind || place.dimension !== sighting.dimension) continue;
    const d = distance(place.position, sighting.position);
    if (d <= radius && d < bestDistance) { best = place; bestDistance = d; }
  }
  return best;
}

/**
 * Adds a sighting: a place already known within the kind's radius is seen again, anything else is new. `from` is where
 * the body is, when known: what is near it is the last to be given up for room.
 */
export function rememberPlace(state: PlaceMemoryState, sighting: Sighting, now: number, from?: { dimension: string; position: PlacePosition },
  options: { later?: boolean; index?: PlaceIndex } = {}): Place {
  const position = { x: Math.floor(sighting.position.x), y: Math.floor(sighting.position.y), z: Math.floor(sighting.position.z) };
  // With an index, a column's dozens of sightings are each matched against their own kind, not against all 1,500 places.
  const known = nearestOfKind(state, { ...sighting, position }, mergeRadius(sighting.kind), options.index);
  if (known) {
    known.lastSeenAt = now;
    if (sighting.count !== undefined) known.count = Math.max(known.count ?? 0, sighting.count);
    if (sighting.note) known.note = sighting.note;
    if (sighting.keep) known.keep = sighting.keep;
    return known;
  }
  const place: Place = { id: `${sighting.kind}@${sighting.dimension}:${position.x},${position.y},${position.z}`, kind: sighting.kind,
    dimension: sighting.dimension, position, ...(sighting.count !== undefined ? { count: sighting.count } : {}),
    ...(sighting.note ? { note: sighting.note } : {}), ...(sighting.keep ? { keep: sighting.keep } : {}), firstSeenAt: now, lastSeenAt: now };
  state.places.push(place);
  options.index && (options.index.get(place.kind) ?? options.index.set(place.kind, []).get(place.kind)!).push(place);
  // `later`: the caller makes room once for a whole column's sightings (see makeRoom), not once for each.
  if (!options.later && state.places.length > MAX_PLACES) makeRoom(state, now, from);
  return place;
}

/** Whether a place is kept whatever the room (see KEPT_KINDS, Place.keep). */
function keptPlaces(state: PlaceMemoryState): Set<Place> {
  const kept = new Set<Place>();
  const deaths: Place[] = [];
  for (const place of state.places) {
    if (place.keep || KEPT_KINDS.has(place.kind)) kept.add(place);
    else if (place.kind === 'death') deaths.push(place);
  }
  for (const death of deaths.sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, KEPT_DEATHS)) kept.add(death);
  return kept;
}

/**
 * Gives up places until the memory fits: of the kind with the most places, the one furthest off and longest unseen.
 * Once for a batch: the kept set, the free list and the count per kind are worked out once.
 */
export function makeRoom(state: PlaceMemoryState, now: number, from?: { dimension: string; position: PlacePosition }): void {
  let excess = state.places.length - MAX_PLACES;
  if (excess <= 0) return;
  const kept = keptPlaces(state);
  let free = state.places.filter(place => !kept.has(place));
  // Nothing left to give up but what is kept (it does not happen in play): those go too, longest unseen first.
  if (free.length < excess) free = state.places;
  const weightOf = (place: Place) => (now - place.lastSeenAt) / 60_000 * BLOCKS_PER_MINUTE
    + (!from ? 0 : place.dimension === from.dimension ? distance(place.position, from.position) : OTHER_DIMENSION);
  // Weighed once each (in the sort they were weighed again at every comparison: room is made after every column once full).
  const weights = new Map<Place, number>();
  for (const place of free) weights.set(place, weightOf(place));
  const byKind = new Map<string, Place[]>();
  for (const place of free) (byKind.get(place.kind) ?? byKind.set(place.kind, []).get(place.kind)!).push(place);
  // Each kind's places, worst last, so that the next to give up is popped.
  for (const list of byKind.values()) list.sort((a, b) => weights.get(a)! - weights.get(b)!);
  const gone = new Set<Place>();
  while (excess-- > 0) {
    let crowded: Place[] | null = null;
    for (const list of byKind.values()) if (!crowded || list.length > crowded.length) crowded = list;
    if (!crowded?.length) break;
    gone.add(crowded.pop()!);
  }
  state.places = state.places.filter(place => !gone.has(place));
}

/** Notes a death; the newest few are kept. */
export function recordDeath(state: PlaceMemoryState, death: DeathRecord): DeathRecord {
  const deaths = state.deaths ??= [];
  deaths.push(death);
  if (deaths.length > MAX_DEATHS) deaths.splice(0, deaths.length - MAX_DEATHS);
  return death;
}

/** Dropped items last this long while their chunk is loaded (6000 ticks). */
export const DROP_LIFETIME_MS = 5 * 60_000;

/**
 * The last death as one line for the observation (under 200 characters, the length a decision's summary keeps):
 * how long ago, where, of what, what was dropped and how long it may still lie there. Said for half an hour, or for
 * as long as the dropped items may still be there.
 */
export function describeLastDeath(state: PlaceMemoryState, now: number, here?: { dimension: string; position: PlacePosition }): string | undefined {
  const death = state.deaths?.at(-1);
  if (!death) return undefined;
  const left = Math.max(0, DROP_LIFETIME_MS - death.nearMs);
  // Far off, the items do not age; but a day on, the world has moved on.
  const waiting = death.lost.length > 0 && !death.cleared && left > 0 && now - death.at <= 24 * 60 * 60_000;
  if (now - death.at > 30 * 60_000 && !waiting) return undefined;
  const minutes = Math.max(0, Math.round((now - death.at) / 60_000));
  const where = `${death.dimension.replace(/^minecraft:/, '')} (${death.position.x},${death.position.y},${death.position.z})`
    + (here && here.dimension === death.dimension
      ? ` ${Math.round(distance(here.position, death.position))}m ${compassDirection(here.position, death.position)}` : '');
  const line = (shown: number, cause: number) => {
    const items = death.lost.slice(0, shown).map(item => `${item.name}×${item.count}`).join(', ')
      + (death.lost.length > shown ? `${shown ? ' ' : ''}ほか${death.lost.length - shown}種` : '');
    const what = death.lost.length === 0 ? '何も落としていない'
      : death.cleared ? `落とした物（${items}）は、戻った時にはもう無かった`
      : left === 0 || !waiting ? `落とした物（${items}）は消えた見込み`
      : `落とした物: ${items}。消えるまで最長約${Math.ceil(left / 60_000)}分（近くにいる間だけ減る）→拾いに戻れる`;
    return `${minutes}分前 ${where}${death.cause && cause ? `「${death.cause.slice(0, cause)}」` : ''} ${what}`;
  };
  // What to do comes last and must not be cut (a decision's summary keeps 200): fewer item names, then a shorter cause.
  for (const [shown, cause] of [[4, 50], [3, 40], [2, 30], [1, 24], [0, 24], [0, 0]]) {
    const text = line(shown, cause);
    if (text.length <= 200) return text;
  }
  return line(0, 0).slice(0, 200);
}

export interface ObservedDeath { at: string; position: PlacePosition; dimension: string; cause?: string; lostItems: string[] }
/** The JSON of the deaths in an observation stays under this (a decision's summary drops a part over 600 whole). */
export const DEATHS_CHARACTERS = 580;
/**
 * The recent deaths as records for the API's recall (newest last; the last day only), as many of the newest as fit:
 * `{ at, position, dimension, cause, lostItems: ['name×n', ...] }`. lastDeath says the newest one as a line, with
 * what to do about it.
 */
export function observedDeaths(state: PlaceMemoryState, now: number): ObservedDeath[] {
  const recent = (state.deaths ?? []).filter(death => now - death.at <= 24 * 60 * 60_000);
  const shaped = recent.map(death => ({ at: new Date(death.at).toISOString(), position: { ...death.position },
    dimension: death.dimension.replace(/^minecraft:/, ''), ...(death.cause ? { cause: death.cause.slice(0, 60) } : {}),
    lostItems: [...death.lost.slice(0, 4).map(item => `${item.name}×${item.count}`), ...(death.lost.length > 4 ? [`ほか${death.lost.length - 4}種`] : [])] }));
  while (shaped.length && JSON.stringify(shaped).length > DEATHS_CHARACTERS) shaped.shift();
  return shaped;
}

/** Removes the places for which `gone` holds (looked at again and no longer there). Returns how many. */
export function forgetPlaces(state: PlaceMemoryState, gone: (place: Place) => boolean): number {
  // Most calls forget nothing: the list is only built again when something goes.
  if (!state.places.some(gone)) return 0;
  const before = state.places.length;
  state.places = state.places.filter(place => !gone(place));
  return before - state.places.length;
}

export interface PlaceQuery {
  from: PlacePosition;
  dimension: string;
  /** A kind, or part of one (`ore` matches every ore). All kinds when omitted. */
  kind?: string;
  limit?: number;
}

/** Known places in this dimension, nearest first. */
export function recallPlaces(state: PlaceMemoryState, query: PlaceQuery): RecalledPlace[] {
  const wanted = query.kind?.trim().toLowerCase();
  return state.places
    .filter(place => place.dimension === query.dimension && (!wanted || place.kind === wanted || place.kind.includes(wanted)))
    .map(place => ({ ...place, position: { ...place.position }, distance: Math.round(distance(place.position, query.from)),
      direction: compassDirection(query.from, place.position) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(1, query.limit ?? 10));
}

/**
 * What the body has in mind without asking: the nearest known place of each kind, as one short line each
 * ("34m 北東 (12,63,-40) ×5"), nearest first. When there are more kinds than lines, the kinds it knows the
 * fewest places of are kept: the one furnace and the one village are worth a line before the two hundredth
 * vein of coal, which a search of what is loaded finds anyway. Everything else is there to be recalled.
 */
const SHORT_NOTE = 24;
/** A chest's contents are shown this far in a line. */
const CONTENTS_NOTE = 40;
/**
 * At most this many characters of JSON: a decision's summary drops a part longer than 600 whole (the API's
 * minecraftObservationSummary), and the remembered places went from every decision as soon as there were ten kinds.
 */
export const DIGEST_CHARACTERS = 560;
/** What a dragon task is always told of, ahead of the rest (the way there goes through each). */
export const DRAGON_PLACES: readonly string[] = ['respawn', 'base', 'nether_portal', 'stronghold', 'end_portal_frame', 'fortress', 'village'];

/** The note as a line shows it: a word, a portal's pair, the start of a chest's contents; a sentence stays for recall-places. */
function shownNote(note: string | undefined): string {
  if (!note) return '';
  if (note.startsWith('↔')) return ` ${note}`;
  if (note.startsWith('中身:')) return ` ${note.length > CONTENTS_NOTE ? `${note.slice(0, CONTENTS_NOTE)}…` : note}`;
  return note.length <= SHORT_NOTE ? ` ${note}` : '';
}

/**
 * What a remembered place is good for, said on its line: run 19 had "bed: 72m 東 (69,66,4) ×2" (an igloo's) in all 64 decisions,
 * went for it in none, and never had a bed; a village 171 m off was never gone to either (the owner, 2026-10-20).
 */
const PLACE_MEANING: Record<string, string> = {
  bed: ' 置かれたベッド: dig-block-at takeEquipment=true で掘れば持てる',
  village: ' 羊・ベッド・食べ物がある見込み',
  cave_entrance: ' 歩いて地下へ下りられる洞窟の入口',
};

/** How many were seen together. A bed is two blocks (foot and head), so its count is halved: "×2" was one bed. */
function countShown(place: { kind: string; count?: number }): string {
  const count = place.kind === 'bed' ? Math.ceil((place.count ?? 1) / 2) : place.count ?? 1;
  return count > 1 ? ` ×${count}` : '';
}

export function placesDigest(state: PlaceMemoryState, from: PlacePosition, dimension: string, limit = 10,
  options: { ensure?: readonly string[]; maxCharacters?: number } = {}): Record<string, string> {
  const nearest = new Map<string, RecalledPlace>();
  const known = new Map<string, number>();
  // The base and the respawn bed by what they are kept as, whatever their kind.
  const marked = new Map<string, RecalledPlace>();
  for (const place of recallPlaces(state, { from, dimension, limit: Number.MAX_SAFE_INTEGER })) {
    // A bed's line is the nearest one that is not the body's own (that one has its base / respawn line): the one to take.
    const shown = nearest.get(place.kind);
    if (!shown || (place.kind === 'bed' && shown.keep && !place.keep)) nearest.set(place.kind, place);
    known.set(place.kind, (known.get(place.kind) ?? 0) + 1);
    if ((place.keep === 'base' || place.keep === 'respawn') && !marked.has(place.keep)) marked.set(place.keep, place);
  }
  // First what the task needs (in its order), then the kinds known fewest of: the one furnace and the one village are worth
  // a line before the two hundredth vein of coal. A place says itself once.
  const ensured = (options.ensure ?? []).flatMap(kind => {
    const place = kind === 'base' || kind === 'respawn' ? marked.get(kind) : nearest.get(kind);
    return place ? [{ key: kind, place }] : [];
  });
  const rest = [...nearest.values()].filter(place => !ensured.some(entry => entry.key === place.kind || entry.place.id === place.id))
    .sort((a, b) => known.get(a.kind)! - known.get(b.kind)! || a.distance - b.distance).map(place => ({ key: place.kind, place }));
  const line = (key: string, place: RecalledPlace) => `${place.distance}m ${place.direction} (${place.position.x},${place.position.y},${place.position.z})`
    + (key === 'base' || key === 'respawn' ? ` ${place.kind}` : '') + countShown(place) + shownNote(place.note)
    // Not for the body's own base or respawn bed: that one is already its own. Said in the dragon's digest too (run 19 was one, and
    // a bed is on its way); the kinds that task ensures are chosen first, so the longer lines take room only from the rest.
    + (key === place.kind && !place.keep ? PLACE_MEANING[place.kind] ?? '' : '');
  const chosen: Array<{ key: string; place: RecalledPlace }> = [];
  let used = 2;
  for (const entry of [...ensured, ...rest]) {
    if (chosen.length >= limit) break;
    const cost = JSON.stringify(entry.key).length + JSON.stringify(line(entry.key, entry.place)).length + 2;
    if (used + cost > (options.maxCharacters ?? DIGEST_CHARACTERS)) continue;
    chosen.push(entry); used += cost;
  }
  const digest: Record<string, string> = {};
  for (const entry of chosen.sort((a, b) => a.place.distance - b.place.distance)) digest[entry.key] = line(entry.key, entry.place);
  return digest;
}

/** The map's names for the kinds, in the order its lines give them. */
const ORE_NAMES: Array<[string, string]> = [['diamond_ore', 'ダイヤ'], ['iron_ore', '鉄'], ['coal_ore', '石炭'], ['gold_ore', '金'],
  ['redstone_ore', 'レッドストーン'], ['lapis_ore', 'ラピス'], ['copper_ore', '銅'], ['emerald_ore', 'エメラルド'],
  ['nether_gold_ore', 'ネザー金'], ['nether_quartz_ore', 'クォーツ'], ['ancient_debris', '古代の残骸']];
const STRUCTURE_NAMES: Array<[string, string]> = [['village', '村'], ['ruined_portal', '荒廃したポータル'], ['igloo', 'イグルー'],
  ['shipwreck', '難破船'], ['fortress', 'ネザー要塞'], ['bastion', '砦の遺跡'], ['stronghold', '要塞'], ['spawner', 'スポナー'],
  ['nether_portal', 'ネザーポータル'], ['end_portal_frame', 'エンドポータル']];
/** Of the map's lines, at most this many characters (the head gives its route planner 3,000). */
export const MAP_CHARACTERS = 3000;
/** A cave of this many open cells or more is "a large hollow". */
const LARGE_CAVE = 2000;
/**
 * What a depth is good for, said with a cave or the bottom of an entrance: diamonds lie mostly below y -45 (the most at -58), iron
 * mostly between -24 and 56 (the most at 16).
 */
function depthWord(y: number): string {
  if (y <= -45) return 'ダイヤの深さ';
  if (y <= -24) return 'ダイヤに近い深さ';
  if (y <= 40) return '鉄の多い深さ';
  return '';
}

/**
 * The map in the body's memory, as lines for a planner that lays out a whole route: each kind of place by how many are known and
 * the nearest few (distance, direction, coordinates), and what the structures hold that the way to the Nether wants: a ruined
 * portal's obsidian and its chest (flint and steel, obsidian), a village smith's chest (iron, obsidian). Within `maxCharacters`, the
 * last lines (the farthest from what the route needs) are the ones cut.
 */
export function mapSummary(state: PlaceMemoryState, from: PlacePosition, dimension: string, options: { maxCharacters?: number } = {}): string {
  const all = recallPlaces(state, { from, dimension, limit: Number.MAX_SAFE_INTEGER });
  const of = (kind: string) => all.filter(place => place.kind === kind);
  const at = (place: RecalledPlace) => `${place.distance}m ${place.direction} (${place.position.x},${place.position.y},${place.position.z})`;
  const near = (place: RecalledPlace, kind: string, radius: number) => all.filter(other => other.kind === kind
    && Math.hypot(other.position.x - place.position.x, other.position.y - place.position.y, other.position.z - place.position.z) <= radius);
  const chestNote = (chest: RecalledPlace) => chest.note?.startsWith('中身:') ? ` ${chest.note.slice(0, CONTENTS_NOTE)}` : '';
  const listed = (places: RecalledPlace[], describe: (place: RecalledPlace) => string, shown = 3) =>
    places.slice(0, shown).map(describe).join('、') + (places.length > shown ? ` ほか${places.length - shown}` : '');
  const lines: string[] = [];

  // An igloo's basement has a bed, a brewing stand and a villager: what the landmark watcher takes for a village. A village without
  // a bell that close to an igloo is the igloo (lab world 20261020: "村: 6m" stood on the igloo's floor).
  const igloos = of('igloo');
  const isIgloo = (village: RecalledPlace) => !/bell/.test(village.note ?? '')
    && igloos.some(igloo => Math.hypot(igloo.position.x - village.position.x, igloo.position.z - village.position.z) <= 24);
  const structures = STRUCTURE_NAMES.flatMap(([kind, name]) => {
    const places = kind === 'village' ? of(kind).filter(village => !isIgloo(village)) : of(kind);
    if (!places.length) return [];
    return [`${name}: ${listed(places, place => {
      let extra = '';
      if (kind === 'village') {
        // A smith's chest: one beside a grindstone (weaponsmith), a smithing table (toolsmith) or a blast furnace (armorer) in the village.
        const smith = [...near(place, 'grindstone', 96), ...near(place, 'smithing_table', 96), ...near(place, 'blast_furnace', 96)]
          .flatMap(station => near(station, 'chest', 8)).filter((chest, index, list) => list.findIndex(other => other.id === chest.id) === index);
        if (smith.length) extra = `（鍛冶屋の箱 ${smith.slice(0, 2).map(chest => `(${chest.position.x},${chest.position.y},${chest.position.z})${chestNote(chest)}`).join('・')}: 鉄・黒曜石が入ることがある）`;
      } else if (kind === 'ruined_portal') {
        const obsidian = near(place, 'obsidian', 20).reduce((sum, block) => sum + (block.count ?? 1), 0);
        const chests = near(place, 'chest', 20);
        extra = `（黒曜石${obsidian ? `${obsidian}個` : 'あり'}${chests.length ? `・箱 (${chests[0].position.x},${chests[0].position.y},${chests[0].position.z})${chestNote(chests[0])}: 火打石と打ち金・黒曜石が入ることがある` : ''}）`;
      } else if (kind === 'shipwreck' || kind === 'igloo') {
        // A ship's chests (supply, map, treasure: only one is beside the water it is known by); an igloo's is in the basement, down
        // a ladder under the floor (30 blocks down in lab world 20261020).
        const chests = kind === 'shipwreck' ? near(place, 'chest', 16)
          : all.filter(other => other.kind === 'chest' && Math.hypot(other.position.x - place.position.x, other.position.z - place.position.z) <= 8
            && other.position.y <= place.position.y && other.position.y >= place.position.y - 40);
        if (chests.length) extra = `（箱 ${chests.slice(0, 3).map(chest => `(${chest.position.x},${chest.position.y},${chest.position.z})${chestNote(chest)}`).join('・')}${kind === 'igloo' ? ': 地下室（床の下の梯子）' : ''}）`;
      } else if (place.note) extra = shownNote(place.note);
      return `${at(place)}${extra}`;
    }, kind === 'village' || kind === 'ruined_portal' ? 2 : 1)}`];
  });
  if (structures.length) lines.push(`構造物: ${structures.join('／')}`);

  const ores = ORE_NAMES.flatMap(([kind, name]) => {
    const places = of(kind);
    return places.length ? [`${name} ${places.length}か所（${listed(places, place => `${at(place)}${countShown(place)}`, kind === 'diamond_ore' || kind === 'iron_ore' ? 3 : 2)}）`] : [];
  });
  if (ores.length) lines.push(`鉱石: ${ores.join('／')}`);

  const lava = of('lava');
  if (lava.length) lines.push(`溶岩の溜まり ${lava.length}か所: ${listed(lava, place => `${at(place)} ${place.position.y >= 50 ? '地表' : '地下'}${countShown(place)}`)}`
    + '（水バケツで黒曜石にできる: use-item-on-block water_bucket count=10）');
  // The ways down that are walked: an entrance's mouth (where to stand) and the bottom its hollow was followed to.
  const entrances = of('cave_entrance');
  if (entrances.length) {
    lines.push(`洞窟の入口 ${entrances.length}か所（地表から歩いて地下へ下りられる。鉄・ダイヤへの近道）: ${listed(entrances, place => {
      const bottom = Number(place.note?.match(/\(-?\d+,(-?\d+),-?\d+\)/)?.[1]);
      const word = Number.isFinite(bottom) ? depthWord(bottom) : '';
      return `${at(place)}${place.note ? ` → ${place.note}` : ''}${word ? ` ${word}` : ''}`;
    })}`);
  }
  // The hollows under ground: the nearest large ones, and the nearest at the diamonds' depth.
  const caves = of('cave');
  if (caves.length) {
    const large = caves.filter(cave => (cave.count ?? 0) >= LARGE_CAVE);
    const shown = (large.length ? large : caves).slice(0, 2);
    const deep = caves.find(cave => cave.position.y <= -45 && !shown.includes(cave));
    if (deep) shown.push(deep);
    const words = (cave: RecalledPlace) => [(cave.count ?? 0) >= LARGE_CAVE ? '大きな空洞' : '', depthWord(cave.position.y)].filter(Boolean);
    lines.push(`洞窟 ${caves.length}か所（うち大きな空洞${large.length}）: ${shown.map(cave => `${at(cave)} 約${cave.count ?? 0}マス${words(cave).length ? `（${words(cave).join('・')}）` : ''}`).join('、')}`
      + (caves.length > shown.length ? ` ほか${caves.length - shown.length}` : ''));
  }
  const obsidian = of('obsidian');
  if (obsidian.length) lines.push(`黒曜石 ${obsidian.length}か所: ${listed(obsidian, place => `${at(place)}${countShown(place)}`)}`);
  const water = of('water');
  if (water.length) lines.push(`水源 ${water.length}か所: ${listed(water, at, 2)}`);

  const kept = all.filter(place => place.keep === 'base' || place.keep === 'respawn');
  const beds = of('bed').filter(place => !place.keep);
  const chests = of('chest').filter(chest => chest.note?.startsWith('中身:'));
  const own = [
    ...kept.map(place => `${place.keep === 'respawn' ? 'リスポーン' : `拠点の${place.kind}`} ${at(place)}`),
    ...(beds.length ? [`置かれたベッド ${listed(beds, at, 2)}（dig-block-at takeEquipment=true で持てる）`] : []),
    ...(chests.length ? [`中身を見た箱 ${listed(chests, chest => `${at(chest)}${chestNote(chest)}`, 2)}`] : []),
  ];
  if (own.length) lines.push(`拠点と設備: ${own.join('／')}`);

  const biomes = describeBiomes(biomesAround(state, from, dimension, 10));
  if (biomes) lines.push(`バイオーム: ${biomes}`);
  lines.push(`見た範囲: ${describeSeenReach(seenReach(state, from, dimension))}`);

  const limit = options.maxCharacters ?? MAP_CHARACTERS;
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (limit - used < 40) break;
    const piece = line.length > limit - used - 1 ? `${line.slice(0, limit - used - 2)}…` : line;
    out.push(piece); used += piece.length + 1;
  }
  return out.join('\n');
}

/** Columns kept as seen per dimension; the oldest go first (a body does not go back over all of a long journey). */
export const MAX_SEEN_COLUMNS = 20_000;
const seenIndex = new WeakMap<PlaceMemoryState, Map<string, Set<string>>>();
function seenSet(state: PlaceMemoryState, dimension: string): Set<string> {
  let byDimension = seenIndex.get(state);
  if (!byDimension) { byDimension = new Map(); seenIndex.set(state, byDimension); }
  let set = byDimension.get(dimension);
  if (!set) { set = new Set(state.seen?.[dimension] ?? []); byDimension.set(dimension, set); }
  return set;
}

/** Notes that a chunk column has been in view. Returns whether it was new. */
export function markSeen(state: PlaceMemoryState, dimension: string, chunkX: number, chunkZ: number): boolean {
  const set = seenSet(state, dimension);
  const key = `${chunkX},${chunkZ}`;
  if (set.has(key)) return false;
  set.add(key);
  const list = (state.seen ??= {})[dimension] ??= [];
  list.push(key);
  if (list.length > MAX_SEEN_COLUMNS) { const dropped = list.splice(0, list.length - MAX_SEEN_COLUMNS); for (const old of dropped) set.delete(old); }
  return true;
}

const COMPASS: Array<[string, number, number]> = [['北', 0, -1], ['北東', 1, -1], ['東', 1, 0], ['南東', 1, 1], ['南', 0, 1], ['南西', -1, 1], ['西', -1, 0], ['北西', -1, -1]];

/**
 * How far the ground the body has seen reaches in each of the eight directions from where it stands, in
 * blocks: the distance to the first column along that line it has never had in view. `null` where everything
 * out to `maxBlocks` has been seen. The direction with the smallest number is where new ground is nearest.
 */
export function seenReach(state: PlaceMemoryState, from: PlacePosition, dimension: string, maxBlocks = 384): Record<string, number | null> {
  const set = seenSet(state, dimension);
  const reach: Record<string, number | null> = {};
  for (const [name, dx, dz] of COMPASS) {
    const unit = Math.hypot(dx, dz);
    let found: number | null = null;
    for (let step = 16; step <= maxBlocks; step += 16) {
      const x = from.x + (dx / unit) * step, z = from.z + (dz / unit) * step;
      if (!set.has(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)) { found = step; break; }
    }
    reach[name] = found;
  }
  return reach;
}

/** The same, as one line for a result text: nearest new ground first. */
export function describeSeenReach(reach: Record<string, number | null>, maxBlocks = 384): string {
  return Object.entries(reach).sort((a, b) => (a[1] ?? Infinity) - (b[1] ?? Infinity))
    .map(([direction, blocks]) => blocks === null ? `${direction}は${maxBlocks}m先まで見た` : `${direction}は${blocks}m先から未見`).join('、');
}

/** A state read from disk, or an empty one when it is not what this version wrote. */
export function parsePlaceMemory(value: unknown): PlaceMemoryState {
  const input = value as Partial<PlaceMemoryState> | null;
  if (!input || input.version !== 1 || !Array.isArray(input.places)) return emptyPlaceMemory();
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  const places = input.places.filter((place): place is Place => !!place && typeof place.kind === 'string' && typeof place.dimension === 'string'
    && !!place.position && finite(place.position.x) && finite(place.position.y) && finite(place.position.z)
    && finite(place.firstSeenAt) && finite(place.lastSeenAt) && typeof place.id === 'string');
  for (const place of places) if (place.keep !== undefined && !['base', 'respawn', 'portal'].includes(place.keep)) delete place.keep;
  const seen: Record<string, string[]> = {};
  if (input.seen && typeof input.seen === 'object') {
    for (const [dimension, columns] of Object.entries(input.seen)) {
      if (Array.isArray(columns)) seen[dimension] = columns.filter(column => typeof column === 'string' && /^-?\d+,-?\d+$/.test(column)).slice(-MAX_SEEN_COLUMNS);
    }
  }
  const point = (p: any) => !!p && finite(p.x) && finite(p.y) && finite(p.z);
  const deaths = (Array.isArray(input.deaths) ? input.deaths : []).filter((death): death is DeathRecord => !!death && finite(death.at)
    && typeof death.dimension === 'string' && point(death.position) && finite(death.nearMs) && Array.isArray(death.lost)
    && death.lost.every(item => !!item && typeof item.name === 'string' && finite(item.count))).slice(-MAX_DEATHS);
  const biomes: Record<string, Record<string, string>> = {};
  if (input.biomes && typeof input.biomes === 'object') {
    for (const [dimension, columns] of Object.entries(input.biomes)) {
      if (!columns || typeof columns !== 'object') continue;
      const kept = Object.entries(columns).filter(([column, biome]) => /^-?\d+,-?\d+$/.test(column) && typeof biome === 'string' && /^[a-z_]+$/.test(biome));
      if (kept.length) biomes[dimension] = Object.fromEntries(kept.slice(-MAX_BIOME_COLUMNS));
    }
  }
  return { version: 1, places: places.slice(-MAX_PLACES), ...(deaths.length ? { deaths } : {}), ...(Object.keys(seen).length ? { seen } : {}),
    ...(Object.keys(biomes).length ? { biomes } : {}) };
}

/** Chunk columns kept with their biome per dimension; the oldest noted go first. */
export const MAX_BIOME_COLUMNS = 6000;

const biomeCounts = new WeakMap<object, number>();
/** Notes the biome of a chunk column (read at its middle). Returns whether anything changed. */
export function noteBiome(state: PlaceMemoryState, dimension: string, chunkX: number, chunkZ: number, biome: string): boolean {
  const columns = (state.biomes ??= {})[dimension] ??= {};
  const key = `${chunkX},${chunkZ}`;
  if (columns[key] === biome) return false;
  const known = key in columns;
  delete columns[key]; // noted again: it goes to the end, the last to be given up
  columns[key] = biome;
  // How many are kept, counted once and then kept count of (listing 6,000 keys for each column read was most of noting one).
  let count = biomeCounts.get(columns);
  count = count === undefined ? Object.keys(columns).length : count + (known ? 0 : 1);
  if (count > MAX_BIOME_COLUMNS) {
    for (const old of Object.keys(columns).slice(0, count - MAX_BIOME_COLUMNS)) delete columns[old];
    count = MAX_BIOME_COLUMNS;
  }
  biomeCounts.set(columns, count);
  return true;
}

export interface BiomeArea { biome: string; distance: number; direction: string; here: boolean }
/**
 * The biomes seen in this dimension, each by its nearest column: how far and which way from `from`, nearest first, the one under the
 * body first of all. Run 19 went badlands, snowy plains, frozen ocean, and only the one it stood in was ever in an observation: a
 * search for sheep went south through snow for 130 m with the grass it had walked through nowhere in mind.
 */
export function biomesAround(state: PlaceMemoryState, from: PlacePosition, dimension: string, limit = 6): BiomeArea[] {
  const columns = state.biomes?.[dimension];
  if (!columns) return [];
  const hereKey = `${Math.floor(from.x / 16)},${Math.floor(from.z / 16)}`;
  const best = new Map<string, { distance: number; x: number; z: number; here: boolean }>();
  for (const [key, biome] of Object.entries(columns)) {
    const [chunkX, chunkZ] = key.split(',').map(Number);
    const x = chunkX * 16 + 8, z = chunkZ * 16 + 8;
    const here = key === hereKey;
    const d = here ? 0 : Math.hypot(x - from.x, z - from.z);
    const known = best.get(biome);
    if (!known || d < known.distance) best.set(biome, { distance: d, x, z, here });
  }
  return [...best.entries()].map(([biome, area]) => ({ biome, distance: Math.round(area.distance), here: area.here,
    direction: area.here ? '' : compassDirection(from, { x: area.x, z: area.z }) }))
    .sort((a, b) => Number(b.here) - Number(a.here) || a.distance - b.distance).slice(0, limit);
}

/** The same as one line: "snowy_plains（ここ）・frozen_ocean 南 60m・badlands 西 130m". */
export function describeBiomes(areas: BiomeArea[]): string {
  return areas.map(area => area.here ? `${area.biome}（ここ）` : `${area.biome} ${area.direction} ${area.distance}m`).join('・');
}
