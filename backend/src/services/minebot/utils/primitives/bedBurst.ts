import { Vec3 } from 'vec3';
import { actionSignal, hasActiveSafetyLease, nativeActionHost } from '../../execution/ActionExecution.js';
import { bedBurstOnOwnedMove, bedBurstWorld } from '../bedBurstRuntime.js';
import { LANDING_BLAST_GAP_TICKS, bedBurstDue, bedBurstProblem } from '../bedBurst.js';
import { bedBodyBox, bedDamage, bedExposureSearch, landingBedFireClear, landingBedRefusalSearch } from '../dragonBedGeometry.js';
import { dragonLandingTarget, landingBurstDue, landingShotWindow, landingStandContacts, predictLandingPath } from '../dragonLandingPath.js';
import { dragonHazards } from '../dragonDanger.js';
import { dragonPhaseOf, fountainOf, isEnd } from '../dragonState.js';
import { lifeOf } from '../life.js';
import { bedBurstFireCells, hasBedBurstDiagnosticObservers, noteBedBurstDiagnostic } from '../bedBurstDiagnostics.js';
import { StepStopped, wait, type StepContext, type StepOutcome } from './common.js';
import type { P3 } from '../dragonParts.js';

export interface BedBurstArgs { at: P3[]; target: string; count: number; seconds: number }
const distance = (a: P3, b: P3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** One head-selected approach. Placement of supports, movement and retreat remain separate head-selected hands. */
export async function bedBurst(ctx: StepContext, args: BedBurstArgs): Promise<StepOutcome> {
  const problem = bedBurstProblem(args); if (problem) return { ok: false, reason: 'invalid_input', text: `bed_burst: ${problem}` };
  const bot = ctx.bot, host: any = nativeActionHost(bot), id = Number(args.target.slice(1)), dragon = host.entities?.[id];
  const startPhase = dragonPhaseOf(host, dragon);
  let diagnostic: (stage: string, code: string, extra?: () => Record<string, unknown>) => void = () => {};
  const result = (done: number, code: string, unknown = false): StepOutcome => { diagnostic('finish', code, () => ({ done })); return { ok: true, ...(unknown ? { goal: 'unknown' as const } : {}), code,
    text: `bed_burst 確認爆発${done}/${args.count}（${code}）`, at: args.at[1], progress: { unit: 'item', done, left: null } }; };
  if (!isEnd(host) || dragon?.name !== 'ender_dragon' || ![2, 3].includes(startPhase ?? -1)) return { ok: false, reason: 'not_this_landing', text: 'bed_burst: 指定の竜の現在の進入2/3ではない' };
  if (host.version !== '1.21.11') return { ok: false, reason: 'unsupported_bed_protocol', text: 'bed_burst: 1.21.11で検証された送信形式が必要' };
  const world = bedBurstWorld(host), receipt = world.dragon(id)!;
  const epoch = world.epoch(), entity = host.entity, dimension = host.game.dimension, life = lifeOf(host)?.view();
  const approach = receipt.approach, stand = { ...entity.position }, until = Math.min(ctx.deadline, Date.now() + args.seconds * 1000);
  const [foot, head] = args.at.map(p => ({ ...p }));
  const read = (p: P3) => host.blockAt(new Vec3(p.x, p.y, p.z));
  const centre = fountainOf(host);
  const minY = host.game.minY ?? 0, maxY = minY + (host.game.height ?? 256) - 1;
  const target = centre && dragonLandingTarget(centre, minY, maxY, read);
  if (!target) return { ok: false, reason: 'landing_target_unread', text: 'bed_burst: 泉の中央列が未観測' };
  const layout = world.site(id, foot, head);
  if (!layout || distance(layout.stand, stand) > 1) return { ok: false, reason: 'landing_layout_unobserved', text: 'bed_burst: この進入のbedsiteで読んだ配置と立場が必要' };
  if (!layout.landingTarget || distance(layout.landingTarget, target) > 1e-6) return result(0, 'landing_target_changed');
  let traceTick = -1; const traceKeys = new Set<string>();
  let lastSelf: (NonNullable<Parameters<typeof landingBedRefusalSearch>[7]>['self'] & { tick: number; actor: P3 }) | null = null;
  diagnostic = (stage, code, extra) => noteBedBurstDiagnostic(host, () => {
    if (traceTick !== world.tick()) { traceTick = world.tick(); traceKeys.clear(); }
    const key = `${stage}:${code}`; if (traceKeys.has(key)) return null; traceKeys.add(key);
    return { stage, code, tick: world.tick(), phase: dragonPhaseOf(host, dragon), approach, uses: receipt.uses,
      actor: { ...entity.position }, health: Number(host.health), lastBlast: world.state.lastBlast,
      latestObservationTick: receipt.history.at(-1)?.tick ?? null, readyAt: world.site(id, foot, head)?.readyAt ?? null,
      bodyPoseHistorySource: 'accepted_native_body_position_packets; one_per_receipt_tick; not_native_part_truth',
      bodyPoseHistory: receipt.history.slice(-16),
      self: lastSelf, selfCheckedAtThisTick: lastSelf?.tick === world.tick(),
      fireCells: code === 'landing_fire_or_unloaded_neighbour' ? bedBurstFireCells(read, entity.position) : undefined,
      contacts: code === 'landing_stand_in_dragon' ? landingStandContacts(predictLandingPath(receipt.history, target, world.tick(), 3), bedBodyBox(entity.position), .5) : undefined,
      ...extra?.() };
  });
  const budget = world.compute;
  let entered = startPhase === 3, done = 0;
  const lifeFence = (): string | null => {
    if (ctx.stop.aborted || actionSignal(bot)?.aborted) throw Object.assign(new StepStopped('cancelled'), { progress: { unit: 'item', done, left: null } });
    const nowLife = lifeOf(host)?.view();
    if (world.stopped() || world.epoch() !== epoch || host._client !== world.client || host.entity !== entity
      || host.game.dimension !== dimension || !isEnd(host) || !(host.health > 0) || (life && (!nowLife || life.life !== nowLife.life
        || life.deathEpoch !== nowLife.deathEpoch || life.dimensionSince !== nowLife.dimensionSince))) throw Object.assign(new StepStopped('life_or_world_changed'), { progress: { unit: 'item', done, left: null } });
    if (host.entities?.[id] !== dragon) return 'landing_target_changed';
    const d = world.dragon(id), phase = dragonPhaseOf(host, dragon);
    const currentSite = world.site(id, foot, head);
    if (currentSite?.targetChanged || (currentSite && distance(currentSite.landingTarget, target) > 1e-6)) return 'landing_target_changed';
    if (!d || d.approach !== approach || (entered ? phase !== 3 : ![2, 3].includes(phase ?? -1))) return 'landing_window_ended';
    if (phase === 3) entered = true;
    return null;
  };
  const standRefusal = (): string | null => {
    if (hasActiveSafetyLease(host) || host.floorReflexes?.busy || host.floorReflexes?.retreat?.engaged || host.shieldBlock?.up) return 'reflex_or_shield_owns_body';
    if (distance(entity.position, stand) > 1) return 'landing_stand_changed';
    if (!landingBedFireClear(read, entity.position)) return 'landing_fire_or_unloaded_neighbour';
    if (dragonHazards(host, { along: [entity.position] }).length) return 'landing_hazard';
    const feet = { x: Math.floor(entity.position.x), y: Math.floor(entity.position.y), z: Math.floor(entity.position.z) };
    if (!['bedrock', 'obsidian'].includes(read({ ...feet, y: feet.y - 1 })?.name ?? '')) return 'landing_footing_not_durable';
    const path = predictLandingPath(receipt.history, target, world.tick(), 3);
    if (path.length && landingStandContacts(path, bedBodyBox(entity.position), .5).some(c => c.blocking)) return 'landing_stand_in_dragon';
    return null;
  };
  const check = (): string | null => {
    const refusal = lifeFence() ?? standRefusal(); if (refusal) return refusal;
    if (!/_bed$/u.test(String(host.heldItem?.name ?? ''))) return 'bed_not_in_hand';
    const path = predictLandingPath(receipt.history, target, world.tick(), 3);
    const capture: NonNullable<Parameters<typeof landingBedRefusalSearch>[7]> | undefined = hasBedBurstDiagnosticObservers(host) ? {} : undefined;
    const search = landingBedRefusalSearch(layout, entity.position, path, read, Number(host.health), .5, entity, capture), r = budget(search);
    if (r.done && capture?.self) lastSelf = { ...capture.self, tick: world.tick(), actor: { ...entity.position } };
    if (!r.done) { search.return(null); return 'landing_computation_budget'; }
    return r.value;
  };
  const ready = (): boolean => {
    const ping = Number(host.player?.ping), lead = Number.isFinite(ping) && ping >= 0 ? 1 + Math.ceil(ping / 50) : Infinity;
    if (lead + 1 > 3 || dragonPhaseOf(host, dragon) !== 3) { diagnostic('ready', lead + 1 > 3 ? 'latency_horizon' : 'not_phase3', () => ({ ping, lead })); return false; }
    const hits = landingShotWindow(receipt.history, target, world.tick());
    if (hits.length !== 2 || hits.some(p => p.phase !== 3 || !landingBurstDue({ phase: 3, now: world.tick(), lastBlast: world.state.lastBlast,
      head: p.head, pillow: { x: head.x + .5, y: head.y + .5, z: head.z + .5 }, beds: 5, error: 0 }))) {
      diagnostic('ready', hits.length !== 2 ? 'head_history_unavailable' : 'head_window_closed', () => ({ heads: hits.map((p, i) => ({ kind: i === 0 ? 'head_model_at_latest_body_packet' : 'forecast_head_model', tick: p.tick, phase: p.phase, head: p.head,
        headBox: p.headBox, observedTick: p.observedTick, forecastTick: p.forecastTick,
        pillowDistance: distance(p.head, { x: head.x + .5, y: head.y + .5, z: head.z + .5 }) })) })); return false;
    }
    const heads: Record<string, unknown>[] | null = hasBedBurstDiagnosticObservers(host) ? [] : null;
    const search = (function* () {
      for (const hit of hits) {
        const exposure = yield* bedExposureSearch(read, { x: head.x + .5, y: head.y + .5, z: head.z + .5 }, hit.headBox, [head, foot]);
        const pillowDistance = distance(hit.head, { x: head.x + .5, y: head.y + .5, z: head.z + .5 }), damage = bedDamage(pillowDistance, exposure);
        heads?.push({ kind: hit === hits[0] ? 'head_model_at_latest_body_packet' : 'forecast_head_model', tick: hit.tick, phase: hit.phase, head: hit.head, headBox: hit.headBox, observedTick: hit.observedTick,
          forecastTick: hit.forecastTick, pillowDistance, exposure, damage });
        if (damage < 35) { diagnostic('ready', 'head_damage_below35', () => ({ headTick: hit.tick, exposure, damage, heads })); return false; }
      }
      return true;
    })();
    const r = budget(search); if (!r.done) { search.return(false); diagnostic('ready', 'computation_budget'); return false; }
    if (r.value) diagnostic('ready', 'ready', () => ({ heads, pillow: { x: head.x + .5, y: head.y + .5, z: head.z + .5 } })); return r.value;
  };
  while (Date.now() < until) {
    const end = lifeFence(); if (end) return result(done, end);
    if (receipt.uses >= 5) return result(done, 'landing_five_bed_limit');
    const unsafe = standRefusal(); if (unsafe) return result(done, unsafe);
    if (dragonPhaseOf(host, dragon) === 2) { diagnostic('wait', 'phase2'); await wait(ctx, 25); continue; }
    if (world.site(id, foot, head)?.readyAt == null) return result(done, 'landing_not_prepared_in_phase2');
    // A second burst needs an actually observed HP decrease after the last use, not an operator query or a predicted damage number.
    const previous = receipt.lastUse;
    if (previous) {
      if (!previous.confirmed || previous.blast === null) return result(done, 'landing_previous_blast_unconfirmed', true);
      const loss = receipt.health.some(h => h.source === 'packet' && h.tick >= previous.tick && h.tick - previous.tick <= 5 && h.value < previous.hp);
      if (!loss && world.tick() - previous.tick > 5) return result(done, 'landing_previous_health_unconfirmed', true);
      if (!loss) { diagnostic('wait', 'post_use_health'); await wait(ctx, 10); continue; }
    }
    if (!bedBurstDue(world.tick(), world.state.lastBlast, LANDING_BLAST_GAP_TICKS)) { diagnostic('wait', 'eleven_tick_gap'); await wait(ctx, 10); continue; }
    const bed = host.inventory?.items?.().find((item: any) => /_bed$/u.test(item.name) && item.count > 0);
    if (!bed) return result(done, 'beds_exhausted');
    if (!/_bed$/u.test(String(host.heldItem?.name ?? ''))) { await bot.equip(bed, 'hand'); lifeFence(); }
    const refusal = check();
    if (refusal === 'landing_prediction_missing' || refusal === 'landing_computation_budget') { diagnostic('check', refusal); await wait(ctx, 10); continue; }
    if (refusal) return result(done, refusal);
    if (!ready()) { await wait(ctx, 10); continue; }
    const hp = receipt.health.at(-1)?.value;
    if (!Number.isFinite(hp)) return result(done, 'landing_health_unobserved');
    const evidence = await bedBurstOnOwnedMove(bot, world, { foot, head, previousDetonationTick: world.state.lastBlast, until, signal: ctx.stop,
      fence: lifeFence, check, ready, onUse: tick => { receipt.uses++; receipt.lastUse = { tick, hp: hp!, blast: null, confirmed: false }; } });
    if (receipt.lastUse && receipt.lastUse.tick === evidence.useTick) {
      receipt.lastUse.blast = evidence.detonationTick;
      receipt.lastUse.confirmed = evidence.detonationTick !== null && !evidence.orientationMismatch && !evidence.failure && !evidence.observationInterrupted;
    }
    lifeFence();
    if (evidence.useTick === null) return result(done, evidence.failure ?? 'landing_use_not_sent');
    if (evidence.detonationTick === null || evidence.orientationMismatch || evidence.observationInterrupted || evidence.failure) return result(done, evidence.failure ?? 'landing_burst_unconfirmed', true);
    done++; ctx.progress?.(`bed_burst 確認爆発${done}/${args.count}`);
    if (done >= args.count) return result(done, 'landing_train_finished');
  }
  return result(done, 'landing_time_limit');
}
