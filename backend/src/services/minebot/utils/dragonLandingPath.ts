import { dragonHeadVanilla } from './dragonHeadVanilla.js';
import { inflate, partBox, shift, type Box, type P3 } from './dragonParts.js';

/** Receipt ticks, not invented server timestamps. One entry per real position packet.
 * velocity is blocks/tick from a fresh packet, if available; sitting velocity is never used. */
export interface LandingObservation {
  tick: number; position: P3; yaw: number; phase: number; velocity?: P3; velocityTick?: number;
}
export interface LandingPoint {
  tick: number; observedTick: number; forecastTick: number; phase: number; position: P3; yaw: number;
  velocity: P3; yRotA: number; p: number; hy: number; head: P3; headBox: Box;
}
const finite = (p: P3) => p && [p.x, p.y, p.z].every(Number.isFinite);
const wrap = (r: number) => Math.atan2(Math.sin(r), Math.cos(r));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const distance = (a: P3, b: P3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Heightmap of ONLY the observed central column. Require the whole upper column loaded.
 * Arms/walls elsewhere cannot change this target. Torch/fire are not motion-blocking. */
export function dragonLandingTarget(column: P3, minY: number, maxY: number,
  read: (p: P3) => { boundingBox?: string; shapes?: number[][] } | null): P3 | null {
  if (!finite(column) || !Number.isInteger(minY) || !Number.isInteger(maxY) || maxY < minY) return null;
  const x = Math.floor(column.x), z = Math.floor(column.z);
  for (let y = maxY; y >= minY; y--) {
    const b = read({ x, y, z });
    if (!b) return null;
    if (b.boundingBox === 'block') return { x: x + 0.5, y: y + 1, z: z + 0.5 };
  }
  return null;
}

export function appendLandingObservation(history: readonly LandingObservation[], sample: LandingObservation): LandingObservation[] {
  if (!Number.isInteger(sample.tick) || !finite(sample.position) || !Number.isFinite(sample.yaw)
    || ![2, 3].includes(sample.phase) || (sample.velocity && !finite(sample.velocity))
    || (sample.velocityTick !== undefined && (!Number.isInteger(sample.velocityTick) || sample.velocityTick < sample.tick - 1 || sample.velocityTick > sample.tick + 3))) return [];
  const last = history.at(-1);
  // Metadata can flush an extra position packet in the same tick. Replace, never divide by zero.
  const prefix = last && sample.tick >= last.tick && sample.tick - last.tick <= 6 ? history.filter(s => s.tick < sample.tick) : [];
  return [...prefix.slice(-63), { ...sample, position: { ...sample.position }, ...(sample.velocity ? { velocity: { ...sample.velocity } } : {}) }];
}

/** Interpolate ONLY bracketed packet observations. No repeated frozen physicsTick poses. */
export function interpolateLanding(history: readonly LandingObservation[], tick: number): LandingObservation | null {
  if (!Number.isInteger(tick)) return null;
  const exact = history.find(s => s.tick === tick);
  if (exact) return { ...exact, position: { ...exact.position } };
  const i = history.findIndex(s => s.tick > tick);
  if (i < 1) return null;
  const a = history[i - 1], b = history[i], dt = b.tick - a.tick;
  if (dt <= 0 || dt > 6) return null;
  const t = (tick - a.tick) / dt;
  return { tick, phase: a.phase, yaw: a.yaw + wrap(b.yaw - a.yaw) * t,
    position: { x: mix(a.position.x, b.position.x, t), y: mix(a.position.y, b.position.y, t), z: mix(a.position.z, b.position.z, t) } };
}

/** Local target-following forecast, NOT a claim to simulate unobserved approach path nodes or
 * explosion impulses. Phase 2 keeps the observed tangent. Phase 3 bends horizontal velocity
 * toward the column at its observed speed, and stops a descending axis at the target.
 * Rebuild after every packet (including the upward velocity after an explosion).
 * The uncalibrated steering and yRotA inference must be measured in the lab. */
export function predictLandingPath(history: readonly LandingObservation[], target: P3, now: number, ahead = 20): LandingPoint[] {
  const last = history.at(-1), before = history.at(-2);
  if (!last || !before || !finite(target) || !Number.isInteger(now) || now < last.tick || now - last.tick > 3
    || !Number.isInteger(ahead) || ahead < 0 || ahead > 20 || last.tick <= before.tick || last.tick - before.tick > 6
    || history.some((s, i) => !Number.isInteger(s.tick) || !finite(s.position) || !Number.isFinite(s.yaw) || ![2, 3].includes(s.phase)
      || (i > 0 && s.tick <= history[i - 1].tick) || (s.velocity && !finite(s.velocity)))) return [];
  const dt = last.tick - before.tick;
  const v = last.velocity && (last.velocityTick ?? last.tick) <= last.tick ? { ...last.velocity } : {
    x: (last.position.x - before.position.x) / dt, y: (last.position.y - before.position.y) / dt, z: (last.position.z - before.position.z) / dt };
  const yawRate = wrap(last.yaw - before.yaw) / dt;
  const samples: LandingObservation[] = [];
  for (let t = last.tick - 11; t <= last.tick; t++) {
    const s = interpolateLanding(history, t);
    if (!s) return [];
    samples.push(s);
  }
  const out: LandingPoint[] = [];
  const point = (s: LandingObservation): LandingPoint | null => {
    const n = samples.length, h0 = samples[n - 2], h5 = samples[n - 7], h10 = samples[n - 12];
    const p = (h5.position.y - h10.position.y) * 10 * Math.PI / 180;
    const hy = h5.position.y - h0.position.y;
    const yRotA = -yawRate * 180 / Math.PI * 10;
    const head = dragonHeadVanilla({ position: s.position, yaw: s.yaw, yRotA, p, hy });
    return head && { tick: s.tick, observedTick: last.tick, forecastTick: now, phase: last.phase, position: { ...s.position }, yaw: s.yaw,
      velocity: { ...v }, p, hy, yRotA, head: head.feet, headBox: head.box };
  };
  const current = point(last);
  if (current && last.tick === now) out.push(current);
  for (let t = last.tick + 1; t <= now + ahead; t++) {
    if (last.velocity && t === last.velocityTick) Object.assign(v, last.velocity);
    const previous = samples.at(-1)!;
    if (last.phase === 3) {
      const dx = target.x - previous.position.x, dz = target.z - previous.position.z, horizontal = Math.hypot(dx, dz);
      const speed = Math.hypot(v.x, v.z);
      if (horizontal > 1e-6 && speed > 0) {
        v.x = mix(v.x, dx / horizontal * speed, 0.1); v.z = mix(v.z, dz / horizontal * speed, 0.1);
      }
    }
    const position = { x: previous.position.x + v.x, y: previous.position.y + v.y, z: previous.position.z + v.z };
    // Never clamp an upward impulse: its height and duration are precisely what M2 measures.
    if (last.phase === 3 && v.y < 0 && previous.position.y >= target.y && position.y < target.y) { position.y = target.y; v.y = 0; }
    const s = { tick: t, phase: last.phase, position, yaw: previous.yaw + yawRate };
    samples.push(s);
    if (t >= now) { const p = point(s); if (p) out.push(p); }
  }
  return out;
}

/** Preparation corridor around the observed target, using the observed approach direction.
 * These are spatial hypotheses, NOT dated forecasts or measured heads. They let phase 2
 * prepare near the fountain before a 20-tick forecast can reach it. Runtime rechecks the real forecast. */
export function landingPreparationCorridor(history: readonly LandingObservation[], target: P3): LandingPoint[] {
  const last = history.at(-1);
  if (!last || !finite(target) || !finite(last.position) || ![2, 3].includes(last.phase)) return [];
  const dx = target.x - last.position.x, dz = target.z - last.position.z, d = Math.hypot(dx, dz);
  if (d < 1) return [];
  const yaw = Math.atan2(dx, dz), out: LandingPoint[] = [];
  for (let back = 9; back >= 3; back--) for (const height of [1, 2, 3]) {
    const position = { x: target.x - dx / d * back, y: target.y + height, z: target.z - dz / d * back };
    const head = dragonHeadVanilla({ position, yaw, yRotA: 0, p: 0, hy: 0 })!;
    out.push({ tick: -1, observedTick: last.tick, forecastTick: -1, phase: 3, position, yaw, velocity: { x: 0, y: 0, z: 0 },
      p: 0, hy: 0, yRotA: 0, head: head.feet, headBox: head.box });
  }
  // Add the end of the approach and its midpoint, rather than only the instant
  // at which the flying head crosses the column. These remain spatial hypotheses.
  const end = landingEndHead(history, target);
  if (end) for (const back of [3.25, 0]) for (const height of [0, 1, 2]) {
    const position = { x: target.x - end.direction.x * back, y: target.y + height, z: target.z - end.direction.z * back };
    const head = dragonHeadVanilla({ position, yaw: end.yaw, yRotA: 0, p: 0, hy: -1 })!;
    out.push({ tick: -1, observedTick: last.tick, forecastTick: -1, phase: 3, position, yaw: end.yaw,
      velocity: { x: 0, y: 0, z: 0 }, p: 0, hy: -1, yRotA: 0, head: head.feet, headBox: head.box });
  }
  return out;
}

/** A spatial hypothesis, never a shot forecast. Prefer measured horizontal progress
 * when it points towards the target; phase-2 circling otherwise supplies only a bearing.
 * Sitting placement uses p=0, hy=-1. Scanning can subsequently turn this head. */
export function landingEndHead(history: readonly LandingObservation[], target: P3) {
  const last = history.at(-1), before = history.at(-2);
  if (!last || !finite(target) || !finite(last.position) || ![2, 3].includes(last.phase)) return null;
  const dx = target.x - last.position.x, dz = target.z - last.position.z;
  const v = before && last.tick > before.tick && last.tick - before.tick <= 6
    ? { x: last.position.x - before.position.x, z: last.position.z - before.position.z } : null;
  const measured = v && Math.hypot(v.x, v.z) > 1e-6 && v.x * dx + v.z * dz > 0;
  const x = measured ? v.x : dx, z = measured ? v.z : dz, length = Math.hypot(x, z);
  if (length < 1e-6) return null;
  const direction = { x: x / length, y: 0, z: z / length }, yaw = Math.atan2(direction.x, direction.z);
  return { direction, yaw, head: dragonHeadVanilla({ position: target, yaw, p: 0, hy: -1, yRotA: 0 })!.feet,
    observedTick: last.tick, source: measured ? 'inbound_packet_progress' : 'target_bearing' };
}

/** Twenty cells on the middle annulus (2..3m, a subset of 2..4m). No world grid
 * search or phase-2 bearing. Cell centres are relative to the observed column. */
export function landingMiddleRing(target: P3): P3[] {
  if (!finite(target)) return [];
  const cells = new Map<string, P3>();
  for (const [a, b] of [[3, 0], [2, 2], [2, 1], [1, 2], [2, 0]]) for (let turn = 0; turn < 4; turn++) {
    const [x, z] = turn === 0 ? [a, b] : turn === 1 ? [-b, a] : turn === 2 ? [-a, -b] : [b, -a];
    const p = { x: Math.floor(target.x) + x, y: Math.floor(target.y), z: Math.floor(target.z) + z };
    cells.set(`${p.x},${p.z}`, p);
  }
  return [...cells.values()];
}

/** Phase-3 entry uses a fresh velocity if it is inbound, then packet progress or
 * the current target bearing. The phase-2 corridor helper retains its old meaning. */
export function landingEntryDirection(history: readonly LandingObservation[], target: P3) {
  const last = history.at(-1);
  if (last?.velocity && (last.velocityTick ?? last.tick) <= last.tick) {
    const v = last.velocity;
    return landingEndHead([{ ...last, tick: last.tick - 1,
      position: { x: last.position.x - v.x, y: last.position.y - v.y, z: last.position.z - v.z } }, last], target);
  }
  return landingEndHead(history, target);
}

/** Freeze this ordering ONCE at phase-3 entry. No future heads in the score. */
export function landingEntryOrder<T extends { head: P3 }>(candidates: readonly T[], history: readonly LandingObservation[], target: P3): T[] {
  const end = landingEntryDirection(history, target);
  if (!end) return [];
  const aim = { x: target.x + 3 * end.direction.x, y: target.y + 0.5, z: target.z + 3 * end.direction.z };
  return candidates.filter(c => (c.head.x + 0.5 - target.x) * end.direction.x + (c.head.z + 0.5 - target.z) * end.direction.z > 0)
    .sort((a, b) => distance({ x: a.head.x + .5, y: a.head.y + .5, z: a.head.z + .5 }, aim)
      - distance({ x: b.head.x + .5, y: b.head.y + .5, z: b.head.z + .5 }, aim));
}

/** Arrival is evidence even if go returned an interruption. Never erase completion. */
export function landingArrival(plan: { readyTick: number | null; stand: P3 }, feet: P3, tick: number, built: boolean): number | null {
  return plan.readyTick ?? (built && finite(feet) && distance(plan.stand, feet) <= 1 ? tick : null);
}

/** Completion is durable evidence for this phase-2 plan, not current permission to fire.
 * A missing fresh packet or reflex displacement must not erase its completion tick. */
export function landingReadiness(plan: { readyTick: number | null; phaseStart: number; target: P3 } | null, target: P3 | null, entry: number) {
  const completedInPhase2 = !!plan && Number.isInteger(plan.readyTick) && plan.readyTick! >= plan.phaseStart;
  const beforeEntry = completedInPhase2 && plan!.readyTick! < entry;
  const targetObserved = !!target && finite(target);
  const sameTarget = !!plan && targetObserved && distance(plan.target, target!) === 0;
  return { completedInPhase2, beforeEntry, targetObserved, sameTarget, ready: beforeEntry && sameTarget };
}

/** The packet-derived head plus ONLY now+1..3; never let a long forecast authorize
 * a click. Requiring both stops a predicted crossing from firing before observation. */
export function landingShotWindow(history: readonly LandingObservation[], target: P3, now: number): LandingPoint[] {
  const last = history.at(-1);
  if (!last || last.phase !== 3 || now < last.tick || now - last.tick > 3) return [];
  const observed = predictLandingPath(history, target, last.tick, 0)[0];
  const future = predictLandingPath(history, target, now, 3).filter(p => p.tick > now);
  return observed && future.length === 3 ? [observed, ...future] : [];
}

/** Flight head/neck use the same history slope/rotation as the targeting formula. Include
 * the wing push boxes, even when hurtTime would temporarily suppress their contact. */
export function landingDragonBoxes(p: LandingPoint, margin = 0): Box[] {
  const neckFeet = { x: p.position.x + Math.sin(p.yaw + p.yRotA * 0.01) * 5.5 * Math.cos(p.p),
    y: p.position.y + p.hy + 5.5 * Math.sin(p.p), z: p.position.z + Math.cos(p.yaw + p.yRotA * 0.01) * 5.5 * Math.cos(p.p) };
  const neck = { minX: neckFeet.x - 1.5, maxX: neckFeet.x + 1.5, minY: neckFeet.y, maxY: neckFeet.y + 3,
    minZ: neckFeet.z - 1.5, maxZ: neckFeet.z + 1.5 };
  return [inflate(p.headBox, 1.1), inflate(neck, 1.1), partBox(p, 'body'),
    ...(['wing1', 'wing2'] as const).map(part => shift(inflate(partBox(p, part), 4, 2, 4), 0, -2, 0))].map(b => inflate(b, margin));
}

export function landingHeadResidual(predicted: LandingPoint, observed: LandingPoint) {
  if (predicted.tick !== observed.tick) return null;
  return { tick: observed.tick, ahead: predicted.tick - predicted.forecastTick, observationLead: predicted.tick - predicted.observedTick,
    phaseChanged: predicted.phase !== observed.phase, predicted: predicted.head, observed: observed.head,
    delta: { x: predicted.head.x - observed.head.x, y: predicted.head.y - observed.head.y, z: predicted.head.z - observed.head.z },
    metres: distance(predicted.head, observed.head), source: 'head_from_packet_body_and_interpolated_history; not_independent_part_truth' };
}

/** Inclusive radii from the supplied mechanics table; the error budget is extra distance.
 * Missing a cadence slot ends that train; a later in-range tick can start a NEW train. */
export function landingBurstDue(input: { phase: number | null; now: number; lastBlast: number | null;
  head: P3; pillow: P3; beds: 4 | 5; error: number }): boolean {
  const { now, lastBlast, error } = input;
  return input.phase === 3 && [4, 5].includes(input.beds) && Number.isInteger(now) && (lastBlast === null || now - lastBlast === 10)
    && finite(input.head) && finite(input.pillow) && Number.isFinite(error) && error >= 0
    && distance(input.head, input.pillow) + error <= (input.beds === 4 ? 2.07 : 3.22);
}

export const landingMode = (phase: number | null): 'prepare' | 'burst' | 'seated' | 'leave' | 'wait' =>
  phase === 2 ? 'prepare' : phase === 3 ? 'burst' : [5, 6, 7].includes(phase ?? -1) ? 'seated' : phase === 4 ? 'leave' : 'wait';

/** Invert D at E=1. Values below one/outside the power-five range are unknown. */
export function landingDamageDistance(damage: number): number | null {
  if (!Number.isFinite(damage) || damage < 1 || damage > 71) return null;
  return 10 * (1 - (-1 + Math.sqrt(1 + 4 * (damage - 1) / 35)) / 2);
}
