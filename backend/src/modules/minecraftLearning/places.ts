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
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface PlaceMemoryState {
  version: 1;
  places: Place[];
  /**
   * The ground the body has had in view, per dimension, as chunk columns ("cx,cz"). Not what is in them: only
   * that they were seen, so that "which way have I not been" has an answer.
   */
  seen?: Record<string, string[]>;
}
export interface Sighting { kind: string; dimension: string; position: PlacePosition; count?: number; note?: string }
export interface RecalledPlace extends Place { distance: number; direction: string }

export const emptyPlaceMemory = (): PlaceMemoryState => ({ version: 1, places: [] });

/** Places kept at most; beyond it the kind with the most places loses the one seen longest ago. */
export const MAX_PLACES = 1500;

const distance = (a: PlacePosition, b: PlacePosition) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * How near two sightings of a kind are to be one place. A lake is one place, not one per cell seen; a furnace
 * is exactly where it stands.
 */
export function mergeRadius(kind: string): number {
  if (kind === 'village' || kind === 'fortress') return 96;
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

/** Adds a sighting: a place already known within the kind's radius is seen again, anything else is new. */
export function rememberPlace(state: PlaceMemoryState, sighting: Sighting, now: number): Place {
  const position = { x: Math.floor(sighting.position.x), y: Math.floor(sighting.position.y), z: Math.floor(sighting.position.z) };
  const known = nearestOfKind(state, { ...sighting, position }, mergeRadius(sighting.kind));
  if (known) {
    known.lastSeenAt = now;
    if (sighting.count !== undefined) known.count = Math.max(known.count ?? 0, sighting.count);
    if (sighting.note) known.note = sighting.note;
    return known;
  }
  const place: Place = { id: `${sighting.kind}@${sighting.dimension}:${position.x},${position.y},${position.z}`, kind: sighting.kind,
    dimension: sighting.dimension, position, ...(sighting.count !== undefined ? { count: sighting.count } : {}),
    ...(sighting.note ? { note: sighting.note } : {}), firstSeenAt: now, lastSeenAt: now };
  state.places.push(place);
  while (state.places.length > MAX_PLACES) {
    const perKind = new Map<string, number>();
    for (const entry of state.places) perKind.set(entry.kind, (perKind.get(entry.kind) ?? 0) + 1);
    const crowded = [...perKind.entries()].sort((a, b) => b[1] - a[1])[0][0];
    let oldest = -1;
    for (let index = 0; index < state.places.length; index++) {
      if (state.places[index].kind === crowded && (oldest < 0 || state.places[index].lastSeenAt < state.places[oldest].lastSeenAt)) oldest = index;
    }
    state.places.splice(oldest, 1);
  }
  return place;
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
export function placesDigest(state: PlaceMemoryState, from: PlacePosition, dimension: string, limit = 10): Record<string, string> {
  const nearest = new Map<string, RecalledPlace>();
  const known = new Map<string, number>();
  for (const place of recallPlaces(state, { from, dimension, limit: Number.MAX_SAFE_INTEGER })) {
    if (!nearest.has(place.kind)) nearest.set(place.kind, place);
    known.set(place.kind, (known.get(place.kind) ?? 0) + 1);
  }
  const kept = [...nearest.values()].sort((a, b) => known.get(a.kind)! - known.get(b.kind)! || a.distance - b.distance).slice(0, limit);
  const digest: Record<string, string> = {};
  for (const place of kept.sort((a, b) => a.distance - b.distance)) {
    digest[place.kind] = `${place.distance}m ${place.direction} (${place.position.x},${place.position.y},${place.position.z})`
      + (place.count && place.count > 1 ? ` ×${place.count}` : '')
      // A word about the place, when it is one (what a spawner makes); a sentence stays for recall-places.
      + (place.note && place.note.length <= SHORT_NOTE ? ` ${place.note}` : '');
  }
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
  const seen: Record<string, string[]> = {};
  if (input.seen && typeof input.seen === 'object') {
    for (const [dimension, columns] of Object.entries(input.seen)) {
      if (Array.isArray(columns)) seen[dimension] = columns.filter(column => typeof column === 'string' && /^-?\d+,-?\d+$/.test(column)).slice(-MAX_SEEN_COLUMNS);
    }
  }
  return { version: 1, places: places.slice(-MAX_PLACES), ...(Object.keys(seen).length ? { seen } : {}) };
}
