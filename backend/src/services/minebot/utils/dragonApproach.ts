import { Vec3 } from 'vec3';
import { boxDistance, boxesOverlap, bodyBoxAt, flameCloudCentre, inflate, isPerched, partBox, shift, BREATH_RADIUS_MIN, type P3 } from './dragonParts.js';
import { cloudReaches, lyingCloudZones } from './dragonDanger.js';
import { fountainOf, STRIKE_REACH } from './dragonState.js';
import { feetCentre, inland, walkGround, walkRoute, type WalkSearch, type WalkCell } from './dragonWalk.js';
import { cellKey, type Cell } from './localMap.js';
import { goWalkRouteChecker, worldWatchOf } from './primitives/go.js';

/** Measured in the Shannon lab, 2026-11-02: docs/minecraft-end-fight.md, 止まり木の周期.
 * Samples, not an execution timer. Damage of about 50 can end a perch early. */
export const PERCH_MEASURED = {
  landingSeconds: 10, scanSeconds: [1.2, 1.3], roarSeconds: 2, roarSafeSeconds: 1.25,
  flameSeconds: [9.9, 10], perchSeconds: 27, windowsPerPerch: 2, nextPerchSeconds: [23, 48],
} as const;
export interface DragonWindows {
  source: 'shannon-lab-2026-11-02'; open: boolean;
  /** Sample ranges in seconds from now; null when no countdown was measured for this phase. */
  secondsUntil: [number, number] | null; lengthSeconds: [number, number]; remainingSeconds: [number, number] | null;
}
export function dragonWindows(phase: number | null, elapsed: number): DragonWindows {
  const m = PERCH_MEASURED, e = Math.max(0, elapsed), length: [number, number] = [m.scanSeconds[0] + m.roarSafeSeconds, m.scanSeconds[1] + m.roarSafeSeconds];
  let until: [number, number] | null = null, remaining: [number, number] | null = null;
  if (phase === 6 && e < m.scanSeconds[1]) { until = [0, 0]; remaining = [Math.max(0, length[0] - e), Math.max(0, length[1] - e)]; }
  else if (phase === 7 && e < m.roarSafeSeconds) { until = [0, 0]; remaining = [m.roarSafeSeconds - e, m.roarSafeSeconds - e]; }
  else if (phase === 7 && e <= m.roarSeconds) until = [m.roarSeconds - e + m.flameSeconds[0], m.roarSeconds - e + m.flameSeconds[1]];
  else if (phase === 5 && e <= m.flameSeconds[1]) until = [Math.max(0, m.flameSeconds[0] - e), Math.max(0, m.flameSeconds[1] - e)];
  else if (phase === 3 && e <= m.landingSeconds) until = [m.landingSeconds - e, m.landingSeconds - e];
  else if (phase === 4 && e <= m.nextPerchSeconds[1]) until = [Math.max(0, m.nextPerchSeconds[0] - e), m.nextPerchSeconds[1] - e];
  return { source: 'shannon-lab-2026-11-02', open: remaining !== null, secondsUntil: until, lengthSeconds: length, remainingSeconds: remaining };
}

export interface DragonApproach {
  /** Connected basin footing; wing push is reported, never exempted from the floor reflex. Absent without a proven walk. */
  basin?: Array<P3 & { walkMeters: number; /** Estimate at walking speed, without sprint or execution delays. */ walkSeconds: number;
    /** Eye to the nearest head/neck/body/wing box. */ headReach: number; inWingPush: boolean; inBreathNow: boolean;
    /** Facing projection: side 0, front 1, behind -1. */ side: number }>;
  strike: Array<P3 & { headReach: number; walkMeters: number }>;
  /** Wait clear of the whole perch, then use strike[strikeIndex] when the window opens. */
  stage?: Array<P3 & { toStrikeMeters: number; walkMeters: number; strikeIndex: number }>;
  /** Retain these while perched, for the LLM to choose a go after phase 4. */
  retreat: Array<P3 & { walkMeters: number }>;
  /** Waiting footing 10 to 14 m from the perch centre, sideways of the facing (|side| <= 0.25), clear of the whole perch and reachable by a go-checked walk: where to wait before the sit and to go back to after it. Landing, take-off and the sit. */
  wait?: Array<P3 & { walkMeters: number; walkSeconds: number; side: number; /** Always false: footing in the wing push zone or the breath (now or forecast) is not offered. */ inWingPush: false; inBreathNow: false }>;
}

/** Same grown contact boxes as the reflex by default; walking can report wing push separately. Always exclude the future flame, even in the early safe window. */
export function perchClearance(bot: any, dragon: { position: P3; yaw?: number }, clearance = 0, avoidWings = true): (feet: P3) => boolean {
  const boxes = [inflate(partBox(dragon, 'head'), 1.1 + clearance), inflate(partBox(dragon, 'neck'), 1.1 + clearance),
    ...(avoidWings ? wingPushBoxes(dragon, clearance) : [])];
  const clouds = lyingCloudZones(bot);
  const flame = flameCloudCentre(dragon);
  let ground: number | null = null;
  for (let y = Math.floor(flame.y); y >= flame.y - 40; y--) {
    const b = bot.blockAt(new Vec3(Math.floor(flame.x), y, Math.floor(flame.z)));
    if (!b) return () => false;
    if (b.boundingBox === 'block') { ground = y + 1; break; }
  }
  const centre = { ...flame, y: ground ?? flame.y };
  return feet => ground !== null && !boxes.some(box => boxesOverlap(bodyBoxAt(feet), box)) &&
    !clouds.some(zone => cloudReaches(zone.centre, zone.radius, feet, Math.max(0.5, clearance))) &&
    !cloudReaches(centre, BREATH_RADIUS_MIN, feet, Math.max(0.5, clearance));
}
export const approachClear = (bot: any, dragon: { position: P3; yaw?: number }, feet: P3): boolean => perchClearance(bot, dragon)(feet);
const wingPushBoxes = (dragon: { position: P3; yaw?: number }, clearance = 0) =>
  (['wing1', 'wing2'] as const).map(part => inflate(shift(inflate(partBox(dragon, part), 4, 2, 4), 0, -2, 0), 0.1 + clearance));

/** Geometry only. Ideas learned from mine-ai-mcp (MIT, aibengineering, https://github.com/aibengineering/mine-ai-mcp):
 * separate perch geometry, preparation and observed timing. Written for Shannon, no copied code or automatic combat sequence. */
const approachCache = new WeakMap<object, { key: string; at: number; value: DragonApproach }>();
/** How long a computed approach stands (the perch lasts about 27 s and the head does not move on it) and the time one computation may take (lab r30-r32: 12 ms for the scan found no cell on a loaded machine). */
const APPROACH_CACHE_MS = 900, APPROACH_SCAN_MS = 60, APPROACH_TOTAL_MS = 120;
export function dragonApproach(bot: any, dragon: any, phase: number | null, perch = fountainOf(bot)): DragonApproach | undefined {
  const landingOrTakeoff = phase === 3 || phase === 4;
  if (!isPerched(phase) && !landingOrTakeoff) { approachCache.delete(bot); return undefined; }
  const me = bot.entity?.position, watch = worldWatchOf(bot);
  // A moved/growing cloud, vertical move or edited floor must invalidate basin routes even inside the 900 ms cache.
  const key = JSON.stringify([isPerched(phase) ? "sit" : phase, me && [Math.floor(me.x), Math.floor(me.y), Math.floor(me.z)], dragon.id, dragon.position, dragon.yaw,
    perch, lyingCloudZones(bot), watch.epoch, watch.tick]);
  const held = approachCache.get(bot), clock = Date.now();
  if (held && held.key === key && clock - held.at < APPROACH_CACHE_MS) return held.value;
  const value = landingOrTakeoff ? computeWaitOnly(bot, dragon, perch) : computeApproach(bot, dragon, perch);
  if (value) approachCache.set(bot, { key, at: clock, value });
  return value;
}
/** Landing and take-off: the parts are moving, so only the waiting footing is offered (by the facing the dragon has now). */
function computeWaitOnly(bot: any, dragon: any, perch: P3 | null): DragonApproach | undefined {
  if (!perch || !bot.entity?.position) return undefined;
  const start = performance.now(), deadline = start + APPROACH_TOTAL_MS, scanDeadline = start + APPROACH_SCAN_MS;
  const ground = walkGround(bot, { deadline: scanDeadline, radius: 32, maxCells: 2500, safe: () => true });
  const wait = waitPositions(bot, dragon, perch, ground, goWalkRouteChecker(bot, deadline), deadline);
  return wait.length ? { strike: [], stage: [], retreat: [], wait } : undefined;
}

/** Footing 10 to 14 m from the perch centre, sideways of the facing, clear of the perch with the reflex margin; shortest verified walks first. */
function waitPositions(bot: any, dragon: any, perch: P3, ground: WalkSearch, verify: (route: Cell[]) => boolean, deadline: number): NonNullable<DragonApproach['wait']> {
  const clear = perchClearance(bot, dragon, 1.5), facing = { x: Math.sin(dragon.yaw ?? 0), z: Math.cos(dragon.yaw ?? 0) };
  const candidates: Array<{ node: WalkCell; p: P3; side: number }> = [];
  for (const node of ground.cells) {
    const p = feetCentre(node.cell), dx = p.x - perch.x, dz = p.z - perch.z, r = Math.hypot(dx, dz);
    if (r < 10 || r > 14) continue;
    const side = (dx * facing.x + dz * facing.z) / r;
    if (Math.abs(side) > 0.25 || !clear(p)) continue;
    candidates.push({ node, p, side });
  }
  candidates.sort((a, b) => a.node.walkMeters - b.node.walkMeters);
  const result: NonNullable<DragonApproach['wait']> = [];
  for (const { node, p, side } of candidates) {
    if (performance.now() >= deadline) break;
    if (!verify(walkRoute(node))) continue;
    if (result.some(w => Math.hypot(w.x - p.x, w.z - p.z) < 3)) continue;
    result.push({ ...p, walkMeters: node.walkMeters, walkSeconds: node.walkMeters / 4.317, side, inWingPush: false, inBreathNow: false });
    if (result.length === 3) break;
  }
  return result;
}

function computeApproach(bot: any, dragon: any, perch: P3 | null): DragonApproach {
  const start = performance.now(), deadline = start + APPROACH_TOTAL_MS, scanDeadline = start + APPROACH_SCAN_MS, head = partBox(dragon, 'head');
  // Two scans share 60 ms, all verification shares 120 ms. Basin work cannot add another unbounded observation pass.
  let basin: DragonApproach['basin'];
  try { if (perch) basin = basinPositions(bot, dragon, perch, start + APPROACH_SCAN_MS / 2, scanDeadline); } catch { /* optional field */ }
  const extra = basin?.length ? { basin } : {};
  const safe = perchClearance(bot, dragon);
  if (!bot.entity?.position || !safe(bot.entity.position)) return { strike: [], stage: [], retreat: [], ...extra };
  const ground = walkGround(bot, { deadline: scanDeadline, radius: 32, maxCells: 2500, safe });
  const verify = goWalkRouteChecker(bot, deadline), strike: DragonApproach['strike'] = [], retreat: DragonApproach['retreat'] = [];
  for (const node of ground.cells) {
    if (performance.now() >= deadline) break;
    if (!inland(ground.read, node.cell) || !safe(feetCentre(node.cell))) continue;
    const p = feetCentre(node.cell), reach = boxDistance({ ...p, y: p.y + 1.62 }, head), route = walkRoute(node);
    if (p.y + 1.8 >= head.minY || reach > STRIKE_REACH || !verify(route) || !verify([...route].reverse())) continue;
    if (strike.every(s => Math.hypot(s.x - p.x, s.z - p.z) >= 1.5)) strike.push({ ...p, headReach: reach, walkMeters: node.walkMeters });
    if (strike.length === 3) break;
  }
  // All suggestions share the connected safe ground graph. Verify the return edges too, for go after a strike.
  for (const node of ground.cells) {
    if (performance.now() >= deadline) break;
    if (!inland(ground.read, node.cell) || !safe(feetCentre(node.cell))) continue;
    const p = feetCentre(node.cell);
    if (boxDistance({ ...p, y: p.y + 1.62 }, head) < STRIKE_REACH + 3) continue;
    const route = walkRoute(node);
    if (!verify(route) || !verify([...route].reverse())) continue;
    if (retreat.every(s => Math.hypot(s.x - p.x, s.z - p.z) >= 3)) retreat.push({ ...p, walkMeters: node.walkMeters });
    if (retreat.length === 2) break;
  }
  const stage = stagePositions(bot, dragon, ground, strike, verify, deadline);
  let wait: DragonApproach['wait'];
  try { if (perch) { const found = waitPositions(bot, dragon, perch, ground, verify, deadline); if (found.length) wait = found; } } catch { /* optional field */ }
  return { strike, stage, retreat, ...(wait ? { wait } : {}), ...extra };
}

/** The body's own walk into the 2–3.2 m ring, with no digging/placing. A one-level rise is offered only if go can really step up it. */
function basinPositions(bot: any, dragon: any, perch: P3, scanDeadline: number, deadline: number): DragonApproach['basin'] {
  const safe = perchClearance(bot, dragon, 0, false), me = bot.entity?.position;
  if (!me || !safe(me) || performance.now() >= scanDeadline) return undefined;
  const ground = walkGround(bot, { deadline: scanDeadline, radius: 32, maxCells: 2500, safe });
  if (performance.now() >= deadline) return undefined;
  const facing = { x: Math.sin(dragon.yaw ?? 0), z: Math.cos(dragon.yaw ?? 0) }, wings = wingPushBoxes(dragon);
  const parts = (['head', 'neck', 'body', 'wing1', 'wing2'] as const).map(part => partBox(dragon, part));
  const candidates: Array<{ node: WalkCell; p: P3; side: number }> = [];
  for (const node of ground.cells) {
    if (performance.now() >= deadline) return undefined;
    const p = feetCentre(node.cell), dx = p.x - perch.x, dz = p.z - perch.z, r = Math.hypot(dx, dz);
    if (r < 2 || r > 3.2 || !safe(p)) continue;
    // Footing inside a wing's push zone is not offered (the push is 4/distance from the body centre every tick it overlaps: lab r145 was thrown 30 blocks up from such a cell mid-sit); the low ring at the fountain's foot lies under the zone.
    if (wings.some(box => boxesOverlap(bodyBoxAt(p), box))) continue;
    candidates.push({ node, p, side: (dx * facing.x + dz * facing.z) / r });
  }
  candidates.sort((a, b) => Math.abs(a.side) - Math.abs(b.side) || a.node.walkMeters - b.node.walkMeters);
  const verify = goWalkRouteChecker(bot, deadline), result: NonNullable<DragonApproach['basin']> = [];
  for (const { node, p, side } of candidates) {
    if (performance.now() >= deadline) break;
    if (!verify(walkRoute(node))) continue;
    const eye = { ...p, y: p.y + 1.62 };
    result.push({ ...p, walkMeters: node.walkMeters, walkSeconds: node.walkMeters / 4.317,
      headReach: Math.min(...parts.map(box => boxDistance(eye, box))),
      inWingPush: wings.some(box => boxesOverlap(bodyBoxAt(p), box)), inBreathNow: false, side });
    if (result.length === 3) break;
  }
  return result.length ? result : undefined;
}

/** Reverse Dijkstra on the already scanned ground: distance is along go-checked steps, never a straight line or a detour via the body.
 * Work shares the approach's deadline/cache. Shortest verified candidates come first, including when all are farther than 8 m. */
function stagePositions(bot: any, dragon: any, ground: WalkSearch, strike: DragonApproach['strike'], verify: (route: Cell[]) => boolean,
  deadline: number): NonNullable<DragonApproach['stage']> {
  const stage: NonNullable<DragonApproach['stage']> = [];
  if (!strike.length || performance.now() >= deadline) return stage;
  // Same 1.5 m clearance used by floorReflexes' dragon retreat; do not wait on its stopping boundary.
  const waitClear = perchClearance(bot, dragon, 1.5);
  const nodes = new Map<string, WalkCell>();
  for (const node of ground.cells) {
    if (performance.now() >= deadline) return stage;
    nodes.set(cellKey(node.cell), node);
  }
  type Entry = { node: WalkCell; meters: number; strikeIndex: number };
  const queue: Entry[] = [], best = new Map<string, Entry>();
  const offer = (entry: Entry) => {
    const key = cellKey(entry.node.cell), old = best.get(key);
    if (old && old.meters <= entry.meters) return;
    best.set(key, entry);
    let lo = 0, hi = queue.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (queue[mid].meters <= entry.meters) lo = mid + 1; else hi = mid; }
    queue.splice(lo, 0, entry);
  };
  strike.forEach((p, strikeIndex) => {
    const node = nodes.get(cellKey({ x: Math.floor(p.x), y: p.y, z: Math.floor(p.z) }));
    if (node) offer({ node, meters: 0, strikeIndex });
  });
  while (queue.length && performance.now() < deadline) {
    const entry = queue.shift()!, { node, meters, strikeIndex } = entry, cell = node.cell;
    if (best.get(cellKey(cell)) !== entry) continue;
    const p = feetCentre(cell);
    if (waitClear(p) && inland(ground.read, cell) && stage.every(s => Math.hypot(s.x - p.x, s.z - p.z) >= 1.5)) {
      const route = walkRoute(node);
      if (verify(route) && verify([...route].reverse())) stage.push({ ...p, toStrikeMeters: meters, walkMeters: node.walkMeters, strikeIndex });
      if (stage.length === 3) break;
    }
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) for (const dy of [0, 1, -1]) {
      if (performance.now() >= deadline) return stage;
      const from = nodes.get(cellKey({ x: cell.x + dx, y: cell.y + dy, z: cell.z + dz }));
      if (!from) continue;
      const distance = meters + Math.hypot(1, dy), old = best.get(cellKey(from.cell));
      if ((!old || old.meters > distance) && verify([from.cell, cell])) offer({ node: from, meters: distance, strikeIndex });
    }
  }
  return stage;
}
