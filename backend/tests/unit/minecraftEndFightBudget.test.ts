import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: {} }));
import { advanceBedSearch, bedBodyBox, bedCentre, bedExposure, bedExposureSearch, bedOpenWaitCells, bedTickBudget,
  landingBedLayouts, landingBedLayoutSearch, landingBedRefusalSearch, landingBedSelfSearch, seatedBedLayouts,
  supportedBedCells, type BedSearch, type LandingBedLayout } from '../../src/services/minebot/utils/dragonBedGeometry.js';
import { landingEndHead, landingPreparationCorridor, landingShotWindow, predictLandingPath, type LandingObservation } from '../../src/services/minebot/utils/dragonLandingPath.js';
import type { P3 } from '../../src/services/minebot/utils/dragonParts.js';

const target = { x: 103.5, y: 74, z: -39.5 };
const air = { name: 'air', boundingBox: 'empty', shapes: [] };
const solid = (name = 'bedrock') => ({ name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] });
const key = (p: P3) => `${p.x},${p.y},${p.z}`;
// A translated fountain/shelf and outer waiting floor, without a server, services or a seed.
const read = (p: P3) => (p.x === Math.floor(target.x) && p.z === Math.floor(target.z) && p.y < target.y)
  || (p.y < target.y - 3 && Math.hypot(p.x + .5 - target.x, p.z + .5 - target.z) <= 8) ? solid()
  : p.y < target.y - 4 ? solid('end_stone') : air;
const history = (phase: number): LandingObservation[] => Array.from({ length: 6 }, (_, i) => ({ tick: i * 3, phase,
  yaw: 5.47, position: { x: target.x + 53 - i * .4, y: target.y + 12, z: target.z + 23 - i * .1 } }));
const measured = <T>(f: () => T) => { const start = performance.now(), value = f(); return { value, ms: performance.now() - start }; };
const drain = <T>(search: BedSearch<T>): T => { let r = search.next(); while (!r.done) r = search.next(); return r.value; };

describe('r247 offline computation budget (real CPU clock)', () => {
  it('bounds each phase 0/1/2/3 tick, with ten crystals and a flying dragon outside the fountain', () => {
    const crystals = Array.from({ length: 10 }, (_, id) => ({ id, name: 'end_crystal' }));
    const wait = { x: target.x - 1, y: target.y - 4, z: target.z + 12 };
    const report: Array<{ phase: number; ticks: number; maxMs: number; totalMs: number }> = [];
    let layouts: LandingBedLayout[] = [];
    for (const phase of [0, 1, 2, 3]) {
      const h = history(phase), corridor = landingPreparationCorridor(h, target);
      const end = landingEndHead(h, target);
      let tick = 0, complete = phase !== 2;
      const compute = bedTickBudget(() => tick), search = landingBedLayoutSearch(target, corridor, read, 16, 20, end?.head);
      const times: number[] = [];
      // More exposure work than an admitted live shot needs. Repeated callbacks
      // share the same allowance; discarding unfinished checks grants no permission.
      const firing = function* (): BedSearch<void> {
        for (const l of layouts.slice(0, 5)) {
          const cells = new Set(l.screen.map(key)), projected = (p: P3) => cells.has(key(p)) ? solid('obsidian') : read(p);
          yield* landingBedRefusalSearch(l, l.stand, corridor.filter(p => Math.hypot(
            p.head.x - bedCentre(l.head).x, p.head.y - bedCentre(l.head).y, p.head.z - bedCentre(l.head).z) <= 2), projected, 20);
          yield* landingBedSelfSearch(projected, l.head, l.foot, l.stand);
          for (const p of corridor.slice(-4)) yield* bedExposureSearch(projected, bedCentre(l.head), p.headBox, [l.head, l.foot]);
        }
      };
      do {
        const { ms } = measured(() => {
          expect(crystals).toHaveLength(10);
          predictLandingPath(h, target, 15, 20); predictLandingPath(h, target, 15, 3);
          if (phase <= 1) { bedOpenWaitCells(wait, wait, read); return; }
          if (phase === 2 && !complete) {
            const r = compute(search, 2);
            if (r.done) { layouts = r.value; complete = true; }
          }
          if (phase === 3) {
            landingShotWindow(h, target, 15);
            for (let i = 0; i < 3; i++) { const work = firing(); compute(work); work.return(); }
          }
        });
        times.push(ms); tick++;
      } while ((!complete || tick < 80) && tick < 2000);
      expect(complete).toBe(true);
      report.push({ phase, ticks: times.length, maxMs: Math.max(...times), totalMs: times.reduce((a, b) => a + b, 0) });
      expect(Math.max(...times), `phase ${phase} computation in one 50ms tick`).toBeLessThan(10);
      if (phase <= 1) { expect(corridor).toEqual([]); expect(end).toBeNull(); }
    }
    expect(layouts.length).toBeGreaterThan(0);
    console.log('r247 simulated tick CPU (ms)', JSON.stringify(report));
  });

  it('profiles component calls and preserves the complete synchronous result when sliced', () => {
    const h = history(2), corridor = landingPreparationCorridor(h, target), end = landingEndHead(h, target)!;
    const profiles = {
      corridor: measured(() => landingPreparationCorridor(h, target)),
      exposure45: measured(() => bedExposure(read, { ...target, x: target.x + 2 }, bedBodyBox({ ...target, z: target.z + 3 }))),
      supports: measured(() => supportedBedCells([{ x: Math.floor(target.x) + 2, y: target.y - 2, z: Math.floor(target.z) }], read, 4)),
      flyingSeated: measured(() => seatedBedLayouts({ position: h[5].position, yaw: 5.47, phase: 0 }, read, 16, 64)),
      synchronousLayouts: measured(() => landingBedLayouts(target, corridor, read, 16, 20, end.head)),
    };
    const search = landingBedLayoutSearch(target, corridor, read, 16, 20, end.head);
    let result = advanceBedSearch(search, 1), slices = 1;
    while (!result.done) { result = advanceBedSearch(search, 1); slices++; }
    expect(slices).toBeGreaterThan(1);
    expect(result.value).toEqual(profiles.synchronousLayouts.value);
    expect(profiles.flyingSeated.value).toEqual([]);
    console.log('r247 single-call CPU (ms)', JSON.stringify(Object.fromEntries(Object.entries(profiles).map(([k, v]) => [k, v.ms]))));
  });

  it('pauses inside the exposure grid; an unfinished exposure never becomes a safety result', () => {
    const head = { ...target, x: target.x + 2 }, box = bedBodyBox({ ...target, z: target.z + 3 });
    const search = bedExposureSearch(read, head, box);
    let cpu = 0;
    expect(advanceBedSearch(search, .1, () => cpu += .1).done).toBe(false);
    expect(drain(search)).toBe(bedExposure(read, head, box));
  });

  it('does not reset the five-ms total for repeated callbacks until the receipt tick changes', () => {
    let tick = 2, cpu = 0, steps = 0;
    const budget = bedTickBudget(() => tick, () => cpu += 1);
    const work = function* (): BedSearch<void> { for (;;) { steps++; yield; } };
    for (let i = 0; i < 20; i++) budget(work());
    const before = steps;
    budget(work()); expect(steps).toBe(before);
    tick++; budget(work()); expect(steps).toBeGreaterThan(before);
  });
});
