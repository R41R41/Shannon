/**
 * The scan kept for the observation's `world.scan` (r4 contract 1; made by utils/worldScan at a spawn). Apart from the scan itself so the
 * observation reads it without the scan's imports.
 */
import { compassDirection } from './landmarks.js';

/** "北東 60m・下 3": the compass way and distance across from `from` to a cell's centre, then up or down from the feet's cell. */
export function wayWords(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): string {
  const across = Math.hypot(to.x + 0.5 - from.x, to.z + 0.5 - from.z);
  const dy = Math.round(to.y - Math.floor(from.y + 1e-3));
  const way = across < 0.75 ? 'ここ' : `${compassDirection(from, { x: to.x + 0.5, z: to.z + 0.5 })} ${Math.round(across)}m`;
  return `${way}・${dy > 0 ? `上 ${dy}` : dy < 0 ? `下 ${-dy}` : '同じ高さ'}`;
}

export type ScanTrigger = 'login' | 'reconnect' | 'respawn' | 'portal';
export interface WorldScanState {
  trigger: ScanTrigger;
  /** When the scan ended (ISO). */
  at: string;
  dimension: string;
  center: { x: number; y: number; z: number };
  text: string;
  rows: string[];
  chunks: number;
  reach: number;
  ms: number;
  partial?: boolean;
}

/** The observation's `world.scan`: the last scan, while the body is in the dimension it was made in. */
export function worldScanView(bot: unknown): WorldScanState | null {
  const body = bot as { worldScan?: WorldScanState; game?: { dimension?: unknown } } | undefined;
  const scan = body?.worldScan;
  if (!scan || scan.dimension !== String(body?.game?.dimension ?? '')) return null;
  return scan;
}
