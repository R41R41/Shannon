import type { P3 } from './dragonParts.js';
import { bedIsFire, type BedBlockReader } from './dragonBedGeometry.js';

/** Lab-only passive notice. No observer means the lazy detail reader is never evaluated. */
export interface BedBurstDiagnostic { stage: string; code: string; tick: number; [key: string]: unknown }
const observers = new WeakMap<object, Set<(event: BedBurstDiagnostic) => void>>();
export function hasBedBurstDiagnosticObservers(bot: object): boolean { return !!observers.get(bot)?.size; }
export function watchBedBurstDiagnostics(bot: object, observer: (event: BedBurstDiagnostic) => void): () => void {
  const rows = observers.get(bot) ?? new Set(); rows.add(observer); observers.set(bot, rows);
  return () => { rows.delete(observer); if (!rows.size) observers.delete(bot); };
}
export function noteBedBurstDiagnostic(bot: object, detail: () => BedBurstDiagnostic | null): void {
  const rows = observers.get(bot); if (!rows?.size) return;
  try { const event = detail(); if (!event) return; for (const observer of [...rows]) { try { observer(structuredClone(event)); } catch { /* a notice cannot change the hand */ } } }
  catch { /* diagnostic reads cannot authorize, refuse or fail the hand */ }
}
/** Same 3x3x4 neighbourhood as landingBedFireClear, retaining null rather than classifying unread as air. */
export function bedBurstFireCells(read: BedBlockReader, stand: P3) {
  const cells = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 2; dy++) {
    const at = { x: Math.floor(stand.x) + dx, y: Math.floor(stand.y) + dy, z: Math.floor(stand.z) + dz }, block = read(at);
    cells.push({ at, name: block?.name ?? null, loaded: !!block, fire: !!block && bedIsFire(block) });
  }
  return cells;
}
