import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { dragonHeadVanilla } from '../../src/services/minebot/utils/dragonHeadVanilla.js';
import { partBox, partOffset } from '../../src/services/minebot/utils/dragonParts.js';

const require = createRequire(import.meta.url);
const { damageFromDistance, distanceFromDamage, statistics, correlation, sittingStart, analyseReports, renderReport } =
  require('../../scripts/lab/dragon-head-error-report.cjs');
const conv = require('mineflayer/lib/conversions.js');
const position = Object.freeze({ x: 11, y: 22, z: 33 });

describe('vanilla head placement, explicit angle units', () => {
  it.each([0, Math.PI / 2, Math.PI, -Math.PI / 2, 6.2])('agrees with partOffset/partBox at zero rotation and slope (yaw=%s)', yaw => {
    const input = Object.freeze({ position, yaw, yRotA: 0, p: 0, hy: -1 });
    const out = dragonHeadVanilla(input)!;
    const offset = partOffset('head', yaw);
    expect(out.feet).toEqual({ x: position.x + offset.x, y: position.y + offset.y, z: position.z + offset.z });
    expect(out.box).toEqual(partBox(input, 'head'));
    expect(out.rotationAssumedZero).toBe(false);
  });

  it.each([0, 90, 180, 270, -90, 405])('converts vanilla theta=%s degrees through Mineflayer and preserves the vanilla signs', degrees => {
    const theta = degrees * Math.PI / 180, yaw = conv.fromNotchianYaw(degrees), yRotA = 12, p = 0.2, hy = 0.7;
    const out = dragonHeadVanilla({ position, yaw, yRotA, p, hy })!;
    const psi = theta - 0.01 * yRotA;
    expect(out.feet.x).toBeCloseTo(position.x + 6.5 * Math.sin(psi) * Math.cos(p), 10);
    expect(out.feet.y).toBeCloseTo(position.y + hy + 6.5 * Math.sin(p), 10);
    expect(out.feet.z).toBeCloseTo(position.z - 6.5 * Math.cos(psi) * Math.cos(p), 10);
  });

  it('a 0.3 RADIAN head correction is yRotA=30, not yRotA=0.3 degrees or a degree-valued psi', () => {
    const base = { position, yaw: 0, p: 0, hy: -1 };
    const zero = dragonHeadVanilla(base)!, plus = dragonHeadVanilla({ ...base, yRotA: 30 })!, minus = dragonHeadVanilla({ ...base, yRotA: -30 })!;
    expect(zero.rotationAssumedZero).toBe(true);
    expect(plus.yaw).toBeCloseTo(0.3, 12);
    expect(plus.feet.x - zero.feet.x).toBeCloseTo(1.920881343298707, 10);
    expect(minus.feet.x - zero.feet.x).toBeCloseTo(-1.920881343298707, 10);
    expect(Math.hypot(plus.feet.x - zero.feet.x, plus.feet.z - zero.feet.z)).toBeCloseTo(13 * Math.sin(0.15), 10);
    expect(dragonHeadVanilla({ ...base, yRotA: 0.3 })!.feet.x - zero.feet.x).toBeCloseTo(6.5 * Math.sin(0.003), 10);
  });

  it('uses supplied slope and height independently, returning feet and a one-block box', () => {
    const out = dragonHeadVanilla({ position, yaw: Math.PI / 2, yRotA: 0, p: Math.PI / 6, hy: 2 })!;
    expect(out.feet.y).toBeCloseTo(position.y + 2 + 3.25, 12);
    expect(out.feet.x).toBeCloseTo(position.x + 6.5 * Math.cos(Math.PI / 6), 12);
    expect(out.box.minY).toBe(out.feet.y);
    expect(out.box.maxY - out.box.minY).toBe(1);
    expect(out.box.maxX - out.box.minX).toBe(1);
    expect(out.box.maxZ - out.box.minZ).toBe(1);
  });

  it('the proposed sync conversion accepts float DEGREES for yaw and signed pitch, not byte angles', () => {
    expect(conv.fromNotchianYaw(90)).toBeCloseTo(Math.PI / 2, 12);
    expect(conv.fromNotchianYaw(-90)).toBeCloseTo(3 * Math.PI / 2, 12);
    expect(conv.fromNotchianPitch(30)).toBeCloseTo(-Math.PI / 6, 12);
    expect(conv.fromNotchianPitch(-30)).toBeCloseTo(Math.PI / 6, 12);
    expect(conv.fromNotchianYawByte(90)).not.toBeCloseTo(Math.PI / 2, 6);
  });

  it('rejects nonfinite packet/model inputs instead of returning a plausible zero pose', () => {
    const base = { position, yaw: 0, p: 0, hy: -1 };
    for (const key of ['yaw', 'p', 'hy', 'yRotA'] as const) expect(dragonHeadVanilla({ ...base, [key]: NaN })).toBeNull();
    expect(dragonHeadVanilla({ ...base, position: { ...position, x: Infinity } })).toBeNull();
  });
});

describe('power-five head damage inversion and aggregation', () => {
  it('uses unreduced floating head damage, including +1', () => {
    expect(damageFromDistance(0, 1)).toBe(71);
    expect(damageFromDistance(2, 1)).toBeCloseTo(51.4, 12);
    expect(distanceFromDamage(51.4, 1)).toBeCloseTo(2, 12);
    expect(damageFromDistance(10, 1)).toBe(1);
    expect(damageFromDistance(10.1, 1)).toBe(0);
  });

  it.each([1, 0.75, 0.2, 1 / 64])('round trips known distances with E=%s', e => {
    for (const d of [0, 0.5, 2, 6.5, 9.99, 10]) expect(distanceFromDamage(damageFromDistance(d, e), e)).toBeCloseTo(d, 10);
  });

  it('does not invent a unique distance for zero exposure, zero/negative/too much damage or missing data', () => {
    for (const [damage, e] of [[1, 0], [0, 1], [-1, 1], [72, 1], [51.4, 0.5], [NaN, 1], [51.4, null], [null, 1], [51.4, 1.01]])
      expect(distanceFromDamage(damage, e)).toBeNull();
    expect(damageFromDistance(-1)).toBeNull();
    expect(damageFromDistance(2, null)).toBeNull();
  });

  it('computes population SD, nearest-rank p90 and signed maxima without coercing missing values', () => {
    const input = [-2, 0, 2, null, NaN, undefined];
    const s = statistics(input);
    expect(s).toEqual({ n: 3, mean: 0, sd: Math.sqrt(8 / 3), min: -2, max: 2, p90: 2 });
    expect(input).toEqual([-2, 0, 2, null, NaN, undefined]);
    expect(statistics(Array.from({ length: 10 }, (_, i) => i + 1)).p90).toBe(9);
    expect(statistics([null, NaN])).toEqual({ n: 0, mean: null, sd: null, min: null, max: null, p90: null });
    expect(statistics([-3, -2]).max).toBe(-2);
  });

  it('correlates complete pairs only and leaves constant series unknown', () => {
    expect(correlation([[1, 2], [2, 4], [3, 6], [null, 8]])).toEqual({ n: 3, r: 1 });
    expect(correlation([[1, 2], [1, 3]]).r).toBeNull();
    expect(correlation([[1, null]]).r).toBeNull();
  });
});

// Invented, translated geometry. The feet are 2m from the PILLOW centre; the head
// receipt is 0.5m higher. The foot block and the client health are deliberately different.
function fixture() {
  const head = { x: 10, y: 20, z: 30 }, feet = { x: 12.5, y: 20.5, z: 30.5 }, centre = { ...feet, y: feet.y + 0.5 };
  const trial: any = { n: 1, perch: 1, useTick: 8, detonationTick: 9, foot: { ...head, z: head.z - 1 }, head,
    dragonBefore: 200, dragonAfter: 0, dragonHealthServerBefore: 200, dragonHealthServerAfter: 148.6,
    phaseAtUse: 5, phaseAtExplosion: 4, headAtUse: centre, phase7Head: { centre, feet },
    prediction: { tick: 8, source: 'seated_body_position_yaw', predictedHead: centre, exposure: 1, headDistance: 2 } };
  const scene = { bedTrials: [trial], perches: [{ n: 1, startTick: 4, body: { yaw: 0 } }],
    phaseTimeline: [3, 6, 6, 7, 5, 6, 7, 5].map((phase, i) => ({ tick: i + 1, phase })) };
  return { trial, scene, reports: [{ name: 'r299-report.json', report: { scenes: { end_bed_kill: scene } } }] };
}

describe('report extraction, missing evidence and actual sitting intervals', () => {
  it('uses server loss, pillow centre, head FEET, pre-hit phase, and both exposure scenarios', () => {
    const { reports } = fixture(), result = analyseReports(reports), r = result.rows[0];
    expect(r.loss).toBeCloseTo(51.4, 12);
    expect(r.dPred).toBe(2); expect(r.dActual1).toBeCloseTo(2, 12); expect(r.dActualE).toBeCloseTo(2, 12);
    expect(r.delta).toBeCloseTo(0, 12); expect(r.storedDistanceDifference).toBe(0); expect(r.phase).toBe(5);
    expect(r.seat).toBe(2); expect(r.elapsed).toBe(7); expect(r.phase7Age).toBe(5);
    expect(result.counts).toEqual({ files: 1, scenes: 1, trials: 1, detonations: 1, undetonated: 0 });
    expect(renderReport(result)).toContain('r299 / 1 / 1');
  });

  it('does not split a seat on phase 5→6→7, and rejects timeline gaps or a missing prior boundary', () => {
    const { scene } = fixture();
    expect(sittingStart(scene.phaseTimeline, 7)).toBe(2);
    expect(sittingStart(scene.phaseTimeline.filter(s => s.tick !== 3), 7)).toBeNull();
    expect(sittingStart(scene.phaseTimeline.slice(1), 7)).toBeNull();
    expect(sittingStart([], 7)).toBeNull();
  });

  it('reports missing server health instead of substituting rounded client health or dragonLoss', () => {
    const { trial, reports } = fixture();
    trial.dragonLoss = 51.4; delete trial.dragonHealthServerAfter;
    const r = analyseReports(reports).rows[0];
    expect(r.delta).toBeNull(); expect(r.issues).toContain('server_health_unknown');
    expect(statistics([r.delta]).n).toBe(0);
  });

  it('keeps recorded E separate from the E=1 upper-distance scenario and marks unknown E', () => {
    const { trial, reports } = fixture();
    trial.prediction.exposure = 0.8;
    trial.dragonHealthServerAfter = 200 - damageFromDistance(2, 0.8);
    let r = analyseReports(reports).rows[0];
    expect(r.dActualE).toBeCloseTo(2, 12); expect(r.dActual1).toBeCloseTo(3.6, 12);
    delete trial.prediction.exposure;
    r = analyseReports(reports).rows[0];
    expect(r.exposure).toBeNull(); expect(r.dActualE).toBeNull(); expect(r.dActual).toBe(r.dActual1);
  });

  it('counts undetonated trials, and never coerces a missing yaw/phase to zero', () => {
    const { trial, scene, reports } = fixture();
    scene.bedTrials.push({ n: 2 } as any); delete trial.phaseAtUse; delete (scene.perches[0].body as any).yaw;
    const result = analyseReports(reports);
    expect(result.counts.undetonated).toBe(1); expect(result.rows).toHaveLength(1);
    expect(result.rows[0].yaw).toBeNull(); expect(result.rows[0].phase).toBeNull();
  });

  it('refuses an unknown coordinate convention or conflicting explosion centre', () => {
    const { trial, reports } = fixture();
    trial.prediction.source = 'unknown'; delete trial.phase7Head;
    expect(analyseReports(reports).rows[0].issues).toContain('prediction_feet_unknown');
    trial.prediction.source = 'seated_body_position_yaw'; trial.explosion = { ...trial.head };
    expect(analyseReports(reports).rows[0].issues).toContain('pillow_explosion_mismatch');
  });

  it('does not call a lethal or multi-explosion health window a precise distance measurement', () => {
    const { trial, scene, reports } = fixture();
    trial.dragonHealthServerAfter = 1;
    expect(analyseReports(reports).rows[0].issues).toContain('lethal_censored');
    trial.dragonHealthServerAfter = 148.6; trial.serverBeforeTick = 5; trial.serverAfterTick = 12;
    scene.bedTrials.push({ ...trial, n: 2, detonationTick: 11 });
    expect(analyseReports(reports).rows.every((r: any) => r.delta === null && r.issues.includes('multiple_blasts_in_health_window'))).toBe(true);
  });

  it('accepts an at-use latestEstimate when prediction is absent and ignores a later mutable estimate', () => {
    const { trial, reports } = fixture();
    trial.latestEstimate = trial.prediction; delete trial.prediction;
    expect(analyseReports(reports).rows[0].delta).toBeCloseTo(0, 12);
    trial.latestEstimate = { ...trial.latestEstimate, tick: 20, predictedHead: { x: 999, y: 999, z: 999 } };
    // The explicit at-use snapshot still has a matching feet/centre convention.
    expect(analyseReports(reports).rows[0].dPred).toBe(2);
  });
});
