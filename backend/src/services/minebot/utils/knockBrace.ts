import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { fallIsDangerous, predictJumpFall, type EdgeGuardBot } from './edgeGuard.js';

const log = createLogger('Minebot:KnockBrace');
const { Physics } = createRequire(import.meta.url)('prismarine-physics');

/**
 * Leaning against a blow that is throwing the body off a ledge.
 *
 * A hit throws the body a block back and half a block up. Until the client library was put right the body
 * never felt this (it read every such push as next to nothing), so nothing here had ever had to deal with it.
 * In the open a push is harmless, and often a help: it takes the body out of the reach of what struck it. At a
 * ledge it is how a body dies without having taken a step: a zombie walked a standing body twenty blocks to
 * the rim of its platform and over it, a block a blow (lab).
 *
 * The guard at the rim takes back a step the body takes itself; a body in the air has no step to take back.
 * What a person does is hold the key against the push while in the air. It does not undo the push: a blow
 * keeps the body up for eight ticks or so, and what the game lets a body in the air change its speed by adds
 * up over them to rather more than half a block, against a push of one (measured: 0.97 of a block a blow
 * unbraced, 0.40 braced). It buys blows, not safety: a body that stands still at a rim and is struck again and
 * again still goes over, at the eighth blow instead of the third from 1.7 blocks in, at the fifth instead of
 * the second from 0.7 (lab). Getting away from the rim is for whoever has the legs.
 *
 * So, each tick the body is in the air from a launch it did not make itself: where it will come down as it
 * flies is worked out, and when that is a dangerous fall (or lava, or nothing), its own keys are let go and
 * its speed is changed against the push by what the game allows a body in the air, until it lands. A push that
 * never threatened a fall is left to run.
 */
/**
 * What the game lets a body in the air change its speed by in a tick: 0.026 for one that sprints against the
 * push (0.02 for one that only walks), of which 98% is applied.
 */
export const AIR_CONTROL = 0.026 * 0.98;
const HORIZONTAL = ['forward', 'back', 'left', 'right', 'sprint'] as const;
/** Every key named and up: the engine does arithmetic on them, and a key left out makes the whole flight NaN. */
const NO_KEYS = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };

/**
 * A tick of leaning against a push that went the way of `push` (a unit vector, level): the speed changes by
 * what the game allows, against the push, as it does for a person who holds the key against it. Past
 * standing still as well: the key held brings the body back toward where it stood.
 */
export function leanAgainst(velocity: Vec3, push: { x: number; z: number }): void {
  velocity.x -= push.x * AIR_CONTROL;
  velocity.z -= push.z * AIR_CONTROL;
}

type BraceBot = EdgeGuardBot & {
  registry?: unknown;
  on?(event: string, listener: (...args: any[]) => void): unknown;
  knockBrace?: KnockBraceState;
};
/** `launches` counts throws the body did not make itself; `braced` those it leaned against, `ticks` for how long in all. */
export interface KnockBraceState { enabled: boolean; launches: number; braced: number; ticks: number }

export function installKnockBrace(bot: BraceBot, fallOf?: (bot: BraceBot, takeOffY: number) => number): void {
  if (bot.knockBrace || typeof bot.on !== 'function') return;
  const state: KnockBraceState = bot.knockBrace = { enabled: true, launches: 0, braced: 0, ticks: 0 };
  const world = { getBlock: (pos: Vec3) => (bot.blockAt as (pos: Vec3, extra?: boolean) => unknown)(pos, false) };
  let engine: unknown = null;
  // Where the flight ends with no key held: the fall from its highest point, as the guard at the rim reckons a jump.
  const fall = fallOf ?? ((body: BraceBot, takeOffY: number) => {
    engine ??= Physics(body.registry, world);
    return predictJumpFall(engine as any, world, body, NO_KEYS, takeOffY);
  });
  let wasOnGround = true, jumpHeld = false, thrown: { fromY: number; leaning: boolean; push: { x: number; z: number } | null } | null = null, lastY = 0, lastLogAt = 0;
  bot.on('physicsTick', () => {
    try {
      const entity = bot.entity;
      if (!entity) return;
      const jumping = bot.getControlState('jump');
      if (entity.onGround || entity.isInWater || entity.isInLava) thrown = null;
      else if (wasOnGround && !thrown && entity.velocity.y > 0.1 && !jumping && !jumpHeld) {
        // Off the ground and rising with no jump of its own: something threw it.
        const speed = Math.hypot(entity.velocity.x, entity.velocity.z);
        thrown = { fromY: lastY, leaning: false, push: speed > 0.01 ? { x: entity.velocity.x / speed, z: entity.velocity.z / speed } : null };
        state.launches++;
      }
      wasOnGround = entity.onGround;
      jumpHeld = jumping;
      if (entity.onGround) lastY = entity.position.y;
      if (!thrown?.push || !state.enabled) return;
      // Once leaning, to the end of the flight: stopping as soon as the landing was only just safe set the body
      // down on the very rim each time, and the next blow took it over (lab: no later over the edge than a
      // body that did nothing).
      if (!thrown.leaning && !fallIsDangerous(fall(bot, thrown.fromY), bot.health ?? 20)) return;
      for (const control of HORIZONTAL) if (bot.getControlState(control)) bot.setControlState(control, false);
      leanAgainst(entity.velocity, thrown.push);
      state.ticks++;
      if (!thrown.leaning) {
        thrown.leaning = true;
        state.braced++;
        if (Date.now() - lastLogAt > 3000) { lastLogAt = Date.now(); log.warn(`🧍 押された先が危険な落差: 空中で押し返す（累計${state.braced}回）`); }
      }
    } catch { /* a reflex never breaks the tick */ }
  });
}

/** Loaded after the pathfinder, so that in the ticks it leans the keys it lets go stay let go. */
export function knockBracePlugin(bot: unknown): void { installKnockBrace(bot as BraceBot); }
