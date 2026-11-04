import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { interpolateHeads, countWindows, replay } = require('../../scripts/lab/landing-replay.cjs');
const head = { x: 0, y: 0, z: 0 };

describe('M2 read-only landing replay aggregation', () => {
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
