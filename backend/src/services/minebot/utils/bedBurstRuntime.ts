import { Vec3 } from 'vec3';
import { actionSignal, bindActionCallback, createBedBurstMotor } from '../execution/ActionExecution.js';
import { bedHalves } from './bedRules.js';
import { appendLandingObservation, type LandingObservation } from './dragonLandingPath.js';
import { dragonPhaseOf } from './dragonState.js';
import { bedBurstDue, bedBurstReach, classifyBedBurst, emptyBedBurst, LANDING_BLAST_GAP_TICKS, type BedBurstEvidence } from './bedBurst.js';
import type { P3 } from './dragonParts.js';
import { bedCanReplace, bedTickBudget, landingBedFireClear, type LandingBedLayout } from './dragonBedGeometry.js';

interface DragonReceipt { entity: any; phase: number | null; approach: number; history: LandingObservation[]; uses: number;
  lastUse: { tick: number; hp: number; blast: number | null; confirmed: boolean } | null;
  yaw: number | null; velocity: { tick: number; value: P3 } | null; health: Array<{ tick: number; value: number; source: 'snapshot' | 'packet' }> }
const worlds = new WeakMap<object, ReturnType<typeof installBedBurstWorld>>();

/** Read-only receipt clock and protocol fence shared across consecutive hands. No frozen physics pose is a dragon observation.
 * The write tap observes successful native writes (sequence numbers and teleport replies); it never sends a packet. */
function installBedBurstWorld(bot: any) {
  const client = bot._client, original = client.write;
  let tick = 0, epoch = 0, sequence = 0, stopped = false;
  let pendingTeleport: number | null = null, acknowledged = false;
  const state = { awaitingPosition: false, settledTick: 0, lastBlast: null as number | null,
    movement: null as { tick: number; position: P3 } | null };
  const dragons = new Map<number, DragonReceipt>();
  const sites = new Map<string, { entity: any; approach: number; epoch: number; layout: LandingBedLayout; target: P3; targetChanged: boolean; readyAt: number | null }>();
  const siteKey = (foot: P3, head: P3) => [foot.x, foot.y, foot.z, head.x, head.y, head.z].join(',');
  const listeners: Array<[any, string, (...args: any[]) => void]> = [];
  const on = (emitter: any, name: string, fn: (...args: any[]) => void, prepend = false) => {
    emitter[prepend ? 'prependListener' : 'on'](name, fn); listeners.push([emitter, name, fn]);
  };
  const dragon = (id: number): DragonReceipt | null => {
    const entity = bot.entities?.[id]; if (entity?.name !== 'ender_dragon') return null;
    let d = dragons.get(id);
    if (!d || d.entity !== entity) {
      const health = entity.metadata?.[9];
      d = { entity, phase: null, approach: 0, history: [], uses: 0, lastUse: null, yaw: null, velocity: null,
        health: Number.isFinite(health) ? [{ tick, value: health, source: 'snapshot' }] : [] }; dragons.set(id, d);
    }
    const phase = dragonPhaseOf(bot, entity);
    if (phase !== d.phase) {
      if ((phase === 2 && d.phase !== 2) || (phase === 3 && d.phase !== 2 && d.phase !== 3)) { d.approach++; d.uses = 0; d.lastUse = null; }
      if (![2, 3].includes(phase ?? -1)) d.history = [];
      if (phase === 3 && d.phase === 2) {
        const read = (p: P3) => bot.blockAt(new Vec3(p.x, p.y, p.z)), here = bot.entity?.position;
        for (const s of sites.values()) {
          if (s.entity !== entity || s.approach !== d.approach || s.epoch !== epoch) continue;
          const c = s.layout, feet = here && { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) };
          if (here && feet && Math.hypot(here.x - c.stand.x, here.y - c.stand.y, here.z - c.stand.z) <= 1
            && [c.foot, c.head].every(p => bedCanReplace(read(p)))
            && [...c.screen, ...c.supports, { ...feet, y: feet.y - 1 }].every(p => ['obsidian', 'bedrock'].includes(read(p)?.name ?? ''))
            && landingBedFireClear(read, here)) s.readyAt = tick;
        }
      }
      d.phase = phase;
    }
    return d;
  };
  on(bot, 'physicsTick', () => { tick++; for (const id of dragons.keys()) dragon(id); });
  on(bot, 'blockUpdate', (old, block) => {
    if (!block?.position || (old?.stateId === block.stateId && old?.name === block.name && old?.boundingBox === block.boundingBox)) return;
    for (const s of sites.values()) if (block.position.x === Math.floor(s.target.x) && block.position.z === Math.floor(s.target.z)) s.targetChanged = true;
  });
  for (const event of ['death', 'respawn', 'spawn', 'game']) on(bot, event, () => { epoch++; dragons.clear(); sites.clear(); state.lastBlast = null; });
  on(client, 'position', (packet: any) => { pendingTeleport = packet.teleportId; acknowledged = false; state.awaitingPosition = true; }, true);
  const write = function(this: unknown, name: string, data: any, ...rest: any[]) {
    const result = original.call(this, name, data, ...rest);
    if (stopped) return result;
    if (Number.isInteger(data?.sequence)) sequence = Math.max(sequence, data.sequence);
    if (name === 'teleport_confirm' && data.teleportId === pendingTeleport) acknowledged = true;
    if (name === 'position' || name === 'position_look') {
      state.movement = { tick, position: { x: data.x, y: data.y, z: data.z } };
      if (pendingTeleport !== null && acknowledged) {
        state.awaitingPosition = false; state.settledTick = tick; pendingTeleport = null;
      }
    }
    return result;
  };
  client.write = write;
  for (const name of ['rel_entity_move', 'entity_move_look', 'entity_teleport', 'sync_entity_position']) on(client, name, packet => {
    const d = dragon(packet.entityId); if (!d || ![2, 3].includes(d.phase ?? -1)) return;
    if (name === 'sync_entity_position' && [packet.dx, packet.dy, packet.dz].every(Number.isFinite)) {
      d.velocity = { tick, value: { x: packet.dx, y: packet.dy, z: packet.dz } };
    }
    if (Number.isFinite(packet.yaw)) d.yaw = Math.PI - packet.yaw * Math.PI / (name === 'sync_entity_position' ? 180 : 128);
    d.yaw ??= d.entity.yaw;
    d.history = appendLandingObservation(d.history, { tick, position: { ...d.entity.position }, yaw: d.yaw!, phase: d.phase!,
      ...(d.velocity && tick - d.velocity.tick <= 1 ? { velocity: { ...d.velocity.value }, velocityTick: d.velocity.tick } : {}) });
  });
  on(client, 'entity_look', packet => {
    const d = dragon(packet.entityId); if (d && Number.isFinite(packet.yaw)) d.yaw = Math.PI - packet.yaw * Math.PI / 128;
  });
  on(client, 'entity_velocity', packet => {
    const d = dragon(packet.entityId); if (!d) return;
    const v = packet.velocity ?? (Number.isFinite(packet.velocityX) ? { x: packet.velocityX / 8000, y: packet.velocityY / 8000, z: packet.velocityZ / 8000 } : null);
    if (!v || ![v.x, v.y, v.z].every(Number.isFinite)) return;
    d.velocity = { tick, value: { ...v } };
    const latest = d.history.at(-1);
    if (latest && tick - latest.tick <= 3 && [2, 3].includes(d.phase ?? -1)) {
      d.history = appendLandingObservation(d.history, { ...latest, velocity: { ...v }, velocityTick: tick });
    }
  });
  on(client, 'entity_metadata', packet => {
    const d = dragon(packet.entityId); if (!d) return;
    const value = packet.metadata?.find((m: any) => m.key === 9)?.value;
    if (Number.isFinite(value)) { d.health.push({ tick, value, source: 'packet' }); if (d.health.length > 64) d.health.shift(); }
  });
  const stop = () => {
    if (stopped) return; stopped = true; epoch++;
    for (const [emitter, event, fn] of listeners) emitter.removeListener(event, fn);
    if (client.write === write) client.write = original;
    worlds.delete(bot);
  };
  on(bot, 'end', stop);
  return { client, state, dragon, tick: () => tick, epoch: () => epoch, stopped: () => stopped, compute: bedTickBudget(() => tick),
    rememberSite: (id: number, layout: LandingBedLayout, target: P3) => {
      const d = dragon(id); if (!d || d.phase !== 2) return;
      sites.set(siteKey(layout.foot, layout.head), { entity: d.entity, approach: d.approach, epoch, layout: structuredClone(layout), target: { ...target }, targetChanged: false, readyAt: null });
      if (sites.size > 32) sites.delete(sites.keys().next().value!);
    },
    site: (id: number, foot: P3, head: P3) => {
      const d = dragon(id), s = sites.get(siteKey(foot, head));
      return s && d && s.entity === d.entity && s.approach === d.approach && s.epoch === epoch
        ? { ...structuredClone(s.layout), landingTarget: { ...s.target }, targetChanged: s.targetChanged, readyAt: s.readyAt } : null;
    },
    nextSequence: () => { if (sequence >= 0x7ffffffe) throw new Error('prediction_sequence_exhausted'); const next = sequence + 1; sequence += 2; return next; }, stop };
}

export function bedBurstWorld(bot: any) {
  let world = worlds.get(bot);
  if (!world || world.client !== bot._client || world.stopped()) { world?.stop(); world = installBedBurstWorld(bot); worlds.set(bot, world); }
  return world;
}

/** One atomic place/use attempt. Timers only bound observation; real receipt ticks and readiness authorize writes. */
export async function bedBurstOnOwnedMove(bot: any, world: ReturnType<typeof bedBurstWorld>, options: {
  foot: P3; head: P3; previousDetonationTick: number | null; until: number; signal: AbortSignal;
  fence: () => string | null; check: () => string | null; ready: () => boolean; onUse?: (tick: number) => void;
}): Promise<BedBurstEvidence> {
  const { foot, head } = options, e = emptyBedBurst(options.previousDetonationTick);
  const ownerSignal = actionSignal(bot);
  const motor = createBedBurstMotor(bot, foot, head, () => options.fence() ?? (world.state.awaitingPosition
    || world.tick() <= world.state.settledTick ? 'teleport_unsettled' : null));
  const yaw = Math.atan2(-(head.x - foot.x), -(head.z - foot.z));
  const here = bot.entity.position;
  const pitch = Math.atan2(foot.y - here.y - 1.62, Math.hypot(foot.x + .5 - here.x, foot.z + .5 - here.z));
  // Mineflayer's bookkeeping is kept in step with the actual raw look, through the owner's normal motor port.
  try { await bot.look(yaw, pitch, true); } catch (error) { motor.close(); throw error; }
  return new Promise(resolve => {
    let done = false, sending = false, triggeringMove = false, sentTick: number | null = null, attemptTick: number | null = null;
    const finish = (reason?: string) => {
      if (done) return; done = true; motor.close(); if (reason) e.failure = reason;
      clearTimeout(timer);
      for (const [emitter, event, fn] of listeners) emitter.removeListener(event, fn);
      options.signal.removeEventListener('abort', aborted);
      if (ownerSignal !== options.signal) ownerSignal?.removeEventListener('abort', aborted);
      e.completedTick = world.tick(); e.classification = classifyBedBurst(e);
      e.useToDetonationTicks = e.useTick !== null && e.detonationTick !== null ? e.detonationTick - e.useTick : null;
      resolve(e);
    };
    const aborted = () => { e.observationInterrupted = String(options.signal.aborted ? options.signal.reason : ownerSignal?.reason ?? 'cancelled'); finish(); };
    const listeners: Array<[any, string, (...args: any[]) => void]> = [];
    const on = (emitter: any, event: string, callback: (...args: any[]) => void, owned = true) => {
      const guarded = (...args: any[]) => { try { callback(...args); } catch (error) { e.observationInterrupted = String(error); finish(); } };
      const fn = owned ? bindActionCallback(bot, guarded) : guarded; listeners.push([emitter, event, fn]); emitter.on(event, fn);
    };
    const attempt = () => {
      if (done || sending || triggeringMove || sentTick !== null || attemptTick === world.tick()
        || !bedBurstDue(world.tick(), options.previousDetonationTick, LANDING_BLAST_GAP_TICKS)) return;
      attemptTick = world.tick();
      if (Date.now() >= options.until) { finish('burst_time_limit'); return; }
      const refusal = options.fence() ?? options.check(); if (refusal) { finish(refusal); return; }
      e.reach = bedBurstReach(bot.entity.position, foot); e.awaitingPosition ||= world.state.awaitingPosition;
      if (world.state.awaitingPosition || world.tick() <= world.state.settledTick || !options.ready()) return;
      sending = true;
      try {
        const p = bot.entity.position, movement = world.state.movement;
        if (!movement || movement.tick !== world.tick() || ['x', 'y', 'z'].some(k => movement.position[k as keyof P3] !== p[k])) motor.position();
        bot.setControlState('sneak', false);
        sentTick = world.tick();
        motor.burst(world.nextSequence(), yaw, pitch, world.tick, receipt => {
          e.sent.push(receipt); if (receipt.stage === 'use') { e.useTick = receipt.tick; options.onUse?.(receipt.tick); }
        });
      } catch (error) { finish(`packet_write_failed:${String(error)}`); }
      finally { sending = false; }
    };
    on(bot, 'move', attempt);
    on(bot, 'physicsTick', () => {
      const refusal = options.fence(); if (refusal) { finish(refusal); return; }
      if (sentTick !== null) {
        if (world.tick() - sentTick > 3) finish();
        else e.samples.push({ tick: world.tick(), foot: bot.blockAt(new Vec3(foot.x, foot.y, foot.z))?.name ?? null,
          head: bot.blockAt(new Vec3(head.x, head.y, head.z))?.name ?? null });
      } else queueMicrotask(bindActionCallback(bot, () => {
        if (done || sending || triggeringMove || sentTick !== null || attemptTick === world.tick()
          || !bedBurstDue(world.tick(), options.previousDetonationTick, LANDING_BLAST_GAP_TICKS)) return;
        try {
          const refusal = options.fence() ?? options.check(); if (refusal) { finish(refusal); return; }
          if (world.state.awaitingPosition || world.tick() <= world.state.settledTick) { e.awaitingPosition ||= world.state.awaitingPosition; return; }
          if (!options.ready()) { attemptTick = world.tick(); return; }
          // The position is real, but ONLY the following move callback may dispatch look/place/use.
          // Suppress a reentrant move emitted while position itself is still being written.
          triggeringMove = true;
          try { motor.position(); } finally { triggeringMove = false; }
          if (done) return; motor.assert();
          const p = bot.entity.position; bot.emit('move', new Vec3(p.x, p.y, p.z));
        } catch (error) { e.observationInterrupted = String(error); finish(); }
      }));
    });
    on(bot, 'blockUpdate', (_old, block) => {
      if (sentTick === null || world.tick() - sentTick > 3 || !block?.position) return;
      const p = block.position; if (![foot, head].some(c => c.x === p.x && c.y === p.y && c.z === p.z)) return;
      const halves = /_bed$/u.test(block.name) ? bedHalves(block, p) : null;
      e.blockUpdates.push({ tick: world.tick(), cell: { x: p.x, y: p.y, z: p.z }, name: block.name, halves });
      if (halves) {
        e.placeSeen = true;
        const matches = ['x', 'y', 'z'].every(k => halves.foot[k as keyof P3] === foot[k as keyof P3] && halves.head[k as keyof P3] === head[k as keyof P3]);
        e.orientationMismatch ||= !matches; if (matches) e.orientationMatches = true;
      }
    });
    on(world.client, 'explosion', packet => {
      if (e.useTick === null || e.detonationTick !== null || world.tick() - e.useTick > 3) return;
      const p = packet?.center ?? packet;
      const observed = e.blockUpdates.flatMap(b => b.halves ? [b.halves.head] : []);
      if ([head, ...observed].some(h => Number.isFinite(p?.x) && Math.hypot(p.x - h.x - .5, p.y - h.y - .5, p.z - h.z - .5) <= .75)) {
        e.detonationTick = world.tick(); world.state.lastBlast = world.tick();
      }
    });
    for (const event of ['death', 'respawn', 'spawn', 'game', 'end']) on(bot, event, () => finish('life_or_world_changed'), false);
    const timer = setTimeout(() => finish('physics_stalled_or_burst_timeout'), Math.max(1, Math.min(4000, options.until - Date.now())));
    options.signal.addEventListener('abort', aborted, { once: true });
    if (ownerSignal !== options.signal) ownerSignal?.addEventListener('abort', aborted, { once: true });
    if (options.signal.aborted || ownerSignal?.aborted) aborted();
  });
}
