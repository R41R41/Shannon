/** Loaded world cells only; `solid` is the CampReader/bodyReader fallback for boundingBox. */
export interface StandBlock {
  name: string; boundingBox?: string; solid?: boolean; shapes?: readonly (readonly number[])[];
}
export interface StandCell { x: number; y: number; z: number }
export type StandReader = (x: number, y: number, z: number) => StandBlock | null | undefined;
export interface StandOptions {
  /** Planned cells ("x,y,z") cannot contain the body or supply a floor, whether currently air or a wall. */
  ignore?: ReadonlySet<string>;
}
export interface Standability {
  ok: boolean;
  why: 'ok' | 'no_floor' | 'floor_hazard' | 'no_head_room' | 'fire_near' | 'hazard_near' | 'unloaded';
  floor: string;
}

const FIRE = new Set(['fire', 'soul_fire']);
const HAZARD = new Set(['lava', 'water', ...FIRE, 'magma_block', 'cactus', 'powder_snow', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'wither_rose']);
// go.hazardAtFeetWith: lava/magma/cactus/fire beside feet or head, and lava above the head.
const BESIDE = new Set(['lava', 'magma_block', 'cactus']);
const HORIZONTAL = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const key = (p: StandCell) => `${p.x},${p.y},${p.z}`;
const solid = (b: StandBlock) => b.boundingBox === undefined ? b.solid === true : b.boundingBox === 'block';
const fireCells = (p: StandCell): StandCell[] => [
  ...[-1, 0, 1, 2].map(dy => ({ ...p, y: p.y + dy })),
  ...HORIZONTAL.flatMap(([dx, dz]) => [-1, 0, 1].map(dy => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz }))),
];

/** The fires checked by standableAt; used by fill to extinguish only those cells via the dig hand. */
export function standabilityFires(read: StandReader, cell: StandCell): StandCell[] {
  return fireCells(cell).filter(p => FIRE.has(read(p.x, p.y, p.z)?.name ?? ''));
}

/** One cell model for a placement footing and a walking destination. Never reads map memory or changes the world. */
export function standableAt(read: StandReader, cell: StandCell, options: StandOptions = {}): Standability {
  const { x, y, z } = cell, floor = read(x, y - 1, z), feet = read(x, y, z), head = read(x, y + 1, z);
  const result = (why: Standability['why']): Standability => ({ ok: why === 'ok', why, floor: floor?.name ?? 'unloaded' });
  if (!floor || !feet || !head) return result('unloaded');
  if (HAZARD.has(floor.name)) return result('floor_hazard');
  if (options.ignore?.has(key({ x, y: y - 1, z })) || (!solid(floor) && !floor.shapes?.length)) return result('no_floor');
  if (options.ignore?.has(key(cell)) || options.ignore?.has(key({ x, y: y + 1, z })) || solid(feet) || solid(head)) return result('no_head_room');
  if ([feet, head].some(b => HAZARD.has(b.name) && !FIRE.has(b.name))) return result('hazard_near');
  let fire = false, hazard = false;
  for (const p of fireCells(cell)) {
    const b = read(p.x, p.y, p.z);
    if (!b) return result('unloaded');
    fire ||= FIRE.has(b.name);
    hazard ||= (p.y >= y && p.y <= y + 1 && (p.x !== x || p.z !== z) && BESIDE.has(b.name))
      || (p.x === x && p.y === y + 2 && p.z === z && b.name === 'lava');
  }
  return result(hazard ? 'hazard_near' : fire ? 'fire_near' : 'ok');
}
