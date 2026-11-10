import type { Cell } from '../localMap.js';
import { lifeOf } from '../life.js';

/**
 * The cells this body's own hands dug out (a mine or a dig that finished one): a small memory, so that a later hand naming a cell an earlier hand already took
 * ("the same tree, queued twice"; a vein followed past the cell a later mine names) is told "already mined" and not "no such block". Per body, per life, at most
 * DUG_MAX cells, each kept DUG_KEEP_MS. In memory only.
 */
export const DUG_MAX = 512;
export const DUG_KEEP_MS = 5 * 60_000;

interface Entry { name: string; at: number }
const books = new WeakMap<object, { life: number | null; cells: Map<string, Entry> }>();
const keyOf = (cell: Cell) => `${cell.x},${cell.y},${cell.z}`;
const lifeNumber = (bot: any): number | null => { try { return lifeOf(bot)?.number ?? null; } catch { return null; } };

function bookOf(bot: object) {
  const life = lifeNumber(bot);
  let book = books.get(bot);
  if (!book || book.life !== life) { book = { life, cells: new Map() }; books.set(bot, book); }
  return book;
}

/** `name` was dug out of `cell` by this body. */
export function noteDugCell(bot: object, cell: Cell, name: string): void {
  const book = bookOf(bot);
  book.cells.delete(keyOf(cell));
  book.cells.set(keyOf(cell), { name, at: Date.now() });
  while (book.cells.size > DUG_MAX) book.cells.delete(book.cells.keys().next().value as string);
}

/** The block this body dug out of `cell` in the last five minutes, or null. */
export function dugCellName(bot: object, cell: Cell): string | null {
  const entry = bookOf(bot).cells.get(keyOf(cell));
  return entry && Date.now() - entry.at <= DUG_KEEP_MS ? entry.name : null;
}
