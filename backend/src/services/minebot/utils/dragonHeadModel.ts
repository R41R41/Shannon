import { isPerched, PART_ID_OFFSET, type DragonPart, type P3 } from './dragonParts.js';

/** Post-movement samples, oldest first, one per client physicsTick. Mineflayer yaw is radians:
 * Notchian yRot (degrees) = 180 - yaw * 180 / PI. Never feed the rounded observation yaw here. */
export interface DragonBodySample { tick: number; position: P3; yaw: number; phase: number | null }
export interface DragonHeadOptions {
  /** Server flight: yRot += yRotA * .1. Client aiStep never updates yRotA (initially zero).
   * Inferring server yRotA from yaw deltas assumes no teleport or other phase-owned yaw change. */
  rotation?: 'server_yaw_delta' | 'client_zero';
  /** An independently known vanilla yRotA, in degrees; useful for formula fixtures. */
  yRotA?: number;
}
export interface DragonHeadPrediction {
  observedTick: number; tick: number; ahead: number; phase: number;
  position: P3; yaw: number; pitch: number; headYOffset: number; yRotA: number;
  rotationSource: 'server_yaw_delta' | 'client_zero' | 'supplied';
  /** Entity positions (bottom of AABB), NOT box centres. */
  parts: Record<DragonPart, P3>;
  velocity: P3; yawPerTick: number;
}
const finitePoint = (p: P3 | undefined): p is P3 => !!p && [p.x, p.y, p.z].every(Number.isFinite);
export const wrapDragonYaw = (yaw: number): number => ((yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
export const dragonHeadCentre = (feet: P3): P3 => ({ ...feet, y: feet.y + 0.5 });

/** A bounded, contiguous history. A missing/invalid tick or identity change must clear the caller's
 * history; gaps are deliberately not filled with fictional samples. Inputs are never mutated. */
export function appendDragonBody(history: readonly DragonBodySample[], sample: DragonBodySample): DragonBodySample[] {
  if (!Number.isInteger(sample.tick) || !finitePoint(sample.position) || !Number.isFinite(sample.yaw)
    || !Number.isInteger(sample.phase) || sample.phase! < 0 || sample.phase! > 10) return [];
  const previous = history.at(-1);
  const prefix = previous && previous.tick + 1 === sample.tick ? history : [];
  return [...prefix.slice(-19), { ...sample, position: { ...sample.position } }];
}

/** EnderDragon.aiStep / tickPart / getHeadYOffset, 1.21.11, repository 6c4ae19:
 * https://github.com/youxuezhe7/minecraft-1.21.11-sources/blob/6c4ae19/net/minecraft/world/entity/boss/enderdragon/EnderDragon.java
 * flightHistory.record happens BEFORE movement/interpolation. Consequently get(k) at post-step T
 * reads post-step T-1-k, not T-k. aiStep uses integer history entries (no render partial-tick lerp).
 * The head/neck need entries 0,5,10 only, so twelve post-step samples suffice; no startup padding.
 *
 * Future BODY motion is an assumption, not a vanilla AI simulation: mean translation and wrapped
 * yaw change across the last four ticks, same phase, at most eight ticks ahead. Each future step
 * is appended BEFORE reapplying the part formula, advancing the latency history too. Unknown
 * targets, phase changes, network interpolation and server yRotA are not observable from poses.
 * JS sin/cos use doubles rather than vanilla's float lookup table; this is not bit-exact Java FP.
 */
export function predictDragonHead(history: readonly DragonBodySample[], ahead = 0, options: DragonHeadOptions = {}): DragonHeadPrediction | null {
  if (!Number.isInteger(ahead) || ahead < 0 || ahead > 8 || history.length < 12) return null;
  const samples = history.slice(-20);
  if (samples.some((s, i) => !Number.isInteger(s.tick) || !finitePoint(s.position) || !Number.isFinite(s.yaw)
    || !Number.isInteger(s.phase) || s.phase! < 0 || s.phase! > 10 || (i > 0 && s.tick !== samples[i - 1].tick + 1))) return null;
  const observed = samples.at(-1)!;
  // Never extrapolate through a phase boundary, even if the position happened to be continuous.
  const recent = samples.slice(-5);
  if (ahead && recent.some(s => s.phase !== observed.phase)) return null;
  const velocity = { x: 0, y: 0, z: 0 };
  let yawPerTick = 0;
  for (let i = 1; i < recent.length; i++) {
    for (const axis of ['x', 'y', 'z'] as const) velocity[axis] += (recent[i].position[axis] - recent[i - 1].position[axis]) / 4;
    yawPerTick += wrapDragonYaw(recent[i].yaw - recent[i - 1].yaw) / 4;
  }
  for (let n = 1; n <= ahead; n++) samples.push({ tick: observed.tick + n, phase: observed.phase,
    yaw: observed.yaw + yawPerTick * n, position: { x: observed.position.x + velocity.x * n,
      y: observed.position.y + velocity.y * n, z: observed.position.z + velocity.z * n } });
  const current = samples.at(-1)!, before = samples.at(-2)!;
  const latency = (k: number) => samples[samples.length - 2 - k];
  const pitch = (latency(5).position.y - latency(10).position.y) * 10 * Math.PI / 180;
  const headYOffset = isPerched(current.phase) ? -1 : latency(5).position.y - latency(0).position.y;
  const rotationSource = options.yRotA !== undefined ? 'supplied' : options.rotation ?? 'server_yaw_delta';
  const yRotA = options.yRotA ?? (rotationSource === 'client_zero' ? 0 : -wrapDragonYaw(current.yaw - before.yaw) * 180 / Math.PI * 10);
  if (!Number.isFinite(yRotA)) return null;
  const angle = current.yaw + yRotA * 0.01, cosPitch = Math.cos(pitch), sinPitch = Math.sin(pitch);
  const at = (x: number, y: number, z: number): P3 => ({ x: current.position.x + x, y: current.position.y + y, z: current.position.z + z });
  const front = (length: number) => at(Math.sin(angle) * length * cosPitch, headYOffset + sinPitch * length, Math.cos(angle) * length * cosPitch);
  return { observedTick: observed.tick, tick: current.tick, ahead, phase: current.phase!, position: { ...current.position }, yaw: current.yaw,
    pitch, headYOffset, yRotA, rotationSource, velocity, yawPerTick,
    parts: { head: front(6.5), neck: front(5.5), body: at(Math.sin(current.yaw) * 0.5, 0, Math.cos(current.yaw) * 0.5),
      wing1: at(-Math.cos(current.yaw) * 4.5, 2, Math.sin(current.yaw) * 4.5),
      wing2: at(Math.cos(current.yaw) * 4.5, 2, -Math.sin(current.yaw) * 4.5) } };
}

/** Only a real part entity can be a measurement. dragonState.headPosition is currently a rounded
 * perched box estimate and must NOT enter this path. Both identity offset and part type are checked. */
export function observedDragonPart(entities: Record<number, any>, dragonId: number, part: DragonPart): P3 | null {
  const e = entities[dragonId + PART_ID_OFFSET[part]];
  if (!e || e.id !== dragonId + PART_ID_OFFSET[part] || !finitePoint(e.position) || e.isValid === false) return null;
  if (e.dragonId !== undefined && e.dragonId !== dragonId) return null;
  if (e.dragonPart !== undefined && e.dragonPart !== part) return null;
  if (!['ender_dragon_part', `ender_dragon_${part}`].includes(e.name) && !(e.dragonId === dragonId && e.dragonPart === part)) return null;
  return { x: e.position.x, y: e.position.y, z: e.position.z };
}

/** Prefer measured head feet, then transport that measurement by the model's future offset.
 * The real observation anchors all three axes; an observation box estimate is never an anchor. */
export function forecastDragonHead(history: readonly DragonBodySample[], ahead: number, measuredFeet: P3 | null = null) {
  const now = predictDragonHead(history), future = predictDragonHead(history, ahead);
  if (!now || !future || (measuredFeet !== null && !finitePoint(measuredFeet))) return null;
  const origin = measuredFeet ?? now.parts.head;
  const feet = { x: origin.x + future.parts.head.x - now.parts.head.x, y: origin.y + future.parts.head.y - now.parts.head.y,
    z: origin.z + future.parts.head.z - now.parts.head.z };
  return { feet, centre: dragonHeadCentre(feet), source: measuredFeet ? 'observed_part_entity' : 'vanilla_history_model', model: future };
}
