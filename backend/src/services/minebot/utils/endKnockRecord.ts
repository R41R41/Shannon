import { Vec3 } from 'vec3';
import { bodyBoxAt, boxesOverlap, inflate, isPerched, partBox, shift, type DragonPart, type P3 } from './dragonParts.js';
import { cloudReaches } from './dragonDanger.js';
import { breathCloudsOf, dragonPhaseOf, endDragonOf } from './dragonState.js';
import { CLUTCH_FALLING_VY, CLUTCH_MIN_DAMAGE, CLUTCH_REACH, groundUnder } from './fallClutch.js';
import { bodyReader } from './localMap.js';
import { standing } from './dragonWalk.js';

// Lab observation only. No reflex call, action, item selection, or mutation of FallMemory.
export type KnockCause = 'wing_push' | 'head_contact' | 'neck_contact' | 'body_contact' | 'takeoff_wing' | 'bed_blast' | 'cloud' | 'unknown';
type Pose = { id?: number; position: P3; yaw: number; phase: number | null };
type Cloud = { id?: number; position: P3; radius: number | null };
type Trial = { detonationTick: number | null };
const point = (p: any): P3 | null => p && [p.x, p.y, p.z].every(Number.isFinite) ? { x: p.x, y: p.y, z: p.z } : null;

/** Same box arithmetic as dragonDanger: contact +1 and its 0.1 margin; wing inflate(4,2,4), then shift(0,-2,0).
 * Unlike the reflex, diagnostics retain wings while sitting and all boxes in flight. Flight boxes are estimates.
 * Cloud disc/slab overlap is the reflex's cloudReaches (radius at least 7), not proof of an impulse from a cloud.
 */
export function knockGeometry(feet: P3, dragon: Pose | null, clouds: readonly Cloud[] = []) {
  const bodyBox = bodyBoxAt(feet);
  const parts = dragon ? (['head', 'neck', 'body', 'wing1', 'wing2'] as DragonPart[]).map(part => {
    const box = partBox(dragon, part), contactBox = inflate(box, 1.1);
    const pushBox = part.startsWith('wing') ? shift(inflate(box, 4, 2, 4), 0, -2, 0) : null;
    return { part, box, contactBox, overlaps: boxesOverlap(bodyBox, box), contactOverlap: boxesOverlap(bodyBox, contactBox),
      pushBox, pushOverlap: pushBox !== null && boxesOverlap(bodyBox, pushBox) };
  }) : [];
  return { bodyBox, parts, partModel: !dragon ? 'unavailable' : isPerched(dragon.phase) ? 'perched_partBox_estimate' : 'flight_partBox_estimate',
    dragonBreath: clouds.map(c => ({ ...c, position: { ...c.position }, overlap: cloudReaches(c.position, c.radius ?? 0, feet) })) };
}

/** Deterministic evidence ranking, not causal proof: confirmed bed explosion in [tick-3,tick] first; then a wing
 * push overlap in phase 4 (takeoff_wing), head, neck, body, other wing push, cloud, unknown. Retain ALL candidates
 * so a simultaneous blast/contact is visible. Explosions 4..20 ticks old are context only; future ticks are excluded.
 * Head/neck use the grown contact box; body uses the raw body part box (no invented body hurt radius).
 */
export function classifyKnock(tick: number, phase: number | null, geometry: ReturnType<typeof knockGeometry>, trials: readonly Trial[]) {
  const bedDetonationTicks = trials.map(t => t.detonationTick).filter((t): t is number => typeof t === 'number' && tick - t >= 0 && tick - t <= 20);
  const wing = geometry.parts.some(p => p.pushOverlap), candidates: KnockCause[] = [];
  if (bedDetonationTicks.some(t => tick - t <= 3)) candidates.push('bed_blast');
  if (wing && phase === 4) candidates.push('takeoff_wing');
  for (const part of ['head', 'neck', 'body'] as const) if (geometry.parts.some(p => p.part === part && (part === 'body' ? p.overlaps : p.contactOverlap))) candidates.push(`${part}_contact`);
  if (wing && phase !== 4) candidates.push('wing_push');
  if (geometry.dragonBreath.some(c => c.overlap)) candidates.push('cloud');
  return { cause: candidates[0] ?? 'unknown', candidates, ambiguous: candidates.length > 1, bedDetonationTicks };
}

/** Both protocol formats, in blocks/tick. Never divide the 1.21.9+ lpVec3 by 8000. */
export function knockPacketVelocity(packet: any): P3 | null {
  return point(packet?.velocity) ?? (typeof packet?.velocityX === 'number'
    ? point({ x: packet.velocityX / 8000, y: packet.velocityY / 8000, z: packet.velocityZ / 8000 }) : null);
}

export interface KnockRecordOptions {
  enabled: boolean; tick?: () => number; now?: () => number; bedTrials?: () => readonly Trial[];
  dragon?: () => Pose | null; clouds?: () => readonly Cloud[];
}

export function recordEndKnocks(bot: any, options: KnockRecordOptions) {
  const now = options.now ?? Date.now, started = now();
  let localTick = 0, stopped = false, finished = false, lastVy = Number(bot.entity?.velocity?.y ?? 0), lastHp = Number(bot.health);
  let lastMark = bot.reflexLedger?.mark?.() ?? 0;
  let knockCount = Number(bot.reflexLedger?.counts?.().knock ?? 0);
  let lastClutch = bot.floorReflexes?.fall?.clutchAt;
  const tick = () => options.tick?.() ?? localTick;
  const knocks: Array<Record<string, any>> = [], errors: string[] = [];
  const precedingDamage: Array<Record<string, any>> = [];
  let flight: Record<string, any> | null = null;
  const seenLedger = new Map<number, string>();
  for (const e of bot.reflexLedger?.entriesSince?.(0) ?? []) seenLedger.set(e.seq, JSON.stringify(e));
  const at = () => ({ tick: tick(), seconds: (now() - started) / 1000 });
  // Observation failure never interrupts the body or a packet write.
  const safe = (f: () => void) => { try { f(); } catch (e) { if (errors.length < 8) errors.push(String(e)); } };
  const dragon = (): Pose | null => {
    if (options.dragon) return options.dragon();
    const d = endDragonOf(bot);
    return d && point(d.position) && Number.isFinite(d.yaw) ? { id: d.id, position: point(d.position)!, yaw: d.yaw, phase: dragonPhaseOf(bot, d) } : null;
  };
  const snapshot = () => {
    const position = point(bot.entity?.position);
    if (!position) return null;
    const d = dragon(), geometry = knockGeometry(position, d, options.clouds?.() ?? breathCloudsOf(bot));
    return { ...at(), position, velocity: point(bot.entity?.velocity), health: Number(bot.health),
      onGround: bot.entity?.onGround === true, inWater: bot.entity?.isInWater === true,
      dragon: d ? { ...d, position: { ...d.position } } : null, ...geometry };
  };
  const trigger = (source: string, velocity: P3 | null = null) => {
    if (stopped || finished || Number(bot.health) <= 0) return;
    const s = snapshot(); if (!s) return;
    const impulse = { ...s, source, packetVelocity: velocity,
      ...classifyKnock(tick(), s.dragon?.phase ?? null, s, options.bedTrials?.() ?? []) };
    // Packet + ledger may describe the same launch. Airborne re-launches remain impulses of the same flight.
    if (!flight) {
      flight = { ...s, cause: impulse.cause, impulses: [], peak: { ...at(), position: s.position },
        fallingTick: null, end: null, airborne: !s.onGround, trajectory: [], clutchStarts: [], ledger: [], waterUses: [], waterObserved: [],
        healthLosses: [], damageEvents: precedingDamage.filter(d => tick() - d.tick <= 2).map(d => ({ ...d })),
        fallDamage: null, fallDamageBasis: 'unknown_damage_type_or_packet_order' };
      knocks.push(flight);
    }
    flight.impulses.push(impulse);
  };
  const recent = () => flight ?? (knocks.at(-1)?.end && now() - knocks.at(-1)!.end.atMs <= 8000 ? knocks.at(-1)! : null);
  const ledgerSample = () => {
    for (const e of bot.reflexLedger?.entriesSince?.(0) ?? []) {
      const signature = JSON.stringify(e);
      if (seenLedger.get(e.seq) === signature) continue;
      seenLedger.set(e.seq, signature);
      // Actual floor uses kind=retreat, detail="落下を水バケツで..."; no clutch/fall ReflexKind exists today.
      if (!/clutch|fall|落下.*水バケツ/iu.test(`${e.kind} ${e.detail}`)) continue;
      // A ledger ends asynchronously. Its begin seq predates a subsequent flight's clutch start seq.
      const owner = [...knocks].reverse().find(k => k.clutchStarts.some((s: any) => s.beforeSeq < e.seq && s.seq >= e.seq)) ?? recent();
      if (owner) {
        const i = owner.ledger.findIndex((old: any) => old.seq === e.seq);
        const row = { ...e, observedTick: tick() };
        if (i < 0) owner.ledger.push(row); else owner.ledger[i] = row;
      }
    }
  };
  const pendingLedger = (k: Record<string, any>) => k.clutchStarts.some((s: any) => !k.ledger.some((e: any) => s.beforeSeq < e.seq && e.seq <= s.seq));
  const end = (outcome: string) => {
    if (!flight || flight.end) return;
    const s = snapshot();
    flight.end = { ...at(), atMs: now(), outcome, position: s?.position ?? null, health: Number(bot.health) };
    flight.heightFromPeak = s ? flight.peak.position.y - s.position.y : null;
    flight.secondsFromPeak = (now() - started) / 1000 - flight.peak.seconds;
    flight.secondsFromKnock = (now() - started) / 1000 - flight.seconds;
    flight = null;
  };
  const sample = () => {
    localTick++;
    if (finished) { ledgerSample(); return; }
    const vy = Number(bot.entity?.velocity?.y ?? 0), count = Number(bot.reflexLedger?.counts?.().knock ?? 0);
    if (count > knockCount) trigger('ledger_knock');
    // A normal jump is ~0.42. Physics fallback requires a sudden rise; velocity packet needs only a large upward component.
    if (vy >= 0.8 && vy - lastVy >= 0.5) trigger('physics_velocity');
    knockCount = count; lastVy = vy;
    if (flight) {
      const s = snapshot();
      if (s) {
        if (s.position.y > flight.peak.position.y) flight.peak = { ...at(), position: s.position };
        if (!s.onGround) flight.airborne = true;
        if (vy < 0 && flight.airborne) flight.fallingTick ??= tick();
        const read = bodyReader(bot), ground = groundUnder(read, s.position), memory = bot.floorReflexes?.fall;
        const bucket = bot.heldItem?.name === 'water_bucket' ? 'hand' : (bot.inventory?.items?.() ?? []).some((i: any) => i.name === 'water_bucket' && i.slot >= 36 && i.slot <= 44) ? 'hotbar' : 'absent_or_pack';
        const floorCell = new Vec3(Math.floor(s.position.x), ground.top - 1, Math.floor(s.position.z));
        const floorBlock = ground.kind === 'floor' ? bot.blockAt?.(floorCell) : null;
        // Reproduce clutchWanted's total (integer ground.drop), retaining continuous eye distance for the use window.
        const predictedDamage = Math.max(memory?.from ?? flight.peak.position.y, flight.peak.position.y) - s.position.y + ground.drop - 3;
        const cooldownMs = memory?.clutchAt === undefined ? 0 : Math.max(0, 6000 - (now() - memory.clutchAt));
        const conditions: string[] = [];
        if (vy > CLUTCH_FALLING_VY) conditions.push('not_falling_fast_enough');
        if (s.onGround) conditions.push('on_ground');
        if (s.inWater) conditions.push('already_in_water');
        if (bucket === 'absent_or_pack') conditions.push('bucket_not_in_hand_or_hotbar');
        if (ground.kind !== 'floor') conditions.push(`ground_${ground.kind}`); // "void" means no floor within LOOK_DOWN=70, not proven infinite void.
        if (predictedDamage < CLUTCH_MIN_DAMAGE) conditions.push('below_min_damage');
        if (cooldownMs > 0) conditions.push('cooldown');
        if (!options.enabled) conditions.push('release_disabled');
        const row = { ...at(), position: s.position, velocity: s.velocity, health: s.health, onGround: s.onGround, inWater: s.inWater,
          ground, floorName: floorBlock?.name ?? null,
          floorFullCube: floorBlock?.shapes?.some((b: number[]) => b[0] <= 0 && b[1] <= 0 && b[2] <= 0 && b[3] >= 1 && b[4] >= 1 && b[5] >= 1) ?? null,
          endStoneStandable: floorBlock?.name === 'end_stone' && standing(read, { x: floorCell.x, y: ground.top, z: floorCell.z }),
          bucket, predictedDamage, cooldownMs, conditions,
          eyeToFloor: s.position.y + 1.62 - ground.top, inUseReach: ground.kind === 'floor' && s.position.y + 1.62 - ground.top <= CLUTCH_REACH,
          floorBusy: bot.floorReflexes?.busy ?? null };
        flight.trajectory.push(row);
        if (memory?.clutchAt !== undefined && memory.clutchAt !== lastClutch) {
          flight.clutchStarts.push({ ...at(), atMs: memory.clutchAt, beforeSeq: lastMark, seq: bot.reflexLedger?.mark?.() ?? 0 });
        }
        lastClutch = memory?.clutchAt;
        if (Number(bot.health) <= 0) end('death');
        else if (flight.airborne && (s.onGround || s.inWater) && vy <= 0) end(s.inWater ? 'water_landing' : 'landed');
        else if (!flight.airborne && tick() - flight.tick >= 4 && vy <= 0) end('grounded_no_flight');
      }
    }
    ledgerSample();
    lastMark = bot.reflexLedger?.mark?.() ?? lastMark;
  };
  const onVelocity = (p: any) => {
    if (p?.entityId !== bot.entity?.id) return;
    const v = knockPacketVelocity(p);
    if (v && v.y >= 0.8) trigger('entity_velocity', v);
  };
  const onHealth = () => {
    const hp = Number(bot.health), owner = recent();
    if (owner && hp < lastHp) owner.healthLosses.push({ ...at(), lost: lastHp - hp, before: lastHp, after: hp });
    lastHp = hp;
  };
  const onDamage = (p: any) => {
    if (p?.entityId !== bot.entity?.id) return;
    // IDs are version/registry dependent. Keep the wire ID; never assume a numeric ID means fall.
    const type = bot.registry?.damageTypesById?.[p.sourceTypeId]?.name ?? null;
    const row = { ...at(), sourceTypeId: p.sourceTypeId, type, causeId: p.sourceCauseId, directId: p.sourceDirectId };
    precedingDamage.push(row); if (precedingDamage.length > 20) precedingDamage.shift();
    recent()?.damageEvents.push(row);
  };
  const onBlock = (_old: any, block: any) => {
    const owner = recent();
    const p = point(block?.position), body = point(bot.entity?.position);
    if (owner && block?.name === 'water' && p && body && Math.hypot(p.x + 0.5 - body.x, p.z + 0.5 - body.z) <= 2)
      owner.waterObserved.push({ ...at(), position: p, source: Number(block.metadata ?? 0) === 0 });
  };
  const onDeath = () => {
    safe(onHealth);
    const previous = recent();
    if (!flight && previous?.end && tick() - previous.end.tick <= 2) {
      previous.end.outcome = 'death'; previous.end.health = Number(bot.health); previous.death = at();
    }
    safe(() => end('death'));
  };
  const onMove = () => end('server_position_correction'); // don't score an operator tp/respawn as a safe fall
  const bindings: Array<[any, string, (...args: any[]) => void]> = [];
  const bind = (emitter: any, event: string, f: (...args: any[]) => void) => {
    const listener = (...args: any[]) => safe(() => f(...args));
    emitter?.on?.(event, listener); bindings.push([emitter, event, listener]);
  };
  bind(bot, 'physicsTick', sample); bind(bot, 'health', onHealth); bind(bot, 'death', onDeath); bind(bot, 'forcedMove', onMove);
  bind(bot, 'blockUpdate', onBlock); bind(bot._client, 'entity_velocity', onVelocity); bind(bot._client, 'damage_event', onDamage);
  // Transparent write tap: preserve receiver, arguments, return value and thrown error. No packet is added or changed.
  const client = bot._client, original = client?.write;
  const tap = function (this: unknown, name: string, data: any, ...rest: any[]) {
    let row: Record<string, any> | undefined;
    safe(() => {
      const owner = recent(), held = data?.hand === 1 ? bot.inventory?.slots?.[45]?.name : bot.heldItem?.name;
      if (!stopped && owner && ['use_item', 'block_place'].includes(name) && ['water_bucket', 'bucket'].includes(held)) {
        const position = point(bot.entity?.position), ground = position ? groundUnder(bodyReader(bot), position) : null;
        row = { ...at(), packet: name, held, phase: flight ? 'airborne' : 'after_landing', sequence: data?.sequence ?? null,
          heightToFloor: ground?.kind === 'floor' && position ? position.y - ground.top : null,
          status: 'write_pending', position: point(bot.entity?.position) };
        owner.waterUses.push(row);
      }
    });
    try { const result = original.call(this, name, data, ...rest); if (row) row.status = client.serializer?.writable === false ? 'serializer_closed' : 'sent_unconfirmed'; return result; }
    catch (error) { if (row) { row.status = 'write_failed'; row.error = String(error); } throw error; }
  };
  if (typeof original === 'function') client.write = tap;
  return {
    knocks, errors, enabled: options.enabled,
    finish(reason = 'scene_end') { safe(() => end(reason)); finished = true; },
    // The floor ends its ledger asynchronously after landing/death (bucket update/scoop/timeout).
    // Only already observed starts are awaited, after the scene has ended, up to the floor's 8s timeout + one poll.
    async settle() {
      const until = Date.now() + 8250;
      safe(ledgerSample);
      while (knocks.some(pendingLedger) && Date.now() < until) {
        await new Promise(resolve => setTimeout(resolve, 25)); safe(ledgerSample);
      }
    },
    stop(reason = 'scene_end') {
      if (stopped) return;
      safe(ledgerSample); safe(() => end(reason)); stopped = true;
      for (const [emitter, event, listener] of bindings) emitter?.removeListener?.(event, listener);
      if (client?.write === tap) client.write = original;
      for (const k of knocks) safe(() => {
        // Explosion listener ordering can fill bedTrials after the velocity listener in the same receipt tick.
        for (const i of k.impulses) Object.assign(i, classifyKnock(i.tick, i.dragon?.phase ?? null, i, options.bedTrials?.() ?? []));
        k.cause = k.impulses[0].cause;
        k.clutchLedgerPendingAtStop = pendingLedger(k);
        for (const u of k.waterUses) { u.secondsToEnd = k.end ? k.end.seconds - u.seconds : null; u.heightAboveEnd = u.position && k.end?.position ? u.position.y - k.end.position.y : null; }
        k.clutch = clutchAssessment(k, options.enabled);
      });
    },
  };
}

export function clutchAssessment(k: Record<string, any>, enabled: boolean) {
  const descending = k.trajectory.filter((s: any) => s.velocity?.y <= CLUTCH_FALLING_VY && !s.onGround && !s.inWater);
  const eligible = descending.filter((s: any) => s.conditions.length === 0);
  const poured = k.waterUses.some((u: any) => u.held === 'water_bucket' && u.phase === 'airborne' && u.status === 'sent_unconfirmed');
  const reasons = new Set<string>();
  if (!enabled) reasons.add('release_disabled');
  if (!descending.length) reasons.add('no_falling_threshold_sample');
  if (!k.ledger.length && !k.clutchStarts.length) {
    for (const s of descending) for (const c of s.conditions) reasons.add(c);
    if (eligible.length) reasons.add('eligible_but_start_unobserved');
  }
  if ((k.clutchStarts.length || k.ledger.length) && !poured) {
    reasons.add(k.end?.outcome === 'landed' ? 'landed_before_pour' : 'no_water_use_observed');
    if (!descending.some((s: any) => s.inUseReach)) reasons.add('no_reachable_floor_sample_before_end');
  }
  for (const e of k.ledger) if (e.outcome !== 'done') reasons.add(`ledger_${e.outcome}:${e.detail}`);
  if (k.clutchLedgerPendingAtStop) reasons.add('ledger_pending_at_stop');
  for (const u of k.waterUses) if (u.held === 'water_bucket' && ['write_failed', 'serializer_closed'].includes(u.status)) reasons.add(`water_use_${u.status}`);
  if (poured && k.end?.outcome !== 'water_landing') reasons.add('pour_sent_water_landing_unconfirmed');
  // Damage packets carry a type but no amount; update_health is all-cause and may be batched/reordered.
  // Preserve both, report a landing-window HP loss separately, and leave actual fall damage null without proof.
  // The bed scene freezes its tick at termination while draining the ledger: also bound by receipt time.
  const landingLoss = k.healthLosses.filter((h: any) => k.end && Math.abs(h.tick - k.end.tick) <= 2 && Math.abs(h.seconds - k.end.seconds) <= 0.100001)
    .reduce((n: number, h: any) => n + h.lost, 0);
  return { enabled, thresholds: { fallingVy: CLUTCH_FALLING_VY, minDamage: CLUTCH_MIN_DAMAGE, reach: CLUTCH_REACH },
    ledgerKinds: [...new Set(k.ledger.map((e: any) => e.kind))], started: k.clutchStarts.length > 0 || k.ledger.length > 0,
    poured, waterLanding: k.end?.outcome === 'water_landing', eligibleTicks: eligible.map((s: any) => s.tick),
    notWorkedReasons: [...reasons], landingWindowHpLossAllCauses: landingLoss, actualFallDamage: null,
    unmitigatedFallEstimate: typeof k.heightFromPeak === 'number' ? Math.max(0, Math.ceil(k.heightFromPeak - 3)) : null,
    useSuccess: k.end?.outcome === 'water_landing' && poured ? 'water_landing_after_send' : 'unconfirmed' };
}
