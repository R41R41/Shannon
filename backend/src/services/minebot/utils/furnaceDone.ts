/**
 * The batches in the furnaces that have come due (smelt, furnace, start-smelting all write `bot.activeFurnaces`): each is told once, as
 * the working event `furnace.done` ("かまど (x,y,z) の焼きが終わった"). The time is the body's estimate from the furnace's own progress
 * when the batch was put in; whether it is truly done is seen on taking it out (`completionVerified` stays false in the jobs).
 * - Told once per batch: the key is the furnace's cell, its dimension and the time the batch began, so a batch put in again is a new one,
 *   and a batch taken out before it was due (the entry is dropped) is never told.
 * - Not told while the body is in another dimension than the furnace's: it is told on the first reading after the body is back
 *   (`lateSec` says how long after the time it was due). The body being far from the furnace does not matter: the time is the time.
 */
export interface FurnaceBatch { pos: { x: number; y: number; z: number }; item?: string; count?: number; readyAt: number; startedAt?: number; dimension?: string; unfueledCount?: number;
  /** A wait has said it (`furnacesDueByNow`). */ waitTold?: boolean }
export interface FurnaceBody { activeFurnaces?: FurnaceBatch[]; game?: { dimension?: unknown } }
export interface FurnaceDone {
  subject: string;
  data: Record<string, string | number | boolean | null>;
}

/**
 * A batch come due, as said: done, or (run 43: five waits before a furnace out of fuel, about 420 s) stopped for want of fuel with how many smelted
 * and how many still need fuel.
 */
export function furnaceDoneWords(batch: FurnaceBatch): string {
  const { x, y, z } = batch.pos;
  return batch.unfueledCount
    ? `かまど (${x},${y},${z}) は燃料切れで止まった（焼けたのは約 ${batch.count ?? 0} 個。${batch.item ?? '材料'} ${batch.unfueledCount} 個は燃料が要る）`
    : `かまど (${x},${y},${z}) の焼きが終わった`;
}
/**
 * The batches due by `now` that no wait has said yet, as said (`furnaceDoneWords`), in this dimension; each is said by one wait only (run 43: the
 * waits came 50 s and more after the plank had burnt out, and the next ones too).
 */
export function furnacesDueByNow(bot: FurnaceBody, now: number): string[] {
  const here = String(bot.game?.dimension ?? '');
  const due = (Array.isArray(bot.activeFurnaces) ? bot.activeFurnaces : [])
    .filter(batch => batch?.pos && Number.isFinite(batch.readyAt) && batch.readyAt <= now && !batch.waitTold && !(batch.dimension && here && batch.dimension !== here));
  for (const batch of due) batch.waitTold = true;
  return due.map(furnaceDoneWords);
}

const keyOf = (batch: FurnaceBatch) => `${batch.dimension ?? ''}|${batch.pos.x},${batch.pos.y},${batch.pos.z}|${batch.startedAt ?? 0}`;

/** The batches due at `now` that have not been told (they are marked told in `told`), and `told` forgets the batches that are gone. */
export function dueFurnaces(bot: FurnaceBody, told: Set<string>, now: number): FurnaceDone[] {
  const batches = Array.isArray(bot.activeFurnaces) ? bot.activeFurnaces : [];
  const here = String(bot.game?.dimension ?? '');
  const live = new Set(batches.map(keyOf));
  for (const key of told) if (!live.has(key)) told.delete(key);
  const out: FurnaceDone[] = [];
  for (const batch of batches) {
    if (!batch?.pos || !Number.isFinite(batch.readyAt) || now < batch.readyAt) continue;
    const key = keyOf(batch);
    if (told.has(key)) continue;
    if (batch.dimension && here && batch.dimension !== here) continue;
    told.add(key);
    const { x, y, z } = batch.pos;
    out.push({ subject: `furnace:${x},${y},${z}`, data: {
      x, y, z, text: furnaceDoneWords(batch), input: batch.item ?? null, count: batch.count ?? null,
      dimension: batch.dimension ?? (here || null), lateSec: Math.round((now - batch.readyAt) / 1000), estimated: true,
      ...(batch.unfueledCount ? { unfueledCount: batch.unfueledCount } : {}),
    } });
  }
  return out;
}
