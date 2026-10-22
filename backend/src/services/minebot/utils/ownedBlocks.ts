import { bedHalves, isBedName } from './bedRules.js';

/**
 * Whose block it is (r8, run 32: the body's own bed, placed 200 seconds before, stopped its dig as "守られた物" and cost a hand). A small
 * ledger of what this body put in the world: every block it placed (the `place` hand, and any skill through mineflayer's `blockPlaced`), a
 * bed's two halves, and the bed it slept in (the spawn point). A protected block (a bed, a chest, a crafting table, a furnace) that the
 * ledger holds, still standing as the block it placed, is the body's own: a dig does not stop at it. One that is not in the ledger may be a
 * village's or another player's, and the dig stops there and says so.
 *
 * Kept on the body in memory (it lives as long as the connection); never written to a file. It reports only: no hand is chosen by it.
 */
export type OwnedKind = 'placed' | 'spawn_bed';
export interface OwnedRecord { name: string; kind: OwnedKind; at: number }

const BODY_KEY = 'ownedBlocks';
type Holder = { [BODY_KEY]?: Map<string, OwnedRecord>; game?: { dimension?: unknown } };

const dimensionOf = (bot: Holder) => String(bot.game?.dimension ?? 'unknown');
const keyOf = (bot: Holder, cell: { x: number; y: number; z: number }) => `${dimensionOf(bot)}|${cell.x},${cell.y},${cell.z}`;
const ledgerOf = (bot: Holder): Map<string, OwnedRecord> => (bot[BODY_KEY] ??= new Map());

/** The most the ledger keeps (the oldest go first). */
const LEDGER_MAX = 4000;

/** `name` was put at `cell` by this body. */
export function noteOwned(bot: object, cell: { x: number; y: number; z: number }, name: string, kind: OwnedKind = 'placed', now = Date.now()): void {
  const holder = bot as Holder;
  const ledger = ledgerOf(holder);
  const key = keyOf(holder, cell);
  ledger.delete(key);
  ledger.set(key, { name: String(name).replace(/^minecraft:/u, ''), kind, at: now });
  while (ledger.size > LEDGER_MAX) { const oldest = ledger.keys().next().value; if (oldest === undefined) break; ledger.delete(oldest); }
}

/** The record for `cell` when the block standing there now (`nowName`) is the one this body put there; else null (gone, or something else is there). */
export function ownedAt(bot: object, cell: { x: number; y: number; z: number }, nowName: string): OwnedRecord | null {
  const holder = bot as Holder;
  const record = holder[BODY_KEY]?.get(keyOf(holder, cell));
  if (!record) return null;
  return record.name === String(nowName).replace(/^minecraft:/u, '') ? record : null;
}

/** A bed the body slept in: the respawn point. Both halves are given (the cells the bed fills). */
export function noteSpawnBed(bot: object, cells: Array<{ x: number; y: number; z: number }>, name: string, now = Date.now()): void {
  if (!isBedName(name)) return;
  for (const cell of cells) noteOwned(bot, cell, name, 'spawn_bed', now);
}

/** "自分で置いた物（41秒前）" / "自分のスポーン地点のベッド"; what a dig says it let through. */
export function ownerWords(record: OwnedRecord, now = Date.now()): string {
  if (record.kind === 'spawn_bed') return '自分のスポーン地点のベッド';
  const seconds = Math.max(0, Math.round((now - record.at) / 1000));
  return `自分で置いた物（${seconds >= 120 ? `${Math.round(seconds / 60)}分前` : `${seconds}秒前`}）`;
}

/** mineflayer plugin: every block this body places, by any skill (`blockPlaced` fires once the server has taken the block). */
export function ownedBlocksPlugin(bot: unknown): void {
  const body = bot as { on?(event: string, listener: (...args: any[]) => void): unknown };
  body.on?.('blockPlaced', (_old: unknown, placed: { position?: { x: number; y: number; z: number }; name?: string }) => {
    try {
      if (!placed?.position || !placed.name) return;
      const cell = { x: placed.position.x, y: placed.position.y, z: placed.position.z };
      noteOwned(bot as object, cell, placed.name);
      // A bed is put down as a pair: the other half is the body's own too (the server sends it a tick later).
      if (isBedName(placed.name)) { const halves = bedHalves(placed, cell); if (halves) noteOwned(bot as object, halves.other, placed.name); }
    } catch { /* a ledger is a help */ }
  });
}
