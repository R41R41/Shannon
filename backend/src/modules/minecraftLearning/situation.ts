/**
 * World-independent description of the bot's situation. Learned knowledge is
 * keyed by these features, never by coordinates or world identity, so what is
 * learned in one isolated world applies in the next.
 */
export type TimeBand = 'day' | 'dusk' | 'night' | 'dawn' | 'unknown';
export type DepthBand = 'deep' | 'cave' | 'low' | 'surface' | 'high' | 'unknown';

export interface SituationFeatures {
  dimension: string | null;
  timeBand: TimeBand;
  depthBand: DepthBand;
  health: number | null;
  food: number | null;
  oxygen: number | null;
  /** Hidden hunger reserve, and how the body has moved since it connected (cumulative). */
  saturation?: number | null;
  exertion?: { walkedMetres: number; sprintedMetres: number; swumMetres: number; jumps: number };
  movementPace?: 'walk' | 'sprint';
  inWater: boolean;
  /** Nearest hostiles first, by registry kind, with rounded distance. */
  /** `contact`: seconds until within reach at the observed approach rate, when it is closing. */
  threats: Array<{ name: string; distance: number; contact?: number }>;
  /** Non-hostile living things nearby (animals, villagers), nearest first. */
  others: string[];
  /** Kinds of notable places in view (e.g. village). */
  landmarks?: string[];
  heldItem: string | null;
  inventory: Record<string, number>;
  emergency: boolean;
}

/** Structural subset of WorldObservation so this module stays SDK-free. */
export interface ObservationLike {
  dimension: string | null;
  position: { x: number; y: number; z: number } | null;
  health: number | null;
  food: number | null;
  oxygen: number | null;
  saturation?: number | null;
  exertion?: { walkedMetres: number; sprintedMetres: number; swumMetres: number; jumps: number };
  movementPace?: 'walk' | 'sprint';
  isInWater: boolean;
  time: string | null;
  heldItem: string | null;
  inventory: Array<{ name: string; count: number }>;
  nearbyEntities: Array<{ name: string; kind: string; distance: number; secondsToContact?: number; canReachMe?: false }>;
  nearbyThreats?: Array<{ name: string; kind: string; distance: number; secondsToContact?: number; canReachMe?: false }>;
  landmarks?: Array<{ kind: string; distance: number }>;
}

function timeBand(time: string | null): TimeBand {
  const ticks = time === null ? NaN : Number(time);
  if (!Number.isFinite(ticks)) return 'unknown';
  const t = ((ticks % 24000) + 24000) % 24000;
  if (t < 12000) return 'day';
  if (t < 13000) return 'dusk';
  if (t < 23000) return 'night';
  return 'dawn';
}

function depthBand(dimension: string | null, y: number | null): DepthBand {
  if (y === null) return 'unknown';
  if (dimension && !dimension.includes('overworld')) return y < 40 ? 'low' : y < 100 ? 'surface' : 'high';
  if (y < 0) return 'deep';
  if (y < 40) return 'cave';
  if (y < 60) return 'low';
  if (y < 100) return 'surface';
  return 'high';
}

export function describeSituation(observation: ObservationLike, emergency = false): SituationFeatures {
  const threats = (observation.nearbyThreats ?? observation.nearbyEntities.filter(entity => entity.kind === 'hostile'))
    // A hostile sealed off behind solid blocks is not part of the situation the body has to answer.
    .filter(entity => entity.distance <= 24 && entity.canReachMe !== false)
    .slice(0, 5)
    .map(entity => ({ name: entity.name, distance: Math.round(entity.distance),
      ...(typeof entity.secondsToContact === 'number' ? { contact: Math.round(entity.secondsToContact) } : {}) }));
  const others = observation.nearbyEntities
    .filter(entity => entity.kind !== 'hostile' && entity.kind !== 'other' && entity.kind !== 'player' && entity.distance <= 24)
    .slice(0, 5).map(entity => entity.name);
  const inventory: Record<string, number> = {};
  for (const stack of observation.inventory) inventory[stack.name] = (inventory[stack.name] ?? 0) + stack.count;
  return {
    dimension: observation.dimension,
    // The clock runs everywhere, but day and night are the overworld's: in the Nether and the End nothing
    // comes with the dark or goes with the morning, and "wait for dawn" there is waiting for nothing.
    timeBand: observation.dimension && !observation.dimension.includes('overworld') ? 'unknown' : timeBand(observation.time),
    depthBand: depthBand(observation.dimension, observation.position?.y ?? null),
    health: observation.health,
    food: observation.food,
    oxygen: observation.oxygen,
    ...(observation.saturation !== undefined ? { saturation: observation.saturation } : {}),
    ...(observation.exertion ? { exertion: observation.exertion, movementPace: observation.movementPace } : {}),
    inWater: observation.isInWater,
    threats,
    others,
    ...(observation.landmarks?.length ? { landmarks: [...new Set(observation.landmarks.map(landmark => landmark.kind))] } : {}),
    heldItem: observation.heldItem,
    inventory,
    emergency,
  };
}

/** Compact one-line rendering for experience logs and reflection prompts. */
export function situationSummary(features: SituationFeatures): string {
  const items = Object.entries(features.inventory).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([name, count]) => `${name}x${count}`).join(',');
  return [
    `dim=${features.dimension ?? '?'}`, `time=${features.timeBand}`, `depth=${features.depthBand}`,
    `hp=${features.health ?? '?'}`, `food=${features.food ?? '?'}`, `air=${features.oxygen ?? '?'}`,
    features.inWater ? 'inWater' : '',
    features.threats.length ? `threats=${features.threats.map(t => `${t.name}@${t.distance}m${t.contact !== undefined ? `(到達まで約${t.contact}秒)` : ''}`).join(',')}` : 'threats=none',
    features.others.length ? `others=${features.others.join(',')}` : '',
    features.landmarks?.length ? `landmarks=${features.landmarks.join(',')}` : '',
    `held=${features.heldItem ?? 'none'}`, `inv=[${items}]`,
    features.emergency ? 'EMERGENCY' : '',
  ].filter(Boolean).join(' ');
}
