import { Vec3 } from 'vec3';
import { guard, wait, type StepContext } from './common.js';

interface Point { x: number; y: number; z: number }
export interface SwimControls { yaw: number; forward: boolean; jump: boolean; sneak: boolean }
const OPEN = new Set(['water', 'air', 'cave_air', 'void_air']);

/**
 * A short, fully observed water corridor to a caller's target, not a new target
 * or an underwater route search. The pathfinder always jumps in water and has
 * no vertical swim edges. Steering this clear corridor needs depth control.
 * A wall, ice, an unloaded cell or a dry feet cell leaves the ordinary route
 * planner in charge. No digging, placing, sprint swimming or new permission.
 */
export function swimControls(bot: any, target: Point, allowed: (x: number, y: number, z: number) => boolean = () => true): SwimControls | null {
  const p = bot.entity?.position;
  if (!p || ![p.x, p.y, p.z, target.x, target.y, target.z].every(Number.isFinite)) return null;
  const dx = target.x - p.x, dy = target.y - p.y, dz = target.z - p.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance > 12) return null;
  const seen = new Map<string, string | null>();
  const checked = new Set<string>();
  const nameAt = (x: number, y: number, z: number) => {
    const key = `${x},${y},${z}`;
    if (!seen.has(key)) {
      const block = bot.blockAt?.(new Vec3(x, y, z), false);
      const level = block?.getProperties?.().level;
      // Current pushes and falling water need the ordinary route's handling.
      // An unmeasured liquid is not evidence of a still, controllable corridor.
      seen.set(key, block?.name === 'water' && Number(level) !== 0 ? 'flowing_water' : block?.name ?? null);
    }
    return seen.get(key)!;
  };
  const corridor = (from: Point, to: Point): boolean => {
   const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) / 0.25));
   for (let i = 0; i <= steps; i++) {
    const x = from.x + (to.x - from.x) * i / steps, y = from.y + (to.y - from.y) * i / steps, z = from.z + (to.z - from.z) * i / steps;
    // Sweep the whole upright body, not just its centre ray. In water this is
    // conservative (swimming posture can be smaller) and avoids clipping ice.
    for (let bx = Math.floor(x - 0.3); bx <= Math.floor(x + 0.3); bx++) {
      for (let bz = Math.floor(z - 0.3); bz <= Math.floor(z + 0.3); bz++) {
        const fy = Math.floor(y + 0.01);
        if (nameAt(bx, fy, bz) !== 'water') return false;
        const key = `${bx},${fy},${bz}`;
        if (!checked.has(key)) {
          if (!allowed(bx, fy, bz) || nameAt(bx, fy - 1, bz) === 'magma_block') return false;
          for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const oy of [0, 1]) {
            if (['lava', 'magma_block', 'cactus'].includes(nameAt(bx + ox, fy + oy, bz + oz) ?? '')) return false;
          }
          checked.add(key);
        }
        for (let by = fy; by <= Math.floor(y + 1.79); by++) if (!OPEN.has(nameAt(bx, by, bz) ?? '')) return false;
      }
    }
   }
   return true;
  };
  let aim = target;
  if (!corridor(p, target)) {
    // A narrow opening often needs depth before horizontal travel (and the
    // reverse on return). Both legs must be observed clear before either runs.
    const turns = [{ x: p.x, y: target.y, z: p.z }, { x: target.x, y: p.y, z: target.z }];
    const turn = turns.find(point => Math.hypot(point.x - p.x, point.y - p.y, point.z - p.z) > 0.1
      && corridor(p, point) && corridor(point, target));
    if (!turn) return null;
    aim = turn;
  }
  const ax = aim.x - p.x, ay = aim.y - p.y, az = aim.z - p.z;
  // A 0.6m body has only 0.2m clearance on each side of a one-block hole.
  // Stopping horizontal alignment at 0.25m can pin its shoulders on the rim.
  return { yaw: Math.atan2(-ax, -az), forward: Math.hypot(ax, az) > 0.1,
    jump: ay > 0.15, sneak: ay < -0.15 };
}

const AIR = new Set(['air', 'cave_air', 'void_air']);
const FACE_LOOKS_M = [8, 4];

/**
 * end1109s09 S9: a far place over open sea had only the route search (swimControls steers 12 m at most), and it crossed about 700 m at
 * 0.85 m/s: 35 redraws in two minutes, most run out of their 1.5 s, and a way three times the straight line. Over still water with open
 * air above, a far place is swum to straight along the face: forward and jump held (the body stays at the face), one pulse at a time and
 * re-observed between. Only when the next 8 m (or 4 m) of the face are still water with air over them, the body is at the face, and the
 * caller's hazard check passes every cell. A shore, ice, a roof, flowing water, kelp at the face or a body under the face hands back to
 * the route search. No digging, placing or new permission; the caller's waterOk is the leave to swim.
 */
export function surfaceSwimControls(bot: any, target: Point, allowed: (x: number, y: number, z: number) => boolean = () => true): SwimControls | null {
  const p = bot.entity?.position;
  if (!p || ![p.x, p.y, p.z, target.x, target.z].every(Number.isFinite)) return null;
  const dx = target.x - p.x, dz = target.z - p.z;
  const far = Math.hypot(dx, dz);
  if (far <= 12) return null;
  const seen = new Map<string, string | null>();
  const nameAt = (x: number, y: number, z: number) => {
    const key = `${x},${y},${z}`;
    if (!seen.has(key)) {
      const block = bot.blockAt?.(new Vec3(x, y, z), false);
      const level = block?.getProperties?.().level;
      seen.set(key, block?.name === 'water' && Number(level) !== 0 ? 'flowing_water' : block?.name ?? null);
    }
    return seen.get(key)!;
  };
  const isFace = (x: number, y: number, z: number) => nameAt(x, y, z) === 'water' && AIR.has(nameAt(x, y + 1, z) ?? '');
  const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
  // The body bobs at the face: its feet are in the face cell, just over it, or a cell under it (its head still in the face).
  const face = [fy, fy - 1, fy + 1].find(y => isFace(fx, y, fz));
  if (face === undefined) return null;
  const ux = dx / far, uz = dz / far;
  const clear = (length: number): boolean => {
    for (let i = 0; i <= length * 4; i++) {
      const x = p.x + ux * i / 4, z = p.z + uz * i / 4;
      for (let bx = Math.floor(x - 0.3); bx <= Math.floor(x + 0.3); bx++) {
        for (let bz = Math.floor(z - 0.3); bz <= Math.floor(z + 0.3); bz++) {
          if (!isFace(bx, face, bz) || !AIR.has(nameAt(bx, face + 2, bz) ?? '')) return false;
          if (!allowed(bx, face, bz) || nameAt(bx, face - 1, bz) === 'magma_block') return false;
          for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const oy of [0, 1]) {
            if (['lava', 'magma_block', 'cactus'].includes(nameAt(bx + ox, face + oy, bz + oz) ?? '')) return false;
          }
        }
      }
    }
    return true;
  };
  if (!FACE_LOOKS_M.some(clear)) return null;
  return { yaw: Math.atan2(-dx, -dz), forward: true, jump: true, sneak: false };
}

/** One bounded motor pulse; the caller re-observes its goal and all guards. */
export async function swimPulse(ctx: StepContext, controls: SwimControls, ms = 100): Promise<void> {
  const bot = ctx.bot;
  bot.pathfinder?.setGoal?.(null);
  bot.clearControlStates?.();
  try {
    if (controls.forward) await guard(ctx, Promise.resolve(bot.look(controls.yaw, 0, true)), 1000);
    for (const key of ['forward', 'jump', 'sneak'] as const) bot.setControlState(key, controls[key]);
    await wait(ctx, ms);
  } finally {
    for (const key of ['forward', 'jump', 'sneak'] as const) {
      try { bot.setControlState(key, false); } catch { /* a reflex may now own the motor port */ }
    }
  }
}
