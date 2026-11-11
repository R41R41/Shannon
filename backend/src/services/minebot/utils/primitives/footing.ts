import { Vec3 } from 'vec3';
import { actionSignal, createMotorPort, executeAction } from '../../execution/ActionExecution.js';
import { climbableBank, nearestDryStand, swimOntoBank } from '../exitWater.js';
import { eyeInWater } from '../digTimeIn.js';
import { feetCell, type Cell } from '../localMap.js';
import { holdsWater } from '../waterBlocks.js';
import { blockAt, cellText, isAirLike, StepStopped, wait, type StepContext } from './common.js';
import { pillarEmpty, pillarUp } from './pillarUp.js';
import { place } from './place.js';
import { damBlockHeld, flowingAt, stanchStream, waterLevel } from './stanch.js';

/**
 * steadyInWater: a body whose feet are in water it does not stand in (a stream that carries it, a pool with no floor under the feet, a head under the surface) is put
 * on its feet before a hand works there (the owner, run 6, 2026-11-11: "water carries her away, and the reflex against it never fires"; 480 s of one run in a shaft the
 * body's own dig had flooded).
 *
 * The order is the cheapest first: out onto a bank beside it; a flowing stream stopped with a block upstream (stanch); a block laid under the feet when there is no floor, so that
 * the head is in the air and a dig does not sink the body a block (it did, in 1.85 s, and the head in the water ended the dig as "not enough air"); at last a step or two to
 * dry ground. It takes 3 s at most (4.5 s in a stream, which needs the time to dry), only in water, never fails a hand (it says what it did and the hand goes on), and lays
 * nothing in air.
 */
export interface FootingResult {
  /** Something was done (a bank climbed, a stream stopped, a block laid, a step taken). */
  acted: boolean;
  /** The body is on its feet after it (nothing left to do). */
  steady: boolean;
  /** One short line (about 60 characters) for the act; empty when nothing was needed. */
  words: string;
}

export const FOOTING_MAX_MS = 3000;
export const FOOTING_MAX_STREAM_MS = 4500;

/** What the water has pushed the body by when it was not walking: set by installWaterPush, read by waterTrouble and feetWaterWords. */
export interface WaterPush { at: number; dx: number; dz: number; meters: number }
export const PUSH_FLOW_WINDOW_MS = 3000;
export const PUSH_KEEP_MS = 10000;
const PUSH_MIN_M = 0.3;

/** The push the water gave the body in the last `windowMs` (at least 0.3 m), or null. */
export function pushedRecently(bot: any, windowMs: number): WaterPush | null {
  const push = bot?.waterPush as WaterPush | undefined;
  return push && Date.now() - push.at <= windowMs && push.meters >= PUSH_MIN_M ? push : null;
}

/** What is wrong with the body's footing in water, or null when it stands well (dry, or standing on a floor in still water with the head in the air). */
export function waterTrouble(bot: any): 'flow' | 'no_floor' | 'head_wet' | null {
  const feet = feetCell(bot);
  if (!feet) return null;
  const here = blockAt(bot, feet);
  if (!here || !holdsWater(here)) return null;
  const below = blockAt(bot, { x: feet.x, y: feet.y - 1, z: feet.z });
  const floorless = !!below && below.boundingBox !== 'block';
  // A stream that carries the body: no floor, a head under the surface, or a push measured in the last seconds. A shallow stream that does not move a body on its floor needs nothing.
  if (flowingAt(bot, feet) && (floorless || eyeInWater(bot) || pushedRecently(bot, PUSH_FLOW_WINDOW_MS))) return 'flow';
  if (floorless) return 'no_floor';
  if (eyeInWater(bot)) return 'head_wet';
  return null;
}

const dry = (bot: any) => bot.entity?.isInWater !== true && bot.entity?.onGround === true;

/** A short straight way to `to` over cells a body can pass (open, or water), no lava. */
function lineOpen(bot: any, from: Cell, to: Vec3): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x - 0.5, to.z - from.z - 0.5) * 2));
  for (let i = 1; i < steps; i++) {
    const x = Math.floor(from.x + 0.5 + (to.x - from.x - 0.5) * i / steps), z = Math.floor(from.z + 0.5 + (to.z - from.z - 0.5) * i / steps);
    for (const y of [from.y, from.y + 1]) {
      const block = blockAt(bot, { x, y, z });
      if (!block || block.name === 'lava' || (block.boundingBox === 'block' && !holdsWater(block))) return false;
    }
  }
  return true;
}

/** Up to `ms` of walking (with a jump out of the water) toward a stand; true when the body is on dry ground afterwards. */
async function wadeTo(ctx: StepContext, stand: Vec3, ms: number): Promise<boolean> {
  const bot = ctx.bot;
  const until = Date.now() + ms;
  try {
    while (Date.now() < until) {
      if (dry(bot) && Math.hypot(bot.entity.position.x - stand.x, bot.entity.position.z - stand.z) < 0.7) return true;
      await bot.lookAt(new Vec3(stand.x, bot.entity.position.y + 1.62, stand.z), true);
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);
      await wait(ctx, 50);
    }
  } finally { bot.setControlState('forward', false); bot.setControlState('jump', false); }
  return dry(bot);
}

/** A steadyInWater already running for a body (the dig it calls steadies again before a breathing refusal: not twice over). */
const active = new WeakSet<object>();

export async function steadyInWater(ctx: StepContext, options: { toward?: Cell; deadline?: number } = {}): Promise<FootingResult> {
  if (active.has(ctx.bot as object)) return { acted: false, steady: true, words: '' };
  active.add(ctx.bot as object);
  try { return await steadyInWaterOnce(ctx, options); } finally { active.delete(ctx.bot as object); }
}

async function steadyInWaterOnce(ctx: StepContext, options: { toward?: Cell; deadline?: number }): Promise<FootingResult> {
  const bot = ctx.bot;
  const nothing: FootingResult = { acted: false, steady: true, words: '' };
  let trouble = waterTrouble(bot);
  if (!trouble) return nothing;
  const lines: string[] = [];
  let acted = false;
  try {
    const limit = Math.min(ctx.deadline, options.deadline ?? Infinity, Date.now() + (trouble === 'flow' ? FOOTING_MAX_STREAM_MS : FOOTING_MAX_MS));
    const left = () => limit - Date.now();
    const toward = options.toward;
    const here = () => feetCell(bot)!;
    const tx = () => (toward ? toward.x + 0.5 : bot.entity.position.x), tz = () => (toward ? toward.z + 0.5 : bot.entity.position.z);
    // 1. A bank beside the body at the waterline.
    if (left() > 500 && climbableBank(bot, tx(), tz())) {
      if (await swimOntoBank(bot, tx(), tz(), Math.min(1500, left()))) return { acted: true, steady: true, words: '岸へ上がって水から出た' };
      acted = true;
    }
    trouble = waterTrouble(bot);
    // 2. A stream: the cell it comes from is closed (the same stanch a go or a walk uses when it is held).
    if (trouble === 'flow' && left() > 800) {
      const dam = await stanchStream(ctx, { toward, deadline: limit });
      if (dam.attempted) acted = true;
      if (dam.words) lines.push(dam.words);
      trouble = waterTrouble(bot);
    }
    // 3. No floor under the feet: a block under them, so that the head is in the air (laid whatever the act's canPlace: it is the body's footing, not a route).
    if ((trouble === 'no_floor' || trouble === 'head_wet') && left() > 600) {
      const block = damBlockHeld(bot);
      if (!block) lines.push('足場: dirt か cobblestone を 1 個持てば足元に置ける');
      else {
        const under = { x: here().x, y: here().y - 1, z: here().z };
        const below = blockAt(bot, under);
        if (below && below.boundingBox !== 'block') {
          const out = await place(ctx, { block, at: [under] });
          // The body sank into the cell under it: a block cannot go where the body stands; one level is built upward (jump and lay).
          const final = !out.ok && out.reason === 'body_in_cell' ? await pillarUp(ctx, { n: 1, block }) : out;
          if (final.ok) {
            acted = true;
            const from = Date.now();
            while (Date.now() - from < Math.min(700, Math.max(0, left())) && waterTrouble(bot) === 'no_floor') await wait(ctx, 50);
            lines.push(out.ok ? `足場: 足元 ${cellText(under)} に ${block} を置いて頭を出した` : `足場: ${block} を積んで頭を出した`);
          } else lines.push(`足場を置けない（${cellText(under)}: ${String(final.reason ?? 'refused')}）`);
        } else if (below && trouble === 'head_wet') {
          // A floor under the feet and the head still under the surface: up to two levels are built upward (a pool three deep still puts the head out). The cell two over the feet must be
          // open or water (as pillarUp reads it); a rock there is dug first (a narrow shaft has no room to jump), and what the dig refuses is said and the hand goes on.
          let levels = 0;
          while (waterTrouble(bot) === 'head_wet' && levels < 2 && left() > 600) {
            const feetNow = here();
            const over = { x: feetNow.x, y: feetNow.y + 2, z: feetNow.z };
            const block2 = blockAt(bot, over);
            if (block2 && block2.boundingBox === 'block' && !holdsWater(block2)) {
              const { dig } = await import('./dig.js');
              const opened = await dig(ctx, { at: [over], collect: false });
              if (!opened.ok) { lines.push(`上 ${cellText(over)} の ${block2.name} を開けられない（${String(opened.reason ?? 'refused')}）`); break; }
              acted = true;
              lines.push(`足場: 上 ${cellText(over)} の ${block2.name} を掘って`);
            } else if (!pillarEmpty(block2) || block2?.name === 'lava') break;
            const up = await pillarUp(ctx, { n: 1, block });
            if (!up.ok) { lines.push(`足場を積めない（${String(up.reason ?? 'refused')}）`); break; }
            acted = true; levels++;
          }
          if (levels) lines.push(`足場: ${block} を ${levels} 段積んで頭を出した`);
        }
        trouble = waterTrouble(bot);
      }
    }
    // 4. Still in trouble and dry ground within two cells in a straight line: a step or two to it.
    if (trouble && left() > 500) {
      const stand = nearestDryStand(bot as never, tx(), tz(), 2.2);
      if (stand && Math.abs(stand.y - bot.entity.position.y) <= 1.2 && lineOpen(bot, here(), stand)) {
        acted = true;
        if (await wadeTo(ctx, stand, Math.min(1500, left()))) lines.push(`乾いた ${cellText({ x: Math.floor(stand.x), y: Math.floor(stand.y), z: Math.floor(stand.z) })} へ出た`);
      }
    }
    trouble = waterTrouble(bot);
  } catch (error) {
    if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error;
    // A refusal here is never a hand's: the hand goes on as it is.
  }
  return { acted, steady: trouble === null, words: lines.join('。') };
}

/** The hands whose work is hurt by a body not on its feet in water (a go that may enter water is not one of them). */
const HOLD_HANDS = new Set(['dig', 'use', 'place', 'mine', 'vertical', 'go', 'walk', 'pickup', 'pillarUp']);

/**
 * Before a hand of the planner's (act): steadyInWater when the feet are in water the hand did not ask for. '' when nothing was needed or done.
 * Never throws for anything but the act's own stop.
 */
export async function steadyBeforeHand(ctx: StepContext, hand: { do?: string; waterOk?: boolean }): Promise<string> {
  if (!hand.do || !HOLD_HANDS.has(hand.do)) return '';
  if (hand.do === 'go' && hand.waterOk === true) return '';
  if (!waterTrouble(ctx.bot)) return '';
  const out = await steadyInWater(ctx);
  // Only what was done is told (a refusal to act is the hand's own words, which name what to carry: the line is short).
  return out.acted ? out.words : '';
}

// ---- the reflex: a body held in a stream between hands -------------------------------------------------------------------------------

/** How long a body stays in the same cell of flowing water between hands before the stream is stopped, and how soon it is tried again. */
export const STREAM_HOLD_MS = 1000;
export const STREAM_HOLD_COOLDOWN_MS = 8000;

/**
 * Between hands nobody holds the body (run 6: 1.1 m south in a stream between two hands, the head thinking). A body that has stayed in flowing water for STREAM_HOLD_MS
 * with no skill running stops the stream (steadyInWater, on its own motor action; idle work at priority -1: a command cancels it at once).
 */
export function installStreamHold(bot: any): void {
  if (!bot || bot.streamHold) return;
  const state = { since: 0, key: '', last: 0, running: false };
  bot.streamHold = state;
  let tick = 0;
  bot.on('physicsTick', () => {
    if (++tick % 5 !== 0 || state.running) return;
    try {
      if (bot.executingSkill === true || (bot.health ?? 20) <= 0) { state.since = 0; return; }
      const feet = feetCell(bot);
      if (!feet || !flowingAt(bot, feet)) { state.since = 0; state.key = ''; return; }
      const key = `${feet.x},${feet.y},${feet.z}`;
      const now = Date.now();
      if (key !== state.key || !state.since) { state.key = key; state.since = now; return; }
      if (now - state.since < STREAM_HOLD_MS || now - state.last < STREAM_HOLD_COOLDOWN_MS) return;
      state.running = true; state.last = now; state.since = 0;
      void executeAction(bot, 'hold-footing', FOOTING_MAX_STREAM_MS + 1500, async () => {
        const base = feetCell(bot);
        if (!base) return { success: false, result: 'no body' };
        // The action's own signal and motor port: a command (cancelIdleActions) or a reflex that takes the body ends this at once, and a stopped action sends nothing.
        const stop = actionSignal(bot) ?? new AbortController().signal;
        const out = await steadyInWater({ bot: createMotorPort(bot), stop, deadline: Date.now() + FOOTING_MAX_STREAM_MS, facing: 'south', base });
        return { success: out.steady, result: out.words || '流れの中の足場' };
      }, { priority: -1, waitForQuiescence: false } as never).catch(() => undefined).finally(() => { state.running = false; });
    } catch { state.running = false; }
  });
}

/** As a mineflayer plugin. */
export function streamHoldPlugin(bot: unknown): void { installStreamHold(bot); }

// ---- the push history: what the water did to a body that was not walking ------------------------------------------------------------

const WALK_KEYS = ['forward', 'back', 'left', 'right'] as const;
/** A window of drift longer than this starts over (a body creeping on its own is not carried). */
const PUSH_WINDOW_MS = 3000;

/**
 * Samples the body's position every five ticks while the feet are in water and no walking key is held; the same-direction drift of 0.3 m or more is kept as bot.waterPush.
 * It reads and writes nothing else (it runs in a hand too: the stream hold does not). Idempotent.
 */
export function installWaterPush(bot: any): void {
  if (!bot || bot.waterPushInstalled === true) return;
  bot.waterPushInstalled = true;
  const sample = { x: 0, z: 0, at: 0, accX: 0, accZ: 0, start: 0, has: false };
  let tick = 0;
  bot.on('physicsTick', () => {
    if (++tick % 5 !== 0) return;
    try {
      const position = bot.entity?.position;
      const walking = WALK_KEYS.some(key => bot.controlState?.[key] === true);
      if (!position || bot.entity?.isInWater !== true || walking) { sample.has = false; return; }
      const now = Date.now();
      if (!sample.has) { Object.assign(sample, { x: position.x, z: position.z, at: now, accX: 0, accZ: 0, start: now, has: true }); return; }
      const dx = position.x - sample.x, dz = position.z - sample.z;
      sample.x = position.x; sample.z = position.z; sample.at = now;
      // The other way round: a new drift.
      if (sample.accX * dx + sample.accZ * dz < 0) { sample.accX = 0; sample.accZ = 0; sample.start = now; }
      sample.accX += dx; sample.accZ += dz;
      const meters = Math.hypot(sample.accX, sample.accZ);
      if (meters >= PUSH_MIN_M) bot.waterPush = { at: now, dx: sample.accX, dz: sample.accZ, meters } satisfies WaterPush;
      if (now - sample.start > PUSH_WINDOW_MS) { sample.accX = 0; sample.accZ = 0; sample.start = now; }
    } catch { sample.has = false; }
  });
}

/** As a mineflayer plugin. */
export function waterPushPlugin(bot: unknown): void { installWaterPush(bot); }

const compass = (dx: number, dz: number) => (Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? '東' : '西') : (dz > 0 ? '南' : '北'));

/**
 * One fact line for the planner's live state, only while the feet are in water or the body was pushed in the last 10 s (dry and unpushed: null). Facts only:
 * the water (flowing with its level / still with its depth), the push, the head, the feet.
 */
export function feetWaterWords(bot: any): string | null {
  const feet = feetCell(bot);
  if (!feet) return null;
  const inWater = holdsWater(blockAt(bot, feet));
  const push = pushedRecently(bot, PUSH_KEEP_MS);
  if (!inWater && !push) return null;
  const parts: string[] = [];
  if (inWater) {
    const level = waterLevel(bot, feet);
    if (level !== null && level > 0) parts.push(level >= 8 ? '落ちる水' : '流れる水');
    else {
      let depth = 1;
      while (depth < 8 && holdsWater(blockAt(bot, { x: feet.x, y: feet.y - depth, z: feet.z }))) depth++;
      parts.push(`止まった水（深さ ${depth}）`);
    }
  } else parts.push('水の外');
  if (push) parts.push(`直近 ${Math.max(1, Math.round((Date.now() - push.at) / 1000))} 秒で ${compass(push.dx, push.dz)}へ ${push.meters.toFixed(1)}m 押された`);
  if (inWater) {
    parts.push(eyeInWater(bot) ? '頭は水の中' : '頭は水の外');
    parts.push(bot.entity?.onGround === true ? '足は地面' : '足は浮いている');
  }
  return `足元: ${parts.join('・')}`;
}
