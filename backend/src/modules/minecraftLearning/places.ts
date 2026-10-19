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
export const KEPT_KINDS: ReadonlySet<string> = new Set(['nether_portal', 'end_portal_frame', 'village', 'fortress', 'bastion', 'stronghold', 'spawner']);
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

function nearestOfKind(state: PlaceMemoryState, sighting: Sighting, radius: number): Place | null {
  let best: Place | null = null;
  let bestDistance = Infinity;
  for (const place of state.places) {
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
  options: { later?: boolean } = {}): Place {
  const position = { x: Math.floor(sighting.position.x), y: Math.floor(sighting.position.y), z: Math.floor(sighting.position.z) };
  const known = nearestOfKind(state, { ...sighting, position }, mergeRadius(sighting.kind));
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
  const weight = (place: Place) => (now - place.lastSeenAt) / 60_000 * BLOCKS_PER_MINUTE
    + (!from ? 0 : place.dimension === from.dimension ? distance(place.position, from.position) : OTHER_DIMENSION);
  const byKind = new Map<string, Place[]>();
  for (const place of free) (byKind.get(place.kind) ?? byKind.set(place.kind, []).get(place.kind)!).push(place);
  // Each kind's places, worst last, so that the next to give up is popped.
  for (const list of byKind.values()) list.sort((a, b) => weight(a) - weight(b));
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

export function placesDigest(state: PlaceMemoryState, from: PlacePosition, dimension: string, limit = 10,
  options: { ensure?: readonly string[]; maxCharacters?: number } = {}): Record<string, string> {
  const nearest = new Map<string, RecalledPlace>();
  const known = new Map<string, number>();
  // The base and the respawn bed by what they are kept as, whatever their kind.
  const marked = new Map<string, RecalledPlace>();
  for (const place of recallPlaces(state, { from, dimension, limit: Number.MAX_SAFE_INTEGER })) {
    if (!nearest.has(place.kind)) nearest.set(place.kind, place);
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
    + (key === 'base' || key === 'respawn' ? ` ${place.kind}` : '') + (place.count && place.count > 1 ? ` ×${place.count}` : '') + shownNote(place.note);
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
  return { version: 1, places: places.slice(-MAX_PLACES), ...(deaths.length ? { deaths } : {}), ...(Object.keys(seen).length ? { seen } : {}) };
}
