import { Vec3 } from 'vec3';

/**
 * Whether a hostile can get at the body: `seen` (nothing solid between its
 * eyes and the body), `reachable` (an open way through the air between them,
 * or too much open space to tell) or `sealed` (rock all the way round: no
 * line of sight and no opening that connects them).
 *
 * Distance alone made every mob within 16 blocks a threat, through any amount
 * of rock. Underground that is most of them: in paid run L33 a skeleton in
 * another cave 13 blocks away raised emergencies and "flee" orders that could
 * not be carried out (no route, 0 m moved, six times), and the work stopped.
 * A person mining hears such a mob and carries on.
 */
export type Exposure = 'seen' | 'reachable' | 'sealed';

interface ExposureBot {
  entity?: { position: Vec3; height?: number };
  blockAt?(position: Vec3, extraInfos?: boolean): { boundingBox?: string } | null;
}
interface ExposedEntity { position?: Vec3; height?: number }

const CACHE_MS = 1000;
const RAY_STEP = 0.25;
/** Cells explored before the space counts as open: a sealed pocket is far smaller, open ground or a cave system larger. */
const MAX_CELLS = 3000;
const MARGIN = 6;
const cache = new WeakMap<object, { at: number; value: Exposure }>();
const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

function solid(bot: ExposureBot, x: number, y: number, z: number): boolean {
  const block = bot.blockAt!(new Vec3(x, y, z), false);
  // Not loaded counts as closed: nothing is known to come through it.
  return !block || block.boundingBox === 'block';
}

function clearLine(bot: ExposureBot, from: Vec3, to: Vec3): boolean {
  const span = from.distanceTo(to);
  const steps = Math.max(1, Math.ceil(span / RAY_STEP));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (solid(bot, Math.floor(from.x + (to.x - from.x) * t), Math.floor(from.y + (to.y - from.y) * t), Math.floor(from.z + (to.z - from.z) * t))) return false;
  }
  return true;
}

/**
 * Whether there is a way through the air between the body and the mob that the mob could take: a cell counts
 * only where the mob would fit, in a run of free cells as tall as it is. A gap one cell high is no way in for a
 * mob two cells tall. Counted as any free cell, a blaze shut in a corridor was "able to reach" a body it could
 * not get at through a gap under a slab, and a dig that widened nothing it could use was refused for it (lab).
 */
function openWay(bot: ExposureBot, self: Vec3, other: Vec3, otherHeight: number): Exposure {
  const origin = self.floored();
  const radius = Math.ceil(self.distanceTo(other)) + MARGIN;
  const target = other.floored();
  const top = target.y + Math.max(0, Math.ceil(otherHeight) - 1);
  const need = Math.max(1, Math.ceil(otherHeight - 0.01));
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  // Each cell is read once: the test for room reads the ones above and below as well.
  const read = new Map<string, boolean>();
  const closed = (x: number, y: number, z: number) => {
    const id = key(x, y, z);
    let value = read.get(id);
    if (value === undefined) { value = solid(bot, x, y, z); read.set(id, value); }
    return value;
  };
  const roomFor = (x: number, y: number, z: number) => {
    let run = 1;
    for (let up = 1; run < need && up < need && !closed(x, y + up, z); up++) run++;
    for (let down = 1; run < need && down < need && !closed(x, y - down, z); down++) run++;
    return run >= need;
  };
  const queue: number[][] = [];
  const seen = new Set<string>();
  for (const dy of [0, 1]) if (!closed(origin.x, origin.y + dy, origin.z)) { queue.push([origin.x, origin.y + dy, origin.z]); seen.add(key(origin.x, origin.y + dy, origin.z)); }
  for (let head = 0; head < queue.length; head++) {
    if (seen.size > MAX_CELLS) return 'reachable';
    const [x, y, z] = queue[head];
    if (Math.abs(x - target.x) <= 1 && Math.abs(z - target.z) <= 1 && y >= target.y - 1 && y <= top + 1) return 'reachable';
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (Math.abs(nx - origin.x) > radius || Math.abs(ny - origin.y) > radius || Math.abs(nz - origin.z) > radius) continue;
      const id = key(nx, ny, nz);
      if (seen.has(id)) continue;
      seen.add(id);
      if (!closed(nx, ny, nz) && roomFor(nx, ny, nz)) queue.push([nx, ny, nz]);
    }
  }
  return 'sealed';
}

export function threatExposure(bot: ExposureBot, entity: ExposedEntity, now = Date.now()): Exposure {
  const self = bot.entity?.position;
  // Nothing to judge with: treat as exposed, as before.
  if (!self || !entity.position || typeof bot.blockAt !== 'function'
    || typeof (self as Partial<Vec3>).offset !== 'function' || typeof (entity.position as Partial<Vec3>).offset !== 'function') return 'seen';
  const cached = cache.get(entity);
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const height = entity.height ?? 1.8;
  const eyes = entity.position.offset(0, height * 0.85, 0);
  const value: Exposure = clearLine(bot, eyes, self.offset(0, 1.62, 0)) || clearLine(bot, eyes, self.offset(0, 0.9, 0)) ? 'seen'
    : openWay(bot, self, entity.position, height);
  cache.set(entity, { at: now, value });
  return value;
}

/**
 * Of the hostiles that can neither see nor reach the body now, those that could once the block at `opened`
 * is gone. The world is read as it is, with that one cell taken as open; nothing is remembered from it.
 */
export function exposedByOpening<T extends ExposedEntity>(bot: ExposureBot, entities: T[], opened: Vec3, now = Date.now()): T[] {
  const self = bot.entity?.position;
  if (!self || typeof bot.blockAt !== 'function' || typeof (self as Partial<Vec3>).offset !== 'function') return [];
  const shut = entities.filter(entity => entity.position && typeof (entity.position as Partial<Vec3>).offset === 'function'
    && threatExposure(bot, entity, now) === 'sealed');
  if (!shut.length) return [];
  const after: ExposureBot = { entity: bot.entity,
    blockAt: (position: Vec3, extra?: boolean) => position.x === opened.x && position.y === opened.y && position.z === opened.z
      ? { boundingBox: 'empty' } : bot.blockAt!(position, extra) };
  return shut.filter(entity => {
    const height = entity.height ?? 1.8;
    const eyes = entity.position!.offset(0, height * 0.85, 0);
    return clearLine(after, eyes, self.offset(0, 1.62, 0)) || clearLine(after, eyes, self.offset(0, 0.9, 0))
      || openWay(after, self, entity.position!, height) !== 'sealed';
  });
}

/** A hostile that can neither see nor reach the body is not a threat for now. */
export function isExposedTo(bot: ExposureBot, entity: ExposedEntity, now = Date.now()): boolean {
  return threatExposure(bot, entity, now) !== 'sealed';
}
