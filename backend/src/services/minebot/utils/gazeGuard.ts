import { Vec3 } from 'vec3';
import { eyeHeight } from './bodyPose.js';

/**
 * Creatures that turn on whatever looks them in the eye, with how high their
 * eyes are and how near the eye the look has to fall. The measure is the
 * server's own: the look counts when the cosine of the angle between it and
 * the line to the creature's eyes is above 1 - tolerance / distance.
 */
const PROVOKED_BY_GAZE: Record<string, { eye: number; tolerance: number }> = { enderman: { eye: 2.55, tolerance: 0.025 } };
const RANGE = 64;
/** The look is kept this many times the server's measure clear, for the lag between the look set here and the one the server holds. */
const MARGIN = 2;
const CLEAR = 0.02;

export interface GazeTarget { eyes: Vec3; tolerance: number }

export function viewVector(yaw: number, pitch: number): Vec3 {
  return new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
}

/**
 * The pitch to hold in place of `pitch` so that the look falls on none of the
 * creatures' eyes; `pitch` itself when it falls on none already. Only the
 * pitch is changed: the yaw is the way the body walks. The look goes below
 * the eyes (at the creature's body or the ground in front of it), or above
 * them when below is not possible.
 */
export function avertedPitch(eyes: Vec3, yaw: number, pitch: number, creatures: GazeTarget[]): number {
  let held = pitch;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const creature of creatures) {
      const line = creature.eyes.minus(eyes);
      const distance = line.norm();
      if (distance > RANGE || distance < 1e-6) continue;
      const cosine = Math.max(-1, 1 - MARGIN * creature.tolerance / distance);
      if (viewVector(yaw, held).dot(line.scaled(1 / distance)) <= cosine) continue;
      // Two looks are at least as far apart as their elevations differ: below the eyes by the cone's
      // half-angle is clear of it whatever the yaw.
      const elevation = Math.asin(Math.max(-1, Math.min(1, line.y / distance)));
      const cone = Math.acos(cosine) + CLEAR;
      held = elevation - cone >= -Math.PI / 2 ? elevation - cone : Math.min(Math.PI / 2, elevation + cone);
      moved = true;
    }
    if (!moved) break;
  }
  return held;
}

interface GazeBody {
  entity?: { position: Vec3; yaw: number; pitch: number; id?: number };
  entities?: Record<string, any>;
  blockAt?(position: Vec3): any;
  on(event: 'physicsTick', listener: () => void): unknown;
  gazeGuard?: GazeGuardState;
}
export interface GazeGuardState { enabled: boolean; averted: number }

/**
 * One tick of the gaze guard, run after every other mover has set the look.
 * A body that walks looks straight ahead, level; a creature of this kind a
 * way off on level ground has its eyes in that line, and nothing in the body
 * knew that looking is an act. One came at a body from thirteen metres and
 * killed it in ten seconds, seventeen health points to none, the escape
 * running the whole time (paid run L64). A person keeps their eyes down.
 */
export function gazeGuardTick(bot: GazeBody, state: GazeGuardState): boolean {
  const body = bot.entity;
  if (!state.enabled || !body) return false;
  const creatures: GazeTarget[] = [];
  for (const entity of Object.values(bot.entities ?? {})) {
    const kind = entity && PROVOKED_BY_GAZE[String(entity.name)];
    if (!kind || !entity.position || entity === body) continue;
    creatures.push({ eyes: entity.position.offset(0, kind.eye, 0), tolerance: kind.tolerance });
  }
  if (!creatures.length) return false;
  const eyes = body.position.offset(0, eyeHeight(bot as any), 0);
  const pitch = avertedPitch(eyes, body.yaw, body.pitch, creatures);
  if (pitch === body.pitch) return false;
  body.pitch = pitch;
  state.averted++;
  return true;
}

export function installGazeGuard(bot: GazeBody): void {
  if (bot.gazeGuard) return;
  const state: GazeGuardState = bot.gazeGuard = { enabled: true, averted: 0 };
  bot.on('physicsTick', () => { try { gazeGuardTick(bot, state); } catch { /* the look stays as it was set */ } });
}

/** As a mineflayer plugin, loaded after the movement plugins so that it has the last word on the look each tick. */
export function gazeGuardPlugin(bot: unknown): void { installGazeGuard(bot as GazeBody); }
