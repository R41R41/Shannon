import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { classifyKnock, clutchAssessment, knockGeometry, knockPacketVelocity, recordEndKnocks } from '../../src/services/minebot/utils/endKnockRecord.js';
import { bodyBoxAt, inflate, partBox, shift } from '../../src/services/minebot/utils/dragonParts.js';

const p = (x: number, y: number, z: number) => ({ x, y, z });
const dragon = { position: p(103, 74, -39), yaw: 0, phase: 7 };
const classify = (feet: ReturnType<typeof p>, phase = 7, trials: Array<{ detonationTick: number | null }> = [], tick = 100) =>
  classifyKnock(tick, phase, knockGeometry(feet, { ...dragon, phase }), trials);

describe('knock evidence ranking and boxes', () => {
  it('records every box, using the exact contact margin and shifted wing push formula', () => {
    const feet = p(98.5, 72, -39), g = knockGeometry(feet, dragon);
    expect(g.bodyBox).toEqual(bodyBoxAt(feet)); expect(g.parts).toHaveLength(5);
    const wing = g.parts.find(x => x.part === 'wing1')!;
    expect(wing.box).toEqual(partBox(dragon, 'wing1'));
    expect(wing.contactBox).toEqual(inflate(wing.box, 1.1));
    expect(wing.pushBox).toEqual(shift(inflate(wing.box, 4, 2, 4), 0, -2, 0));
    expect(wing.pushOverlap).toBe(true);
    expect(g.partModel).toBe('perched_partBox_estimate');
    expect(knockGeometry(feet, { ...dragon, phase: 4 }).partModel).toBe('flight_partBox_estimate');
  });
  it.each([5, 6, 7, 0, 1, 2, 3, 10])('retains wing pushes in phase %s, including sitting', phase => {
    expect(classify(p(98.5, 72, -39), phase).cause).toBe('wing_push');
  });
  it('ranks phase-4 wing above head contact, and retains ambiguous candidates', () => {
    const g = knockGeometry(p(98.5, 72, -39), { ...dragon, phase: 4 });
    const result = classifyKnock(100, 4, { ...g, parts: g.parts.map(x => x.part === 'head' ? { ...x, contactOverlap: true } : x) }, []);
    expect(result.cause).toBe('takeoff_wing'); expect(result.candidates).toContain('head_contact'); expect(result.ambiguous).toBe(true);
    expect(classify(p(98.5, 72, -39), 4).cause).toBe('takeoff_wing');
  });
  it.each([0, Math.PI / 2, -Math.PI / 2, Math.PI, 0.7])('translates and rotates boxes with the observed dragon (yaw %s)', yaw => {
    const d = { ...dragon, position: p(-57, 89, 120), yaw };
    const box = partBox(d, 'wing1'), feet = p((box.minX + box.maxX) / 2, 87, (box.minZ + box.maxZ) / 2);
    expect(classifyKnock(1, 7, knockGeometry(feet, d), []).cause).toBe('wing_push');
  });
  it('distinguishes head, neck and raw body contact', () => {
    expect(classify(p(103, 73, -31)).cause).toBe('head_contact');
    expect(classify(p(103, 73, -35)).cause).toBe('neck_contact');
    expect(classify(p(103, 74, -39)).cause).toBe('body_contact');
  });
  it.each([0, 1, 2, 3])('ranks a confirmed bed blast %s ticks ago first', age => {
    const r = classify(p(98.5, 72, -39), 4, [{ detonationTick: 100 - age }]);
    expect(r.cause).toBe('bed_blast'); expect(r.candidates).toContain('takeoff_wing');
  });
  it('keeps the previous 20 ticks but excludes old, null, future and NaN detonations', () => {
    const r = classify(p(98.5, 72, -39), 7, [null, 101, 100 - 4, 80, 79, NaN].map(detonationTick => ({ detonationTick })));
    expect(r.cause).toBe('wing_push'); expect(r.bedDetonationTicks).toEqual([96, 80]);
  });
  it('reports unknown when no pose/overlap exists, and cloud only for disc AND slab overlap', () => {
    const cloud = { id: 9, position: p(0, 64, 0), radius: 3 };
    const g = knockGeometry(p(0, 64, 0), null, [cloud]);
    expect(g.partModel).toBe('unavailable'); expect(g.parts).toEqual([]);
    expect(classifyKnock(10, null, g, []).cause).toBe('cloud');
    expect(classifyKnock(10, null, knockGeometry(p(0, 66, 0), null, [cloud]), []).cause).toBe('unknown');
    expect(classifyKnock(10, null, knockGeometry(p(8, 64, 0), null, [cloud]), []).cause).toBe('unknown');
  });
  it('decodes modern and legacy wire velocities exactly once', () => {
    expect(knockPacketVelocity({ velocity: p(2, 1.25, -3) })).toEqual(p(2, 1.25, -3));
    expect(knockPacketVelocity({ velocityX: 16000, velocityY: 10000, velocityZ: -24000 })).toEqual(p(2, 1.25, -3));
    expect(knockPacketVelocity({ velocity: p(0, NaN, 0) })).toBeNull();
  });
});

function rig(enabled = true, clutchAt?: number) {
  let clock = 100_000, tick = 0, seq = 0, knocks = 0;
  const entries: any[] = [], items: any[] = [{ name: 'water_bucket', slot: 37 }];
  const bot: any = new EventEmitter(); bot._client = new EventEmitter();
  const write = vi.fn(function (this: any, _name: string, _data: any) { expect(this).toBe(bot._client); return 'written'; });
  bot._client.write = write; bot._client.serializer = { writable: true };
  bot.entity = { id: 42, position: new Vec3(98.5, 64, -39), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false };
  bot.health = 20; bot.game = { dimension: 'the_end' }; bot.heldItem = { name: 'iron_sword' };
  bot.inventory = { items: () => items }; bot.floorReflexes = { fall: clutchAt === undefined ? {} : { clutchAt } };
  bot.reflexLedger = { counts: () => ({ knock: knocks }), mark: () => seq, entriesSince: () => entries };
  bot.blockAt = (cell: any) => cell.y === 63 ? { name: 'end_stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: cell }
    : { name: 'air', boundingBox: 'empty', shapes: [], position: cell };
  const d = { ...dragon, position: p(103, 66, -39) }, beds: Array<{ detonationTick: number | null }> = [];
  const recorder = recordEndKnocks(bot, { enabled, now: () => clock, tick: () => tick, dragon: () => d, clouds: () => [], bedTrials: () => beds });
  const step = (y: number, vy: number, onGround = false, inWater = false) => {
    clock += 50; tick++; bot.entity.position.y = y; bot.entity.velocity.y = vy;
    bot.entity.onGround = onGround; bot.entity.isInWater = inWater; bot.emit('physicsTick');
  };
  const launch = () => bot._client.emit('entity_velocity', { entityId: 42, velocity: p(0, 1.2, 0) });
  const ledger = (detail: string, outcome = 'done', kind = 'retreat', entrySeq = ++seq) => {
    entries.push({ seq: entrySeq, at: clock, kind, detail, outcome, n: 1 }); return entrySeq;
  };
  const clutch = () => { bot.floorReflexes.fall.clutchAt = clock; return ++seq; };
  return { bot, recorder, step, launch, ledger, clutch, items, beds, d, write, advanceClock: (ms: number) => { clock += ms; },
    knock: () => { knocks++; }, hp: (hp: number) => { bot.health = hp; bot.emit('health'); } };
}

describe('passive launch/fall/landing recorder', () => {
  it('groups packet, merged knock count and re-launch into one flight; pairs peak, fall and death', () => {
    const r = rig(); r.launch(); r.knock(); r.step(70, 1.1); r.launch(); r.step(80, 0); r.step(70, -1);
    r.step(64, -1.2, true); r.hp(0); r.bot.emit('death'); r.recorder.stop();
    expect(r.recorder.errors).toEqual([]); expect(r.recorder.knocks).toHaveLength(1);
    const k = r.recorder.knocks[0]; expect(k.impulses.some((i: any) => i.source === 'ledger_knock')).toBe(true);
    expect(k.impulses[0].packetVelocity.y).toBe(1.2); expect(k.peak.position.y).toBe(80);
    expect(k.heightFromPeak).toBe(16); expect(k.end.outcome).toBe('death'); expect(k.secondsFromKnock).toBeCloseTo(0.2);
    expect(k.clutch.notWorkedReasons).toContain('eligible_but_start_unobserved');
    expect(k.clutch.actualFallDamage).toBeNull(); expect(k.clutch.landingWindowHpLossAllCauses).toBe(20);
    expect(r.write).not.toHaveBeenCalled();
  });
  it('observes two distinct flights and merged ledger counts without requiring a new seq', () => {
    const r = rig(); r.knock(); r.step(65, 0.3); r.step(64, -0.1, true);
    r.knock(); r.step(65, 0.3); r.step(64, -0.1, true); r.recorder.stop();
    expect(r.recorder.knocks).toHaveLength(2); expect(r.recorder.knocks.every(k => k.end.outcome === 'landed')).toBe(true);
  });
  it('does not trigger on normal jumps, small packets or another entity, but accepts sudden physics velocity', () => {
    const r = rig(); r.step(65, 0.42); r.bot._client.emit('entity_velocity', { entityId: 7, velocity: p(0, 2, 0) });
    r.bot._client.emit('entity_velocity', { entityId: 42, velocity: p(0, 0.42, 0) }); expect(r.recorder.knocks).toHaveLength(0);
    r.step(70, 1.1); r.recorder.stop('time_limit'); expect(r.recorder.knocks[0].end.outcome).toBe('time_limit');
  });
  it('classifies late same-tick explosion confirmation without counting a use request', () => {
    const r = rig(); r.launch(); r.beds.push({ detonationTick: 0 }); r.recorder.stop();
    expect(r.recorder.knocks[0].cause).toBe('bed_blast'); expect(r.recorder.knocks[0].impulses[0].bedDetonationTicks).toEqual([0]);
    const q = rig(); q.launch(); q.beds.push({ detonationTick: null }); q.recorder.stop(); expect(q.recorder.knocks[0].cause).not.toBe('bed_blast');
  });
  it('records clutch retreat detail, actual water use and nearby water, plus the delayed ledger outcome', () => {
    const r = rig(); r.launch(); r.step(80, 1); r.step(75, -0.75);
    const seq = r.clutch(); r.step(66, -1); r.bot.heldItem = { name: 'water_bucket' };
    expect(r.bot._client.write('use_item', { hand: 0, sequence: 4 })).toBe('written');
    r.bot.emit('blockUpdate', null, { name: 'water', metadata: 0, position: new Vec3(98, 64, -39) });
    r.step(64, -0.1, false, true); r.ledger('落下を水バケツで止めた（水は汲み直した）', 'done', 'retreat', seq);
    r.recorder.stop(); const k = r.recorder.knocks[0];
    expect(k.clutch.started).toBe(true); expect(k.clutch.ledgerKinds).toEqual(['retreat']); expect(k.clutch.poured).toBe(true);
    expect(k.waterUses[0]).toMatchObject({ status: 'sent_unconfirmed', heightToFloor: 2, heightAboveEnd: 2 });
    expect(k.waterUses[0].secondsToEnd).toBeCloseTo(0.05);
    expect(k.waterObserved).toHaveLength(1); expect(k.clutch.waterLanding).toBe(true); expect(k.clutch.notWorkedReasons).toEqual([]);
    expect(k.trajectory.find((s: any) => s.floorName === 'end_stone').floorFullCube).toBe(true);
    expect(k.trajectory.find((s: any) => s.floorName === 'end_stone').endStoneStandable).toBe(true);
    expect(r.bot._client.write).toBe(r.write);
  });
  it.each(['cut', 'failed'])('retains a %s clutch, no-pour reason and missing use window', outcome => {
    const r = rig(); r.launch(); r.step(80, 0); const seq = r.clutch(); r.step(75, -1); r.step(64, -1.5, true);
    r.ledger('落下を水バケツで止めた（水をあける前に着地した）', outcome, 'retreat', seq); r.recorder.stop();
    expect(r.recorder.knocks[0].clutch.notWorkedReasons).toContain('landed_before_pour');
    expect(r.recorder.knocks[0].clutch.notWorkedReasons).toContain('no_reachable_floor_sample_before_end');
    expect(r.recorder.knocks[0].ledger[0].outcome).toBe(outcome);
  });
  it('explains disabled release, pack bucket, threshold, unloaded/void/liquid ground and cooldown separately', () => {
    const r = rig(false); r.launch(); r.step(80, 0); r.items[0].slot = 20;
    r.step(75, -0.75); r.step(70, -1); r.recorder.stop();
    const reasons = r.recorder.knocks[0].clutch.notWorkedReasons;
    expect(reasons).toContain('release_disabled'); expect(reasons).toContain('bucket_not_in_hand_or_hotbar');
    for (const [name, kind] of [['air', 'void'], ['water', 'water'], ['lava', 'lava'], [null, 'unknown']] as const) {
      const q = rig(); q.bot.blockAt = () => name === null ? null : { name, boundingBox: 'empty', shapes: [] };
      q.launch(); q.step(80, 0); q.step(75, -1); q.recorder.stop();
      expect(q.recorder.knocks[0].clutch.notWorkedReasons).toContain(`ground_${kind}`);
    }
    const q = rig(true, 100_000); q.launch(); q.step(70, 0); q.step(67, -1); q.recorder.stop();
    expect(q.recorder.knocks[0].clutch.notWorkedReasons).toContain('cooldown');
  });
  it('preserves packet write errors and reports unconfirmed use without inventing success or damage IDs', () => {
    const r = rig(); r.launch(); r.step(75, -1); r.bot.heldItem = { name: 'water_bucket' };
    r.bot._client.emit('damage_event', { entityId: 42, sourceTypeId: 19, sourceCauseId: 0 }); r.hp(17);
    r.bot._client.write('use_item', {}); r.step(64, -1, true); r.recorder.stop(); const k = r.recorder.knocks[0];
    expect(k.damageEvents[0]).toMatchObject({ sourceTypeId: 19, type: null });
    expect(k.clutch.useSuccess).toBe('unconfirmed'); expect(k.clutch.notWorkedReasons).toContain('pour_sent_water_landing_unconfirmed');
    expect(k.fallDamage).toBeNull();
    const q = rig(); q.write.mockImplementation(() => { throw new Error('write refused'); }); q.launch(); q.bot.heldItem = { name: 'water_bucket' };
    expect(() => q.bot._client.write('use_item', {})).toThrow('write refused'); q.recorder.stop();
    expect(q.recorder.knocks[0].waterUses[0].status).toBe('write_failed');
  });
  it('cleans up all listeners/write tap on stop, ignores later activity and records corrections as incomplete', () => {
    const r = rig(); r.launch(); r.step(75, -1); r.bot.emit('forcedMove'); r.recorder.finish('scene_end'); r.step(64, -1, true); r.recorder.stop(); r.recorder.stop();
    expect(r.recorder.knocks[0].end.outcome).toBe('server_position_correction');
    expect(r.bot.eventNames()).toEqual([]); expect(r.bot._client.eventNames()).toEqual([]); expect(r.bot._client.write).toBe(r.write);
    r.launch(); expect(r.recorder.knocks).toHaveLength(1);
  });
  it('can report low-damage/slow falls without treating absence of a ledger as proof of a failed use', () => {
    const r = rig(); r.knock(); r.step(65, -0.2); r.step(64, -0.1, true); r.recorder.stop();
    expect(r.recorder.knocks[0].clutch.notWorkedReasons).toContain('no_falling_threshold_sample');
    const s = rig(); s.launch(); s.step(67, 0); s.step(66, -0.75); s.recorder.stop();
    expect(s.recorder.knocks[0].clutch.notWorkedReasons).toContain('below_min_damage');
    expect(clutchAssessment(s.recorder.knocks[0], true).started).toBe(false);
  });
  it('keeps a delayed clutch ledger on its original flight while the next flight is active', () => {
    const r = rig(); r.launch(); r.step(80, 0); const firstSeq = r.clutch(); r.step(70, -1); r.step(64, -1, true);
    r.launch(); r.step(80, 0); const secondSeq = r.clutch(); r.step(70, -1);
    r.ledger('落下を水バケツで止めた（一回目）', 'failed', 'retreat', firstSeq); r.step(66, -1);
    r.ledger('落下を水バケツで止めた（二回目）', 'cut', 'retreat', secondSeq); r.step(64, -1, true); r.recorder.stop();
    expect(r.recorder.knocks[0].ledger.map((e: any) => e.seq)).toEqual([firstSeq]);
    expect(r.recorder.knocks[1].ledger.map((e: any) => e.seq)).toEqual([secondSeq]);
  });
  it('keeps damage arriving just before launch and safely reports observation failures', () => {
    const r = rig(); r.bot._client.emit('damage_event', { entityId: 42, sourceTypeId: 8, sourceCauseId: 78 }); r.launch();
    expect(r.recorder.knocks[0].damageEvents[0].causeId).toBe(78);
    r.bot.inventory.items = () => { throw new Error('inventory unavailable'); }; expect(() => r.step(70, -1)).not.toThrow();
    expect(() => r.recorder.stop()).not.toThrow(); expect(r.recorder.errors.length).toBeGreaterThan(0);
    expect(r.bot.eventNames()).toEqual([]);
  });
  it('waits for an already started clutch ledger after scene termination without starting another flight', async () => {
    vi.useFakeTimers();
    try {
      const r = rig(); r.launch(); r.step(80, 0); const seq = r.clutch(); r.step(70, -1); r.recorder.finish('death');
      setTimeout(() => r.ledger('落下を水バケツで止めた（失敗）', 'failed', 'retreat', seq), 200);
      const pending = r.recorder.settle(); r.launch(); await vi.advanceTimersByTimeAsync(250); await pending; r.recorder.stop();
      expect(r.recorder.knocks).toHaveLength(1); expect(r.recorder.knocks[0].ledger[0].outcome).toBe('failed');
      expect(r.recorder.knocks[0].clutchLedgerPendingAtStop).toBe(false); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('bounds the ledger drain and reports a missing outcome without inventing a failure or success', async () => {
    vi.useFakeTimers();
    try {
      const r = rig(); r.launch(); r.step(80, 0); r.clutch(); r.step(70, -1); r.recorder.finish('death');
      const pending = r.recorder.settle(); await vi.advanceTimersByTimeAsync(8300); await pending; r.recorder.stop();
      expect(r.recorder.knocks[0].clutch.notWorkedReasons).toContain('ledger_pending_at_stop'); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('excludes later damage from the landing window even while the scene tick is frozen for ledger drain', () => {
    const r = rig(); r.launch(); r.step(80, 0); r.step(64, -1, true); r.hp(18); r.recorder.finish();
    r.advanceClock(500); r.hp(10); r.recorder.stop();
    expect(r.recorder.knocks[0].healthLosses).toHaveLength(2);
    expect(r.recorder.knocks[0].clutch.landingWindowHpLossAllCauses).toBe(2);
  });
});
