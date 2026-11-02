import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bedWallCells, perchBedFoot } from '../../src/services/minebot/utils/dragonBedGeometry.js';
import { isPerched, partBox } from '../../src/services/minebot/utils/dragonParts.js';
import { bedHalves } from '../../src/services/minebot/utils/bedRules.js';
import { ReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';

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
  actor.blockAt = (p: any) => blocks.get(`${p.x},${p.y},${p.z}`) ?? { name: 'air' };
  actor.inventory = { slots: [], items: () => [{ name: 'arrow', count: arrows }, { name: 'white_bed', count: beds }, { name: 'obsidian', count: obsidian },
    { name: 'cobblestone', count: 64 }, { name: 'cooked_beef', count: 64 }, { name: 'bow', count: 1 }] };
  ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'].forEach((name, i) => { actor.inventory.slots[5 + i] = { name }; });
  actor.inventory.slots[45] = { name: 'shield' }; actor.heldItem = { name: 'stone_sword' };
  actor.reflexLedger = new ReflexLedger(actor);
  const d: any = { id: 77, health, phase: 6, windows: { open: true }, position: { x: 100.5, y: 74, z: -30.5 }, yaw: Math.PI / 2,
    approach: { stage: [{ x: 113.5, y: 70, z: -30.5, strikeIndex: 1, toStrikeMeters: 2 }],
      strike: [{ x: 101.5, y: 70, z: -30.5 }, { x: 111.5, y: 70, z: -30.5 }], retreat: [{ x: 118.5, y: 70, z: -30.5 }] } };
  if (options.missingPlan) delete d.approach;
  const calls: any[] = [];
  let handler: ((hands: any[], signal?: AbortSignal) => Promise<any>) | undefined;
  const act = async (hands: any[], _seconds?: number, _extra?: any, signal?: AbortSignal) => {
    calls.push({ hands, signal, at: Date.now() });
    if (signal?.aborted) return { ok: false, lines: ['aborted'], parsed: null, ms: 0 };
    if (handler) { const value = await handler(hands, signal); if (value) return value; }
    for (const h of hands) {
      if (h.do === 'shoot') arrows--;
      if (h.do === 'place') {
        for (const p of h.at) blocks.set(`${p.x},${p.y},${p.z}`, h.block === 'white_bed'
          ? { name: 'white_bed', getProperties: () => ({ part: 'foot', facing: 'west' }) } : { name: h.block });
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
    context: { taskId: 'test', taskRevision: 1 }, Vec3, isPerched, partBox, perchBedFoot, bedWallCells, bedHalves,
    blastAt: vi.fn(() => ({ safe: true, expected: options.estimate ?? 4 })), act,
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    endView: () => ({ dragon: d }), trackMinHealth: () => ({ stop: () => actor.health }),
    dragonHealthServer: vi.fn(async () => d.health), evidence: vi.fn(async () => ({ boss: { verified: true, witness: { entityId: options.proofId ?? 77 } } })),
    prepareMock: vi.fn(async () => ({ dragonId: 77, ground: { x: 110.5, y: 70, z: -30.5 } })),
    END: 'execute in minecraft:the_end run', DRAGON: '@e[type=minecraft:ender_dragon,limit=1]', ACTOR: 'MinebotTrial',
    ask: vi.fn(async () => ''), protect: vi.fn(async () => {}), releaseReflex: vi.fn(), park: vi.fn(async () => {}),
    gear: vi.fn(async () => {}), wearIron: vi.fn(async () => {}), standAt: vi.fn(async () => {}), still: vi.fn(async () => {}),
  };
  const factory = new Function(...Object.keys(deps), `${compiled}\nconst actualPrepare = prepareKillRun; prepareKillRun = prepareMock; return { run: dragonKillRun, choose: chooseKillPlan, layout: killBedLayout, useBed: usePerchBed, actualPrepare, setArena(a) { killArena = a; }, die() { actorDeaths++; actor.health = 0; actor.emit('death'); } };`);
  const api = factory(...Object.values(deps));
  return { ...api, actor, d, calls, deps, blocks, setHandler: (fn: typeof handler) => { handler = fn; },
    reflect: () => { reflected = true; }, noExplosion: () => { explosion = false; },
    kill: async () => { d.health = 0; actor.emit('entityDead', { id: 77 }); await vi.advanceTimersByTimeAsync(250); },
    die: async () => { api.die(); await vi.advanceTimersByTimeAsync(250); },
    drop: () => { arrows = 0; beds = 0; } };
}

afterEach(() => { vi.useRealTimers(); });

describe('dragon kill comparison lab HEAD (mock motors, no server)', () => {
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
    await vi.advanceTimersByTimeAsync(20); await rejected;
  });

  it('uses the observed stage strikeIndex, and translates bed and screen geometry with the head', () => {
    const r = rig(), plan = r.choose(r.d);
    expect(plan.strike).toEqual(r.d.approach.strike[1]);
    const a = r.layout(r.d, plan);
    const shift = (p: any) => ({ ...p, x: p.x + 41, y: p.y + 9, z: p.z - 22 });
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
    const promise = r.run('sword_stage'); await vi.advanceTimersByTimeAsync(100);
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
