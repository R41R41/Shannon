import { Vec3 } from 'vec3';
import { eyeHeight } from './bodyPose.js';

const RANGE = 64;
const MARGIN = 2;
const CLEAR = 0.02;
const HALF_PI = Math.PI / 2;
const EDGE = 1e-7;

export interface GazeTarget { eyes: Vec3; tolerance: number; id?: number; rangeDistance?: number }
export interface GazeLook { yaw: number; pitch: number }
type GazeSource = 'look' | 'lookAt' | 'tick' | 'packet' | 'attack';
export interface GazeSample {
  at: number; source: GazeSource; requested: GazeLook; held: GazeLook | null;
  eyes: Vec3; creatures: Array<{ id?: number; eyes: Vec3; distance: number }>;
  target?: { id: number; part: string };
}
export interface GazeGuardState {
  enabled: boolean; averted: number;
  bySource?: Partial<Record<GazeSource, number>>;
  attackAverted?: number; attackBlocked?: number; unresolved?: number;
  lastAverted?: GazeSample; lastAttackBlocked?: GazeSample;
}
interface GazeBody {
  entity?: { position: Vec3; yaw: number; pitch: number; eyeHeight?: number; id?: number };
  entities?: Record<string, any>;
  blockAt?(position: Vec3): any;
  getControlState?(control: 'sneak'): boolean;
  look?(yaw: number, pitch: number, force?: boolean): Promise<void>;
  lookAt?(point: Vec3, force?: boolean): Promise<void>;
  _client?: { write(name: string, data: any, ...rest: any[]): any };
  on(event: 'physicsTick', listener: () => void): unknown;
  gazeGuard?: GazeGuardState;
}

export function viewVector(yaw: number, pitch: number): Vec3 {
  return new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
}

/** Solve the union of forbidden pitch intervals at this yaw, rather than pushing one cone into another.
 * The server's test is dot > 1 - 0.025 / eye distance. Keep the existing factor-two margin and 0.02 rad clearance.
 * Restricting the interval lets an attack keep its ray inside the chosen part. Null means no such pitch exists. */
export function avertedPitchInRange(eyes: Vec3, yaw: number, pitch: number, creatures: GazeTarget[],
  min = -HALF_PI, max = HALF_PI): number | null {
  const intervals: Array<[number, number]> = [];
  for (const creature of creatures) {
    const line = creature.eyes.minus(eyes), distance = line.norm();
    if ((creature.rangeDistance ?? distance) > RANGE || distance < 1e-6) continue;
    const horizontal = (-Math.sin(yaw) * line.x - Math.cos(yaw) * line.z) / distance;
    const vertical = line.y / distance;
    const amplitude = Math.hypot(horizontal, vertical);
    const cosine = Math.cos(Math.min(Math.PI, Math.acos(Math.max(-1, 1 - MARGIN * creature.tolerance / distance)) + CLEAR));
    if (amplitude < cosine) continue;
    const centre = Math.atan2(vertical, horizontal);
    const half = Math.acos(Math.max(-1, Math.min(1, cosine / (amplitude || 1))));
    for (const turn of [-2 * Math.PI, 0, 2 * Math.PI]) {
      const low = centre + turn - half - EDGE, high = centre + turn + half + EDGE;
      if (high >= min && low <= max) intervals.push([low, high]);
    }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  const wanted = Math.max(min, Math.min(max, pitch));
  const inside = merged.find(([low, high]) => wanted > low && wanted < high);
  if (!inside) return wanted;
  const candidates = inside.filter(p => p >= min && p <= max);
  // The closest boundary of the complete union, below on a tie; both sides are checked at close range.
  return candidates.sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted) || a - b)[0] ?? null;
}

export function avertedPitch(eyes: Vec3, yaw: number, pitch: number, creatures: GazeTarget[]): number {
  return avertedPitchInRange(eyes, yaw, pitch, creatures) ?? pitch;
}

/** Ceiling-forced poses, server-reported crouch and an explicit sneak all use the same eye for aim and protection. */
export function gazeEyes(bot: GazeBody, position = bot.entity?.position): Vec3 {
  const height = Math.min(eyeHeight(bot), bot.entity?.eyeHeight ?? 1.62, bot.getControlState?.('sneak') ? 1.27 : 1.62);
  return (position ?? new Vec3(0, 0, 0)).offset(0, height, 0);
}

export function gazeTargets(bot: GazeBody): GazeTarget[] {
  return Object.values(bot.entities ?? {}).filter(entity => entity?.name === 'enderman' && entity.position && entity !== bot.entity)
    .map(entity => ({ id: entity.id, eyes: entity.position.offset(0, 2.55, 0), tolerance: 0.025,
      rangeDistance: bot.entity ? entity.position.distanceTo(bot.entity.position) : Infinity }));
}

function sample(bot: GazeBody, source: GazeSource, requested: GazeLook, held: GazeLook | null, eyes: Vec3,
  target?: GazeSample['target']): GazeSample {
  return { at: Date.now(), source, requested, held, eyes, target,
    creatures: gazeTargets(bot).filter(c => (c.rangeDistance ?? c.eyes.distanceTo(eyes)) <= RANGE)
      .map(c => ({ id: c.id, eyes: c.eyes, distance: c.eyes.distanceTo(eyes) }))
      .sort((a, b) => a.distance - b.distance).slice(0, 8) };
}

/** One attempt to aim a dragon blow: no safe pitch in any reachable part is a blocked attempt, not a lost reach. */
export function recordGazeAttack(bot: GazeBody, requested: GazeLook, held: GazeLook | null, target: NonNullable<GazeSample['target']>): void {
  const state = bot.gazeGuard;
  if (!state?.enabled) return;
  if (!held) {
    state.attackBlocked = (state.attackBlocked ?? 0) + 1;
    state.lastAttackBlocked = sample(bot, 'attack', requested, null, gazeEyes(bot), target);
  } else if (held.yaw !== requested.yaw || held.pitch !== requested.pitch) {
    state.attackAverted = (state.attackAverted ?? 0) + 1;
    recordAverted(bot, state, 'attack', requested, held, gazeEyes(bot), target);
  }
}

function recordAverted(bot: GazeBody, state: GazeGuardState, source: GazeSource, requested: GazeLook, held: GazeLook,
  eyes: Vec3, target?: GazeSample['target']): void {
  state.averted++;
  const counts = state.bySource ??= {};
  counts[source] = (counts[source] ?? 0) + 1;
  state.lastAverted = sample(bot, source, requested, held, eyes, target);
}

function guarded(bot: GazeBody, state: GazeGuardState, source: GazeSource, yaw: number, pitch: number, eyes = gazeEyes(bot)): GazeLook {
  const requested = { yaw, pitch };
  if (!state.enabled || !bot.entity) return requested;
  const held = avertedPitchInRange(eyes, yaw, pitch, gazeTargets(bot));
  if (held === null) { state.unresolved = (state.unresolved ?? 0) + 1; return requested; }
  if (held !== pitch) recordAverted(bot, state, source, requested, { yaw, pitch: held }, eyes);
  return { yaw, pitch: held };
}

/** Idle/direct entity rotations, including an Enderman moving or teleporting into the held gaze. */
export function gazeGuardTick(bot: GazeBody, state: GazeGuardState): boolean {
  const body = bot.entity;
  if (!state.enabled || !body) return false;
  const held = guarded(bot, state, 'tick', body.yaw, body.pitch);
  if (held.pitch === body.pitch) return false;
  // force also updates mineflayer's private lastSentPitch; assigning entity.pitch alone leaves interpolation unsafe.
  void bot.look?.(held.yaw, held.pitch, true)?.catch(() => undefined);
  body.pitch = held.pitch;
  return true;
}

export function installGazeGuard(bot: GazeBody): void {
  if (bot.gazeGuard) return;
  const state: GazeGuardState = bot.gazeGuard = { enabled: true, averted: 0, bySource: {}, attackAverted: 0, attackBlocked: 0, unresolved: 0 };
  const look = bot.look;
  if (look) {
    const setLook = (yaw: number, pitch: number, force: boolean | undefined, source: 'look' | 'lookAt'): Promise<void> => {
      const held = guarded(bot, state, source, yaw, pitch);
      return look.call(bot, held.yaw, held.pitch, force || held.pitch !== pitch);
    };
    bot.look = (yaw, pitch, force) => setLook(yaw, pitch, force, 'look');
    if (bot.lookAt) {
      const lookAt = bot.lookAt;
      bot.lookAt = (point, force) => {
        if (!state.enabled || !bot.entity) return lookAt.call(bot, point, force);
        const line = point.minus(gazeEyes(bot));
        return setLook(Math.atan2(-line.x, -line.z), Math.atan2(line.y, Math.hypot(line.x, line.z)), force, 'lookAt');
      };
    }
  }
  // physicsTick precedes updatePosition. Its interpolation, later listeners and direct look packets must all pass
  // this final check. Preserve packet position/flags and the write result; never emit an extra movement packet.
  const client = bot._client;
  if (client) {
    const write = client.write;
    let sent: GazeLook | undefined;
    client.write = function (name, data, ...rest) {
      const rotates = (name === 'look' || name === 'position_look') && Number.isFinite(data.yaw) && Number.isFinite(data.pitch);
      if (bot.entity && (rotates || name === 'position' || name === 'flying')) {
        const position = name === 'position_look' || name === 'position' ? new Vec3(data.x, data.y, data.z) : bot.entity.position;
        const requested = rotates ? { yaw: Math.PI - data.yaw * Math.PI / 180, pitch: -data.pitch * Math.PI / 180 }
          : sent ?? { yaw: bot.entity.yaw, pitch: bot.entity.pitch };
        const held = guarded(bot, state, 'packet', requested.yaw, requested.pitch, gazeEyes(bot, position));
        if (held.pitch !== requested.pitch) {
          if (!rotates) name = name === 'position' ? 'position_look' : 'look';
          data = { ...data, yaw: rotates ? data.yaw : Math.fround((Math.PI - held.yaw) * 180 / Math.PI),
            pitch: Math.fround(-held.pitch * 180 / Math.PI) };
        }
        if (rotates || held.pitch !== requested.pitch) sent = held;
      }
      return write.call(this, name, data, ...rest);
    };
  }
  bot.on('physicsTick', () => { gazeGuardTick(bot, state); });
}

export function gazeGuardPlugin(bot: unknown): void { installGazeGuard(bot as GazeBody); }
