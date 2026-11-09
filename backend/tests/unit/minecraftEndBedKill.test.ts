import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { z } from 'zod';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as geometry from '../../src/services/minebot/utils/dragonBedGeometry.js';
import { partBox, isPerched, type P3 } from '../../src/services/minebot/utils/dragonParts.js';
import { bedHalves } from '../../src/services/minebot/utils/bedRules.js';
import { DEN_DIRECTIONS } from '../../src/services/minebot/utils/huntEndermanDen.js';
import { OBSIDIAN_LIMITS } from '../../src/services/minebot/utils/obsidianContract.js';

const source = fs.readFileSync(new URL('../../scripts/minecraft-end-fight-probe.ts', import.meta.url), 'utf8');
const section = '// ' + source.split('// ===== end_bed_kill:')[1].split('// ===== end end_bed_kill =====')[0];
const compiled = ts.transpileModule(section, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const bedUseRefusal: (input: any) => string | null = new Function('scenes', compiled + '\nreturn bedUseRefusal;')({});
// Read the real schemas/range checker without importing the live body's service graph.
const actSource = fs.readFileSync(new URL('../../src/services/minebot/instantSkills/act.ts', import.meta.url), 'utf8');
const schema = actSource.slice(actSource.indexOf('const Pos ='), actSource.indexOf('export const ACT_STOP_IF'));
const ACT_HANDS = new Function('z', 'DEN_DIRECTIONS', 'OBSIDIAN_LIMITS', ts.transpileModule(schema.replace(/export /gu, ''), { compilerOptions: { module: ts.ModuleKind.None } }).outputText + '\nreturn ACT_HANDS;')(z, DEN_DIRECTIONS, OBSIDIAN_LIMITS);
const goSource = fs.readFileSync(new URL('../../src/services/minebot/utils/primitives/go.ts', import.meta.url), 'utf8');
const goNode = ts.createSourceFile('go.ts', goSource, ts.ScriptTarget.Latest, true).statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'goProblem')!;
const goProblem = new Function(ts.transpileModule(goNode.getText().replace(/export /gu, ''), { compilerOptions: { module: ts.ModuleKind.None } }).outputText + '\nreturn goProblem;')();
const p = (x: number, y: number, z: number): P3 => ({ x, y, z });
const solid = (name = 'obsidian', shapes = [[0, 0, 0, 1, 1, 1]]) => ({ name, boundingBox: 'block', shapes });
const air = () => ({ name: 'air', boundingBox: 'empty', shapes: [] });
const key = (v: P3) => `${v.x},${v.y},${v.z}`;
function terrain(perch = p(103.5, 74, -39.5)) {
  const blocks = new Map<string, any>();
  const read = (v: P3): any => blocks.get(key(v)) ?? (v.y < perch.y - 4 ? solid('end_stone')
    : v.x === Math.floor(perch.x) && v.z === Math.floor(perch.z) && v.y < perch.y ? solid('bedrock') : air());
  return { read, blocks, perch };
}

afterEach(() => { vi.useRealTimers(); });

describe('descent bed geometry and damage', () => {
  it.each([0, Math.PI / 2, Math.PI, -Math.PI / 2])('selects supported pillow/screen/low stand from translated terrain (yaw %s)', yaw => {
    const t = terrain(), layouts = geometry.descentBedLayouts(t.perch, yaw, t.read, 4);
    expect(layouts.length).toBeGreaterThan(0);
    const l = layouts[0]; expect(l.head).toEqual(p(103, 74, -40));
    expect(l.screen.length).toBeLessThanOrEqual(4);
    const projected = (v: P3) => l.screen.some(c => key(c) === key(v)) ? solid() : t.read(v);
    expect(geometry.bedSelfEstimate(projected, l.head, l.foot, l.stand).expected).toBeLessThanOrEqual(6);
    for (const cell of [l.head, l.foot, ...l.screen]) expect(geometry.bedEyeReach(l.stand, cell)).toBeLessThanOrEqual(4.5);
    for (const cell of l.screen) { expect(geometry.bedCellSupported(t.read, cell)).toBe(true); t.blocks.set(key(cell), solid()); }
    expect(geometry.descentBedLayouts(t.perch, yaw, () => null, 4)).toEqual([]);
    expect(geometry.descentBedLayouts(t.perch, yaw, t.read, 0).length).toBeGreaterThan(0);
  });
  it('refuses missing material, occupied pillow and a high/unshielded operation point', () => {
    const t = terrain(); expect(geometry.descentBedLayouts(t.perch, 0, t.read, 0)).toEqual([]);
    t.blocks.set('103,74,-40', solid('torch')); expect(geometry.descentBedLayouts(t.perch, 0, t.read, 4)).toEqual([]);
  });
  it('matches floating point 1.21.11 examples, including one HP behind complete cover', () => {
    expect(geometry.bedDamage(1.5, 1)).toBeCloseTo(56.0375);
    expect(geometry.bedDamage(3, 0.25)).toBeCloseTo(8.196875);
    expect(geometry.bedDamage(3, 0)).toBe(1);
    expect(geometry.bedDamage(10.01, 1)).toBe(0);
    expect(geometry.bedDamage(3, NaN)).toBeNaN();
  });
  it('replaces a removed screen with exposure rather than assuming obsidian gives a fixed discount', () => {
    const head = p(0, 1, 0), foot = p(1, 1, 0), feet = p(0.5, 0, 3.5);
    const before = geometry.bedSelfEstimate(v => v.z === 1 && v.y >= 0 && v.y <= 2 ? solid() : air(), head, foot, feet);
    const after = geometry.bedSelfEstimate(() => air(), head, foot, feet);
    expect(before.expected).toBeLessThanOrEqual(6); expect(after.exposure).toBeGreaterThan(before.exposure); expect(after.expected).toBeGreaterThan(6);
  });
  it('counts rays against collision shapes, not material labels or nominal bounding boxes', () => {
    const centre = p(0.5, 3.5, 0.5), box = geometry.bedBodyBox(p(0.5, 0, 3.5));
    const wall = (name: string, shapes: number[][] | undefined) => (v: P3) => v.z === 1 && v.y >= 0 && v.y <= 3 ? { name, boundingBox: 'block', shapes } : air();
    const full = geometry.bedExposure(wall('obsidian', [[0, 0, 0, 1, 1, 1]]), centre, box);
    expect(full).toBe(0);
    expect(geometry.bedExposure(wall('cobblestone', [[0, 0, 0, 1, 1, 1]]), centre, box)).toBe(full);
    expect(geometry.bedExposure(wall('obsidian', undefined), centre, box)).toBe(1);
    expect(geometry.bedExposure(wall('oak_fence_gate', []), centre, box)).toBe(1);
    const partial = geometry.bedExposure(v => v.z === 1 && v.y === 2 ? solid('slab', [[0, 0, 0, 1, 0.5, 1]]) : air(), centre, box);
    expect(partial).toBeGreaterThan(0); expect(partial).toBeLessThan(1);
    expect(geometry.bedExposure(wall('obsidian', [[0, 0, 0, 1, 1, 1]]), centre, box, [p(0, 0, 1), p(0, 1, 1), p(0, 2, 1), p(0, 3, 1)])).toBe(1);
  });
});

const valid = { phase: 3, now: 20, observed: 16, placed: 16, lastBlast: 9, used: 2, reach: 4.5, damage: 6, health: 20, headDamage: 55, headDistance: 1.5 };
describe('human operation and self-harm veto', () => {
  it('accepts the exact four-tick and eleven-tick boundaries', () => { expect(bedUseRefusal(valid)).toBeNull(); });
  it.each([
    [{ phase: 4 }, 'not_descending'], [{ phase: 6 }, 'not_descending'], [{ observed: 17 }, 'observation_delay'],
    [{ placed: 17 }, 'placement_delay'], [{ placed: null }, 'placement_delay'], [{ lastBlast: 10 }, 'dragon_hurt_cooldown'],
    [{ reach: 4.5001 }, 'out_of_reach'], [{ damage: 6.01 }, 'self_damage'], [{ health: 10 }, 'self_damage'],
    [{ damage: NaN }, 'estimate_unknown'], [{ used: 3 }, 'three_bed_limit'], [{ headDistance: 3 }, 'head_not_at_pillow'],
    [{ headDamage: 49 }, 'head_not_at_pillow'],
    [{ placed: NaN }, 'estimate_unknown'], [{ damage: -1 }, 'estimate_unknown'],
  ])('refuses %j', (change, reason) => { expect(bedUseRefusal({ ...valid, ...change })).toBe(reason); });
});

function rig(options: { explode?: boolean; proofId?: number; hurt?: boolean; limit?: number } = {}) {
  const t = terrain();
  const actor: any = new EventEmitter(); actor._client = new EventEmitter(); actor.health = 20; actor.food = 20;
  actor.entity = { position: new Vec3(115.5, 70, -39.5) };
  let beds = 4, obsidian = 4, uses = 0, disconnected: string | null = null;
  const d: any = { id: 77, phase: 2, position: p(103.5, 77, -46), yaw: 0, health: 200,
    approach: { basin: [p(104.5, 70, -40.5)] } };
  const counts: Record<string, number> = {};
  actor.reflexLedger = { counts: () => ({ ...counts }) };
  actor.blockAt = (v: P3) => t.read(v);
  const calls: any[] = [], commands: string[] = [], scenes: Record<string, any> = {};
  let handler: ((hands: any[], signal: AbortSignal) => Promise<void>) | undefined;
  const deps = { ...geometry, Vec3, partBox, isPerched, bedHalves, actor, actorDeaths: 0, disconnected, scenes, KILL_LIMIT_MS: options.limit ?? 10_000,
    chainDistance: (a: P3, b: P3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
    killCell: (v: P3) => p(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)), killPlaced: new Map(), killBlasts: [],
    prepareKillRun: vi.fn(async () => ({ dragonId: 77, ground: { ...actor.entity.position } })),
    endView: () => ({ dragon: structuredClone(d), perch: t.perch }),
    packCount: (name: string) => name === 'white_bed' ? beds : name === 'obsidian' ? obsidian : 64,
    trackMinHealth: () => { let min = actor.health; const f = () => { min = Math.min(min, actor.health); }; actor.on('health', f); return { stop: () => { actor.removeListener('health', f); return min; } }; },
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    dragonHealthServer: vi.fn(async () => d.health),
    evidence: vi.fn(async () => ({ boss: { verified: true, witness: { entityId: options.proofId ?? 77 } } })),
    basinWaitingCell: () => p(115.5, 70, -39.5),
    ask: vi.fn(async (command: string) => { commands.push(command); return ''; }),
    act: async (hands: any[], _seconds: number, _extra: any, signal: AbortSignal) => {
      calls.push({ hands, at: Date.now(), signal });
      if (handler) await handler(hands, signal);
      if (signal.aborted) return { ok: false, lines: ['aborted'], ms: 0 };
      for (const hand of hands) {
        if (hand.do === 'go') actor.entity.position = new Vec3(hand.to.x + 0.5, hand.to.y, hand.to.z + 0.5);
        if (hand.do === 'place') {
          const cell = hand.at[0];
          if (hand.block === 'white_bed') {
            beds--;
            const head = p(Math.floor(t.perch.x), cell.y, Math.floor(t.perch.z));
            const facing = head.x < cell.x ? 'west' : head.x > cell.x ? 'east' : head.z < cell.z ? 'north' : 'south';
            for (const [part, v] of [['foot', cell], ['head', head]] as const) {
              const block = { name: 'white_bed', position: v, getProperties: () => ({ part, facing }), shapes: [[0, 0, 0, 1, 0.5625, 1]] };
              t.blocks.set(key(v), block); actor.emit('blockUpdate', null, block);
            }
          } else { obsidian--; t.blocks.set(key(cell), solid()); }
        }
        if (hand.do === 'use') {
          uses++;
          if (options.explode !== false) {
            const halves = bedHalves(t.read(hand.at[0]), hand.at[0])!;
            actor._client.emit('explosion', { center: geometry.bedCentre(halves.head) });
            t.blocks.delete(key(halves.foot)); t.blocks.delete(key(halves.head));
            d.health -= 55;
            if (options.hurt) { actor.health -= 2; actor.emit('health'); }
            if (uses === 3) d.phase = 6;
          }
        }
        if (hand.do === 'attack') { d.health = Math.max(0, d.health - 6); if (d.health === 0) actor.emit('entityDead', { id: 77 }); }
      }
      await new Promise(resolve => setTimeout(resolve, 60));
      return { ok: true, lines: ['ok'], ms: 60 };
    },
  };
  const api = new Function(...Object.keys(deps), `${compiled}\nreturn { run: endBedKill, disconnect() { disconnected = 'mock'; }, die() { actorDeaths++; actor.health = 0; actor.emit('death'); } };`)(...Object.values(deps));
  const pump = setInterval(() => actor.emit('physicsTick'), 50);
  const run = async () => { try { return await api.run(); } finally { clearInterval(pump); } };
  return { run, actor, d, deps, calls, commands, ...t, disconnect: api.disconnect, die: api.die, setHandler: (f: typeof handler) => { handler = f; }, counts };
}

describe('end_bed_kill scene with mocked I/O', () => {
  it('prepares HP 200, zero crystals, four beds/four obsidian/iron gear and a single natural-flight reset, with reflexes on', async () => {
    const node = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true).statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'prepareKillRun')!;
    const prepareCode = ts.transpileModule(node.getText(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const actor: any = { floorReflexes: {}, reflexLedger: { counts: () => ({}) }, entity: { onGround: true }, health: 20, food: 20, inventory: { slots: [] } };
    let items: Array<{ name: string; count: number }> = [];
    actor.inventory.items = () => items;
    const commands: string[] = [], ground = p(115.5, 70, -39.5);
    const gear = vi.fn(async (list: string[]) => { items = list.map(s => { const [name, n] = s.split(' '); return { name, count: Number(n ?? 1) }; }); });
    const standAt = vi.fn(async () => {}), protect = vi.fn(async (_on: boolean) => {});
    const deps = { actor, wanted: ['enter', 'end_bed_kill'], killEntries: ['end_bed_kill'], g: 70, Vec3, scenes: {},
      killArena: { ground, perch: p(103.5, 74, -39.5), yaw: 180 }, killPlaced: new Map(), killBlasts: [], killCrystalSnapshot: [],
      context: { taskRevision: 1, taskId: 'test' },
      protect, releaseReflex: vi.fn(), park: vi.fn(), standAt, still: vi.fn(),
      basinWaitingCell: () => ground, endView: () => ({ dragon: { id: 77, phase: 0, health: 200 }, crystals: { list: [] } }),
      packCount: (name: string) => items.filter(i => i.name === name).reduce((n, i) => n + i.count, 0),
      dragonHealthServer: async () => 200, ask: async (c: string) => { commands.push(c); return ''; }, gear,
      wearIron: async () => { ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'].forEach((name, i) => { actor.inventory.slots[5 + i] = { name }; }); },
      act: async (hands: any[]) => { for (const h of hands) { if (h.slot === 'offhand') actor.inventory.slots[45] = { name: h.item }; else actor.heldItem = { name: h.item }; } },
      sleep: async () => {}, END: 'end', DRAGON: '@dragon', ACTOR: 'actor' };
    const prepare = new Function(...Object.keys(deps), `${prepareCode}\nreturn prepareKillRun;`)(...Object.values(deps));
    expect(await prepare(true, true)).toEqual({ dragonId: 77, ground });
    expect(gear.mock.calls[0][0]).toEqual(['iron_sword', 'shield', 'cobblestone 64', ...Array(4).fill('white_bed'), 'obsidian 4', 'cooked_beef 64']);
    expect(commands.filter(c => c.includes('DragonPhase'))).toEqual(['end data modify entity @dragon DragonPhase set value 0']);
    expect(commands).toContain('end kill @e[type=minecraft:end_crystal]');
    expect(commands).toContain('end data modify entity @dragon Health set value 200.0f');
    expect(protect.mock.calls.map(c => c[0])).toEqual([true, false]);
    expect(standAt).toHaveBeenCalledOnce(); expect(actor.floorReflexes).toBeTruthy();
    actor.floorReflexes = null; await expect(prepare(true, true)).rejects.toThrow('requires floor reflexes ON');
  });
  it('uses three delayed descending beds, reserves the fourth, then finishes with iron sword and matching boss evidence', async () => {
    vi.useFakeTimers(); const r = rig({ hurt: true }), running = r.run();
    await vi.advanceTimersByTimeAsync(10_000); const out = await running;
    expect(r.deps.prepareKillRun).toHaveBeenCalledWith(true, true);
    expect(out.ok).toBe(true); expect(out.bedsUsed).toBe(3); expect(out.placementAttempts).toBe(3); expect(out.explosionsHit).toBe(3);
    expect(out.windows).toHaveLength(6); expect(out.minHealth).toBe(14); expect(out.bossVerified).toBe(true);
    expect(out.dragonDeadAt).toBeTruthy(); expect(out.killSeconds).toBeLessThan(10);
    for (const b of out.bedTrials) {
      expect(b.useTick - b.placedTick).toBeGreaterThanOrEqual(4);
      expect(b.prediction.tick - b.prediction.observedTick).toBeGreaterThanOrEqual(4);
      expect(b.dragonLoss).toBe(55); expect(b.selfDamage).toBe(2); expect(b.detonationTick).not.toBeNull();
      expect(b.prediction.self.expected).toBeLessThanOrEqual(6); expect(b.prediction.source).toBe('position_yaw_estimate');
    }
    for (let i = 1; i < out.bedTrials.length; i++) expect(out.bedTrials[i].useTick - out.bedTrials[i - 1].detonationTick).toBeGreaterThanOrEqual(11);
    for (const a of out.actions) {
      expect(a.tick - a.observedTick).toBeGreaterThanOrEqual(4);
      expect(a.seconds - a.observedSeconds).toBeGreaterThanOrEqual(0.1999);
      expect(ACT_HANDS.safeParse(a.hands).success).toBe(true);
      for (const h of a.hands) if (h.do === 'go') expect(goProblem(h)).toBeNull();
    }
    expect(out.phaseTimeline.length).toBeGreaterThan(10);
    expect(r.commands).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
  it('vetoes a changed shield after placing a bed, records the reason, and never clicks it', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 2200 });
    r.setHandler(async hands => {
      if (hands[0]?.block === 'white_bed') setTimeout(() => {
        for (const [k, block] of r.blocks) if (block.name === 'obsidian') r.blocks.delete(k);
        r.actor.entity.position.y = 73;
      }, 70);
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(2300); const out = await running;
    expect(r.calls.filter(c => c.hands[0]?.do === 'use')).toHaveLength(0);
    expect(out.refusals.some((f: any) => ['self_damage', 'out_of_reach', 'operating_position_changed'].includes(f.reason))).toBe(true);
    expect(out.ok).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a running hand on takeoff and immediately chooses the observed retreat', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 2000 });
    let first = true;
    r.setHandler(async (_hands, signal) => {
      if (!first) return; first = false; r.d.phase = 4;
      await new Promise(resolve => setTimeout(resolve, 100)); expect(signal.aborted).toBe(true);
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(2100); const out = await running;
    expect(out.actions[0].cancelled).toBe('takeoff_leave_now');
    expect(out.actions.some((a: any) => a.label === 'leave_on_takeoff')).toBe(true);
    expect(r.calls.some(c => c.hands[0]?.do === 'use')).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it('leaves during a slow before-shot server health read instead of waiting for its chat response', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 2500 });
    let readCount = 0;
    r.deps.dragonHealthServer.mockImplementation(async () => {
      if (++readCount === 2) {
        r.d.phase = 4;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      return r.d.health;
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(1800);
    expect(r.calls.filter(c => c.hands[0]?.do === 'go').length).toBeGreaterThanOrEqual(2);
    expect(r.calls.some(c => c.hands[0]?.do === 'use')).toBe(false);
    await vi.advanceTimersByTimeAsync(2000); const out = await running;
    expect(out.actions.find((a: any) => a.label === 'leave_on_takeoff')?.seconds).toBeLessThan(1.8);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('records an unconfirmed use separately from a confirmed blast and does not invent damage', async () => {
    vi.useFakeTimers(); const r = rig({ explode: false, limit: 1800 });
    const running = r.run(); await vi.advanceTimersByTimeAsync(1900); const out = await running;
    const trial = out.bedTrials[0];
    expect(trial.useTick).not.toBeNull(); expect(trial.detonationTick).toBeNull();
    expect(trial.notDetonatedReason).toBe('use_without_explosion_confirmation');
    expect(trial.dragonLoss).toBe(0); expect(out.explosionsHit).toBe(0); expect(out.ok).toBe(false);
  });
  it('does not certify another dragon and preserves cumulative reflex counts', async () => {
    vi.useFakeTimers(); const r = rig({ proofId: 99 }); r.counts.retreat = 4;
    const running = r.run(); await vi.advanceTimersByTimeAsync(1000); r.counts.retreat = 6; r.counts.knock = 1;
    await vi.advanceTimersByTimeAsync(25_000); const out = await running;
    expect(out.bossVerified).toBe(false); expect(out.ok).toBe(false); expect(out.reflexKinds).toEqual({ retreat: 2, knock: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['disconnect', 'die'] as const)('stops on %s without a missing entity becoming a kill', async mode => {
    vi.useFakeTimers(); const r = rig(); const running = r.run(); await vi.advanceTimersByTimeAsync(300);
    r[mode](); await vi.advanceTimersByTimeAsync(300); const out = await running;
    expect(out.endReason).toBe(mode === 'die' ? 'actor_dead' : 'disconnected'); expect(out.ok).toBe(false);
    expect(out.deaths).toBe(mode === 'die' ? 1 : 0); expect(vi.getTimerCount()).toBe(0);
  });
  it('counts and closes long phase 1 intervals at timeout without forcing a phase', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 1500 }); r.d.phase = 1;
    const running = r.run(); await vi.advanceTimersByTimeAsync(1600); const out = await running;
    expect(out.phase1Seconds).toBeCloseTo(1.5, 1); expect(out.killSeconds).toBeNull(); expect(out.endReason).toBe('time_limit');
    expect(r.commands).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
  it('registers exact standalone selection and default report persistence alongside the other kill entries', () => {
    expect(source).toContain("const killEntries = ['end_bed_kill',");
    const selection = source.slice(source.indexOf('const invalidKillSelection ='), source.indexOf('for (const name of invalidKillSelection'));
    const choose = new Function('wanted', 'killEntries', 'report', 'exitCode', ts.transpileModule(`${selection}\nreturn invalidKillSelection;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
    const entries = ['end_bed_kill', 'dragon_kill_bed'];
    for (const wanted of [['end_bed_kill'], ['enter', 'end_bed_kill']]) expect(choose(wanted, entries, { errors: [] }, 0)).toBe(false);
    for (const wanted of [['enter', 'end_bed_kill', 'bed'], ['end_bed_kill', 'dragon_kill_bed']]) expect(choose(wanted, entries, { errors: [] }, 0)).toBe(true);
    expect(source).toContain("wanted.some(name => killEntries.includes(name)) ? path.join(worldDirectory, 'report.json')");
    expect(ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).diagnostics).toEqual([]);
  });
});
