import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as m from '../../src/services/minebot/utils/bedM456.js';
import { bedDamage } from '../../src/services/minebot/utils/dragonBedGeometry.js';

const near = (a: number | null, b: number, eps = 1e-6) => { expect(a).not.toBeNull(); expect(Math.abs((a as number) - b)).toBeLessThan(eps); };

describe('bedM456 inverse formulas', () => {
  it('reads the exposure back from the explosion packet knockback', () => {
    const centre = { x: 0.5, y: 103.5, z: 0.5 }, feet = { x: 1.7, y: 100, z: 0.5 };
    const d = Math.hypot(1.2, 3.5) / 10;
    for (const seen of [0, 1 / 45, 6 / 45, 1]) {
      const size = (1 - d) * seen, dir = { x: 1.2, y: -1.88, z: 0 }, len = Math.hypot(dir.x, dir.y);
      near(m.exposureFromKnockback({ x: dir.x / len * size, y: dir.y / len * size, z: 0 }, feet, centre), seen);
    }
    expect(m.exposureFromKnockback({ x: 0, y: 0, z: 0 }, { x: 20, y: 100, z: 0 }, centre)).toBeNull();
  });
  it('inverts the power-five damage both ways', () => {
    for (const d of [0, 0.5, 1, 2, 2.3, 3.7]) near(m.distanceForDamage(bedDamage(d, 1)), d, 1e-9);
    for (const [dist, seen] of [[3.3, 1 / 45], [3.7, 0.4], [5, 1]] as Array<[number, number]>) near(m.exposureFromDamage(bedDamage(dist, seen), dist), seen, 1e-9);
    expect(m.impactFromDamage(0.5)).toBeNull();
    near(m.distanceForDamage(1), 10);
  });
  it('iron armour takes a lone point of blast damage down to 0.42', () => {
    near(m.afterArmour(1), 0.42, 1e-9);
    near(m.afterArmour(20), 20 * (1 - 5 / 25), 1e-9);
  });
});

describe('bedM456 facing', () => {
  it('turns a direction into the mineflayer yaw whose vanilla facing it is', () => {
    // vanilla yRot (degrees) = 180 - yaw * 180 / PI (bedBurstPackets); south 0, west 90, north 180, east -90
    const vanilla = (dir: m.Cardinal) => ((180 - m.facingYaw(dir) * 180 / Math.PI) % 360 + 540) % 360 - 180;
    near(vanilla('south'), 0); near(vanilla('west'), 90); near(Math.abs(vanilla('north')), 180); near(vanilla('east'), -90);
  });
});

describe('bedM456 M4 layouts', () => {
  const F = 100;
  const at = (k: number, column: number, sx: number, sz: number) => m.m4Layout({ label: '', pillow: { x: 0, y: F + k, z: 0 }, facing: 'east', column, stand: { x: 0.5 + sx, y: F, z: 0.5 + sz }, checks: '' });
  it('puts the foot behind the pillow, the arm under the foot and the column under the pillow', () => {
    const l = at(3, 3, 1.2, 0);
    expect(l.foot).toEqual({ x: -1, y: F + 3, z: 0 });
    expect(l.arm).toEqual({ x: -1, y: F + 2, z: 0 });
    expect(l.column).toEqual([{ x: 0, y: F + 2, z: 0 }, { x: 0, y: F + 1, z: 0 }, { x: 0, y: F, z: 0 }]);
    expect(() => m.m4Layout({ label: '', pillow: { x: 0.5, y: 1, z: 0 }, facing: 'east', column: 1, stand: { x: 0, y: 0, z: 0 }, checks: '' })).toThrow('invalid_m4_layout');
  });
  it('a 3-high column hides every ray at 1.0-1.5 m from its axis, a 2-high one does not (the design\'s 3.1 m lies between two block heights)', () => {
    for (const [sx, sz] of [[1, 0], [1.2, 0], [1.5, 0], [1, 1], [0, 1], [-1, -1]]) {
      const p = m.m4Predict(at(3, 3, sx, sz), F);
      expect(p.rays).toBe(0); near(p.damage, 1); expect(p.knockback).toBe(0);
      expect(p.reach).toBeLessThan(4.5);
    }
    expect(m.m4Predict(at(2, 2, 1, 0), F).rays).toBe(6);
    expect(m.m4Predict(at(3, 3, 2, 0), F).rays).toBe(6);
    expect(m.m4Predict(at(3, 0, 1.2, 0), F).rays).toBe(45); // no column: open
  });
  it('the verdict needs every blast measured, under 1.5 and unpushed', () => {
    expect(m.m4Verdict([{ loss: 1, push: 0 }, { loss: 1.5, push: 0.01 }]).pass).toBe(true);
    expect(m.m4Verdict([{ loss: 1, push: 0 }, { loss: 1.6, push: 0 }]).pass).toBe(false);
    expect(m.m4Verdict([{ loss: 1, push: 0.2 }]).pass).toBe(false);
    expect(m.m4Verdict([{ loss: null, push: null }]).pass).toBe(false);
    expect(m.m4Verdict([]).pass).toBe(false);
  });
});

describe('bedM456 M5', () => {
  const head = { x: 0.5, y: 103, z: 7 };
  it('picks the free cell nearest the asked distance, never under the floor of atLeast', () => {
    const c1 = m.m5PillowCell(head, 2.35, { atLeast: 2.3, isFree: () => true })!;
    expect(c1.distance).toBeGreaterThanOrEqual(2.3);
    expect(c1.damage).toBeLessThanOrEqual(50);
    const c2 = m.m5PillowCell(head, 0, { isFree: () => true })!;
    near(c2.distance, Math.SQRT1_2, 1e-9); // the head's feet lie on a cell face (z = 7): the nearest centre is 0.707 off
    const blocked = m.m5PillowCell(head, 0, { isFree: c => c.y >= 104 })!;
    expect(blocked.cell.y).toBe(104);
    expect(m.m5PillowCell(head, 0, { isFree: () => false })).toBeNull();
  });
  it('the perched rule: losses add up from the perch, the one past 50 takes it off and resets', () => {
    const b = m.perchedBudget([48.3, 63.5, 30]);
    expect(b.takeoffAt).toBe(1);
    expect(b.steps.map(s => s.takesOff)).toEqual([false, true, false]);
    expect(m.perchedBudget([30, 15]).takeoffAt).toBeNull();
    expect(m.perchedBudget([10], 45).takeoffAt).toBe(0);
  });
});

describe('bedM456 M6 summary', () => {
  it('nearest-rank quantiles with the censored count apart', () => {
    const s = m.waitSummary([30, 10, 20, 40, NaN], 2);
    expect(s).toMatchObject({ n: 4, censored: 2, min: 10, p25: 10, median: 20, p75: 30, p90: 40, max: 40, mean: 25 });
    expect(m.waitSummary([]).median).toBeNull();
  });
});

describe('end-bed-m456 splice', () => {
  const probe = fs.readFileSync(new URL('../../scripts/minecraft-end-fight-probe.ts', import.meta.url), 'utf8');
  const part = fs.readFileSync(new URL('../../scripts/lab/end-bed-m456-scenes.part.ts', import.meta.url), 'utf8');
  it('the probe has the one marker the wrapper splices before, and the spliced file parses', () => {
    expect(probe.split('\n').filter(line => line === '// ===== run =====')).toHaveLength(1);
    const spliced = probe.replace('\n// ===== run =====\n', `\n${part}\n// ===== run =====\n`);
    const out = ts.transpileModule(spliced, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
    expect(out.diagnostics ?? []).toEqual([]);
    for (const name of ['m4_stand_safety', 'm5_perch_budget', 'm6_landing_c10', 'm6_landing_c0']) expect(spliced).toContain(`scenes.${name} =`);
  });
  it('the part imports no name the probe imports already (a duplicate import is a load-time error)', () => {
    const names = (src: string) => [...src.matchAll(/^import\s+\{([^}]*)\}/gmu)].flatMap(m => m[1].split(',').map(n => n.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u).pop()!).filter(Boolean));
    const dup = names(part).filter(n => names(probe).includes(n));
    expect(dup).toEqual([]);
  });
});
