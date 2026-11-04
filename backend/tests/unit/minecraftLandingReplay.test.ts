import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { interpolateHeads, countWindows, replay, replayMiddle, replayReturns, replayStandRefusals } = require('../../scripts/lab/landing-replay.cjs');
const head = { x: 0, y: 0, z: 0 };

describe('M2 read-only landing replay aggregation', () => {
  const returnsFixture = () => ({ scenes: { end_bed_crystals_p3: { landing: [{ n: 1, startTick: 0, endTick: 75,
    target: { x: .5, y: 5, z: .5 }, preparation: { stand: { x: -100, y: -50, z: -100 } },
    observations: Array.from({ length: 25 }, (_, n) => ({ tick: n * 3, phase: 3, yaw: 0, position: { x: .5, y: 5, z: 0 }, velocity: { x: 0, y: 0, z: 0 } })),
    shots: [{ useTick: 12, detonationTick: 13, healthRecorded: true, head: { x: 0, y: 4, z: 6 }, serverDragonLoss: 60 }],
    healing: [20, 30, 40, 50, 60, 70].map(tick => ({ tick, amount: 1 })) }], refusals: [] } } });
  it('counts receipt-based returns greedily, caps at five, and subtracts recorded crystal healing over explicit intervals', () => {
    const report = returnsFixture(), [row] = replayReturns(report);
    expect(row.train.map((s: any) => s.tick)).toEqual([12, 24, 36, 48, 60]);
    expect(row.train.map((s: any) => s.receiptTick)).toEqual([13, 25, 37, 49, 61]);
    expect(row.recordedHealing).toBe(5); expect(row.healingThroughLandingEnd).toBe(6);
    expect(row.netE1).toBeCloseTo(row.damageE1 - 5);
    expect(row.netThroughLandingEndE1).toBeCloseTo(row.damageE1 - 6);
    expect(row.actualFirstNetThroughLandingEnd).toBe(54);
    const changed = structuredClone(report);
    changed.scenes.end_bed_crystals_p3.landing[0].observations.filter(p => p.tick > 40).forEach(p => p.position.y += 100);
    expect(replayReturns(changed)[0].train.slice(0, 3)).toEqual(row.train.slice(0, 3));
    expect(replayReturns(changed)[0].shots).toBe(3);
  });
  it('does not invent a first blast or extra lift, and separates targeting from contact vetoes', () => {
    const report = returnsFixture(), l = report.scenes.end_bed_crystals_p3.landing[0];
    l.preparation.stand = { x: .5, y: 5, z: 0 };
    const [row] = replayReturns(report);
    expect(row.targetShots).toBe(5); expect(row.shots).toBe(1);
    expect(row.standStopTick).toBe(14); expect(row.blockedContacts.length).toBeGreaterThan(0);
    l.shots = [];
    expect(replayReturns(report)[0]).toMatchObject({ shots: 0, reason: 'no_confirmed_first_blast_to_anchor_recorded_lift' });
  });
  const r253 = new URL('../../../lab-evidence/r253-report.json', import.meta.url);
  it.skipIf(!fs.existsSync(r253))('reproduces r253 lifted trajectories, returning candidates and known contact refusals', () => {
    const report = JSON.parse(fs.readFileSync(r253, 'utf8'));
    const rows = replayReturns(report).filter((r: any) => r.train.length);
    expect(rows.map((r: any) => r.landing)).toEqual([1, 4, 6]);
    expect(rows.map((r: any) => r.targetTrain.map((s: any) => s.tick))).toEqual([[1475, 1524], [8531], [15395, 15448]]);
    expect(rows.map((r: any) => r.shots)).toEqual([1, 1, 1]);
    expect(rows.map((r: any) => r.healingThroughLandingEnd)).toEqual([6, 6, 6]);
    expect(rows[0].targetTrain[1].damageE1).toBeCloseTo(43.83, 2);
    expect(rows[2].targetTrain[1].damageE1).toBeCloseTo(47.24, 2);
    const hazards = replayStandRefusals(report);
    expect(hazards.map((r: any) => r.callbackRefusals)).toEqual([31, 29, 36]);
    expect(hazards.map((r: any) => r.contactTicks.wing1)).toEqual([9, 11, 8]);
    expect(hazards.every((r: any) => r.environment.includes('unrecorded'))).toBe(true);
  });
  it('counts packet and interpolated ticks separately, refusing phase 2, long gaps and endpoint padding', () => {
    const obs = [
      { tick: 0, phase: 2, head }, { tick: 2, phase: 3, head },
      { tick: 5, phase: 3, head: { ...head, x: 3 } }, { tick: 15, phase: 3, head },
    ];
    const samples = interpolateHeads(obs, 1, 17);
    expect(samples.map((p: any) => p.tick)).toEqual([2, 3, 4, 5, 15]);
    expect(samples.filter((p: any) => p.packet).map((p: any) => p.tick)).toEqual([2, 5, 15]);
    expect(samples[1].head.x).toBe(1);
    expect(countWindows(samples, head, 2)).toEqual({ ticks: 4, packetTicks: 2, ranges: [[2, 4], [15, 15]], shots: 1, train: [2] });
  });
  it('counts exact +10 trains, tries later starts, and never joins missed cadence slots', () => {
    const samples = [0, 1, 10, 11, 21, 31, 41, 51, 70].map(tick => ({ tick, head, packet: true }));
    expect(countWindows(samples, head, 2.07)).toEqual({ ticks: 9, packetTicks: 9,
      ranges: [[0, 1], [10, 11], [21, 21], [31, 31], [41, 41], [51, 51], [70, 70]], shots: 6, train: [1, 11, 21, 31, 41, 51] });
    expect(countWindows(samples, { x: 3.22, y: 0, z: 0 }, 3.22).ticks).toBe(9);
    expect(countWindows(samples, { x: 3.23, y: 0, z: 0 }, 3.22).ticks).toBe(0);
    expect(countWindows(samples, head, 2.07, new Set([0, 10, 31])).train).toEqual([0, 10]);
  });
  const evidence = new URL('../../../lab-evidence/r245-report.json', import.meta.url);
  const r250 = new URL('../../../lab-evidence/r250-report.json', import.meta.url);
  it.skipIf(!fs.existsSync(evidence) || !fs.existsSync(r250))('replays the entry-frozen middle ring with first-tick cadence, never choosing a later train', () => {
    const rows = [evidence, r250].flatMap(file => replayMiddle(JSON.parse(fs.readFileSync(file, 'utf8'))));
    expect(rows.map((r: any) => r.shots)).toEqual([0, 1, 0, 2, 1]);
    expect(rows.map((r: any) => r.train)).toEqual([[], [4093], [], [2697, 2707], [4156]]);
    expect(rows.map((r: any) => r.geometric.shots)).toEqual([2, 1, 1, 2, 1]);
    for (const row of rows) expect(row.train[0] ?? null).toBe(row.admitted[0] ?? null);
    // A later head mutation cannot change the selected pillow.
    const original = JSON.parse(fs.readFileSync(evidence, 'utf8')), changed = structuredClone(original);
    for (const l of changed.scenes.end_bed_crystals_p3.landing) for (const p of l.observations) if (p.tick > l.startTick) p.head.x += 100;
    expect(replayMiddle(changed).map((r: any) => r.cell)).toEqual(replayMiddle(original).map((r: any) => r.cell));
  });
  it.skipIf(!fs.existsSync(evidence))('reproduces the r245 entry-frozen table and a causal near-horizon comparison', () => {
    const report = JSON.parse(fs.readFileSync(evidence, 'utf8'));
    const rows = replay(report).filter((r: any) => ['central', 'midpoint', 'terminal'].includes(r.kind));
    expect(rows.map((r: any) => r.ticks)).toEqual([2, 5, 1, 5, 2, 3, 0, 5, 0, 2, 0, 7, 0, 5, 0, 0, 0, 0]);
    expect(rows.map((r: any) => r.shots)).toEqual([1, 1, 1, 2, 1, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0]);
    expect(rows[3].train).toEqual([962, 972]);
    expect(rows.map((r: any) => r.shortGate.shots)).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const terminal = replay(report, 'terminal').filter((r: any) => r.kind === 'midpoint' && r.landing === 3 && r.radius === 3.22)[0];
    expect(terminal.train).toEqual([7422, 7432]);
    const prepared = replay(report, 'prepared').filter((r: any) => r.kind === 'terminal' && r.radius === 3.22);
    expect(prepared.map((r: any) => r.shots)).toEqual([1, 0, 1]);
  });
});
