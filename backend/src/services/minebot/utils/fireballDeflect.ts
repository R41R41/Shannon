import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { installToldVelocity, toldVelocity } from './toldVelocity.js';
import { answerWith } from './reflexAnswers.js';

const log = createLogger('Minebot:FireballDeflect');

/**
 * Hitting a ghast's fireball back at it.
 *
 * A ghast shoots from sixty blocks, each ball takes six or seven points and breaks the ground the body stands
 * on (paid runs L77c, L77e, L77f: burned, shot off a bridge, knocked off a ledge into the lava sea). A ball
 * that is struck flies off along the line the striker is looking, so the answer is in the look at the moment
 * of the blow. The ball covers its last three blocks in a tenth of a second or two: no plan is in time, this
 * is a reflex.
 *
 * Each tick the balls in the air are followed. The server says where a ball is only every ten ticks or so
 * (measured: the last word comes with the ball some six blocks off, three or four ticks from the body), so
 * between its words the ball is carried forward here by the server's own rule: it moves by its speed, then
 * gains a tenth of a block a tick along its path and keeps 95% (`advance`). One that is coming at the body is aimed for as it
 * closes: the look goes to where the ghast will be when the ball gets back to it (the ball leaves at one block
 * a tick and gains speed towards 1.9; a ghast drifts slowly, and is four blocks wide), the body stops walking
 * so that the look does not carry it off, and the ball is struck as soon as it is in reach. The look is set a
 * few ticks ahead of the blow because the server judges the direction by the look it was last told of.
 *
 * Only the ghast's ball: a blaze's small one cannot be struck.
 */
export const BALL_NAME = 'fireball';
/** From the eyes to the ball's centre at which the blow is struck (the server allows six blocks to the ball's box). */
export const STRIKE_RANGE = 5.2;
/** The speed a ball tends to, and what it gains and keeps each tick (the server's rule for it). */
const BALL_GAIN = 0.1, BALL_KEEP = 0.95, BALL_TOP_SPEED = BALL_GAIN * BALL_KEEP / (1 - BALL_KEEP);

/** A ball one tick on: it moves by its speed, then gains along its path and keeps 95%. */
export function advance(ball: BallTrack): BallTrack {
  const speed = ball.velocity.norm();
  const position = ball.position.plus(ball.velocity);
  const velocity = speed > 0.001 ? ball.velocity.plus(ball.velocity.scaled(BALL_GAIN / speed)).scaled(BALL_KEEP) : ball.velocity.clone();
  return { position, velocity };
}
/** Ticks before the blow at which the look is turned and the body stops. */
const AIM_AHEAD_TICKS = 8;
/** A ball whose line passes further from the eyes than this is not coming at the body. */
const MISS_DISTANCE = 3.5;
const EYE_HEIGHT = 1.62;
const HORIZONTAL = ['forward', 'back', 'left', 'right', 'sprint'] as const;

export interface BallTrack { position: Vec3; velocity: Vec3 }

/** How a ball stands to the eyes: whether it is coming, how near its line passes, and the ticks until it is in reach. */
export function approach(eyes: Vec3, ball: BallTrack): { incoming: boolean; distance: number; ticksToReach: number } {
  const offset = ball.position.minus(eyes);
  const distance = offset.norm();
  const speed = ball.velocity.norm();
  if (speed < 0.05 || distance < 0.001) return { incoming: false, distance, ticksToReach: Infinity };
  const closing = -offset.dot(ball.velocity) / distance;        // blocks a tick towards the eyes
  // Nearest the ball's straight line comes to the eyes.
  const along = -offset.dot(ball.velocity) / speed;
  const miss = Math.sqrt(Math.max(0, distance * distance - along * along));
  const incoming = closing > 0.1 && miss <= MISS_DISTANCE;
  return { incoming, distance, ticksToReach: incoming ? Math.max(0, (distance - STRIKE_RANGE) / closing) : Infinity };
}

/** Ticks a struck ball takes to fly `distance`: it leaves at one block a tick and each tick gains a tenth and keeps 95%. */
export function returnTicks(distance: number): number {
  let speed = 1, covered = 0, ticks = 0;
  while (covered < distance && ticks < 200) { covered += speed; speed = (speed + 0.1) * 0.95; ticks++; }
  return ticks;
}

/**
 * The furthest ahead of the shooter the look is ever put. A ghast floats to a mark and then picks another, so
 * its drift now says less the longer the flight; past this, leading further lost more balls than it gained.
 */
export const LEAD_CAP = 6.5;

/**
 * Where to look so that the struck ball meets the shooter: its middle, moved on by its own drift over the flight.
 *
 * How the drift is taken was settled by measure: 5,277 ticks of four ghasts' movement were recorded and each
 * way of leading was flown against them. The step between the server's last two words of the ghast, capped as
 * above, met its box 80% of the time (96% inside 30 blocks, about half at 60); the average over the last
 * second, which this used before, 61%; no lead at all, 15%.
 */
export function leadPoint(from: Vec3, shooter: { position: Vec3; velocity?: Vec3; height?: number }): Vec3 {
  const middle = shooter.position.offset(0, (shooter.height ?? 4) / 2, 0);
  const drift = shooter.velocity ?? new Vec3(0, 0, 0);
  let aim = middle;
  for (let pass = 0; pass < 3; pass++) {
    const lead = drift.scaled(returnTicks(from.distanceTo(aim)));
    const length = lead.norm();
    aim = middle.plus(length > LEAD_CAP ? lead.scaled(LEAD_CAP / length) : lead);
  }
  return aim;
}

interface DeflectBot {
  entity?: { id?: number; position: Vec3; yaw?: number; pitch?: number };
  entities?: Record<string, any>;
  health?: number;
  look?(yaw: number, pitch: number, force?: boolean): unknown;
  attack?(entity: unknown): unknown;
  getControlState?(control: string): boolean;
  setControlState?(control: string, state: boolean): void;
  on?(event: string, listener: (...args: any[]) => void): unknown;
  fireballDeflect?: FireballDeflectState;
}
/** `strikes` counts balls struck at (not blows); `aimed` the ticks the look was held for one. */
export interface FireballDeflectState { enabled: boolean; strikes: number; aimed: number; last?: string; struck?: StrikeRecord[] }
/** One blow, for measuring where the ball then went against where it was meant to go (kept for the last few). */
export interface StrikeRecord { ball: number; shooter?: number; from: Vec3; aim: Vec3; yaw: number; pitch: number; ticksToReach: number }

/** The ghast a ball came from: the one most nearly back along the ball's path. */
export function shooterOf(bot: Pick<DeflectBot, 'entities'>, ball: BallTrack): any | null {
  const back = ball.velocity.scaled(-1).normalize();
  let best: any = null, bestCos = 0.5;
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity?.position || String(entity.name ?? '') !== 'ghast') continue;
    const to = entity.position.offset(0, 2, 0).minus(ball.position);
    const cos = to.norm() > 0.001 ? to.normalize().dot(back) : -1;
    if (cos > bestCos) { best = entity; bestCos = cos; }
  }
  return best;
}

export function installFireballDeflect(bot: DeflectBot): void {
  if (bot.fireballDeflect || typeof bot.on !== 'function') return;
  const state: FireballDeflectState = bot.fireballDeflect = { enabled: true, strikes: 0, aimed: 0 };
  installToldVelocity(bot as any);
  // Said to the threat watch: a ghast's attack is answered here, so a ghast in range is not by itself an emergency.
  answerWith(bot, kind => kind === 'ghast' && state.enabled);
  // What the server last said of each ball, and when; the ball's place now is worked out from that.
  const seen = new Map<number, { said: Vec3; saidTick: number; velocity: Vec3; struckAt?: number }>();
  // The server's last two words of where each ghast is (it speaks every three ticks or so, and never of its
  // speed): the drift is the step between them. One it has not spoken of for a while is taken to be still.
  const ghasts = new Map<number, { before?: { tick: number; position: Vec3 }; latest: { tick: number; position: Vec3 } }>();
  const STILL_AFTER_TICKS = 8;
  let tick = 0;
  bot.on('physicsTick', () => {
    tick++;
    try {
      if (!state.enabled || !bot.entity || (bot.health ?? 20) <= 0) return;
      const eyes = bot.entity.position.offset(0, EYE_HEIGHT, 0);
      const ghastDrift = new Map<number, Vec3>();
      for (const entity of Object.values(bot.entities ?? {})) {
        if (!entity?.position || entity.name !== 'ghast') continue;
        const known = ghasts.get(entity.id);
        if (!known) ghasts.set(entity.id, { latest: { tick, position: entity.position.clone() } });
        else if (!known.latest.position.equals(entity.position)) {
          known.before = known.latest;
          known.latest = { tick, position: entity.position.clone() };
        }
        const words = ghasts.get(entity.id)!;
        if (words.before && tick - words.latest.tick <= STILL_AFTER_TICKS && words.latest.tick > words.before.tick) {
          ghastDrift.set(entity.id, words.latest.position.minus(words.before.position).scaled(1 / (words.latest.tick - words.before.tick)));
        }
      }
      let nearest: { entity: any; track: BallTrack; ticks: number; distance: number } | null = null;
      const alive = new Set<number>();
      for (const entity of Object.values(bot.entities ?? {})) {
        if (!entity?.position || entity.name !== BALL_NAME) continue;
        alive.add(entity.id);
        let record = seen.get(entity.id);
        if (!record || !record.said.equals(entity.position)) {
          // A new word from the server. Its speed is the one it sent with it when it sent one; otherwise what
          // the ball covered since the last word, a little more for the speed gained on the way.
          const told: Vec3 | undefined = toldVelocity(bot as any, entity.id) ?? entity.velocity;
          let velocity = told && told.norm() > 0.05 ? told.clone() : new Vec3(0, 0, 0);
          if (velocity.norm() <= 0.05 && record && tick > record.saidTick) {
            const average = entity.position.minus(record.said).scaled(1 / (tick - record.saidTick));
            const speed = average.norm();
            if (speed > 0.05) velocity = average.scaled(Math.min(BALL_TOP_SPEED, speed * 1.12) / speed);
          }
          record = { said: entity.position.clone(), saidTick: tick, velocity, struckAt: record?.struckAt };
          seen.set(entity.id, record);
        }
        let track: BallTrack = { position: record.said, velocity: record.velocity };
        for (let step = record.saidTick; step < tick; step++) track = advance(track);
        const how = approach(eyes, track);
        if (!how.incoming || how.ticksToReach > AIM_AHEAD_TICKS) continue;
        if (!nearest || how.ticksToReach < nearest.ticks) nearest = { entity, track, ticks: how.ticksToReach, distance: how.distance };
      }
      for (const id of seen.keys()) if (!alive.has(id)) seen.delete(id);
      if (ghasts.size > 64) ghasts.clear();
      if (!nearest) return;
      // Aim: where the ghast will be when the ball gets back; with no ghast in view, straight back the way it came.
      const shooter = shooterOf(bot, nearest.track);
      const aim = shooter
        ? leadPoint(nearest.track.position, { position: shooter.position, velocity: ghastDrift.get(shooter.id), height: shooter.height ?? 4 })
        : nearest.track.position.plus(nearest.track.velocity.scaled(-1).normalize().scaled(32));
      // The struck ball flies from where it is, parallel to the look: the look is the line from the ball to the
      // mark, not from the eyes to it (the two differ by as much as the ball stands off to one side).
      const from = nearest.track.position;
      const dx = aim.x - from.x, dy = aim.y - from.y, dz = aim.z - from.z;
      const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
      for (const control of HORIZONTAL) if (bot.getControlState?.(control)) bot.setControlState?.(control, false);
      bot.look?.(yaw, pitch, true);
      state.aimed++;
      const record = seen.get(nearest.entity.id)!;
      // Struck every tick it is in reach until the server says it has turned: the first blow that lands turns it,
      // and one sent a tick early (the ball still out of the server's reach) costs nothing.
      if (nearest.ticks <= 1) {
        const first = record.struckAt === undefined;
        record.struckAt = tick;
        bot.attack?.(nearest.entity);
        if (first) {
          state.strikes++;
          (state.struck ??= []).push({ ball: nearest.entity.id, shooter: shooter?.id, from: from.clone(), aim: aim.clone(), yaw, pitch, ticksToReach: nearest.ticks });
          if (state.struck.length > 16) state.struck.shift();
          state.last = shooter ? `ghast ${Math.round(nearest.track.position.distanceTo(shooter.position))}m` : 'back along its path';
          log.info(`🏐 火の玉を打ち返す（${shooter ? `ガストへ、約${Math.round(nearest.track.position.distanceTo(shooter.position))}m` : '来た向きへ'}。累計${state.strikes}個）`);
        }
      }
    } catch { /* a reflex never breaks the tick */ }
  });
}

/** Loaded after the pathfinder, so that in the ticks of a blow its look is the one that stands. */
export function fireballDeflectPlugin(bot: unknown): void { installFireballDeflect(bot as DeflectBot); }
