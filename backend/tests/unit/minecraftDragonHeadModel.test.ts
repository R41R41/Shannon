import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: {} }));
import * as model from '../../src/services/minebot/utils/dragonHeadModel.js';
import type { DragonBodySample } from '../../src/services/minebot/utils/dragonHeadModel.js';
import type { P3 } from '../../src/services/minebot/utils/dragonParts.js';
import { bedCentre } from '../../src/services/minebot/utils/dragonBedGeometry.js';

const p = (x: number, y: number, z: number): P3 => ({ x, y, z });
const history = (change: (tick: number) => Partial<DragonBodySample> = () => ({})): DragonBodySample[] =>
  Array.from({ length: 20 }, (_, tick) => ({ tick, position: p(10, 70, -20), yaw: 0, phase: 3, ...change(tick) }));
afterEach(() => { vi.useRealTimers(); });

describe('vanilla dragon part placement from post-step history', () => {
  it('places head, neck, body and wings at entity feet, separately from the head centre', () => {
    const result = model.predictDragonHead(history())!;
    expect(result.parts).toEqual({ head: p(10, 70, -13.5), neck: p(10, 70, -14.5), body: p(10, 70, -19.5),
      wing1: p(5.5, 72, -20), wing2: p(14.5, 72, -20) });
    expect(model.dragonHeadCentre(result.parts.head)).toEqual(p(10, 70.5, -13.5));
  });
  it.each([5, 6, 7])('uses -1 head offset only when sitting (phase %s)', phase => {
    expect(model.predictDragonHead(history(() => ({ phase })))!.parts.head).toEqual(p(10, 69, -13.5));
  });
  it('reconstructs a descending reference trajectory, including pitch and delayed height', () => {
    const h = history(t => ({ position: p(t * 0.1, 90 - t * 0.2, -30 + t * 0.3), yaw: Math.PI / 2 }));
    const result = model.predictDragonHead(h)!;
    expect(result.pitch).toBeCloseTo(-0.17453292519943295, 10);
    expect(result.headYOffset).toBeCloseTo(1, 10);
    expect(result.parts.head.x).toBeCloseTo(8.301250394579352, 10);
    expect(result.parts.head.y).toBeCloseTo(86.07128684516495, 10);
    expect(result.parts.head.z).toBeCloseTo(-24.3, 10);
    const future = model.predictDragonHead(h, 4)!;
    expect(future.tick).toBe(23); expect(future.observedTick).toBe(19);
    expect(future.parts.head.x).toBeCloseTo(8.701250394579352, 10);
    expect(future.parts.head.y).toBeCloseTo(85.27128684516495, 10);
    expect(future.parts.head.z).toBeCloseTo(-23.1, 10);
  });
  it('records BEFORE movement: history get(5) is T-6, get(10) T-11, get(0) T-1', () => {
    const h = history(t => ({ position: p(10, ({ 8: 78, 13: 79, 18: 82, 19: 85 } as Record<number, number>)[t] ?? 80, -20) }));
    const now = model.predictDragonHead(h)!;
    expect(now.headYOffset).toBe(-3); expect(now.pitch).toBeCloseTo(Math.PI / 18);
    expect(now.parts.head.y).toBeCloseTo(83.12871315483505, 10);
    // Advancing four ticks also advances each latency lookup; it does not translate a static box.
    expect(model.predictDragonHead(h, 4)!.parts.head.y).toBeCloseTo(81.25, 10);
  });
  it('converts Mineflayer radians/sign, applies server yRotA, and exposes the client-zero variant', () => {
    const h = history(t => ({ yaw: t * Math.PI / 180 }));
    const server = model.predictDragonHead(h)!, client = model.predictDragonHead(h, 0, { rotation: 'client_zero' })!;
    expect(server.yRotA).toBeCloseTo(-10); expect(client.yRotA).toBe(0);
    expect(server.parts.head.x).toBeLessThan(client.parts.head.x);
    const explicit = model.predictDragonHead(history(), 0, { yRotA: 100 * Math.PI / 2 })!;
    expect(explicit.parts.head.x).toBeCloseTo(16.5); expect(explicit.parts.head.z).toBeCloseTo(-20);
    expect(explicit.rotationSource).toBe('supplied');
  });
  it('wraps yaw at 2 PI instead of inventing a complete turn in one tick', () => {
    const h = history(t => ({ yaw: (Math.PI * 2 - 0.1 + t * 0.01) % (2 * Math.PI) }));
    const f = model.predictDragonHead(h, 4)!;
    expect(f.yawPerTick).toBeCloseTo(0.01, 10); expect(f.yRotA).toBeCloseTo(-5.729577951308232, 10);
    expect(Math.abs(f.parts.head.x - model.predictDragonHead(h)!.parts.head.x)).toBeLessThan(0.3);
  });
  it('keeps at most twenty copied samples and resets on gaps/invalid samples', () => {
    const h = history(), next = { ...h[19], tick: 20, position: p(2, 3, 4) };
    const copy = model.appendDragonBody(h, next);
    expect(copy).toHaveLength(20); expect(copy[0].tick).toBe(1); next.position.y = 100;
    expect(copy.at(-1)!.position.y).toBe(3); expect(h).toHaveLength(20);
    expect(model.appendDragonBody(copy, { ...next, tick: 22 })).toHaveLength(1);
    expect(model.appendDragonBody(copy, { ...next, yaw: NaN })).toEqual([]);
  });
  it.each([-1, 1.5, 9, NaN])('refuses unsupported forecast horizon %s', n => {
    expect(model.predictDragonHead(history(), n)).toBeNull();
  });
  it('refuses warmup, gaps, invalid inputs and future forecasts across phase changes', () => {
    expect(model.predictDragonHead(history().slice(-11))).toBeNull();
    expect(model.predictDragonHead(history(t => t === 8 ? { tick: 9 } : {}))).toBeNull();
    expect(model.predictDragonHead(history(t => t === 8 ? { position: p(0, NaN, 0) } : {}))).toBeNull();
    expect(model.predictDragonHead(history(t => ({ phase: t === 19 ? 6 : 3 })), 4)).toBeNull();
    expect(model.predictDragonHead(history(), 0, { yRotA: NaN })).toBeNull();
    expect(model.predictDragonHead(history().slice(-12))).not.toBeNull();
  });
  it('anchors forecasts to real head feet while moving the full future geometry', () => {
    const h = history(t => ({ position: p(t, 70, -20) }));
    const f = model.forecastDragonHead(h, 4, p(500, 75, 600))!;
    expect(f.feet).toEqual(p(504, 75, 600)); expect(f.centre).toEqual(p(504, 75.5, 600));
    expect(f.source).toBe('observed_part_entity');
    expect(model.forecastDragonHead(h, 4)!.source).toBe('vanilla_history_model');
  });
  it('requires part identity and type, never mistaking a following unrelated entity for a head', () => {
    const e = { id: 78, name: 'ender_dragon_part', position: p(2, 3, 4) };
    expect(model.observedDragonPart({ 78: e }, 77, 'head')).toEqual(p(2, 3, 4));
    for (const change of [{ name: 'enderman' }, { id: 79 }, { dragonId: 99 }, { dragonPart: 'neck' }, { isValid: false }])
      expect(model.observedDragonPart({ 78: { ...e, ...change } }, 77, 'head')).toBeNull();
    expect(model.observedDragonPart({}, 77, 'head')).toBeNull();
  });
});

const source = fs.readFileSync(new URL('../../scripts/minecraft-end-fight-probe.ts', import.meta.url), 'utf8');
const section = '// ' + source.split('// ===== dragon_head_model:')[1].split('// ===== end dragon_head_model =====')[0];
const compiled = ts.transpileModule(section, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

async function measurementRig(parts: boolean, stop: 'normal' | 'disconnect' | 'death' = 'normal', options: { gap?: boolean; noLandingPerch?: boolean } = {}) {
  const actor: any = new EventEmitter(); actor.floorReflexes = {}; actor.entities = {};
  const raw = { id: 77, position: p(100, 80, -40), yaw: 0, phase: 0 };
  if (parts) actor.entities[78] = { id: 78, name: 'ender_dragon_part', position: p(110, 80, -33.5) };
  const deps = { ...model, actor, actorDeaths: 0, disconnected: null as string | null, scenes: {}, KILL_LIMIT_MS: 10_000,
    park: vi.fn(async () => {}), releaseReflex: vi.fn(), protect: vi.fn(async () => {}), gear: vi.fn(async () => {}), standAt: vi.fn(async () => {}),
    basinWaitingCell: () => p(110, 75, -30), endView: () => ({ dragon: { headPosition: p(-999, -999, -999) },
      perch: options.noLandingPerch && raw.phase === 3 ? undefined : p(100, 80, -33.5) }),
    dragonEntity: () => raw, dragonPhaseOf: () => raw.phase, bedCentre, killCell: (v: P3) => p(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)),
    chainDistance: (a: P3, b: P3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), END: 'end', DRAGON: '@dragon',
    ask: vi.fn(async () => '[100.0d, 80.0d, -40.0d]'), // Parent Pos must never become a head measurement.
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) };
  const api = new Function(...Object.keys(deps), `${compiled}\nreturn { run: dragonHeadModelScene,
    disconnect() { disconnected = 'mock'; }, die() { actorDeaths++; } };`)(...Object.values(deps));
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    raw.phase = tick < 20 ? 0 : tick < 40 ? 3 : tick < 50 ? 6 : tick < 60 ? 4 : tick < 70 ? 0 : tick < 90 ? 3 : tick < 100 ? 6 : 4;
    if (parts) actor.entities[78] = { id: 78, name: 'ender_dragon_part', position: p(tick < 30 ? 110 : 100, raw.phase === 6 ? 79 : 80, -33.5) };
    if (options.gap && tick === 25) delete actor.entities[78];
    actor.emit('physicsTick');
    if (tick === 45 && stop === 'disconnect') api.disconnect();
    if (tick === 45 && stop === 'death') api.die();
  }, 50);
  try {
    const run = api.run(); await vi.advanceTimersByTimeAsync(6000);
    return { out: await run, deps, actor };
  } finally { clearInterval(timer); }
}

describe('dragon_head_model lab scene with independent mocked I/O', () => {
  it('records raw poses each physicsTick, scores current and delayed heads by phase, and preserves the landing trajectory', async () => {
    vi.useFakeTimers(); const { out, deps, actor } = await measurementRig(true);
    expect(out.ok).toBe(true); expect(out.endReason).toBe('two_natural_landings_and_takeoff');
    expect(out.samples[0].position).toEqual(p(100, 80, -40));
    expect(out.samples[11].errorNow.horizontal).toBe(10); expect(out.samples[15].errorAhead4.horizontal).toBe(10);
    expect(out.samples[30].errorNow.metres).toBe(0);
    expect(Object.keys(out.phaseStats)).toHaveLength(8); expect(out.phaseStats[1].reconstruction.count).toBe(0);
    expect(out.phaseStats[3].reconstruction.count).toBeGreaterThan(0);
    expect(out.landings).toHaveLength(2); expect(out.landings[0].lastFiveSeconds).toHaveLength(20);
    expect(out.landings[0].firstActualPillowTick).toBe(30);
    expect(out.landings[0].pillowPredictions.some((f: any) => Number.isFinite(f.tickError) && f.ahead >= 4)).toBe(true);
    expect(deps.ask.mock.calls).toHaveLength(1); // crystal removal only; no phase/pose/health commands
    expect(deps.gear).toHaveBeenCalledWith([]); expect(actor.listenerCount('physicsTick')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('tries data get once, retains failures, and leaves all errors null without real parts', async () => {
    vi.useFakeTimers(); const { out, deps } = await measurementRig(false);
    expect(out.ok).toBe(false); expect(out.validationStatus).toBe('unavailable_no_independent_head_position');
    expect(out.fallbackReads).toHaveLength(3); expect(deps.ask.mock.calls).toHaveLength(4);
    expect(out.fallbackReads.every((r: any) => r.acceptedAsMeasurement === false)).toBe(true);
    expect(out.samples.every((r: any) => r.observedHead === null && r.errorNow === null && r.errorAhead4 === null)).toBe(true);
    expect(out.phaseStats[3].reconstruction.horizontal).toBeNull();
    expect(out.landings[0].pillowPredictions.every((f: any) => f.tickError === null)).toBe(true);
    expect(out.landings[0].pillowStatus).toBe('measurement_incomplete');
  });
  it.each(['disconnect', 'death'] as const)('stops and removes listeners on %s', async mode => {
    vi.useFakeTimers(); const { out, actor } = await measurementRig(true, mode);
    expect(out.ok).toBe(false); expect(out.endReason).toBe(mode === 'death' ? 'actor_dead' : 'disconnected');
    expect(actor.listenerCount('physicsTick')).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not score the first-entry tick when earlier head coverage has a gap', async () => {
    vi.useFakeTimers(); const { out } = await measurementRig(true, 'normal', { gap: true });
    expect(out.landings[0].measurementComplete).toBe(false);
    expect(out.landings[0].pillowStatus).toBe('measurement_incomplete');
    expect(out.landings[0].pillowPredictions.every((f: any) => f.tickError === null)).toBe(true);
  });
  it('does not coerce a missing pillow distance to a zero-distance pass', async () => {
    vi.useFakeTimers(); const { out } = await measurementRig(true, 'normal', { noLandingPerch: true });
    expect(out.landings[0].pillowStatus).toBe('pillow_unavailable');
    expect(out.ok).toBe(false);
    expect(out.landings[0].firstActualPillowTick).toBeNull();
    expect(out.landings[0].closestMeasuredPillow).toBeNull();
  });
});
