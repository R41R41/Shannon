/**
 * The way the body has gone through rock, kept whoever dug it.
 *
 * Run 24: the way back to the furnace, 15 m, was cut again (42 blocks, 46.7 s; by the trail 5 s) because the trail of the tunnels cut
 * (utils/stairLine TunnelTrail) was written by the tunnel walk (utils/tunnelWalk) alone. A stair-mine, a mine-block, the route search's own
 * digging walked the same cells and left nothing behind. Here the cells the body stands in are written to the trail from its feet, whatever
 * moved it: a step from one cell to the next that is a legal step (isStep), on the ground, in a place that is shut in (a roof over the
 * head, or rock on three sides), so that a walk over open ground does not fill the memory.
 */
import { Vec3 } from 'vec3';
import { isStep } from './tunnelWalk.js';
import { trailOf, type TunnelTrail } from './stairLine.js';

type Cell = { x: number; y: number; z: number };
interface WorldLike { blockAt(position: Vec3, extraInfos?: boolean): { name?: string; boundingBox?: string } | null }
const SIDES: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const LIQUIDS = new Set(['water', 'lava', 'flowing_water', 'flowing_lava', 'bubble_column']);

function readBlock(world: WorldLike, x: number, y: number, z: number): { name?: string; boundingBox?: string } | null {
  try { return world.blockAt(new Vec3(x, y, z), false); } catch { return null; }
}

/** Whether the cell is in a tunnel, a stair or a shaft: rock over the head, or rock on three sides at the feet or the head. */
export function shutIn(world: WorldLike, cell: Cell): boolean {
  if (readBlock(world, cell.x, cell.y + 2, cell.z)?.boundingBox === 'block') return true;
  for (const dy of [0, 1]) {
    let solid = 0;
    for (const [dx, dz] of SIDES) if (readBlock(world, cell.x + dx, cell.y + dy, cell.z + dz)?.boundingBox === 'block') solid++;
    if (solid >= 3) return true;
  }
  return false;
}

/**
 * Whether a route of the trail can be walked as it stands: no liquid in a cell (feet or head), and no more than `maxSolid` of its cells
 * (feet and head together) filled in since (those are dug on the way, the price of the route not being nothing).
 */
export function trailCellsOpen(world: WorldLike, cells: Cell[], maxSolid = 3): boolean {
  let solid = 0;
  for (const cell of cells) {
    for (const dy of [0, 1]) {
      const block = readBlock(world, cell.x, cell.y + dy, cell.z);
      if (!block) continue;                       // not loaded: unknown, the walk looks again before each step
      if (LIQUIDS.has(block.name ?? '')) return false;
      if (block.boundingBox === 'block' && ++solid > maxSolid) return false;
    }
  }
  return true;
}

/** Follows the feet cell of one body and writes the steps it takes in shut-in places to the trail. */
export class TrailRecorder {
  private last: Cell | null = null;
  private readonly trail: TunnelTrail;
  constructor(private readonly bot: WorldLike & { entity?: { position?: Vec3; onGround?: boolean } }, trail?: TunnelTrail) {
    this.trail = trail ?? trailOf(bot as object);
  }

  /** The body is somewhere else (a respawn, a portal, a teleport): the next cell is a new beginning, not a step from the last. */
  reset(): void { this.last = null; }

  /** One look at the body (every physics tick). Returns true when an edge was written. */
  observe(): boolean {
    const entity = this.bot.entity;
    const position = entity?.position;
    if (!position) return false;
    // Only on the ground: a jump passes through cells the body never stood in.
    if (entity.onGround === false) return false;
    const cell = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
    const last = this.last;
    if (last && last.x === cell.x && last.y === cell.y && last.z === cell.z) return false;
    this.last = cell;
    if (!last || !isStep(last, cell)) return false;
    if (!shutIn(this.bot, cell) && !shutIn(this.bot, last)) return false;
    this.trail.add(last, cell);
    return true;
  }
}

interface Emitter { on(event: string, listener: (...args: any[]) => void): unknown }
const installed = new WeakSet<object>();

/** The trail is written from the body's feet for the whole life of the body (the plugin of the client; the recorder is per body). */
export function installTrailRecorder(bot: Emitter & WorldLike & { entity?: { position?: Vec3; onGround?: boolean } }): TrailRecorder | null {
  if (installed.has(bot)) return null;
  installed.add(bot);
  const recorder = new TrailRecorder(bot);
  bot.on('physicsTick', () => { try { recorder.observe(); } catch { /* a recorder must never stop the body */ } });
  bot.on('respawn', () => recorder.reset());
  bot.on('spawn', () => recorder.reset());
  return recorder;
}

export function trailRecorderPlugin(bot: unknown): void { installTrailRecorder(bot as Parameters<typeof installTrailRecorder>[0]); }
