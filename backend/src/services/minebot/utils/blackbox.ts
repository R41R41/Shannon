import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:BlackBox');
const gzipAsync = promisify(gzip);

/**
 * The body's black box (2026-10-28, owner: 「黒箱・現場の保存・止めて直す実走を 1 つの版で」). Run 43's go stops took about 770 s, and what
 * happened inside them (each route search, the step that failed, the body tick by tick, the server putting it back, the blocks it dug and laid
 * and what the server answered, the creatures near) was seen only in the replay lab, never in a paid run; the cause was inferred from the world
 * after the run and the RCON samples every 12 s.
 *
 * Always on, no switch. The last WINDOW_MS (90 s) are kept in memory rings and written to a file when it matters:
 * - `ticks`: every physics tick (20 a second): the feet, the velocity, on the ground, the controls held, health;
 * - `events`: the server's corrections of the position (`forcedMove`), every route search (start, goal, status, nodes, ms, the first cells of the way),
 *   the route's resets and their reasons, each dig and place with its answer, the block changes near the body (the server's word on a dig or a place),
 *   health changes and hurts with the nearest threat, the body's own blows, the act's hands as they start and end;
 * - `near`: the creatures within 16 m every half second (kind, id, where, health);
 * - the reflex ledger's entries of the window, read when the box is written.
 * `dump` writes one gzip JSON under the run's directory (`<root>/<task>/<at>-<kind>-<id>.json.gz`), bounded per file, per run and in all.
 * The cost on the tick is measured (`stats`), and said in every file.
 */
export const BLACKBOX_WINDOW_MS = 90_000;
const NEAR_EVERY_TICKS = 10;
const NEAR_RANGE = 16;
const EVENTS_MAX = 6_000;
const PATH_CELLS = 32;
/** A file at most this many bytes before compression (the ticks are thinned from the oldest when over). */
const DUMP_RAW_MAX = 6_000_000;
/** Per run (task) directory and in all: the oldest go first. */
const RUN_FILES_MAX = 400, RUN_BYTES_MAX = 150_000_000, ALL_BYTES_MAX = 1_500_000_000;
const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const;

type Num = number;
/** [t, x, y, z, vx, vy, vz, onGround(0|1), controls bits, health] */
export type TickRow = [Num, Num, Num, Num, Num, Num, Num, 0 | 1, Num, Num];
export interface BoxEvent { t: number; k: string; [key: string]: unknown }
export interface NearRow { t: number; c: Array<[number, string, number, number, number, number | null]> }
export interface BlackBoxStats { ticks: number; meanUs: number; p99Us: number; maxUs: number; nearMeanUs: number }
export interface BlackBoxDump {
  v: 1; id: string; kind: string; at: string; reason: string; task: string | null; serverId: string | null; dimension: string | null;
  body: { pos: [number, number, number] | null; health: number | null; food: number | null; items: Array<{ slot: number; name: string; count: number; durabilityUsed?: number }>;
    armor: Array<{ slot: number; name: string; durabilityUsed?: number }>; yaw: number | null; pitch: number | null };
  act?: unknown; window: { from: number; to: number }; ticks: TickRow[]; events: BoxEvent[]; near: NearRow[]; reflexes: unknown[]; stats: BlackBoxStats;
  scene?: string | null;
}

const r3 = (value: number) => Math.round(value * 1000) / 1000;
const r2 = (value: number) => Math.round(value * 100) / 100;
const cell = (p: { x: number; y: number; z: number }) => [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
function goalText(goal: any): string {
  try {
    const name = goal?.constructor?.name ?? '?';
    if (Array.isArray(goal?.goals)) return `${name}[${goal.goals.slice(0, 4).map(goalText).join(';')}]`;
    const keys = ['x', 'y', 'z', 'rangeSq', 'range'].filter(key => typeof goal?.[key] === 'number').map(key => `${key}=${r2(goal[key])}`);
    return `${name}(${keys.join(',')})`;
  } catch { return '?'; }
}

export class BlackBox {
  private readonly ticks: TickRow[] = [];
  private readonly events: BoxEvent[] = [];
  private readonly near: NearRow[] = [];
  private tickCount = 0;
  private readonly costs = new Float64Array(2048);
  private costIndex = 0;
  private costSum = 0;
  private costMax = 0;
  private nearSum = 0;
  private nearCount = 0;
  task: string | null = null;
  serverId: string | null = null;
  /** Wraps the body's dig, placeBlock and attack (and the route search) again where another function was put over them; set by `installBlackBox`. */
  ensureWrapped: () => void = () => undefined;

  constructor(private readonly bot: any, readonly root: string, private readonly now: () => number = Date.now) {}

  /** One event into the ring (any module may add one: `blackBoxOf(bot)?.note(...)`). */
  note(kind: string, data: Record<string, unknown> = {}): void {
    this.events.push({ t: this.now(), k: kind, ...data });
    if (this.events.length > EVENTS_MAX) this.events.splice(0, this.events.length - EVENTS_MAX);
  }

  private prune(now: number): void {
    const from = now - BLACKBOX_WINDOW_MS;
    let drop = 0;
    while (drop < this.ticks.length && this.ticks[drop]![0] < from) drop++;
    if (drop) this.ticks.splice(0, drop);
    drop = 0;
    while (drop < this.events.length && this.events[drop]!.t < from) drop++;
    if (drop) this.events.splice(0, drop);
    drop = 0;
    while (drop < this.near.length && this.near[drop]!.t < from) drop++;
    if (drop) this.near.splice(0, drop);
  }

  /** The physics tick's sample (and every NEAR_EVERY_TICKS the creatures near), with its own cost measured. */
  tick(): void {
    const started = performance.now();
    const bot = this.bot, entity = bot.entity;
    if (!entity?.position) return;
    const t = this.now();
    let bits = 0;
    for (let i = 0; i < CONTROLS.length; i++) { try { if (bot.controlState?.[CONTROLS[i]!]) bits |= 1 << i; } catch { /* unread */ } }
    const p = entity.position, v = entity.velocity ?? { x: 0, y: 0, z: 0 };
    this.ticks.push([t, r3(p.x), r3(p.y), r3(p.z), r3(v.x), r3(v.y), r3(v.z), entity.onGround ? 1 : 0, bits, typeof bot.health === 'number' ? r2(bot.health) : -1]);
    this.tickCount++;
    if (this.tickCount % NEAR_EVERY_TICKS === 0) {
      const nearStarted = performance.now();
      const rows: NearRow['c'] = [];
      for (const other of Object.values(bot.entities ?? {}) as any[]) {
        if (!other?.position || other === entity || other.type === 'object' && other.name === 'item' && other.position.distanceTo(p) > 6) continue;
        if (other.position.distanceTo(p) > NEAR_RANGE) continue;
        rows.push([Number(other.id), String(other.name ?? other.username ?? other.type ?? '?'), r2(other.position.x), r2(other.position.y), r2(other.position.z),
          typeof other.health === 'number' ? r2(other.health) : null]);
      }
      this.near.push({ t, c: rows.slice(0, 40) });
      const nearCost = performance.now() - nearStarted;
      this.nearSum += nearCost; this.nearCount++;
    }
    if (this.tickCount % 200 === 0) this.prune(t);
    const cost = (performance.now() - started) * 1000;
    this.costSum += cost; this.costMax = Math.max(this.costMax, cost);
    this.costs[this.costIndex++ % this.costs.length] = cost;
  }

  stats(): BlackBoxStats {
    const filled = Math.min(this.costIndex, this.costs.length);
    const sorted = Array.from(this.costs.subarray(0, filled)).sort((a, b) => a - b);
    return { ticks: this.tickCount, meanUs: r2(this.costSum / Math.max(1, this.tickCount)), p99Us: r2(sorted[Math.floor(sorted.length * 0.99)] ?? 0),
      maxUs: r2(this.costMax), nearMeanUs: r2(this.nearSum * 1000 / Math.max(1, this.nearCount)) };
  }

  /** What the box holds now, with the body's state and the reflexes of the window. */
  snapshot(kind: string, reason: string, extra: { id?: string; act?: unknown; scene?: string | null } = {}): BlackBoxDump {
    const now = this.now();
    this.prune(now);
    const bot = this.bot;
    const from = now - BLACKBOX_WINDOW_MS;
    let reflexes: unknown[] = [];
    try { reflexes = (bot.reflexLedger?.entriesSince?.(-1) ?? []).filter((entry: any) => entry.at >= from); } catch { reflexes = []; }
    const items = ((bot.inventory?.slots ?? []) as any[]).flatMap((item, slot) => item ? [{ slot, name: String(item.name), count: Number(item.count),
      ...(item.durabilityUsed ? { durabilityUsed: Number(item.durabilityUsed) } : {}) }] : []);
    const p = bot.entity?.position;
    const id = extra.id ?? `${new Date(now).toISOString().replace(/[-:.]/gu, '').slice(0, 15)}-${kind}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      v: 1, id, kind, at: new Date(now).toISOString(), reason: reason.slice(0, 400), task: this.task, serverId: this.serverId,
      dimension: bot.game?.dimension ? String(bot.game.dimension) : null,
      body: { pos: p ? [r3(p.x), r3(p.y), r3(p.z)] : null, health: typeof bot.health === 'number' ? r2(bot.health) : null,
        food: typeof bot.food === 'number' ? bot.food : null, items: items.filter(item => item.slot >= 9 || item.slot === 45),
        armor: items.filter(item => item.slot >= 5 && item.slot <= 8).map(({ slot, name, durabilityUsed }) => ({ slot, name, ...(durabilityUsed ? { durabilityUsed } : {}) })),
        yaw: typeof bot.entity?.yaw === 'number' ? r3(bot.entity.yaw) : null, pitch: typeof bot.entity?.pitch === 'number' ? r3(bot.entity.pitch) : null },
      ...(extra.act !== undefined ? { act: extra.act } : {}),
      window: { from, to: now }, ticks: [...this.ticks], events: [...this.events], near: [...this.near], reflexes, stats: this.stats(),
      ...(extra.scene !== undefined ? { scene: extra.scene } : {}),
    };
  }

  /** Writes the box (gzip JSON) and keeps the directories within their bounds; resolves to the file, or null when it could not be written. */
  async dump(kind: string, reason: string, extra: { id?: string; act?: unknown; scene?: string | null } = {}): Promise<{ id: string; file: string; bytes: number; ms: number } | null> {
    const started = performance.now();
    const box = this.snapshot(kind, reason, extra);
    try {
      let raw = JSON.stringify(box);
      while (raw.length > DUMP_RAW_MAX && box.ticks.length > 200) { box.ticks.splice(0, Math.ceil(box.ticks.length / 4)); raw = JSON.stringify(box); }
      const data = await gzipAsync(Buffer.from(raw, 'utf8'));
      const dir = path.join(this.root, safe(this.task ?? 'no-task'));
      await fs.promises.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${box.id}.json.gz`);
      await fs.promises.writeFile(file, data);
      await this.tidy(dir).catch(() => undefined);
      const ms = Math.round(performance.now() - started);
      log.info(`📦 黒箱を書いた ${kind}: ${path.relative(this.root, file)} (${Math.round(data.length / 1024)} KB, ${ms} ms, tick 平均 ${box.stats.meanUs} µs / p99 ${box.stats.p99Us} µs) ${reason.slice(0, 120)}`);
      return { id: box.id, file, bytes: data.length, ms };
    } catch (error) {
      log.warn(`黒箱を書けなかった ${kind}: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
      return null;
    }
  }

  /** The run's directory within RUN_FILES_MAX / RUN_BYTES_MAX, and the root within ALL_BYTES_MAX (the oldest runs first). */
  private async tidy(dir: string): Promise<void> {
    const listed = async (where: string) => (await fs.promises.readdir(where, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isFile()).map(entry => path.join(where, entry.name));
    const sized = async (files: string[]) => Promise.all(files.map(async file => ({ file, ...(await fs.promises.stat(file).then(s => ({ bytes: s.size, at: s.mtimeMs }), () => ({ bytes: 0, at: 0 }))) })));
    const run = (await sized(await listed(dir))).sort((a, b) => a.at - b.at);
    let bytes = run.reduce((sum, entry) => sum + entry.bytes, 0);
    while (run.length > RUN_FILES_MAX || bytes > RUN_BYTES_MAX) { const gone = run.shift()!; bytes -= gone.bytes; await fs.promises.rm(gone.file, { force: true }); }
    const runs = (await fs.promises.readdir(this.root, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).map(entry => path.join(this.root, entry.name));
    const all = await Promise.all(runs.map(async where => { const files = await sized(await listed(where)); return { where, bytes: files.reduce((s, f) => s + f.bytes, 0), at: Math.max(0, ...files.map(f => f.at)) }; }));
    all.sort((a, b) => a.at - b.at);
    let total = all.reduce((sum, entry) => sum + entry.bytes, 0);
    while (all.length > 1 && total > ALL_BYTES_MAX) { const gone = all.shift()!; if (gone.where === dir) continue; total -= gone.bytes; await fs.promises.rm(gone.where, { recursive: true, force: true }); }
  }
}

const safe = (value: string) => String(value).replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 80);
const boxes = new WeakMap<object, BlackBox>();
export function blackBoxOf(bot: object | null | undefined): BlackBox | null { return bot ? boxes.get(bot) ?? null : null; }
/** Where the boxes go: MINEBOT_BLACKBOX_DIR, else `saves/minecraft/blackbox` of the body's working directory. */
export function blackBoxRoot(): string { return path.resolve(process.env.MINEBOT_BLACKBOX_DIR ?? 'saves/minecraft/blackbox'); }

/**
 * Installs the box on a bot (once): the tick sampler, the position corrections, the route searches and resets, digs, places and the server's block
 * changes near, health, hurts and the body's blows, and the act's hands. Wrappers are put on the host's own functions (go's counting wrappers
 * then wrap these, and put them back by identity).
 */
export function installBlackBox(bot: any, root = blackBoxRoot(), now: () => number = Date.now): BlackBox {
  const existing = boxes.get(bot);
  if (existing) return existing;
  const box = new BlackBox(bot, root, now);
  boxes.set(bot, box);
  bot.on?.('physicsTick', () => { try { box.tick(); } catch { /* the box never breaks the tick */ } });
  bot.on?.('forcedMove', () => {
    const p = bot.entity?.position;
    const last = box['ticks'].at(-1) as TickRow | undefined;
    if (p) box.note('forced', { to: [r3(p.x), r3(p.y), r3(p.z)], from: last ? [last[1], last[2], last[3]] : null });
  });
  bot.on?.('health', () => box.note('health', { hp: typeof bot.health === 'number' ? r2(bot.health) : null, food: bot.food ?? null }));
  bot.on?.('death', () => box.note('death', {}));
  bot.on?.('entityHurt', (entity: any) => {
    if (entity !== bot.entity) return;
    const p = bot.entity?.position;
    const near = p ? (Object.values(bot.entities ?? {}) as any[]).filter(e => e && e !== bot.entity && e.position && e.type === 'hostile' && e.position.distanceTo(p) <= 6)
      .map(e => ({ id: e.id, name: e.name, d: r2(e.position.distanceTo(p)) })).sort((a, b) => a.d - b.d).slice(0, 3) : [];
    box.note('hurt', { hp: typeof bot.health === 'number' ? r2(bot.health) : null, near });
  });
  bot.on?.('blockUpdate', (before: any, after: any) => {
    const at = after?.position ?? before?.position, p = bot.entity?.position;
    if (!at || !p || Math.abs(at.x + 0.5 - p.x) > 6 || Math.abs(at.y + 0.5 - p.y) > 6 || Math.abs(at.z + 0.5 - p.z) > 6) return;
    if (before?.name === after?.name) return;
    box.note('block', { at: cell(at), from: before?.name ?? null, to: after?.name ?? null });
  });
  bot.on?.('minebotActStep', (step: any) => box.note('hand', { i: step?.index, of: step?.total, status: step?.status, label: String(step?.label ?? '').slice(0, 80),
    detail: String(step?.detail ?? '').slice(0, 160) }));
  bot.on?.('path_update', (result: any) => {
    const way = Array.isArray(result?.path) ? result.path : [];
    box.note('path', { status: String(result?.status), nodes: result?.visitedNodes ?? 0, ms: Math.round(result?.time ?? 0), len: way.length,
      cells: way.slice(0, PATH_CELLS).map((node: any) => cell(node)), toBreak: way.reduce((s: number, n: any) => s + (n?.toBreak?.length ?? 0), 0),
      toPlace: way.reduce((s: number, n: any) => s + (n?.toPlace?.length ?? 0), 0) });
  });
  bot.on?.('path_reset', (reason: unknown) => box.note('reset', { reason: String(reason) }));
  bot.on?.('goal_reached', () => box.note('goal_reached', {}));
  // mineflayer gives the body dig, placeBlock and attack on its own next tick (its plugins load then): they are wrapped once, at the first moment
  // they are there (install, spawn, or the first ticks), before any act (go puts its counting wrappers over these and back by identity).
  // A plugin may put its own function over one of these after the box wrapped it (promptPlace replaces placeBlock): each is wrapped again, before
  // each act too (`ensureWrapped`, from utils/incidents), when the one there is not the box's.
  const wrapBody = () => {
    if (typeof bot.dig !== 'function' || typeof bot.placeBlock !== 'function') return;
    bot.__blackBoxBody = true;
    const wrap = (name: string, record: (args: unknown[], ok: boolean, ms: number, error?: string) => void) => {
      const original = bot[name];
      if (typeof original !== 'function' || original.__blackBox) return;
      bot[name] = Object.assign(async function (this: unknown, ...args: unknown[]) {
        const started = performance.now();
        try { const result = await original.apply(bot, args); record(args, true, performance.now() - started); return result; }
        catch (error) { record(args, false, performance.now() - started, String((error as Error)?.message ?? error).slice(0, 120)); throw error; }
      }, { __blackBox: true });
    };
    wrap('dig', (args, ok, ms, error) => { const block = args[0] as any; box.note('dig', { at: block?.position ? cell(block.position) : null, block: block?.name ?? null, ok, ms: Math.round(ms), ...(error ? { error } : {}) }); });
    wrap('placeBlock', (args, ok, ms, error) => {
      const ref = args[0] as any, face = args[1] as any, p = bot.entity?.position;
      const at = ref?.position && face ? [Math.floor(ref.position.x + face.x), Math.floor(ref.position.y + face.y), Math.floor(ref.position.z + face.z)] : null;
      box.note('place', { at, against: ref?.name ?? null, held: bot.heldItem?.name ?? null, ok, ms: Math.round(ms), feet: p ? [r3(p.x), r3(p.y), r3(p.z)] : null, ...(error ? { error } : {}) });
    });
    const attack = bot.attack;
    if (typeof attack === 'function' && !attack.__blackBox) {
      bot.attack = Object.assign(function (target: any, ...rest: unknown[]) { box.note('blow', { id: target?.id ?? null, name: target?.name ?? null }); return attack.call(bot, target, ...rest); }, { __blackBox: true });
    }
  };
  box.ensureWrapped = () => { try { wrapNav(); wrapBody(); } catch { /* the box never stops an act */ } };
  // Every route search the pathfinder makes (the go's drawings and the executor's own): its goal, start, status, nodes and time. The pathfinder
  // plugin may be loaded after the box: it is wrapped when it is there (at install, at spawn, and at the first tick that finds it).
  const wrapNav = () => {
  const nav = bot.pathfinder;
  if (nav && typeof nav.getPathFromTo === 'function' && !nav.__blackBox) {
    nav.__blackBox = true;
    const original = nav.getPathFromTo.bind(nav);
    nav.getPathFromTo = function* (movements: any, startPos: any, goal: any, options: any = {}) {
      const record: BoxEvent = { t: now(), k: 'search', goal: goalText(goal), from: startPos ? [r2(startPos.x), r2(startPos.y), r2(startPos.z)] : null,
        timeout: options?.timeout ?? null, status: 'begun', nodes: 0, ms: 0, len: 0, end: null };
      box['events'].push(record);
      const inner = original(movements, startPos, goal, options);
      for (;;) {
        const step = inner.next();
        if (step.done) return step.value;
        const result = step.value?.result;
        if (result) {
          record.status = String(result.status); record.nodes = result.visitedNodes ?? 0; record.ms = Math.round(result.time ?? 0); record.len = result.path?.length ?? 0;
          const end = result.path?.[result.path.length - 1]; record.end = end ? cell(end) : null;
        }
        yield step.value;
      }
    };
  }
  };
  wrapNav(); wrapBody();
  bot.once?.('spawn', () => { wrapNav(); wrapBody(); });
  const firstTicks = () => { wrapNav(); wrapBody(); if (bot.pathfinder?.__blackBox && bot.__blackBoxBody) bot.removeListener?.('physicsTick', firstTicks); };
  bot.on?.('physicsTick', firstTicks);
  return box;
}
