import { activeActionCapabilities } from '../execution/ActionExecution.js';
import { refusedCells } from './serverRefusals.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:Motion');

const SAMPLE_MS = 250;
const KEEP = 40;
const CONTROLS = ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak'] as const;

export interface MotionSample {
  at: number;
  x: number; y: number; z: number;
  vy: number;
  onGround: boolean;
  health: number | null;
  controls: string[];
  /** The pathfinder goal type, which names a mover that runs outside any action (e.g. a reflex). */
  goal: string | null;
  actions: string[];
}

interface RecorderBot {
  entity?: { position: { x: number; y: number; z: number }; velocity: { y: number }; onGround: boolean };
  health?: number;
  getControlState?(control: string): boolean;
  pathfinder?: { goal?: object | null };
  blockAt?(position: unknown, extraInfos?: boolean): { name?: string; boundingBox?: string } | null;
  on(event: 'death' | 'end' | 'forcedMove' | 'physicsTick', listener: () => void): unknown;
}

/**
 * What the client believed where the server refused it: how far the claimed
 * position was from the one the server put back (to the centimetre: a rise or
 * fall of a few hundredths says "floor" or "ceiling", a sideways step says
 * "wall"), and the blocks the client holds around the body there. The server
 * refuses a move that runs into something the client does not have; this
 * names the cell the two disagree about.
 */
function describeDisagreement(bot: RecorderBot, claimed: { x: number; y: number; z: number; onGround: boolean; vy: number } | null): string {
  const server = bot.entity?.position;
  if (!server || !claimed) return '';
  const dx = claimed.x - server.x, dy = claimed.y - server.y, dz = claimed.z - server.z;
  const parts = [`主張との差=(${dx.toFixed(2)},${dy.toFixed(2)},${dz.toFixed(2)}) サーバー位置=(${server.x.toFixed(2)},${server.y.toFixed(2)},${server.z.toFixed(2)}) ${claimed.onGround ? '接地' : '空中'} vy=${claimed.vy.toFixed(2)}`];
  const position = server as any;
  if (typeof bot.blockAt === 'function' && typeof position.offset === 'function') {
    const name = (ox: number, oy: number, oz: number) => { try { return bot.blockAt!(position.offset(ox, oy, oz).floored(), false)?.name ?? '?'; } catch { return '?'; } };
    const sx = Math.abs(dx) > 0.01 ? Math.sign(dx) * 0.31 : 0, sz = Math.abs(dz) > 0.01 ? Math.sign(dz) * 0.31 : 0;
    parts.push(`クライアントの世界: 足元の下=${name(0, -0.1, 0)} 足=${name(0, 0.1, 0)} 頭=${name(0, 1.7, 0)} 頭上=${name(0, 2.1, 0)}`
      + (sx || sz ? ` 進む先の足=${name(sx, 0.1, sz)} 進む先の頭=${name(sx, 1.7, sz)} 進む先の足元の下=${name(sx, -0.1, sz)}` : ''));
  }
  // Every cell the body was entering, as the client holds it: the one the two sides disagree about is among them.
  if (typeof bot.blockAt === 'function' && typeof position.offset === 'function') {
    const entering = refusedCells(claimed, { x: server.x, y: server.y, z: server.z }).slice(0, 8).map(cell => {
      const [x, y, z] = cell.split(',').map(Number);
      let name = '?';
      try { name = bot.blockAt!(position.offset(x - server.x, y - server.y, z - server.z).floored(), false)?.name ?? '?'; } catch { /* unreadable */ }
      return `(${cell})=${name}`;
    });
    if (entering.length) parts.push(`入ろうとしたセル: ${entering.join(' ')}`);
  }
  return ` ${parts.join(' ')}`;
}

/** Server position corrections seen by this body: how many, and the last few. */
export interface ForcedMoves { count: number; recent: Array<{ at: number; from: string; to: string }> }
const corrections = new WeakMap<object, ForcedMoves>();
export function forcedMoves(bot: object): ForcedMoves { return corrections.get(bot) ?? { count: 0, recent: [] }; }

const traces = new WeakMap<object, MotionSample[]>();
const round = (value: number) => Math.round(value * 10) / 10;

export function sampleMotion(bot: RecorderBot, at = Date.now()): MotionSample | null {
  const entity = bot.entity;
  if (!entity) return null;
  return {
    at, x: round(entity.position.x), y: round(entity.position.y), z: round(entity.position.z), vy: round(entity.velocity.y),
    onGround: entity.onGround, health: bot.health ?? null,
    controls: CONTROLS.filter(control => { try { return bot.getControlState?.(control) ?? false; } catch { return false; } }),
    goal: bot.pathfinder?.goal ? bot.pathfinder.goal.constructor.name : null,
    actions: activeActionCapabilities(bot),
  };
}

export function recentMotion(bot: object): MotionSample[] { return [...(traces.get(bot) ?? [])]; }

/**
 * What the body was doing just before an outcome, without coordinates: how far
 * it fell, and which mover had the controls when it left the ground. Death
 * reflections otherwise only see the server's death message.
 */
export function describeRecentMotion(samples: MotionSample[]): string | null {
  if (samples.length < 2) return null;
  const last = samples[samples.length - 1];
  const window = samples.filter(sample => last.at - sample.at <= 5000);
  let launch = -1;
  for (let i = window.length - 1; i >= 0; i--) if (window[i].onGround) { launch = i; break; }
  const peak = window.reduce((max, sample) => Math.max(max, sample.y), -Infinity);
  const drop = peak - last.y;
  const parts: string[] = [];
  if (drop >= 4) parts.push(`直前5秒で約${Math.round(drop)}ブロック降下`);
  const mover = launch >= 0 ? window[launch] : last;
  const who = mover.actions.length ? `行動=${mover.actions.join(',')}` : mover.goal ? `行動なしで経路目標=${mover.goal}（反射的な移動）` : '行動・経路目標なし';
  const controls = mover.controls.length ? mover.controls.join('+') : 'なし';
  parts.push(`${launch >= 0 ? '最後に接地していた時点' : '直前'}の${who}、操作=${controls}`);
  return parts.join('。');
}

/** Keep a short ring buffer of the body's motion and print it on death. */
export function installMotionRecorder(bot: RecorderBot): void {
  if (traces.has(bot)) return;
  const trace: MotionSample[] = [];
  traces.set(bot, trace);
  const timer = setInterval(() => {
    const sample = sampleMotion(bot);
    if (!sample) return;
    trace.push(sample);
    if (trace.length > KEEP) trace.splice(0, trace.length - KEEP);
  }, SAMPLE_MS);
  timer.unref?.();
  // The server puts the body back when it rejects a move (into a block it
  // still has, too fast, an unconfirmed teleport). Nothing recorded these: a
  // bot stood frozen for ten minutes, every move ending where it began, and
  // the log could not say whether the server was holding it (paid run L26).
  const forced: ForcedMoves = { count: 0, recent: [] };
  corrections.set(bot, forced);
  let lastNoted = 0;
  // The exact position the body last claimed, tick by tick: the quarter-second samples are too coarse to tell floor from wall.
  let claimed: { x: number; y: number; z: number; onGround: boolean; vy: number } | null = null;
  bot.on('physicsTick', () => {
    const entity = bot.entity;
    if (entity) claimed = { x: entity.position.x, y: entity.position.y, z: entity.position.z, onGround: entity.onGround, vy: entity.velocity.y };
  });
  bot.on('forcedMove', () => {
    const before = trace[trace.length - 1];
    const now = bot.entity?.position;
    if (!now) return;
    forced.count++;
    forced.recent.push({ at: Date.now(), from: before ? `${before.x},${before.y},${before.z}` : '?', to: `${round(now.x)},${round(now.y)},${round(now.z)}` });
    if (forced.recent.length > 8) forced.recent.shift();
    if (Date.now() - lastNoted > 10_000) {
      lastNoted = Date.now();
      log.warn(`↩ サーバーが位置を戻した（累計${forced.count}回）: (${forced.recent[forced.recent.length - 1].from}) → (${forced.recent[forced.recent.length - 1].to}) 行動=${activeActionCapabilities(bot).join(',') || '-'}${describeDisagreement(bot, claimed)}`);
    }
  });
  bot.on('death', () => {
    const final = sampleMotion(bot);
    if (final) trace.push(final);
    const lines = trace.slice(-20).map(sample => `${new Date(sample.at).toISOString().slice(11, 23)} (${sample.x},${sample.y},${sample.z}) vy=${sample.vy}`
      + ` ${sample.onGround ? '接地' : '空中'} HP=${sample.health ?? '?'} 操作=${sample.controls.join('+') || '-'} 目標=${sample.goal ?? '-'} 行動=${sample.actions.join(',') || '-'}`);
    log.warn(`🎞 死亡直前の動き:\n${lines.join('\n')}\n要約: ${describeRecentMotion(trace) ?? '不明'}`);
  });
  bot.on('end', () => clearInterval(timer));
}
