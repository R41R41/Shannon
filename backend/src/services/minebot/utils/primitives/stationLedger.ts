import type { Cell } from '../localMap.js';
import { lifeOf } from '../life.js';

/**
 * The work stations this body set down (run 5, 2026-11-11: five crafting tables and four furnaces placed, one taken back, the rest left standing
 * with 16 planks and 32 cobblestone in them). A small list on the body, in memory: `place` writes it (every station placement ends there, `make` and
 * `smelt` too), `carryAway` (stations.ts) reads it before a hand that moves the body far from one. A station in another life or another dimension
 * is not the body's to carry any more. Never written to a file.
 */
export const STATION_BLOCKS = new Set(['crafting_table', 'furnace', 'blast_furnace', 'smoker']);
export const STATION_MAX = 8;

export interface Station { block: string; x: number; y: number; z: number; dim: string; life: number | null; told: boolean;
  /** A furnace whose input or output slot held something when the body last looked (a batch with no `activeFurnaces` entry: the burn was not observed). */
  holds?: boolean;
  /** Pickup attempts that left the station standing (stations.ts gives up after two) and when the last one began. */
  tries?: number; lastTry?: number }

const lists = new WeakMap<object, Station[]>();
const dimOf = (bot: any) => String(bot?.game?.dimension ?? 'unknown');
const lifeNumber = (bot: any): number | null => { try { return lifeOf(bot)?.number ?? null; } catch { return null; } };

/** The stations of this life (the list is cleared of other lives'). */
export function stationsOf(bot: object): Station[] {
  const life = lifeNumber(bot);
  const kept = (lists.get(bot) ?? []).filter(station => station.life === life);
  lists.set(bot, kept);
  return kept;
}

/** `block` was set down at `cell` by this body (only the four station kinds are kept). */
export function noteStation(bot: object, block: string, cell: Cell): void {
  if (!STATION_BLOCKS.has(block)) return;
  const kept = stationsOf(bot).filter(station => !(station.x === cell.x && station.y === cell.y && station.z === cell.z && station.dim === dimOf(bot)));
  kept.push({ block, x: cell.x, y: cell.y, z: cell.z, dim: dimOf(bot), life: lifeNumber(bot), told: false });
  while (kept.length > STATION_MAX) kept.shift();
  lists.set(bot, kept);
}

/** What the furnace at `cell` holds, as the body last saw it in its window (written by furnaceWork; a station not in the list is not noted). */
export function noteStationContents(bot: object, cell: Cell, holds: boolean): void {
  const station = stationsOf(bot).find(other => other.x === cell.x && other.y === cell.y && other.z === cell.z && other.dim === dimOf(bot));
  if (station) station.holds = holds;
}

export function forgetStation(bot: object, station: Station): void {
  lists.set(bot, stationsOf(bot).filter(other => other !== station));
}

export const currentDimension = dimOf;
