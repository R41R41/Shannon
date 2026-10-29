import { Vec3 } from 'vec3';
import { actionSignal } from '../../execution/ActionExecution.js';
import { feetCell, isOpenBlock, relativeCell, relativeWords, type Cell, type Facing } from '../localMap.js';
import { BLOCK_REACH } from '../blockReach.js';
import type { GoalOutcome, InventoryEvent, Progress } from '../../integration/commonFca/continueContract.js';

/**
 * What every part of `act` shares (design mb-llm-centric 2.3, 4: utils/primitives). A part does what its arguments say and nothing
 * else: no place chosen for it, no way round, no giving up after a count. When it cannot, it stops and says exactly why: the
 * block's name, its coordinates, and where it is from the body.
 */
export type PositionSpec = { x: number; y: number; z: number } | { front?: number; right?: number; up?: number };

export interface StepContext {
  /** The body to move (the act's motor port). */
  bot: any;
  /** Aborted when the act has to stop now: its stopIf, a reflex, the command's end. */
  stop: AbortSignal;
  /** When the whole act must be over (ms since the epoch). */
  deadline: number;
  /** The facing relative positions are read in (the act's, or the body's at the step's start). */
  facing: Facing;
  /** The feet cell when the step began: the origin of relative positions. */
  base: Cell;
  /** Tells the act a step made progress (for the UI's step list and the long-step watch). */
  progress?(detail: string): void;
  /** Continue contracts (3): tells the act an inventory change the part has made as it makes it (an ingredient used, a thing made); the act numbers it and keeps it even if the hand is cut after. */
  record?(event: Omit<InventoryEvent, 'id' | 'obsSeq' | 'deliverySeq'>): void;
}

export interface StepOutcome {
  ok: boolean;
  /** One line for the planner (what was done, or where and why it stopped). */
  text: string;
  /** Why it stopped, as a short code (not_reachable, occupied, missing_item, no_path ...). */
  reason?: string;
  /** The root of the stop in a few words (what held the body: the search, the water, the shut door), put first in the line (utils/actReport stoppedLine). */
  cause?: string;
  /** The cell it is about (the target, or where it stopped). */
  at?: Cell;
  /** Where the body stood or walked from (a walk's stop). */
  from?: Cell;
  /**
   * Continue contracts (1): how far the part got, by the part's own measure (a unit and a count, never read back out of the line's words).
   * The act puts it in the hand's result (HandOutcome.progress).
   */
  progress?: Progress;
  /**
   * Continue contracts (1): the part's own verdict where the ok flag cannot say it: 'already' (ok, nothing was changed: the aim held when the
   * hand began) or 'unknown' (the part could not see whether its aim was met: an attack whose target went out of sight). Without it an ok
   * hand is 'done' and a failed one 'failed' (or 'partial' when it has progress).
   */
  goal?: Extract<GoalOutcome, 'already' | 'unknown'>;
  /** The closed code of the hand's stop (HandOutcome.code); the part's `reason` when it has none of its own. */
  code?: string;
  /** Continue contracts (3): the inventory changes this part made (an ingredient used, a thing made), one event each; intermediate ones marked. */
  events?: InventoryEvent[];
  /** What the act's result carries beside the line (the contract's ActResult): a thrown eye, a container's contents, arrows left. */
  data?: {
    eye?: { from: Cell; bearingDeg: number; flew: number; to: Cell; broke: boolean };
    container?: { at: Cell; kind: string; items: string[] };
    arrowsLeft?: number;
    /** A walk that entered a portal and ended in the other dimension (the act ends there). */
    crossedDimension?: true;
    /** A go: what it dug and laid and how far it walked (the hands that use go for the way, `mine`, count on it). */
    work?: { dug: number; placed: number; steps: number; redraws: number };
    /** A vertical: the ores that showed on its way (told, never followed), 8 at most. */
  };
}

/** Thrown inside a part when the act stops it (the reason is the act's). */
export class StepStopped extends Error {
  constructor(readonly why: string) { super(`step stopped: ${why}`); this.name = 'StepStopped'; }
}

export const vec = (cell: Cell) => new Vec3(cell.x, cell.y, cell.z);
export const cellText = (cell: Cell) => `(${cell.x},${cell.y},${cell.z})`;

/** A position from the planner: absolute, or "front / right / up n" from the feet in the act's facing. */
export function resolvePosition(ctx: Pick<StepContext, 'facing' | 'base'>, spec: PositionSpec | null | undefined): Cell | null {
  if (!spec || typeof spec !== 'object') return null;
  const absolute = spec as { x?: unknown; y?: unknown; z?: unknown };
  const given = [absolute.x, absolute.y, absolute.z].filter(value => value !== undefined && value !== null);
  if (given.length === 3) {
    const s = spec as { x: number; y: number; z: number };
    if (![s.x, s.y, s.z].every(value => typeof value === 'number' && Number.isFinite(value))) return null;
    return { x: Math.floor(s.x), y: Math.floor(s.y), z: Math.floor(s.z) };
  }
  // Part of an absolute cell is no cell (and never mixed with a relative one).
  if (given.length) return null;
  const rel = spec as { front?: number; right?: number; up?: number };
  if (![rel.front ?? 0, rel.right ?? 0, rel.up ?? 0].every(value => typeof value === 'number' && Number.isFinite(value))) return null;
  return relativeCell(ctx.base, ctx.facing, rel);
}

/** "(x,y,z)（東3・上1）": a cell and where it lies from the body now. */
export function placeText(bot: any, cell: Cell): string {
  const feet = feetCell(bot);
  return feet ? `${cellText(cell)}（自分から${relativeWords(feet, cell)}）` : cellText(cell);
}

/** What a cell holds now, in a word ("stone", "air", "未ロード"). */
export function cellNow(bot: any, cell: Cell): string {
  let block: any;
  try { block = bot.blockAt?.(vec(cell), false); } catch { block = null; }
  if (!block) return '未ロード';
  let extra = '';
  if (block.name === 'water' || block.name === 'lava') {
    try { const level = Number(block.getProperties?.().level ?? block.metadata ?? 0); extra = level === 0 ? '（源）' : `（流れ ${level}）`; } catch { /* plain */ }
  }
  return `${block.name}${extra}`;
}

export function blockAt(bot: any, cell: Cell): any {
  try { return bot.blockAt?.(vec(cell), false) ?? null; } catch { return null; }
}
export function isAirLike(block: any): boolean {
  if (!block) return false;
  return isOpenBlock({ name: String(block.name), solid: block.boundingBox === 'block' });
}

const EYE_HEIGHT = 1.62;
/** Distance from the eyes to the centre of a cell. */
export function eyeDistance(bot: any, cell: Cell): number {
  const at = bot.entity?.position;
  if (!at) return Infinity;
  return Math.hypot(at.x - (cell.x + 0.5), at.y + EYE_HEIGHT - (cell.y + 0.5), at.z - (cell.z + 0.5));
}
/** How far the hand reaches for digging, placing and using a block (a chest, a furnace, a bucket): one number (utils/blockReach). */
export const USE_REACH = BLOCK_REACH;
export const DIG_REACH = BLOCK_REACH;

/** Sleeps `ms`, ended early (StepStopped) by the act's stop or the action's own abort. */
export function wait(ctx: Pick<StepContext, 'stop' | 'bot'>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = actionSignal(ctx.bot);
    if (ctx.stop.aborted) { reject(new StepStopped(String(ctx.stop.reason ?? 'stopped'))); return; }
    if (signal?.aborted) { reject(new Error('Action interrupted')); return; }
    const timer = setTimeout(done, Math.max(0, ms));
    function cleanup() { clearTimeout(timer); ctx.stop.removeEventListener('abort', onStop); signal?.removeEventListener('abort', onAbort); }
    function done() { cleanup(); resolve(); }
    function onStop() { cleanup(); reject(new StepStopped(String(ctx.stop.reason ?? 'stopped'))); }
    function onAbort() { cleanup(); reject(new Error('Action interrupted')); }
    ctx.stop.addEventListener('abort', onStop, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Waits for a native promise, but no longer than the act's stop, the action's abort, or `timeoutMs` (then null). */
export async function guard<T>(ctx: Pick<StepContext, 'stop' | 'bot'>, native: Promise<T>, timeoutMs = 30_000): Promise<{ value: T } | null> {
  native.catch(() => { /* an abandoned native call must not surface as unhandled */ });
  const signal = actionSignal(ctx.bot);
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { if (timer) clearTimeout(timer); ctx.stop.removeEventListener('abort', onStop); signal?.removeEventListener('abort', onAbort); };
    const onStop = () => { cleanup(); reject(new StepStopped(String(ctx.stop.reason ?? 'stopped'))); };
    const onAbort = () => { cleanup(); reject(new Error('Action interrupted')); };
    if (ctx.stop.aborted) { onStop(); return; }
    if (signal?.aborted) { onAbort(); return; }
    ctx.stop.addEventListener('abort', onStop, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { cleanup(); resolve(null); }, Math.max(0, timeoutMs));
    native.then(value => { cleanup(); resolve({ value }); }, error => { cleanup(); reject(error); });
  });
}

/** Polls `predicate` until true (true), the time is up (false), or the act stops (StepStopped). */
export async function waitUntil(ctx: Pick<StepContext, 'stop' | 'bot'>, predicate: () => boolean, timeoutMs: number, everyMs = 50): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try { if (predicate()) return true; } catch { /* read again */ }
    if (Date.now() >= until) return false;
    await wait(ctx, Math.min(everyMs, Math.max(1, until - Date.now())));
  }
}

export function inventoryCount(bot: any, name: string): number {
  return (bot.inventory?.items?.() ?? []).filter((item: any) => item.name === name).reduce((sum: number, item: any) => sum + item.count, 0);
}
export function findItem(bot: any, name: string): any {
  return (bot.inventory?.items?.() ?? []).find((item: any) => item.name === name) ?? null;
}
/** "bread×3 cobblestone×20": what the pack holds of these names (all, when none are given), for a result line. */
export function packLine(bot: any, names?: string[]): string {
  const counts = new Map<string, number>();
  for (const item of bot.inventory?.items?.() ?? []) if (!names || names.includes(item.name)) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  return [...counts.entries()].map(([name, count]) => `${name}×${count}`).join(' ') || 'なし';
}
/** Free slots of the pack (36 slots, armour and the off hand apart). */
export function freeSlots(bot: any): number {
  const slots: any[] = bot.inventory?.slots ?? [];
  let free = 0;
  for (let slot = 9; slot <= 44; slot++) if (!slots[slot]) free++;
  return free;
}

/**
 * Run 47 (hold 5): a go or a vertical does not need room in the pack to arrive: what it digs falls and is not picked up. Taken at the start, the returned function tells at the end, when the
 * pack is full, how many dug things lie unpicked (the item entities that were not lying at the start), as a clause for the result line; empty when there is room.
 */
export function fullPackWatch(bot: any): () => string {
  const isItem = (entity: any) => entity?.name === 'item' || entity?.displayName === 'Item';
  const before = new Set<number>();
  for (const entity of Object.values(bot.entities ?? {}) as any[]) if (isItem(entity)) before.add(entity.id);
  return () => {
    if (freeSlots(bot) > 0) return '';
    const kinds = new Map<string, number>();
    let total = 0;
    for (const entity of Object.values(bot.entities ?? {}) as any[]) {
      if (!isItem(entity) || before.has(entity.id)) continue;
      let stack: { name?: string; count?: number } | null = null;
      try { stack = entity.getDroppedItem?.() ?? null; } catch { stack = null; }
      if (!stack?.name) continue;
      const count = Math.max(1, Number(stack.count ?? 1));
      kinds.set(stack.name, (kinds.get(stack.name) ?? 0) + count); total += count;
    }
    const names = [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name).join('・');
    return total ? `持ち物が満杯（掘った ${names} は拾えずに落ちた ${total} 個）` : '持ち物が満杯（拾えずに落ちた物は無い）';
  };
}

/** Everything that drives the body, let go (a step that stops leaves no key down and no path running). */
export function letGo(bot: any): void {
  for (const stop of [() => bot.pathfinder?.stop?.(), () => bot.pathfinder?.setGoal?.(null), () => bot.stopDigging?.(), () => bot.deactivateItem?.(),
    () => bot.clearControlStates?.()]) {
    try { stop(); } catch { /* the rest still */ }
  }
}

/** A failed step's outcome, with the cell's place and what it holds now. */
export function stopped(bot: any, reason: string, text: string, at?: Cell, from?: Cell, cause?: string): StepOutcome {
  return { ok: false, reason, text, ...(at ? { at } : {}), ...(from ? { from } : {}), ...(cause ? { cause } : {}) };
}

export const DIRECTIONS: Record<string, [number, number, number]> = {
  down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0],
};
export const DIRECTION_JA: Record<string, string> = { down: '下', up: '上', north: '北', south: '南', west: '西', east: '東' };
