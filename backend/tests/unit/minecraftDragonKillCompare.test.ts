import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bedWallCells, perchBedFoot, bedCellSupported, supportedBedCells } from '../../src/services/minebot/utils/dragonBedGeometry.js';
import { isPerched, partBox } from '../../src/services/minebot/utils/dragonParts.js';
import { bedHalves } from '../../src/services/minebot/utils/bedRules.js';
import { ReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';
import { BLOCK_REACH } from '../../src/services/minebot/utils/blockReach.js';
import { feetCentre } from '../../src/services/minebot/utils/dragonWalk.js';
import { makeSim } from '../helpers/physicsBody.js';
import { go as bodyGo } from '../../src/services/minebot/utils/primitives/go.js';
import { StepStopped } from '../../src/services/minebot/utils/primitives/common.js';

// Load only the marked lab HEAD, with its I/O replaced. Importing the probe itself would open two live connections.
const source = fs.readFileSync(new URL('../../scripts/minecraft-end-fight-probe.ts', import.meta.url), 'utf8');
const section = source.split('// ===== dragon_kill_compare:')[1].split('// ===== end dragon_kill_compare =====')[0];
const bedUse = source.slice(source.indexOf('function perchBedEstimate('), source.indexOf('scenes.bed ='));
const compiled = ts.transpileModule(`${source.match(/^const round =.*$/m)![0]}\n// ${section}\n${bedUse}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

function rig(options: { estimate?: number; proofId?: number; missingPlan?: boolean } = {}) {
  let health = 200, arrows = 64, beds = 12, obsidian = 12, reflected = false, explosion = true;
  const actor: any = new EventEmitter();
  actor._client = new EventEmitter(); actor.health = 20; actor.food = 20; actor.floorReflexes = {};
  actor.entity = { position: new Vec3(110.5, 70, -30.5), onGround: true };
  const blocks = new Map<string, any>();
  let groundY = 70;
  actor.blockAt = (p: any) => blocks.get(`${p.x},${p.y},${p.z}`) ?? (p.y < groundY ? { name: 'end_stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' });
  actor.inventory = { slots: [], items: () => [{ name: 'arrow', count: arrows }, { name: 'white_bed', count: beds }, { name: 'obsidian', count: obsidian },
    { name: 'cobblestone', count: 64 }, { name: 'cooked_beef', count: 64 }, { name: 'bow', count: 1 }] };
  ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'].forEach((name, i) => { actor.inventory.slots[5 + i] = { name }; });
  actor.inventory.slots[45] = { name: 'shield' }; actor.heldItem = { name: 'stone_sword' };
  actor.reflexLedger = new ReflexLedger(actor);
  const d: any = { id: 77, health, phase: 6, windows: { open: true }, position: { x: 100.5, y: 74, z: -30.5 }, yaw: Math.PI / 2,
    approach: { stage: [{ x: 112.5, y: 70, z: -30.5, strikeIndex: 1, toStrikeMeters: 2 }],
      strike: [{ x: 101.5, y: 70, z: -30.5 }, { x: 111.5, y: 70, z: -30.5 }], retreat: [{ x: 118.5, y: 70, z: -30.5 }] } };
  if (options.missingPlan) delete d.approach;
  const calls: any[] = [];
  let handler: ((hands: any[], signal?: AbortSignal) => Promise<any>) | undefined;
  const act = async (hands: any[], _seconds?: number, _extra?: any, signal?: AbortSignal) => {
    calls.push({ hands, signal, at: Date.now() });
    if (signal?.aborted) return { ok: false, lines: ['aborted'], parsed: null, ms: 0 };
    if (handler) { const value = await handler(hands, signal); if (value) return value; }
    for (const h of hands) {
      if (h.do === 'go') actor.entity.position = new Vec3(h.to.x + 0.5, h.to.y, h.to.z + 0.5);
      if (h.do === 'shoot') arrows--;
      if (h.do === 'place') {
        for (const p of h.at) blocks.set(`${p.x},${p.y},${p.z}`, h.block === 'white_bed'
          ? { name: 'white_bed', getProperties: () => ({ part: 'foot', facing: 'west' }) } : { name: h.block, boundingBox: 'block' });
        if (h.block === 'white_bed') beds--; else obsidian -= h.at.length;
      }
      if (h.do === 'attack') { d.health -= 6; }
      if (h.do === 'use' && explosion) {
        const halves = bedHalves(actor.blockAt(h.at[0]), h.at[0])!;
        d.health -= 30;
        actor._client.emit('explosion', { center: { x: halves.head.x + 0.5, y: halves.head.y + 0.5, z: halves.head.z + 0.5 } });
      }
    }
    // Let the lab's phase watcher run even when the mocked motor completes instantly.
    await new Promise(resolve => setTimeout(resolve, 10));
    return { ok: true, lines: reflected ? ['反射'] : ['ok'], parsed: { lines: [] }, ms: 10 };
  };
  const deps: Record<string, any> = { actor, actorDeaths: 0, disconnected: null, wanted: ['dragon_kill_sword'], scenes: {}, g: 70,
    context: { taskId: 'test', taskRevision: 1 }, Vec3, isPerched, partBox, perchBedFoot, bedWallCells, bedCellSupported, supportedBedCells, bedHalves, BLOCK_REACH, feetCentre,
    approachClear: vi.fn(() => true), dragonHazards: vi.fn(() => []), standing: vi.fn(() => true), bodyReader: vi.fn(() => ({})),
    blastAt: vi.fn(() => ({ safe: true, expected: options.estimate ?? 4 })), act,
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    endView: () => ({ dragon: { ...d, phaseFor: d.phaseFor ?? Date.now() / 1000 } }), trackMinHealth: () => ({ stop: () => actor.health }),
    dragonHealthServer: vi.fn(async () => d.health), evidence: vi.fn(async () => ({ boss: { verified: true, witness: { entityId: options.proofId ?? 77 } } })),
    prepareMock: vi.fn(async () => ({ dragonId: 77, ground: { x: 110.5, y: 70, z: -30.5 } })),
    END: 'execute in minecraft:the_end run', DRAGON: '@e[type=minecraft:ender_dragon,limit=1]', ACTOR: 'MinebotTrial',
    ask: vi.fn(async () => ''), protect: vi.fn(async () => {}), releaseReflex: vi.fn(), park: vi.fn(async () => {}),
    gear: vi.fn(async () => {}), wearIron: vi.fn(async () => {}), standAt: vi.fn(async () => {}), still: vi.fn(async () => {}),
  };
  const factory = new Function(...Object.keys(deps), `${compiled}\nconst actualPrepare = prepareKillRun; prepareKillRun = prepareMock; return { run: dragonKillRun, choose: chooseKillPlan, route: killRetreatRoute, layout: killBedLayout, useBed: usePerchBed, actualPrepare, setArena(a) { killArena = a; }, die() { actorDeaths++; actor.health = 0; actor.emit('death'); } };`);
  const api = factory(...Object.values(deps));
  return { ...api, actor, d, calls, deps, blocks, setGround: (y: number) => { groundY = y; }, setHandler: (fn: typeof handler) => { handler = fn; },
    reflect: () => { reflected = true; }, noExplosion: () => { explosion = false; },
    kill: async () => { d.health = 0; actor.emit('entityDead', { id: 77 }); await vi.advanceTimersByTimeAsync(250); },
    die: async () => { api.die(); await vi.advanceTimersByTimeAsync(250); },
    drop: () => { arrows = 0; beds = 0; } };
}

afterEach(() => { vi.useRealTimers(); });

describe('observed bed support geometry', () => {
  it.each([{ x: 4, y: 66, z: -15 }, { x: 8, y: 65, z: 4 }])('anchors the r73 floating wall at $x,$y,$z to uneven ground, bottom first', target => {
    const built = new Map<string, any>();
    const read = (p: any) => built.get(JSON.stringify(p)) ?? (p.y <= target.y - 2 ? { name: 'end_stone', boundingBox: 'block' } : { name: 'air' });
    const targets = [target, { ...target, y: target.y + 2 }, { ...target, x: target.x + 1, y: target.y + 1 }];
    const cells = supportedBedCells(targets, read)!;
    expect(cells[0].y).toBe(target.y - 1);
    expect(cells.map(p => p.y)).toEqual([...cells.map(p => p.y)].sort((a, b) => a - b));
    for (const p of cells) {
      expect(bedCellSupported(read, p)).toBe(true);
      built.set(JSON.stringify(p), { name: 'obsidian', boundingBox: 'block' });
    }
    for (const p of targets) expect(read(p).name).toBe('obsidian');
  });

  it('uses an existing solid side face without inventing a floor; rejects void, unloaded blocks and liquids', () => {
    const target = { x: 4, y: 66, z: -15 };
    const side = (p: any) => ({ name: p.x === 3 && p.y === 66 ? 'obsidian' : 'air', boundingBox: p.x === 3 && p.y === 66 ? 'block' : 'empty' });
    expect(supportedBedCells([target], side)).toEqual([target]);
    expect(supportedBedCells([target], () => ({ name: 'air' }))).toBeNull();
    expect(supportedBedCells([target], () => null)).toBeNull();
    expect(supportedBedCells([target], () => ({ name: 'water', boundingBox: 'empty' }))).toBeNull();
  });
});

describe('dragon kill comparison lab HEAD (mock motors, no server)', () => {
  it('waits for scan and three fresh stable approach observations, rather than a fixed landing delay', async () => {
    vi.useFakeTimers(); const r = rig(); r.d.phase = 3; r.d.windows.open = false;
    const promise = r.run('sword_stage'); await vi.advanceTimersByTimeAsync(1000);
    expect(r.calls).toHaveLength(0);
    r.d.phase = 5; await vi.advanceTimersByTimeAsync(1000); expect(r.calls).toHaveLength(0);
    r.d.phase = 6;
    for (let i = 0; i < 5; i++) { r.d.approach.stage[0].x++; await vi.advanceTimersByTimeAsync(100); }
    expect(r.calls).toHaveLength(0);
    r.d.phaseFor = 23; r.d.approach.stage[0].x++;
    await vi.advanceTimersByTimeAsync(1000); expect(r.calls).toHaveLength(0);
    r.d.phaseFor = 23.1; await vi.advanceTimersByTimeAsync(100); expect(r.calls).toHaveLength(0);
    r.d.phaseFor = 23.2; await vi.advanceTimersByTimeAsync(100);
    expect(r.calls[0].hands[0].to.x).toBe(Math.floor(r.d.approach.stage[0].x));
    await r.kill(); await promise;
  });

  it.each(['script_observation_changed', 'reflex'])('replans a stage cut by %s in the same perch only after observation changes', async reason => {
    vi.useFakeTimers(); const r = rig(); let attempts = 0, stageSignal: AbortSignal | undefined;
    r.d.windows.open = false;
    r.setHandler(async (hands: any[], signal?: AbortSignal) => {
      if (hands[0]?.do !== 'go' || hands[0].to.x >= 118 || ++attempts !== 1) return;
      stageSignal = signal;
      if (reason === 'reflex') return { ok: false, lines: ['反射: retreat'], ms: 100 };
      return new Promise(resolve => signal!.addEventListener('abort', () => resolve({ ok: false, lines: ['cancelled'], ms: 298 }), { once: true }));
    });
    const promise = r.run('sword_stage'); await vi.advanceTimersByTimeAsync(400);
    if (reason === 'script_observation_changed') r.deps.approachClear.mockImplementation((_a: any, _d: any, p: any) => p.x !== 112.5);
    await vi.advanceTimersByTimeAsync(500);
    expect(attempts).toBe(1);
    if (reason === 'script_observation_changed') expect(stageSignal?.reason).toBe(reason);
    // A new observed pair, with no new perch. Never reuse the cancelled stage or its matching strike.
    r.d.approach.stage[0] = { ...r.d.approach.stage[0], x: 114.5 };
    r.d.approach.strike[1] = { ...r.d.approach.strike[1], x: 113.5 };
    await vi.advanceTimersByTimeAsync(500);
    expect(attempts).toBe(2);
    r.d.windows.open = true; await vi.advanceTimersByTimeAsync(300);
    expect(r.calls.some((c: any) => c.hands[0]?.to?.x === 113)).toBe(true);
    await r.kill(); const result = await promise;
    const stages = result.actions.filter((a: any) => a.label === 'stage');
    expect(stages.map((a: any) => a.stageAttempt)).toEqual([1, 2]);
    expect(stages[0].interruptions).toContain(reason);
    expect(result.perchCount).toBe(1);
  });

  it('bounds stages to three per perch, ignores countdown-only changes, and resets for a new perch', async () => {
    vi.useFakeTimers(); const r = rig(); r.d.windows.open = false;
    r.setHandler(async (hands: any[]) => hands[0]?.to?.x !== 118 ? { ok: false, lines: ['反射'], ms: 10 } : undefined);
    const promise = r.run('sword_stage'); await vi.advanceTimersByTimeAsync(1000);
    const stages = () => r.calls.filter((c: any) => c.hands[0]?.to?.x !== 118);
    expect(stages()).toHaveLength(1);
    for (let i = 0; i < 4; i++) { r.d.approach.stage[0].z++; await vi.advanceTimersByTimeAsync(500); }
    expect(stages()).toHaveLength(3);
    r.d.phase = 0; await vi.advanceTimersByTimeAsync(200);
    r.d.phase = 6; await vi.advanceTimersByTimeAsync(500);
    expect(stages()).toHaveLength(4);
    await r.kill(); const result = await promise;
    expect(result.actions.filter((a: any) => a.label === 'stage').map((a: any) => [a.perch, a.stageAttempt])).toEqual([[1, 1], [1, 2], [1, 3], [2, 1]]);
  });

  it.each(['retreat_route_detour', 'retreat_route_rise'])('cancels %s before its proposed way is walked and uses another observed retreat', async reason => {
    vi.useFakeTimers(); const r = rig(); r.d.approach.stage = [];
    r.d.approach.retreat.push({ x: 120.5, y: 70, z: -30.5 });
    r.deps.approachClear.mockImplementation((_a: any, _d: any, p: any) => p.x >= 118);
    const origin = { ...r.actor.entity.position };
    r.setHandler(async (hands: any[], signal?: AbortSignal) => {
      if (hands[0]?.to?.x !== 118) return;
      r.actor.emit('path_update', { status: 'success', path: reason === 'retreat_route_detour'
        ? [{ x: 110.5, y: 70, z: -50.5 }, { x: 118.5, y: 70, z: -30.5 }]
        : [{ x: 113.5, y: 73, z: -30.5 }, { x: 118.5, y: 70, z: -30.5 }] });
      expect(signal?.reason).toBe(reason);
      expect({ ...r.actor.entity.position }).toEqual(origin);
      return { ok: false, lines: ['cancelled'], ms: 0 };
    });
    const promise = r.run('sword_stage'); await vi.advanceTimersByTimeAsync(500);
    expect(r.calls.map((c: any) => c.hands[0].to.x)).toEqual([118, 120]);
    expect(r.calls[0].hands[0]).toMatchObject({ seconds: 5, maxDrop: 1 });
    await r.kill(); const result = await promise;
    expect(result.actions[0]).toMatchObject({ abortReason: reason, routeRefused: { reason, direct: 8 } });
    expect(result.endReason).toBe('dragon_dead'); expect(r.actor.listenerCount('path_update')).toBe(0);
  });

  it('checks redrawn routes against the original distance including travel already made', async () => {
    vi.useFakeTimers(); const r = rig(); r.d.approach.stage = [];
    r.deps.approachClear.mockImplementation((_a: any, _d: any, p: any) => p.x >= 118);
    r.setHandler(async (_hands: any[], signal?: AbortSignal) => {
      r.actor.emit('path_update', { path: [{ x: 115.5, y: 70, z: -30.5 }] }); expect(signal?.aborted).toBe(false);
      r.actor.entity.position.x = 115.5;
      // Include the first 5 m when checking each redraw.
      r.actor.emit('path_update', { path: [{ x: 115.5, y: 70, z: -37.5 }, { x: 118.5, y: 70, z: -30.5 }] });
      // 5 + 7 + sqrt(58) = 19.62: still within the bound.
      expect(signal?.aborted).toBe(false);
      r.actor.emit('path_update', { path: [{ x: 115.5, y: 70, z: -38.5 }, { x: 118.5, y: 70, z: -30.5 }] });
      expect(signal?.reason).toBe('retreat_route_detour');
      r.deps.approachClear.mockReturnValue(true);
      return { ok: false, lines: ['cancelled'], ms: 0 };
    });
    const promise = r.run('sword_stage'); await vi.advanceTimersByTimeAsync(500); await r.kill();
    const result = await promise;
    expect(result.actions[1]).toMatchObject({ ok: true, hands: [], lines: ['already_safe'] });
    expect(r.calls).toHaveLength(1);
  });

  it('cancels the real route executor before walking a detour around a wall (fake world, no server)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    const r = rig(), sim = makeSim((x, y, z) => y < 70 || (x === 114 && z >= -41 && z <= -20 && y <= 75) ? 'stone' : 'air',
      { start: [110.5, 70, -30.5] });
    r.actor.entity = sim.bot.entity; r.d.approach.stage = [];
    r.deps.approachClear.mockImplementation((_a: any, _d: any, p: any) => p.x >= 118);
    sim.bot.on('path_update', (result: any) => r.actor.emit('path_update', result));
    r.setHandler(async (hands: any[], signal?: AbortSignal) => {
      const hand = hands[0];
      try {
        const outcome = await bodyGo({ bot: sim.bot, stop: signal!, deadline: Date.now() + 6000, facing: 'east', base: hand.to } as never,
          { goals: [hand.to], range: hand.range, maxDrop: hand.maxDrop, seconds: hand.seconds, searchMs: Infinity });
        return { ok: outcome.ok, lines: [outcome.text], ms: 0 };
      } catch (error) {
        expect(error).toBeInstanceOf(StepStopped);
        expect(signal?.reason).toBe('retreat_route_detour');
        r.deps.approachClear.mockReturnValue(true); // Re-observation permits staying here after rejecting this way.
        return { ok: false, lines: ['cancelled'], ms: 0 };
      }
    });
    const promise = r.run('sword_stage');
    for (let i = 0; i < 20; i++) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
    expect(sim.bot.entity.position.distanceTo(new Vec3(110.5, 70, -30.5))).toBeLessThan(0.1);
    await r.kill(); const result = await promise;
    expect(result.actions[0].routeRefused.reason).toBe('retreat_route_detour');
    expect(r.calls).toHaveLength(1);
  });

  it.each([{ x: 0, y: 0, z: 0 }, { x: 217, y: -31, z: 64 }])('keeps route limits relative to the body, with exact boundaries ($x,$y,$z)', offset => {
    const r = rig(), p = (x: number, y = 0) => ({ x: x + offset.x, y: y + offset.y, z: offset.z });
    expect(r.route(p(0), p(4), p(0), 0, [p(-3), p(4)]).reason).toBeNull(); // exactly 2.5 * 4
    expect(r.route(p(0), p(4), p(0), 0, [p(-3.01), p(4)]).reason).toBe('retreat_route_detour');
    expect(r.route(p(0), p(4), p(0), 0, [p(2, 3)]).reason).toBe('retreat_route_rise');
  });

  it('treats repeated window closures at an already safe position as successful without issuing go', async () => {
    vi.useFakeTimers(); const r = rig({ missingPlan: true }); const promise = r.run('sword_stage');
    for (let i = 0; i < 12; i++) {
      r.d.windows.open = true; await vi.advanceTimersByTimeAsync(100);
      r.d.windows.open = false; await vi.advanceTimersByTimeAsync(100);
    }
    await r.kill(); const result = await promise;
    expect(r.calls).toHaveLength(0);
    expect(result.actions.filter((a: any) => a.label === 'window_closed')).toHaveLength(12);
    expect(result.actions.every((a: any) => a.ok && a.lines[0] === 'already_safe')).toBe(true);
    expect(result.endReason).toBe('dragon_dead');
  });

  it('resets consecutive retreat failures after confirming an already safe window closure', async () => {
    vi.useFakeTimers(); const r = rig(); r.d.approach.stage = []; let safeCurrent = false, finished = false;
    r.deps.approachClear.mockImplementation((_a: any, _d: any, p: any) => safeCurrent || p.x >= 118);
    r.setHandler(async () => ({ ok: false, lines: ['search_timeout'], ms: 0 }));
    const promise = r.run('sword_stage').then((result: any) => { finished = true; return result; });
    await vi.advanceTimersByTimeAsync(3000); // Seven failed cycles; the eighth would end the run.
    safeCurrent = true; r.d.windows.open = false; await vi.advanceTimersByTimeAsync(600);
    safeCurrent = false; await vi.advanceTimersByTimeAsync(3000);
    expect(finished).toBe(false);
    safeCurrent = true; await r.kill(); const result = await promise;
    expect(result.actions.some((a: any) => a.label === 'window_closed' && a.lines[0] === 'already_safe')).toBe(true);
    expect(result.endReason).toBe('dragon_dead');
  });

  it('prepares equal packs, removes every crystal/cloud/ball, sets phase only once, and rejects missing floor or armour', async () => {
    vi.useFakeTimers(); const r = rig();
    r.setArena({ ground: { x: 110.5, y: 70, z: -30.5 }, perch: { x: 100.5, y: 74, z: -30.5 }, yaw: 90 });
    const prepared = r.actualPrepare(); await vi.advanceTimersByTimeAsync(20); await prepared;
    const commands = r.deps.ask.mock.calls.map((c: any[]) => c[0]);
    for (const name of ['end_crystal', 'area_effect_cloud', 'dragon_fireball']) expect(commands.some((c: string) => c.includes(`kill @e[type=minecraft:${name}]`))).toBe(true);
    expect(commands.filter((c: string) => c.includes('DragonPhase'))).toHaveLength(1);
    expect(r.deps.gear.mock.calls[0][0].filter((i: string) => i === 'white_bed')).toHaveLength(12);
    r.actor.floorReflexes = null; await expect(r.actualPrepare()).rejects.toThrow('floor reflexes ON');
    r.actor.floorReflexes = {}; r.actor.inventory.slots[5] = null;
    const bad = r.actualPrepare(); const rejected = expect(bad).rejects.toThrow('initial health/ground/gear');
    await vi.advanceTimersByTimeAsync(7000); await rejected;
  });

  it('uses the observed stage strikeIndex, and translates bed and screen geometry with the head', () => {
    const r = rig(), plan = r.choose(r.d);
    expect(plan.strike).toEqual(r.d.approach.strike[1]);
    const a = r.layout(r.d, plan);
    const shift = (p: any) => ({ ...p, x: p.x + 41, y: p.y + 9, z: p.z - 22 });
    r.setGround(79);
    const b = r.layout({ ...r.d, position: shift(r.d.position) }, { stage: shift(plan.stage), strike: shift(plan.strike) });
    expect(b.foot).toEqual(shift(a.foot)); expect(b.cells).toEqual(a.cells.map(shift));
    expect(a.cells.length).toBeLessThanOrEqual(12);
    const legacyWall = bedWallCells({ x: 0, y: 67, z: 9 }, { x: 0.5, y: 64, z: 13.2 }, 64, 68, 6);
    expect(legacyWall[0]).toEqual({ x: -2, y: 64, z: 11 });
    expect(legacyWall.at(-1)).toEqual({ x: 3, y: 68, z: 11 });
  });

  it('goes stage → matching strike → sword → stage, and retreats on phase 4', async () => {
    vi.useFakeTimers(); const r = rig(); const promise = r.run('sword_stage');
    await vi.advanceTimersByTimeAsync(300);
    expect(r.calls.slice(0, 4).map((c: any) => c.hands.at(-1).do)).toEqual(['go', 'go', 'attack', 'go']);
    expect(r.calls[1].hands[0].to).toEqual({ x: 111, y: 70, z: -31 });
    r.d.phase = 4; r.d.windows.open = false;
    await vi.advanceTimersByTimeAsync(300);
    expect(r.calls.at(-1).hands[0].to).toEqual({ x: 118, y: 70, z: -31 });
    await r.kill(); const result = await promise;
    expect(result).toMatchObject({ ok: true, deaths: 0, perchCount: 1, perchesHit: 1, bossVerified: true });
    expect(result.killSeconds).toBeLessThan(1);
  });

  it('cancels a sword hand when the observed window closes and withdraws before another attack', async () => {
    vi.useFakeTimers(); const r = rig(); let signal: AbortSignal | undefined;
    r.setHandler(async (hands: any[], s?: AbortSignal) => {
      if (!hands.some((h: any) => h.do === 'attack')) return;
      signal = s;
      return new Promise(resolve => s!.addEventListener('abort', () => resolve({ ok: false, lines: ['cut'], parsed: null, ms: 100 }), { once: true }));
    });
    const promise = r.run('sword_stage'); await vi.advanceTimersByTimeAsync(400);
    r.d.windows.open = false; await vi.advanceTimersByTimeAsync(300);
    expect(signal?.aborted).toBe(true);
    expect(r.calls.at(-1).hands[0].do).toBe('go');
    expect(r.calls.filter((c: any) => c.hands.some((h: any) => h.do === 'attack'))).toHaveLength(1);
    await r.kill(); await promise;
  });

  it('does not attack after a floor cut of the strike go', async () => {
    vi.useFakeTimers(); const r = rig();
    r.setHandler(async (hands: any[]) => { if (hands[0]?.do === 'go' && hands[0].to.x === 111) r.reflect(); });
    const promise = r.run('sword_stage'); await vi.advanceTimersByTimeAsync(500);
    expect(r.calls.filter((c: any) => c.hands[0]?.do === 'go').length).toBeGreaterThanOrEqual(3);
    expect(r.calls.some((c: any) => c.hands.some((h: any) => h.do === 'attack'))).toBe(false);
    await r.kill(); await promise;
  });

  it('waits while perched, shoots only in flight, and counts ammunition', async () => {
    vi.useFakeTimers(); const r = rig(); const promise = r.run('bow');
    await vi.advanceTimersByTimeAsync(500); expect(r.calls).toHaveLength(0);
    r.d.phase = 0; r.d.windows.open = false;
    await vi.advanceTimersByTimeAsync(100); expect(r.calls.length).toBeGreaterThan(0);
    r.d.phase = 6; await vi.advanceTimersByTimeAsync(200);
    const n = r.calls.length; await vi.advanceTimersByTimeAsync(300); expect(r.calls).toHaveLength(n);
    await r.kill(); const result = await promise; expect(result.arrowsUsed).toBe(n); expect(result.bedsUsed).toBe(0);
  });

  it('waits when the phase is unknown, rather than assuming the dragon is flying', async () => {
    vi.useFakeTimers(); const r = rig(); r.d.phase = null;
    const promise = r.run('bow'); await vi.advanceTimersByTimeAsync(500);
    expect(r.calls).toHaveLength(0); await r.kill(); await promise;
  });

  it('builds a bed screen before waiting for the window, uses an actual bed at estimate 4, and counts a hit perch', async () => {
    vi.useFakeTimers(); const r = rig(); r.d.windows.open = false;
    const promise = r.run('bed'); await vi.advanceTimersByTimeAsync(300);
    expect(r.calls.some((c: any) => c.hands[0].block === 'obsidian')).toBe(true);
    expect(r.calls.some((c: any) => c.hands[0].block === 'white_bed')).toBe(false);
    r.d.windows.open = true; await vi.advanceTimersByTimeAsync(300);
    expect(r.calls.some((c: any) => c.hands[0].do === 'use')).toBe(true);
    await r.kill(); const result = await promise;
    expect(result).toMatchObject({ bedsUsed: 1, explosionsHit: 1, perchesHit: 1, arrowsUsed: 0 });
  });

  it('refuses bed use above estimate 4 and does not mistake disappearance for an explosion', async () => {
    vi.useFakeTimers(); const r = rig({ estimate: 4.1 }); const promise = r.run('bed');
    await vi.advanceTimersByTimeAsync(400);
    expect(r.calls.some((c: any) => c.hands[0].do === 'use')).toBe(false);
    await r.kill(); expect((await promise).explosionsHit).toBe(0);
    const noBlast = rig(); noBlast.noExplosion(); const other = noBlast.run('bed');
    await vi.advanceTimersByTimeAsync(400); await noBlast.kill(); expect((await other).explosionsHit).toBe(0);
  });

  it('places one observed supported cell per hand and logs bed position, wall height, estimate and observed damage', async () => {
    vi.useFakeTimers(); const r = rig();
    r.setHandler(async (hands: any[]) => {
      const h = hands[0];
      if (h?.block === 'obsidian') {
        expect(h.at).toHaveLength(1);
        expect(bedCellSupported(r.actor.blockAt, h.at[0])).toBe(true);
      }
      if (h?.do === 'use') { r.actor.health = 16.5; r.actor.emit('health'); }
    });
    const promise = r.run('bed'); await vi.advanceTimersByTimeAsync(500); await r.kill();
    const result = await promise;
    expect(result.bedTrials[0]).toMatchObject({ expectedDamage: 4, actualDamage: 3.5, exploded: true, wallBottom: 70, wallTop: 74, wallHeight: 5 });
    expect(result.bedTrials[0].foot).toEqual(r.calls.find((c: any) => c.hands[0].block === 'white_bed').hands[0].at[0]);
    expect(result.lastObservation).toMatchObject({ actorHealth: 16.5, hazards: [] });
  });

  it('tries a different observed layout after a refused cell, without replaying that cell', async () => {
    vi.useFakeTimers(); const r = rig(); let refused: any;
    r.setHandler(async (hands: any[]) => {
      if (hands[0]?.block !== 'obsidian') return;
      if (!refused) { refused = hands[0].at[0]; return { ok: false, lines: ['no supporting face'], ms: 0 }; }
      expect(hands[0].at[0]).not.toEqual(refused);
      expect(bedCellSupported(r.actor.blockAt, hands[0].at[0])).toBe(true);
    });
    const promise = r.run('bed'); await vi.advanceTimersByTimeAsync(600); await r.kill();
    const result = await promise;
    expect(result.bedsUsed).toBe(1);
    expect(result.actions.filter((a: any) => a.label === 'bed_layout')).toHaveLength(2);
  });

  it.each(['refused', 'unconfirmed'])('bounds %s support to three distinct candidates, then retreats for the rest of the perch', async failure => {
    vi.useFakeTimers(); const r = rig();
    r.setHandler(async (hands: any[]) => hands[0]?.block === 'obsidian'
      ? { ok: failure === 'unconfirmed', lines: [failure], ms: 0 } : undefined);
    const promise = r.run('bed'); await vi.advanceTimersByTimeAsync(600);
    r.d.windows.open = false; await vi.advanceTimersByTimeAsync(200);
    r.d.windows.open = true; await vi.advanceTimersByTimeAsync(500);
    const placements = r.calls.filter((c: any) => c.hands[0]?.block === 'obsidian');
    expect(placements).toHaveLength(3);
    expect(new Set(placements.map((c: any) => JSON.stringify(c.hands[0].at[0]))).size).toBe(3);
    expect(r.calls.at(-1).hands[0].to).toEqual({ x: 118, y: 70, z: -31 });
    expect(r.calls.some((c: any) => c.hands[0]?.block === 'white_bed')).toBe(false);
    await r.kill(); const result = await promise;
    expect(result.actions.filter((a: any) => a.label === 'bed_layout')).toHaveLength(3);
    expect(result.deaths).toBe(0);
  });

  it('aborts screen construction on window closure and withdraws instead of continuing the column', async () => {
    vi.useFakeTimers(); const r = rig(); let placementSignal: AbortSignal | undefined;
    r.setHandler(async (hands: any[], signal?: AbortSignal) => {
      if (hands[0]?.block !== 'obsidian') return;
      placementSignal = signal;
      return new Promise(resolve => signal!.addEventListener('abort', () => resolve({ ok: false, lines: ['closed'], ms: 100 }), { once: true }));
    });
    const promise = r.run('bed'); await vi.advanceTimersByTimeAsync(400);
    r.d.windows.open = false; await vi.advanceTimersByTimeAsync(300);
    expect(placementSignal?.aborted).toBe(true);
    expect(r.calls.filter((c: any) => c.hands[0]?.block === 'obsidian')).toHaveLength(1);
    expect(r.calls.at(-1).hands[0].to).toEqual({ x: 118, y: 70, z: -31 });
    await r.kill(); await promise;
  });

  it('retreats when the observed bed columns have no loaded anchor within the scan bound', async () => {
    vi.useFakeTimers(); const r = rig(); r.setGround(50);
    const promise = r.run('bed'); await vi.advanceTimersByTimeAsync(500);
    expect(r.calls.some((c: any) => c.hands[0]?.do === 'place')).toBe(false);
    expect(r.calls.at(-1).hands[0].to).toEqual({ x: 118, y: 70, z: -31 });
    await r.kill(); const result = await promise;
    expect(result.actions.filter((a: any) => a.label === 'bed_layout')).toHaveLength(3);
  });

  it('rejects an unsupported sword stage and retreats without an attack or placement', async () => {
    vi.useFakeTimers(); const r = rig();
    r.deps.standing.mockImplementation((_read: any, p: any) => p.x !== 112);
    const promise = r.run('sword_stage'); await vi.advanceTimersByTimeAsync(500);
    expect(r.calls.some((c: any) => c.hands.some((h: any) => h.do === 'attack' || h.do === 'place'))).toBe(false);
    expect(r.calls.at(-1).hands[0].to).toEqual({ x: 118, y: 70, z: -31 });
    await r.kill(); await promise;
  });

  it.each(['bed', 'sword_stage'])('withdraws %s on a direct phase change to flight, without requiring phase 4', async style => {
    vi.useFakeTimers(); const r = rig(); const promise = r.run(style);
    await vi.advanceTimersByTimeAsync(500);
    r.d.phase = 0; r.d.windows.open = false;
    await vi.advanceTimersByTimeAsync(300);
    const n = r.calls.length; await vi.advanceTimersByTimeAsync(500); expect(r.calls).toHaveLength(n);
    await r.kill(); const result = await promise;
    expect(result.actions.find((a: any) => a.label === 'window_closed')).toMatchObject({ ok: true, hands: [], lines: ['already_safe'] });
  });

  it.each(['bed', 'sword_stage'])('rechecks %s waiting safety and leaves a stage that has become hazardous', async style => {
    vi.useFakeTimers(); const r = rig(); r.d.windows.open = false;
    const promise = r.run(style); await vi.advanceTimersByTimeAsync(500);
    r.deps.approachClear.mockImplementation((_actor: any, _d: any, p: any) => p.x >= 118);
    await vi.advanceTimersByTimeAsync(300);
    expect(r.calls.at(-1).hands[0].to).toEqual({ x: 118, y: 70, z: -31 });
    r.d.windows.open = true; await vi.advanceTimersByTimeAsync(500);
    expect(r.calls.some((c: any) => c.hands.some((h: any) => h.do === 'use' || h.do === 'attack'))).toBe(false);
    await r.kill(); await promise;
  });

  it('falls back from withdraw_stage search_timeout to retreat, without reissuing the failed stage go', async () => {
    vi.useFakeTimers(); const r = rig(); let attacked = false, failed = 0;
    r.setHandler(async (hands: any[]) => {
      if (hands.some((h: any) => h.do === 'attack')) attacked = true;
      if (attacked && hands[0]?.do === 'go' && hands[0].to.x === 112) { failed++; return { ok: false, lines: ['search_timeout'], ms: 5000 }; }
    });
    const promise = r.run('sword_stage'); await vi.advanceTimersByTimeAsync(500);
    expect(failed).toBe(1);
    expect(r.calls.at(-1).hands[0].to).toEqual({ x: 118, y: 70, z: -31 });
    await vi.advanceTimersByTimeAsync(500); expect(failed).toBe(1);
    await r.kill(); await promise;
  });

  it('does not mark a damaged takeoff retreat as done; tries another safe destination', async () => {
    vi.useFakeTimers(); const r = rig(); const promise = r.run('sword_stage');
    await vi.advanceTimersByTimeAsync(300);
    r.setHandler(async (hands: any[]) => hands[0]?.to?.x === 118 ? { ok: false, lines: ['被弾: 20 → 16'], ms: 10 } : undefined);
    r.d.approach.retreat.push({ x: 120.5, y: 70, z: -30.5 });
    r.d.phase = 4; r.d.windows.open = false; await vi.advanceTimersByTimeAsync(300);
    expect(r.calls.at(-1).hands[0].to).toEqual({ x: 120, y: 70, z: -31 });
    await r.kill(); await promise;
  });

  it('ends with a failed safety result when no retreat destination is found for 90 s, instead of waiting in danger', async () => {
    vi.useFakeTimers(); const r = rig(); const promise = r.run('sword_stage');
    await vi.advanceTimersByTimeAsync(300);
    r.setHandler(async (hands: any[]) => hands[0]?.do === 'go' ? { ok: false, lines: ['search_timeout'], ms: 5000 } : undefined);
    r.deps.approachClear.mockImplementation((_actor: any, _d: any, p: any) => p.x >= 118);
    r.d.phase = 0; r.d.windows.open = false; await vi.advanceTimersByTimeAsync(100_000);
    expect(await promise).toMatchObject({ endReason: 'retreat_failed', ok: false, deaths: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a non-finite bed damage estimate', async () => {
    vi.useFakeTimers(); const r = rig({ estimate: NaN }); const promise = r.run('bed');
    await vi.advanceTimersByTimeAsync(500);
    expect(r.calls.some((c: any) => c.hands[0]?.do === 'use')).toBe(false);
    await r.kill(); await promise;
  });

  it('stops at a body death, without counting the dropped pack as used beds/arrows', async () => {
    vi.useFakeTimers(); const r = rig(); const promise = r.run('bow');
    await vi.advanceTimersByTimeAsync(100); r.drop(); await r.die();
    const result = await promise;
    expect(result).toMatchObject({ endReason: 'actor_dead', deaths: 1, killSeconds: null, bedsUsed: 0, arrowsUsed: 0, ok: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a 5-second health series until the real 25-minute cap, preserves HP, and issues no later hands', async () => {
    vi.useFakeTimers(); const r = rig({ missingPlan: true }); const promise = r.run('sword_stage');
    setTimeout(() => { r.d.health = 149; }, 5200);
    await vi.advanceTimersByTimeAsync(1_500_000); const result = await promise;
    expect(result).toMatchObject({ endReason: 'time_limit', seconds: 1500, killSeconds: null, dragonHealthAt25Minutes: 149, ok: false });
    expect(result.healthTimeline.find((p: any) => p.seconds === 5).health).toBe(200);
    expect(result.healthTimeline.find((p: any) => p.seconds === 10).health).toBe(149);
    expect(result.healthTimeline.at(-1)).toMatchObject({ seconds: 1500, health: 149 });
    expect(r.calls).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an in-flight motor at the 25-minute cap', async () => {
    vi.useFakeTimers(); const r = rig(); r.d.phase = 0;
    let signal: AbortSignal | undefined;
    r.setHandler(async (_hands: any[], s?: AbortSignal) => { signal = s; return new Promise(resolve => s!.addEventListener('abort', () => resolve({ ok: false, lines: ['cancelled'], ms: 0 }), { once: true })); });
    const promise = r.run('bow'); await vi.advanceTimersByTimeAsync(1_500_000);
    expect(signal?.aborted).toBe(true); expect(await promise).toMatchObject({ endReason: 'time_limit', seconds: 1500, ok: false });
    expect(r.calls).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects proof for a previous dragon on the same connection', async () => {
    vi.useFakeTimers(); const r = rig({ proofId: 76 }); const promise = r.run('bow');
    await vi.advanceTimersByTimeAsync(100); await r.kill(); await vi.advanceTimersByTimeAsync(15_000);
    expect(await promise).toMatchObject({ bossVerified: false, ok: false });
  });

  it('counts evicted ledger entries and merged resident counters without exposing mutable totals', () => {
    const bot: any = { health: 20, shieldBlock: { raised: 0 } }, ledger = new ReflexLedger(bot, () => 1000);
    for (let i = 0; i < 25; i++) ledger.note('retreat', 'test');
    bot.shieldBlock.raised = 3; ledger.sample(); bot.shieldBlock.raised = 8; ledger.sample();
    expect(ledger.entriesSince(0)).toHaveLength(16);
    expect(ledger.counts()).toEqual({ retreat: 25, shield: 8 });
    ledger.counts().retreat = 0; expect(ledger.counts().retreat).toBe(25);
  });
});
