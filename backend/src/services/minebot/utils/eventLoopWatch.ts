/**
 * A watch on the body's own process: how long the event loop stood still, and what it was doing.
 *
 * Run 20 (2026-10-20): 21 s after the body respawned 400 m from where it died and was told to walk back, the server
 * dropped it ("Timed out"; the server wants a keep-alive answer within 15 s). The body's journal had no line for 69.7
 * seconds, and nothing in the body measured the loop, so the cause (a long path search, the burst of chunks after the
 * respawn, a blocked write) could not be told. Three things are kept now:
 *
 *  1. A timer that notices when it ran late (>= 1 s by default) and says how late, with what the body was doing:
 *     the longest gap between physics ticks, chunks loaded since, the slowest event handlers and packets, the path
 *     executor, the action running, memory.
 *  2. A worker thread that watches a heartbeat the main thread writes. When the main thread has been silent for
 *     two seconds it asks the main thread's inspector where it is (Debugger.pause), and writes the top of the stack
 *     straight to stderr and to a file, from the worker, so it is out while the main thread is still stuck.
 *  3. A line a minute with the loop's worst delay, the garbage collector's time, and memory.
 *
 * MINEBOT_LOOP_WATCH=off turns all of it off; MINEBOT_LOOP_LAG_WARN_MS (default 1000), MINEBOT_LOOP_STALL_SAMPLE_MS
 * (default 2000, 0 = no worker) tune it. Nothing here changes what the body does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance, monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { createLogger } from '../../../utils/logger.js';
import { activeActionCapabilities } from '../execution/ActionExecution.js';

const log = createLogger('Minebot:EventLoop');

const TIMER_MS = 250;
const SUMMARY_MS = 60_000;
const SLOW_EMIT_MS = 100;
const WORST_KEPT = 4;

export interface LoopWatchOptions {
  /** Lag (ms) at which a line is written. */
  warnMs: number;
  /** Silence (ms) after which the worker samples the main thread's stack; 0 for no worker. */
  stallSampleMs: number;
  /** Where the worker also appends its lines (one JSON per line). */
  stallFile: string | null;
}

export function loopWatchOptions(env: NodeJS.ProcessEnv = process.env): LoopWatchOptions | null {
  if ((env.MINEBOT_LOOP_WATCH ?? 'on') === 'off') return null;
  const number = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return value !== undefined && value !== '' && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    warnMs: Math.max(100, number(env.MINEBOT_LOOP_LAG_WARN_MS, 1000)),
    // 1.2 s: run 25's stalls of 1.6-1.8 s (six of them) left no stack at the 2 s this was, and where they stood was not known.
    stallSampleMs: number(env.MINEBOT_LOOP_STALL_SAMPLE_MS, 1200),
    // The worker's line goes to stderr (the journal) always; a file of JSON lines too only when asked for.
    stallFile: env.MINEBOT_LOOP_STALL_FILE ? path.resolve(env.MINEBOT_LOOP_STALL_FILE) : null,
  };
}

/** What the worker thread runs (plain CommonJS, so that it needs no loader and no build step of its own). */
export const STALL_WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const inspector = require('node:inspector');
const heartbeat = new Float64Array(workerData.buffer);
const stallMs = workerData.stallMs;
let session = null;
let sampling = false;
let sampleStartedAt = 0;
let lastSampleAt = 0;
let episodeStartedAt = 0;
function emit(line, record) {
  try { fs.writeSync(2, line + '\\n'); } catch (error) { /* nowhere to write */ }
  if (workerData.file) { try { fs.appendFileSync(workerData.file, JSON.stringify(record) + '\\n'); } catch (error) { /* the line above stands */ } }
}
function frameText(frame) {
  const url = String(frame.url || '').replace(/^file:\\/\\//, '').split('/').slice(-3).join('/');
  return (frame.functionName || '(anonymous)') + '@' + url + ':' + (frame.lineNumber + 1) + ':' + (frame.columnNumber + 1);
}
function finish(frames, stalledMs, note) {
  sampling = false;
  lastSampleAt = Date.now();
  const top = (frames || []).slice(0, 10).map(frameText);
  const record = { at: new Date().toISOString(), stalledMs, episodeMs: Date.now() - episodeStartedAt, top, note: note || null };
  emit('[EVENT_LOOP_STALL] the main thread has been silent for ' + stalledMs + ' ms; where it is: ' + (top.length ? top.join(' <- ') : '(no stack: ' + (note || 'unknown') + ')'), record);
}
function sample(stalledMs) {
  if (sampling) {
    if (Date.now() - sampleStartedAt > 15000) { sampling = false; try { session.post('Debugger.disable'); } catch (error) { /* gone */ } finish([], stalledMs, 'inspector did not answer in 15 s'); }
    return;
  }
  if (Date.now() - lastSampleAt < workerData.repeatMs) return;
  sampling = true;
  sampleStartedAt = Date.now();
  try {
    if (!session) {
      session = new inspector.Session();
      session.connectToMainThread();
      session.on('Debugger.paused', (message) => {
        let frames = [];
        try {
          frames = message.params && message.params.callFrames ? message.params.callFrames.map((frame) => ({
            functionName: frame.functionName, url: frame.url, lineNumber: frame.location.lineNumber, columnNumber: frame.location.columnNumber })) : [];
        } catch (error) { /* the resume below matters more than the stack */ }
        // Resumed first; the session is let go only once the main thread has answered both (a lingering session is also what makes a
        // process say "Waiting for the debugger to disconnect" when it exits).
        const gone = session;
        try {
          gone.post('Debugger.resume', () => {
            try { gone.post('Debugger.disable', () => { try { gone.disconnect(); } catch (error) { /* gone */ } if (session === gone) session = null; }); }
            catch (error) { /* gone */ }
          });
        } catch (error) { /* gone */ }
        finish(frames, Math.round(Date.now() - heartbeat[0]), null);
      });
    }
    session.post('Debugger.enable', () => { try { session.post('Debugger.pause'); } catch (error) { sampling = false; } });
  } catch (error) {
    sampling = false;
    lastSampleAt = Date.now();
    emit('[EVENT_LOOP_STALL] the main thread has been silent for ' + stalledMs + ' ms (no stack: ' + String(error && error.message || error) + ')', { at: new Date().toISOString(), stalledMs, top: [], note: String(error && error.message || error) });
  }
}
setInterval(() => {
  const silent = Date.now() - heartbeat[0];
  if (silent < stallMs) { if (episodeStartedAt) episodeStartedAt = 0; return; }
  if (!episodeStartedAt) episodeStartedAt = heartbeat[0];
  sample(Math.round(silent));
}, 500);
parentPort && parentPort.postMessage('ready');
`;

interface ProcessWatch { stop(): void }
type ContextProvider = () => Record<string, unknown>;

const providers = new Set<ContextProvider>();
let processWatch: ProcessWatch | null = null;

/** What the body knows about itself now, for the line written after a stall. Returns what it registered, to be called to unregister. */
export function addLoopContext(provider: ContextProvider): () => void {
  providers.add(provider);
  return () => { providers.delete(provider); };
}

function collectContext(): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  for (const provider of providers) {
    try { Object.assign(context, provider()); } catch { /* a provider must never break the watch */ }
  }
  return context;
}

const mb = (bytes: number) => Math.round(bytes / 1048576);

/** Starts the process-wide timer, the delay histogram, the GC observer and the worker (once per process). */
export function startEventLoopWatch(options: LoopWatchOptions | null = loopWatchOptions()): ProcessWatch | null {
  if (!options) return null;
  if (processWatch) return processWatch;
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let gcMs = 0; let gcMaxMs = 0; let gcCount = 0;
  let gcObserver: PerformanceObserver | null = null;
  try {
    gcObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) { gcMs += entry.duration; gcMaxMs = Math.max(gcMaxMs, entry.duration); gcCount++; }
    });
    gcObserver.observe({ entryTypes: ['gc'] });
  } catch { gcObserver = null; }

  const buffer = typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(8) : null;
  const heartbeat = buffer ? new Float64Array(buffer) : null;
  if (heartbeat) heartbeat[0] = Date.now();
  let worker: Worker | null = null;
  if (heartbeat && options.stallSampleMs > 0) {
    try {
      if (options.stallFile) fs.mkdirSync(path.dirname(options.stallFile), { recursive: true });
      worker = new Worker(STALL_WORKER_SOURCE, { eval: true, workerData: { buffer, stallMs: options.stallSampleMs, repeatMs: 5000, file: options.stallFile } });
      worker.on('error', error => { log.warn(`stall sampler stopped: ${error instanceof Error ? error.message : String(error)}`); });
      worker.unref();
    } catch (error) {
      worker = null;
      log.warn(`stall sampler not started: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let last = performance.now();
  let lastSummary = last;
  let worstLagMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = now - last - TIMER_MS;
    last = now;
    if (heartbeat) heartbeat[0] = Date.now();
    worstLagMs = Math.max(worstLagMs, lag);
    if (lag >= options.warnMs) {
      const context = collectContext();
      log.warn(`⏱ event loop が ${Math.round(lag)} ms 止まっていました（いまの記録）: ${JSON.stringify({ ...context, rssMB: mb(process.memoryUsage().rss),
        heapMB: mb(process.memoryUsage().heapUsed), gcMsSinceLastSummary: Math.round(gcMs), gcMaxMs: Math.round(gcMaxMs) })}`);
    }
    if (now - lastSummary >= SUMMARY_MS) {
      lastSummary = now;
      const usage = process.memoryUsage();
      log.info(`⏱ event loop 1分: 最大遅れ ${Math.round(worstLagMs)} ms / p99 ${Math.round(histogram.percentile(99) / 1e6)} ms / 最大 ${Math.round(histogram.max / 1e6)} ms、`
        + `GC ${gcCount} 回 ${Math.round(gcMs)} ms（最長 ${Math.round(gcMaxMs)} ms）、rss ${mb(usage.rss)} MB、heap ${mb(usage.heapUsed)} MB`);
      worstLagMs = 0; gcMs = 0; gcMaxMs = 0; gcCount = 0; histogram.reset();
    }
  }, TIMER_MS);
  timer.unref();

  processWatch = {
    stop() {
      clearInterval(timer);
      histogram.disable();
      gcObserver?.disconnect();
      void worker?.terminate();
      processWatch = null;
    },
  };
  return processWatch;
}

// ─── The bot's side: ticks, chunks, slow handlers ───────────────────────────────────────────────

/** What the watch needs of a mineflayer bot (the rest is read defensively). */
export interface WatchableBot {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  emit: (event: string, ...args: any[]) => unknown;
  _client?: { emit: (event: string, ...args: any[]) => unknown; on(event: string, listener: (...args: any[]) => void): unknown };
  entity?: { position: { x: number; y: number; z: number } };
  pathfinder?: { goal?: unknown; isMoving?(): boolean; isMining?(): boolean; isBuilding?(): boolean };
}

export interface BotLoopStats {
  /** Longest gap between two physics ticks since the last read, ms. */
  maxTickGapMs: number;
  /** Chunk columns loaded since the last read. */
  chunkLoads: number;
  /** When the chunk columns last arrived, and when the body last respawned or spawned (Date.now(); 0 for never). */
  lastChunkLoadAt: number;
  respawnedAt: number;
  /** The slowest handlers of events and packets since the last read: [name, ms]. */
  slow: Array<[string, number]>;
}

export interface BotLoopWatch {
  stats: BotLoopStats;
  /** Reads and clears the window counters. */
  take(): { maxTickGapMs: number; chunkLoads: number; slow: Array<[string, number]> };
  dispose(): void;
}

const watches = new WeakMap<object, BotLoopWatch>();

export function botLoopWatch(bot: object): BotLoopWatch | undefined { return watches.get(bot); }

/** Wraps `emitter.emit` so that a handler (or a whole packet) that takes long is remembered by name. Returns the undo. */
function timeEmits(emitter: { emit: (event: string, ...args: any[]) => unknown }, watched: (event: string, args: any[]) => string | null,
  note: (name: string, ms: number) => void): () => void {
  const original = emitter.emit;
  const wrapped = function (this: unknown, event: string, ...args: any[]) {
    const name = watched(event, args);
    if (name === null) return original.apply(this, [event, ...args] as never);
    const started = performance.now();
    try { return original.apply(this, [event, ...args] as never); }
    finally { const took = performance.now() - started; if (took >= SLOW_EMIT_MS) note(name, took); }
  };
  emitter.emit = wrapped as typeof emitter.emit;
  return () => { if (emitter.emit === wrapped) emitter.emit = original; };
}

/**
 * Starts the process watch (if not started) and the bot's side: the gap between physics ticks, the chunk arrivals,
 * the slow handlers. Written to the journal with each stall line.
 */
export function installBotLoopWatch(bot: WatchableBot, options: LoopWatchOptions | null = loopWatchOptions()): BotLoopWatch | null {
  if (!options) return null;
  const existing = watches.get(bot);
  if (existing) return existing;
  startEventLoopWatch(options);
  const stats: BotLoopStats = { maxTickGapMs: 0, chunkLoads: 0, lastChunkLoadAt: 0, respawnedAt: 0, slow: [] };
  let lastTickAt = performance.now();
  const note = (name: string, ms: number) => {
    stats.slow.push([name, Math.round(ms)]);
    stats.slow.sort((a, b) => b[1] - a[1]);
    if (stats.slow.length > WORST_KEPT) stats.slow.length = WORST_KEPT;
  };
  const onTick = () => {
    const now = performance.now();
    stats.maxTickGapMs = Math.max(stats.maxTickGapMs, now - lastTickAt);
    lastTickAt = now;
  };
  const onChunk = () => { stats.chunkLoads++; stats.lastChunkLoadAt = Date.now(); };
  const onRespawn = () => { stats.respawnedAt = Date.now(); };
  bot.on('physicsTick', onTick);
  bot.on('chunkColumnLoad', onChunk);
  bot.on('respawn', onRespawn);
  bot.on('spawn', onRespawn);
  const undo: Array<() => void> = [];
  try {
    undo.push(timeEmits(bot, event => event === 'physicsTick' || event === 'chunkColumnLoad' || event === 'blockUpdate' || event === 'entityMoved' ? event : null, note));
    if (bot._client) undo.push(timeEmits(bot._client, (event, args) => event === 'packet' ? `packet:${String(args[1]?.name ?? '?')}` : null, note));
  } catch { /* timing is a nicety: the counters above stand */ }

  const describe = () => {
    const taken = take();
    const position = bot.entity?.position;
    const pathfinder = bot.pathfinder;
    return {
      maxTickGapMs: Math.round(taken.maxTickGapMs), lastTickAgoMs: Math.round(performance.now() - lastTickAt), chunkLoads: taken.chunkLoads,
      slowest: taken.slow, sinceRespawnMs: stats.respawnedAt ? Date.now() - stats.respawnedAt : null,
      at: position ? [Math.round(position.x), Math.round(position.y), Math.round(position.z)] : null,
      goal: pathfinder?.goal ? (pathfinder.goal as object).constructor?.name ?? 'goal' : null,
      pathfinder: pathfinder ? [pathfinder.isMoving?.() ? 'moving' : null, pathfinder.isMining?.() ? 'mining' : null, pathfinder.isBuilding?.() ? 'building' : null].filter(Boolean) : null,
      actions: (() => { try { return activeActionCapabilities(bot); } catch { return []; } })(),
    };
  };
  const take = () => {
    const taken = { maxTickGapMs: stats.maxTickGapMs, chunkLoads: stats.chunkLoads, slow: stats.slow.slice() };
    stats.maxTickGapMs = 0; stats.chunkLoads = 0; stats.slow = [];
    return taken;
  };
  const removeContext = addLoopContext(describe);
  const watch: BotLoopWatch = {
    stats,
    take,
    dispose() {
      bot.removeListener('physicsTick', onTick);
      bot.removeListener('chunkColumnLoad', onChunk);
      bot.removeListener('respawn', onRespawn);
      bot.removeListener('spawn', onRespawn);
      for (const undoOne of undo) undoOne();
      removeContext();
      watches.delete(bot);
    },
  };
  watches.set(bot, watch);
  bot.on('end', () => watch.dispose());
  return watch;
}
