import { scanLoadedBlocks } from './loadedBlockScan.js';

/**
 * Looking for the end portal's frames around a place where two eyes cross (S2, 2026-11-02).
 *
 * The method follows aibengineering/mine-ai-mcp (MIT, src/actions/locate-stronghold/locate-stronghold.ts: `loadedStrongholdFrame` and
 * `survey`) and is written afresh for this body: the frames are read from the chunks the server has sent, over their whole height (the
 * portal room lies tens of blocks below the surface), and only `end_portal_frame` counts as the portal room (the stronghold's stone bricks lie
 * in many other places, and the infested ones only say a stronghold is near). When no frame is in the loaded chunks, rings of points sixteen
 * blocks apart (the square rings at 16, 32 ... up to the radius from the centre) are what to walk, each walk loading the columns round it;
 * which points are worth walking is told from what the scans have already covered. The walking is the planner's (a go hand); nothing here moves.
 */

export const FRAME_RING_STEP = 16;
export const FRAME_SEARCH_DEFAULT = 64;
export const FRAME_SEARCH_MAX = 128;
/** The frames listed at most (a stronghold's portal room has twelve). */
const FRAMES_LISTED = 12;
/** The points of the survey given back at a time. */
const POINTS_GIVEN = 6;

export interface FrameHit { x: number; y: number; z: number; /** Blocks from the centre, level. */ horizontal: number; eye: boolean | null }
export interface FrameScan {
  frames: FrameHit[]; /** The furthest loaded column's centre from the body, level. */ reach: number; columns: number;
  /** With no frame in the radius: the loaded frame beyond it nearest the body (review 11/10 G20: it was read and then cut without a word). */
  outside?: FrameHit;
}
export interface SurveyPoint { x: number; z: number; ring: number }

interface ScanBody {
  entity?: { position: { x: number; y: number; z: number } };
  registry: { blocksByName: Record<string, { minStateId?: number; maxStateId?: number } | undefined> };
  world: { getColumns?(): Array<{ chunkX: number | string; chunkZ: number | string; column: any }> };
  blockAt?(position: any, extraInfos?: boolean): any;
}

/** The frames in the loaded chunks within `radius` blocks of the centre (level, any height), nearest the centre first. */
export function framesAround(bot: ScanBody, center: { x: number; z: number }, radius: number): FrameScan {
  const body = bot.entity?.position ?? { x: center.x, y: 64, z: center.z };
  // The scan measures in three dimensions from the body; the portal room is far below a body on the surface, so ask wide and cut level.
  const scan = scanLoadedBlocks(bot as any, ['end_portal_frame'], { maxHits: 64, maxDistance: radius + Math.abs(body.x - center.x) + Math.abs(body.z - center.z) + 320 });
  const frames: FrameHit[] = [];
  let outside: FrameHit | undefined;
  for (const hit of scan.hits) {
    const horizontal = Math.hypot(hit.position.x - center.x, hit.position.z - center.z);
    // The hits come nearest the body first: of those beyond the radius, the first is kept.
    if (horizontal > radius && outside) continue;
    let eye: boolean | null = null;
    try { const properties = bot.blockAt?.(hit.position, false)?.getProperties?.(); if (properties) eye = properties.eye === true || properties.eye === 'true'; } catch { eye = null; }
    const frame = { x: hit.position.x, y: hit.position.y, z: hit.position.z, horizontal: Math.round(horizontal * 10) / 10, eye };
    if (horizontal > radius) outside = frame; else frames.push(frame);
  }
  frames.sort((a, b) => a.horizontal - b.horizontal);
  return { frames: frames.slice(0, FRAMES_LISTED), reach: scan.reachMetres, columns: scan.columns, ...(outside && !frames.length ? { outside } : {}) };
}

/**
 * The points of the square rings round the centre: at 16, 32 ... up to the radius, each ring's points sixteen blocks apart along its four sides
 * (the corners included), the rings from the inside out and each ring in a walk round it from the side nearest `from`.
 */
export function ringPoints(center: { x: number; z: number }, radius: number, from?: { x: number; z: number }): SurveyPoint[] {
  const out: SurveyPoint[] = [];
  const top = Math.min(FRAME_SEARCH_MAX, Math.max(FRAME_RING_STEP, Math.floor(radius / FRAME_RING_STEP) * FRAME_RING_STEP));
  for (let ring = FRAME_RING_STEP; ring <= top; ring += FRAME_RING_STEP) {
    // A walk round the square: the north side west to east, the east side north to south, the south side east to west, the west side south to north.
    const side: Array<{ x: number; z: number }> = [];
    for (let x = -ring; x < ring; x += FRAME_RING_STEP) side.push({ x, z: -ring });
    for (let z = -ring; z < ring; z += FRAME_RING_STEP) side.push({ x: ring, z });
    for (let x = ring; x > -ring; x -= FRAME_RING_STEP) side.push({ x, z: ring });
    for (let z = ring; z > -ring; z -= FRAME_RING_STEP) side.push({ x: -ring, z });
    let start = 0;
    if (from) {
      let best = Infinity;
      side.forEach((p, index) => { const d = Math.hypot(center.x + p.x - from.x, center.z + p.z - from.z); if (d < best) { best = d; start = index; } });
    }
    for (let i = 0; i < side.length; i++) {
      const p = side[(start + i) % side.length];
      out.push({ x: Math.floor(center.x + p.x), z: Math.floor(center.z + p.z), ring });
    }
  }
  return out;
}

/** Where a scan was made and how far the loaded columns reached from there: the area it has covered. */
export interface Covered { x: number; z: number; reach: number }

/**
 * The survey points no earlier scan covers: a point within `reach - margin` of a place already scanned from adds nothing to look at (its own
 * columns were loaded then), so it is not walked to. `margin` is how much of the loaded edge is trusted (the columns at the very edge are the
 * ones a body that has just arrived has not finished receiving).
 */
export function uncovered(points: SurveyPoint[], scans: Covered[], margin = 16): SurveyPoint[] {
  return points.filter(point => !scans.some(scan => Math.hypot(point.x - scan.x, point.z - scan.z) <= Math.max(0, scan.reach - margin)));
}

/** The next points to walk, nearest the body first within the ring being done. */
export function nextSurveyPoints(points: SurveyPoint[], scans: Covered[], from: { x: number; z: number }): SurveyPoint[] {
  const left = uncovered(points, scans);
  if (!left.length) return [];
  const ring = Math.min(...left.map(point => point.ring));
  return left.filter(point => point.ring === ring)
    .sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z)).slice(0, POINTS_GIVEN);
}

/** The survey the body has made round one centre: the scans (where, how far they reached), so a later call knows what is covered. */
export interface FrameSurvey { center: { x: number; z: number }; radius: number; scans: Covered[] }

/** The survey held on the body for this centre (a centre within 24 blocks of the last is the same search); a new centre starts a new survey. */
export function surveyOf(holder: { frameSurvey?: FrameSurvey }, center: { x: number; z: number }, radius: number): FrameSurvey {
  const held = holder.frameSurvey;
  if (held && Math.hypot(held.center.x - center.x, held.center.z - center.z) <= 24 && held.radius >= radius) return held;
  return (holder.frameSurvey = { center: { x: Math.floor(center.x), z: Math.floor(center.z) }, radius, scans: [] });
}
