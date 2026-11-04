import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { z } from 'zod';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as geometry from '../../src/services/minebot/utils/dragonBedGeometry.js';
import * as headModel from '../../src/services/minebot/utils/dragonHeadModel.js';
import { partBox, boxDistance, boxesOverlap, inflate, isPerched, type P3 } from '../../src/services/minebot/utils/dragonParts.js';
import { dragonHazards } from '../../src/services/minebot/utils/dragonDanger.js';
import { bedHalves } from '../../src/services/minebot/utils/bedRules.js';
import { recordEndKnocks } from '../../src/services/minebot/utils/endKnockRecord.js';

const source = fs.readFileSync(new URL('../../scripts/minecraft-end-fight-probe.ts', import.meta.url), 'utf8');
const section = '// ' + source.split('// ===== end_bed_kill:')[1].split('// ===== end end_bed_kill =====')[0];
const compiled = ts.transpileModule(section, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const bedUseRefusal: (input: any) => string | null = new Function('scenes', compiled + '\nreturn bedUseRefusal;')({});
const bedSwordAllowed: (beds: number, unavailable: boolean) => boolean = new Function('scenes', compiled + '\nreturn bedSwordAllowed;')({});
const bedPlacementRefusal: (input: any) => string | null = new Function('scenes', compiled + '\nreturn bedPlacementRefusal;')({});
// Read the real schemas/range checker without importing the live body's service graph.
const actSource = fs.readFileSync(new URL('../../src/services/minebot/instantSkills/act.ts', import.meta.url), 'utf8');
const schema = actSource.slice(actSource.indexOf('const Pos ='), actSource.indexOf('export const ACT_STOP_IF'));
const ACT_HANDS = new Function('z', ts.transpileModule(schema.replace(/export /gu, ''), { compilerOptions: { module: ts.ModuleKind.None } }).outputText + '\nreturn ACT_HANDS;')(z);
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
const waitPlan: (anchor: P3 | null, here: P3, centre: P3 | null, fallback: P3[], read: geometry.BedBlockReader, clouds: geometry.BedCloud[]) =>
  { kind: 'recover' | 'return' | 'move'; to: P3 } | null = new Function('scenes', 'bedOpenWaitCells', 'chainDistance',
    compiled + '\nreturn bedWaitPlan;')({}, geometry.bedOpenWaitCells, (a: P3, b: P3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));

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

const valid = { phase: 7, now: 20, observed: 16, placed: 16, lastBlast: 9, used: 2, reach: 4.5, damage: 6, health: 20, headDamage: 55, headDistance: 1.5 };
describe('human operation and self-harm veto', () => {
  it('accepts the exact four-tick and eleven-tick boundaries', () => { expect(bedUseRefusal(valid)).toBeNull(); });
  it.each([
    [{ phase: 4 }, 'not_turned_seated'], [{ phase: 6 }, 'not_turned_seated'], [{ phase: 3 }, 'not_turned_seated'], [{ observed: 17 }, 'observation_delay'],
    [{ placed: 17 }, 'placement_delay'], [{ placed: null }, 'placement_delay'], [{ lastBlast: 10 }, 'dragon_hurt_cooldown'],
    [{ reach: 4.5001 }, 'out_of_reach'], [{ damage: 6.01 }, 'self_damage'], [{ health: 10 }, 'self_damage'],
    [{ damage: NaN }, 'estimate_unknown'], [{ used: 8 }, 'eight_bed_limit'], [{ headDistance: 2.2001 }, 'head_not_at_pillow'],
    [{ headDamage: 49 }, 'head_not_at_pillow'],
    [{ placed: NaN }, 'estimate_unknown'], [{ damage: -1 }, 'estimate_unknown'],
  ])('refuses %j', (change, reason) => { expect(bedUseRefusal({ ...valid, ...change })).toBe(reason); });
  it('permits phase 5 and the fourth bed, and only falls back to sword when beds are gone or placement is unavailable', () => {
    expect(bedUseRefusal({ ...valid, phase: 5, used: 3 })).toBeNull();
    expect(bedSwordAllowed(4, false)).toBe(false);
    expect(bedSwordAllowed(1, false)).toBe(false);
    expect(bedSwordAllowed(0, false)).toBe(true);
    expect(bedSwordAllowed(4, true)).toBe(true);
  });
});

describe('same-sit placement gate', () => {
  const next = { phase: 7, now: 50, startTick: 0, endTick: null, perch: 1, detonated: 1,
    previous: { perch: 1, detonationTick: 40 }, damage: 6, health: 20 };
  it('requires a prior confirmed blast for a repeat, accepting the same layout only afterwards', () => {
    expect(bedPlacementRefusal(next)).toBeNull();
    expect(bedPlacementRefusal({ ...next, previous: null, detonated: 0 })).toBeNull();
    for (const previous of [{ perch: 1, detonationTick: null }, { perch: 1, detonationTick: 50 }, { perch: 2, detonationTick: 40 }])
      expect(bedPlacementRefusal({ ...next, previous })).toBe('previous_blast_unconfirmed');
  });
  it.each([
    [{ damage: 6.001 }, 'self_damage'], [{ health: 10 }, 'self_damage'], [{ damage: NaN }, 'estimate_unknown'],
    [{ now: 240 }, 'seated_window_ended'], [{ endTick: 49 }, 'seated_window_ended'], [{ phase: 4 }, 'seated_window_ended'],
    [{ phase: 6 }, 'seated_window_ended'], [{ detonated: 3 }, 'three_bed_perch_limit'],
  ])('blocks another placement for %j', (change, reason) => expect(bedPlacementRefusal({ ...next, ...change })).toBe(reason));
});

function dangerBot(dragon: geometry.SeatedBedPose, read: geometry.BedBlockReader) {
  const position = new Vec3(dragon.position.x, dragon.position.y, dragon.position.z);
  return { game: { dimension: 'the_end' }, entity: { position }, blockAt: read,
    entities: { 77: { id: 77, name: 'ender_dragon', position, yaw: dragon.yaw, metadata: { 16: dragon.phase } } } as Record<number, any> };
}

describe('turned seated head and bed operation geometry', () => {
  it('checks head, neck and body voxels with a 0.15 m margin, and identifies each placement role', () => {
    const d = { position: p(103.5, 74, -39.5), yaw: 0, phase: 7 }, t = terrain();
    for (const part of ['head', 'neck', 'body'] as const) {
      const box = partBox(d, part);
      expect(geometry.bedCellInDragon(d, p(Math.floor(box.minX), Math.floor(box.minY), Math.floor(box.minZ)))).toBe(true);
    }
    const box = partBox(d, 'head'), outside = partBox(d, 'body');
    expect(geometry.bedCellInDragon(d, p(outside.maxX + 0.14, outside.minY, outside.minZ))).toBe(true);
    expect(geometry.bedCellInDragon(d, p(outside.maxX + 0.16, outside.minY, outside.minZ))).toBe(false);
    const safe = geometry.seatedBedLayouts(d, t.read, 4, 64)[0], hit = p(Math.floor(box.minX), box.minY, Math.floor(box.minZ));
    expect(geometry.bedLayoutDragonRefusal(d, safe)).toBeNull();
    expect(geometry.bedLayoutDragonRefusal(d, { ...safe, head: hit })).toBe('head_in_dragon');
    expect(geometry.bedLayoutDragonRefusal(d, { ...safe, foot: hit })).toBe('foot_in_dragon');
    expect(geometry.bedLayoutDragonRefusal(d, { ...safe, supportBlocks: [hit] })).toBe('support_in_dragon');
    expect(geometry.bedLayoutDragonRefusal(d, { ...safe, screen: [hit] })).toBe('screen_in_dragon');
    // A non-overlapping bed above the head still cannot have its support in the dragon.
    const body = partBox(d, 'body');
    expect(geometry.bedLayoutDragonRefusal(d, { ...safe, head: p(Math.floor(d.position.x), body.maxY + 1, Math.floor(d.position.z)), screen: [] })).toBe('support_in_dragon');
  });
  it('calls the unchanged reflex with candidate feet, including live clouds and fireball lines', () => {
    const d = { position: p(103.5, 74, -39.5), yaw: 0, phase: 7 }, t = terrain();
    const ordinary = geometry.seatedBedLayouts(d, t.read, 4, 64), feet = ordinary[0].stand;
    const bot = dangerBot(d, t.read), diag: Record<string, number> = {};
    bot.entities[90] = { id: 90, name: 'dragon_fireball', position: new Vec3(feet.x - 2, feet.y + 0.9, feet.z), velocity: p(0.5, 0, 0) };
    expect(dragonHazards(bot, { along: [feet] }).some(h => h.kind === 'fireball')).toBe(true);
    const filtered = geometry.seatedBedLayouts(d, t.read, 4, 64, 20, diag, bot);
    expect(diag.stand_in_reflex_zone).toBeGreaterThan(0);
    expect(filtered.some(l => key(l.stand) === key(feet))).toBe(false);
    for (const l of filtered) expect(dragonHazards(bot, { along: [l.stand] })).toEqual([]);
    expect(diag.candidates).toBe(diag.rejected + diag.expanded + diag.accepted);
    delete bot.entities[90];
    bot.entities[91] = { id: 91, name: 'area_effect_cloud', position: new Vec3(feet.x, feet.y, feet.z), metadata: { 8: 7, 10: 'dragon_breath' } };
    const cloudDiag: Record<string, number> = {};
    expect(geometry.seatedBedLayouts(d, t.read, 4, 64, 20, cloudDiag, bot).some(l => key(l.stand) === key(feet))).toBe(false);
    expect(cloudDiag.stand_in_reflex_zone).toBeGreaterThan(0);
  });
  it.each([p(103.5, 74, -39.5), p(-42.5, 69, 123.5)])('rejects the old level shelf candidates whose pillow overlaps a seated part at %j', position => {
    const d = { position, yaw: 0, phase: 7 }, floor = position.y - 2;
    const read = (v: P3) => v.y <= floor ? solid('end_stone') : air();
    const diag: Record<string, number> = {}, layouts = geometry.seatedBedLayouts(d, read, 4, 64, 20, diag);
    expect(layouts).toEqual([]); expect(diag.head_in_dragon).toBeGreaterThan(0);
  });
  it.each(['normal', 'unloaded', 'solid', 'budget', 'support', 'health'] as const)('accounts for every visited node and stage (%s)', mode => {
    const d = { position: p(103.5, 74, -39.5), yaw: 0, phase: 7 }, t = terrain(), diag: Record<string, number> = {};
    const read = mode === 'unloaded' ? () => null : mode === 'solid' ? () => solid() : t.read;
    const budget = mode === 'budget' ? 0 : 4, health = mode === 'health' ? 5 : 20;
    const cobblestone = mode === 'support' ? 0 : 64;
    const result = geometry.seatedBedLayouts(d, read, budget, cobblestone, health, diag);
    expect(result).toEqual(geometry.seatedBedLayouts(d, read, budget, cobblestone, health));
    expect(diag.head_candidates).toBe(125);
    expect(diag.candidates).toBe(diag.rejected + diag.expanded + diag.accepted);
    expect(diag.accepted).toBe(result.length);
    expect(diag.head_candidates).toBe(diag.head_not_air + diag.head_in_dragon + diag.head_far_or_weak + diag.head_passed);
    expect(diag.foot_candidates).toBe(diag.foot_not_air + diag.foot_in_dragon + diag.foot_passed);
    expect(diag.stand_candidates).toBe(diag.stand_not_open + diag.stand_no_floor + diag.stand_in_reflex_zone + diag.stand_not_clear + diag.stand_out_of_reach + diag.stand_passed);
    expect(diag.screen_candidates).toBe(diag.screen_unsupported + diag.screen_over_budget + diag.support_over_budget + diag.screen_conflict + diag.screen_out_of_reach
      + diag.support_in_dragon + diag.screen_in_dragon + diag.self_damage_too_high + diag.head_damage_low + diag.accepted);
    if (mode === 'budget') {
      expect(diag.screen_over_budget).toBeGreaterThan(0);
      expect(diag.screen_over_budget_required_min).toBeGreaterThan(0);
      expect(Object.entries(diag).filter(([k]) => /^screen_over_budget_required_\d+$/u.test(k)).reduce((n, [, count]) => n + count, 0)).toBe(diag.screen_over_budget);
    }
  });
  it.each([0, Math.PI / 2, Math.PI, -Math.PI / 2])('retains non-overlapping strong beds independent of the fountain at yaw %s', yaw => {
    const dragon = { position: p(103.5, 74, -39.5), yaw, phase: 7 };
    const t = terrain(), pose = headModel.seatedDragonHead(dragon)!;
    expect(pose.box).toEqual(partBox(dragon, 'head'));
    expect(pose.feet.y).toBe(73);
    expect(Math.hypot(pose.feet.x - dragon.position.x, pose.feet.z - dragon.position.z)).toBeCloseTo(6.5);
    const layouts = geometry.seatedBedLayouts(dragon, t.read, 4, 64);
    expect(layouts.length).toBeGreaterThan(0);
    const l = layouts[0];
    for (const layout of layouts) for (const cell of [layout.head, layout.foot, ...layout.supportBlocks, ...layout.screen]) {
      const box = { minX: cell.x, minY: cell.y, minZ: cell.z, maxX: cell.x + 1, maxY: cell.y + 1, maxZ: cell.z + 1 };
      for (const part of ['head', 'neck', 'body'] as const) expect(boxesOverlap(box, inflate(partBox(dragon, part), 0.15))).toBe(false);
    }
    expect(geometry.bedDamage(l.headDistance, 1)).toBeGreaterThanOrEqual(50);
    expect(l.headDamage).toBeGreaterThanOrEqual(50); expect(l.selfDamage).toBeLessThanOrEqual(6);
    expect(l.screen.length).toBeLessThanOrEqual(4);
    expect(Math.hypot(l.head.x + 0.5 - dragon.position.x, l.head.z + 0.5 - dragon.position.z)).toBeGreaterThan(4);
    expect(geometry.bedOperationClear(dragon, l.stand)).toBe(true);
    for (const cell of [...l.supportBlocks, ...l.screen, l.head, l.foot]) expect(geometry.bedEyeReach(l.stand, cell)).toBeLessThanOrEqual(4.5);
    const build = [...l.supportBlocks, ...l.screen].sort((a, b) => a.y - b.y);
    while (build.length) {
      const i = build.findIndex(cell => geometry.bedCellSupported(t.read, cell)); expect(i).toBeGreaterThanOrEqual(0);
      const cell = build.splice(i, 1)[0]; t.blocks.set(key(cell), solid(l.screen.includes(cell) ? 'obsidian' : 'cobblestone'));
    }
    expect(geometry.seatedBedLayouts(dragon, t.read, 0, 64).length).toBeGreaterThan(0);
    expect(geometry.seatedBedLayouts(dragon, () => null, 4, 64)).toEqual([]);
  });
  it('does not target scanning or flight, or trust a clear centre while the body intersects the cloud', () => {
    const d = { position: p(20, 74, -50), yaw: 0, phase: 7 };
    for (const phase of [2, 3, 6, 4]) {
      expect(headModel.seatedDragonHead({ ...d, phase })).toBeNull();
      expect(geometry.seatedBedLayouts({ ...d, phase }, terrain().read, 4, 64)).toEqual([]);
    }
    const cloud = headModel.seatedDragonHead(d)!.cloud;
    expect(geometry.bedOperationClear(d, p(cloud.x, 70, cloud.z - 5.2))).toBe(false);
    expect(geometry.bedOperationClear(d, p(cloud.x, 70, cloud.z - 7.4))).toBe(true);
    expect(geometry.bedOperationClear(d, p(cloud.x, 100, cloud.z - 5.2))).toBe(false);
    expect(geometry.bedOperationClear(d, p(cloud.x, 70, cloud.z - 5.4), [{ ...cloud, radius: 7 }])).toBe(false);
  });
  it('rejects insufficient support budget, unsafe health and occupied terrain', () => {
    const d = { position: p(103.5, 74, -39.5), yaw: 0, phase: 7 }, t = terrain();
    expect(geometry.seatedBedLayouts(d, t.read, 0, 64)).toEqual([]);
    expect(geometry.seatedBedLayouts(d, t.read, 4, 64, 5)).toEqual([]);
    expect(geometry.seatedBedLayouts(d, () => solid(), 4, 64)).toEqual([]);
    expect(headModel.seatedDragonHead({ ...d, yaw: NaN })).toBeNull();
  });
  it('budgets only wall voxels as obsidian, and requires a separate finite cobblestone budget', () => {
    const d = { position: p(103.5, 74, -39.5), yaw: 0, phase: 7 }, t = terrain();
    const layouts = geometry.seatedBedLayouts(d, t.read, 2, 64);
    expect(layouts.length).toBeGreaterThan(0);
    const l = layouts.find(l => l.supportBlocks.length > 0 && l.screen.length > 0)!;
    expect(l).toBeTruthy(); expect(l.screen.length).toBeLessThanOrEqual(2);
    expect(l.supportBlocks.every(s => !l.screen.some(w => key(w) === key(s)))).toBe(true);
    const same = (a: geometry.SeatedBedLayout) => key(a.head) === key(l.head) && key(a.foot) === key(l.foot)
      && key(a.stand) === key(l.stand) && a.screen.map(key).join('|') === l.screen.map(key).join('|');
    expect(geometry.seatedBedLayouts(d, t.read, l.screen.length, l.supportBlocks.length).some(same)).toBe(true);
    expect(geometry.seatedBedLayouts(d, t.read, l.screen.length - 1, 64).some(same)).toBe(false);
    const diag: Record<string, number> = {};
    expect(geometry.seatedBedLayouts(d, t.read, 2, l.supportBlocks.length - 1, 20, diag).some(same)).toBe(false);
    expect(diag.support_over_budget).toBeGreaterThan(0);
    expect(diag.candidates).toBe(diag.rejected + diag.expanded + diag.accepted);
    expect(geometry.seatedBedLayouts(d, t.read, 2, 0)).toEqual([]);
    for (const budget of [-1, NaN, Infinity, 1.5]) expect(geometry.seatedBedLayouts(d, t.read, 2, budget)).toEqual([]);
  });
  it('projects cobblestone supports and obsidian walls, while ignoring cheap support shielding for self damage', () => {
    const d = { position: p(103.5, 74, -39.5), yaw: 0, phase: 7 }, t = terrain();
    for (const l of geometry.seatedBedLayouts(d, t.read, 2, 64)) {
      const projected = (v: P3) => l.screen.some(c => key(c) === key(v)) ? solid('obsidian')
        : l.supportBlocks.some(c => key(c) === key(v)) ? solid('cobblestone') : t.read(v);
      const self = geometry.bedSelfEstimate(projected, l.head, l.foot, l.stand);
      expect(self.expected).toBe(l.selfDamage); expect(self.expected).toBeLessThanOrEqual(6);
      expect(self.expected + 4).toBeLessThan(20);
      const pose = headModel.seatedDragonHead(d)!;
      expect(geometry.bedDamage(l.headDistance, geometry.bedExposure(projected, geometry.bedCentre(l.head), pose.box, [l.head, l.foot]))).toBe(l.headDamage);
    }
    const head = p(0, 3, 0), foot = p(0, 3, -1), feet = p(0.5, 0, 3.5);
    const wall = (name: string) => (v: P3) => v.z === 1 && v.y >= 0 && v.y <= 3 ? solid(name) : air();
    const cheap = geometry.bedSelfEstimate(wall('cobblestone'), head, foot, feet);
    expect(cheap.expected).toBe(geometry.bedSelfEstimate(() => air(), head, foot, feet).expected);
    expect(cheap.expected).toBeGreaterThan(6);
    expect(geometry.bedSelfEstimate(wall('obsidian'), head, foot, feet).expected).toBe(1);
    expect(bedUseRefusal({ ...valid, damage: cheap.expected })).toBe('self_damage');
  });
  it('keeps a concrete four-block build within two obsidian plus two cobblestone', () => {
    const read = (v: P3) => v.y < 70 ? solid('end_stone') : air();
    const l = geometry.seatedBedLayouts({ position: p(103.5, 74, -39.5), yaw: 0, phase: 7 }, read, 2, 2)[0];
    expect(l.supportBlocks).toHaveLength(2); expect(l.screen).toHaveLength(2);
    expect(l.selfDamage).toBe(1); expect(l.headDamage).toBeGreaterThanOrEqual(50);
  });
  it('offers a different open natural footing for the next wait move and excludes roofs/unknown floor', () => {
    const t = terrain(), anchor = p(115.5, 70, -39.5);
    const cells = geometry.bedOpenWaitCells(anchor, anchor, t.read);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells[0]).not.toEqual(anchor);
    expect(geometry.bedOpenWaitCells(anchor, anchor, () => null)).toEqual([]);
    expect(geometry.bedOpenWaitCells(anchor, anchor, v => v.y === 73 ? solid() : t.read(v))).toEqual([]);
  });
  it('returns from eight metres, preserves the nearby shuffle, and chooses recovery before a sit from the outer island', () => {
    const t = terrain(), centre = t.perch, anchor = p(115.5, 70, -39.5);
    for (const here of [anchor, p(anchor.x + 3, 70, anchor.z), p(anchor.x + 7.99, 70, anchor.z)]) {
      expect(waitPlan(anchor, here, centre, [], t.read, [])).toEqual({ kind: 'move', to: geometry.bedOpenWaitCells(anchor, here, t.read)[0] });
    }
    const displaced = p(anchor.x + 8, 70, anchor.z);
    expect(geometry.bedOpenWaitCells(anchor, { ...displaced, x: displaced.x + 0.1 }, t.read)).toEqual([]);
    expect(waitPlan(anchor, displaced, centre, [], t.read, [])).toEqual({ kind: 'return', to: anchor });
    const far = p(centre.x + 25, 53, centre.z);
    expect(waitPlan(anchor, far, centre, [centre, anchor], t.read, [])).toEqual({ kind: 'recover', to: anchor });
    expect(waitPlan(null, displaced, centre, [centre, anchor], t.read, [])).toEqual({ kind: 'recover', to: anchor });
    expect(waitPlan(null, displaced, centre, [centre], t.read, [])).toBeNull(); // no portal destination
    expect(waitPlan(anchor, displaced, centre, [], () => null, [])).toBeNull();
    expect(waitPlan(anchor, displaced, centre, [], t.read, [{ ...anchor, radius: 50 }])).toBeNull();
  });
});

function rig(options: { explode?: boolean; proofId?: number; hurt?: boolean; limit?: number; damage?: number; headDelayMs?: number; beds?: number; obsidian?: number; cobblestone?: number; destroySupports?: boolean } = {}) {
  const t = terrain();
  const actor: any = new EventEmitter(); actor._client = new EventEmitter(); actor.health = 20; actor.food = 20;
  actor.game = { dimension: 'the_end' };
  actor.entity = { position: new Vec3(115.5, 70, -39.5) };
  let beds = options.beds ?? 4, obsidian = options.obsidian ?? 4, cobblestone = options.cobblestone ?? 64, uses = 0, disconnected: string | null = null;
  const d: any = { id: 77, name: 'ender_dragon', phase: 7, position: new Vec3(103.5, 74, -39.5), yaw: 0, health: 200,
    approach: { basin: [p(104.5, 70, -40.5)] } };
  d.metadata = { get 16() { return d.phase; } };
  const counts: Record<string, number> = {};
  const preempts: any[] = [], entries: any[] = [];
  actor.reflexLedger = { counts: () => ({ ...counts }), mark: () => preempts.length + entries.length,
    preemptsSince: (mark: number) => preempts.filter(e => e.seq > mark), entriesSince: (mark: number) => entries.filter(e => e.seq > mark) };
  actor.blockAt = (v: P3) => t.read(v);
  const calls: any[] = [], commands: string[] = [], scenes: Record<string, any> = {};
  let handler: ((hands: any[], signal: AbortSignal) => Promise<void | boolean>) | undefined;
  const clouds: any[] = [];
  actor.entities = { 77: d };
  const deps = { ...geometry, ...headModel, dragonEntity: () => d, Vec3, partBox, boxDistance, dragonHazards, isPerched, bedHalves, actor, actorDeaths: 0, disconnected, scenes, KILL_LIMIT_MS: options.limit ?? 10_000,
    trackEndKnocks: (tick: () => number, bedTrials: () => Array<{ detonationTick: number | null }>) => recordEndKnocks(actor, { enabled: false, tick, bedTrials, dragon: () => d, clouds: () => [] }),
    chainDistance: (a: P3, b: P3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
    killCell: (v: P3) => p(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)), killPlaced: new Map(), killBlasts: [],
    prepareKillRun: vi.fn(async () => ({ dragonId: 77, ground: { ...actor.entity.position } })),
    endView: () => ({ dragon: structuredClone(d), perch: t.perch, dragonBreath: clouds }),
    packCount: (name: string) => name === 'white_bed' ? beds : name === 'obsidian' ? obsidian : name === 'cobblestone' ? cobblestone : 64,
    trackMinHealth: () => { let min = actor.health; const f = () => { min = Math.min(min, actor.health); }; actor.on('health', f); return { stop: () => { actor.removeListener('health', f); return min; } }; },
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    dragonHealthServer: vi.fn(async () => d.health),
    evidence: vi.fn(async () => ({ boss: { verified: true, witness: { entityId: options.proofId ?? 77 } } })),
    basinWaitingCell: vi.fn((): P3 | null => p(115.5, 70, -39.5)),
    islandFootings: vi.fn(() => [p(115.5, 70, -39.5)]),
    ask: vi.fn(async (command: string) => { commands.push(command); return ''; }),
    act: async (hands: any[], _seconds: number, _extra: any, signal: AbortSignal) => {
      expect(ACT_HANDS.safeParse(hands).success).toBe(true);
      for (const hand of hands) if (hand.do === 'go') expect(goProblem(hand)).toBeNull();
      calls.push({ hands, at: Date.now(), signal });
      if (handler && await handler(hands, signal) === false) return { ok: false, lines: ['mock refused'], ms: 0 };
      if (signal.aborted) return { ok: false, lines: ['aborted'], ms: 0 };
      for (const hand of hands) {
        if (hand.do === 'go') actor.entity.position = new Vec3(hand.to.x + 0.5, hand.to.y, hand.to.z + 0.5);
        if (hand.do === 'place') {
          const cell = hand.at[0];
          if (hand.block === 'white_bed') {
            beds--;
            const vx = cell.x + 0.5 - actor.entity.position.x, vz = cell.z + 0.5 - actor.entity.position.z;
            const head = p(cell.x + (Math.abs(vx) > Math.abs(vz) ? Math.sign(vx) : 0), cell.y,
              cell.z + (Math.abs(vx) <= Math.abs(vz) ? Math.sign(vz) : 0));
            const facing = head.x < cell.x ? 'west' : head.x > cell.x ? 'east' : head.z < cell.z ? 'north' : 'south';
            for (const [part, v] of [['foot', cell], ['head', head]] as const) {
              if (part === 'head' && options.headDelayMs) await new Promise(resolve => setTimeout(resolve, options.headDelayMs));
              const block = { name: 'white_bed', position: v, getProperties: () => ({ part, facing }), shapes: [[0, 0, 0, 1, 0.5625, 1]] };
              t.blocks.set(key(v), block); actor.emit('blockUpdate', null, block);
            }
          } else {
            if (hand.block === 'cobblestone') cobblestone--; else obsidian--;
            t.blocks.set(key(cell), solid(hand.block));
          }
        }
        if (hand.do === 'use') {
          uses++;
          if (options.explode !== false) {
            const halves = bedHalves(t.read(hand.at[0]), hand.at[0])!;
            actor._client.emit('explosion', { center: geometry.bedCentre(halves.head) });
            t.blocks.delete(key(halves.foot)); t.blocks.delete(key(halves.head));
            if (options.destroySupports) for (const [k, block] of t.blocks) if (block.name === 'cobblestone') t.blocks.delete(k);
            d.health = Math.max(0, d.health - (options.damage ?? 45));
            if (options.hurt) { actor.health -= 2; actor.emit('health'); }
            if (d.health === 0) actor.emit('entityDead', { id: 77 });
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
  return { run, actor, d, deps, calls, commands, clouds, ...t, materials: () => ({ cobblestone, obsidian }), disconnect: api.disconnect, die: api.die, setHandler: (f: typeof handler) => { handler = f; }, counts, preempts, entries };
}

describe('end_bed_kill scene with mocked I/O', () => {
  it('places columns with cobblestone and walls with obsidian, consuming each inventory separately', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 4000, obsidian: 2 }), running = r.run();
    await vi.advanceTimersByTimeAsync(4600); const out = await running;
    const trial = out.bedTrials[0]; expect(trial).toBeTruthy();
    const supports = out.actions.filter((s: any) => s.label === 'place_cobblestone_support');
    const walls = out.actions.filter((s: any) => s.label === 'place_obsidian_screen');
    expect(supports.length).toBe(trial.supportBlocks.length); expect(supports.length).toBeGreaterThan(0);
    expect(walls.length).toBe(trial.screen.length); expect(walls.length).toBeGreaterThan(0);
    for (const s of supports) expect(s.hands[0]).toMatchObject({ do: 'place', block: 'cobblestone' });
    for (const s of walls) expect(s.hands[0]).toMatchObject({ do: 'place', block: 'obsidian' });
    expect(r.materials()).toEqual({ cobblestone: 64 - supports.length, obsidian: 2 - walls.length });
    expect(trial.supportsAtUse.some((s: any) => s.name === 'cobblestone')).toBe(true);
    expect(trial.screenAtUse.every((s: any) => s.name === 'obsidian')).toBe(true);
  });
  it('does not substitute obsidian for missing cobblestone', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 1500, cobblestone: 0, obsidian: 16 }), running = r.run();
    await vi.advanceTimersByTimeAsync(1800); const out = await running;
    expect(out.initial.cobblestone).toBe(0); expect(out.perches[0].layoutDiag.cobblestone).toBe(0);
    expect(out.perches[0].layoutDiag.diag.support_over_budget).toBeGreaterThan(0);
    expect(out.bedTrials).toEqual([]); expect(r.calls.some(c => c.hands[0]?.do === 'place')).toBe(false);
    expect(r.materials().obsidian).toBe(16);
  });
  it('rebuilds cheap supports after a blast without spending more obsidian on the surviving wall', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 10_000, destroySupports: true, obsidian: 2 }), running = r.run();
    await vi.advanceTimersByTimeAsync(10_500); const out = await running;
    expect(out.detonations).toBe(3);
    const first = out.bedTrials[0], second = out.bedTrials[1];
    expect(out.actions.some((s: any) => s.label === 'place_cobblestone_support' && s.tick > first.detonationTick && s.tick < second.placeRequestTick)).toBe(true);
    const walls = out.actions.filter((s: any) => s.label === 'place_obsidian_screen');
    expect(walls.length).toBe(first.screen.length); expect(r.materials().obsidian).toBe(2 - first.screen.length);
    expect(out.bedTrials.every((b: any) => b.prediction.self.expected <= 6 && b.prediction.self.expected + 4 < b.healthBefore)).toBe(true);
  });
  it.each(['foot_missing', 'head_missing', 'wrong_facing', 'neighbour_half', 'properties_unknown'] as const)('records both cells and expected facing when %s vetoes use before dispatch', async cause => {
    vi.useFakeTimers(); const r = rig({ limit: 3500 });
    r.setHandler(async hands => {
      if (hands[0]?.block !== 'white_bed') return;
      const cell = hands[0].at[0];
      setTimeout(() => {
        const halves = bedHalves(r.read(cell), cell)!;
        const target = cause === 'foot_missing' || cause === 'properties_unknown' ? halves.foot : halves.head;
        const before = r.read(target);
        const after = cause.endsWith('_missing') ? { ...air(), position: target }
        : { ...before, getProperties: () => cause === 'properties_unknown' ? {} : { part: cause === 'neighbour_half' ? 'foot' : 'head', facing: cause === 'wrong_facing' ? (halves.facing === 'west' ? 'east' : 'west') : halves.facing } };
        r.blocks.set(key(target), after); r.actor.emit('blockUpdate', before, after);
      }, 70);
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(4000); const out = await running;
    const place = out.perches[0].steps.find((s: any) => s.label === 'place_seated_head_bed');
    expect(place.bedHalvesDiag.after.matches).toBe(true);
    const use = out.perches[0].steps.find((s: any) => s.label === 'use_seated_head_bed');
    expect(use.ok).toBe(false); expect(use.tick).toBeUndefined(); // veto before act was dispatched
    const diag = use.bedHalvesDiag.checked;
    expect(diag.matches).toBe(false); expect(diag.expected).toEqual(place.bedHalvesDiag.after.expected);
    expect(diag.foot).toHaveProperty('name'); expect(diag.head).toHaveProperty('facing');
    if (cause === 'foot_missing') expect(diag.foot.name).toBe('air');
    if (cause === 'head_missing') expect(diag.head.name).toBe('air');
    if (cause === 'properties_unknown') expect(diag.foot.facing).toBeNull();
    expect(out.bedTrials[0].bedBlockUpdates.at(-1).after.name).toBe(diag[cause === 'foot_missing' || cause === 'properties_unknown' ? 'foot' : 'head'].name);
    expect(out.bedTrials[0].notDetonatedReason).toBe('bed_halves_missing_or_wrong_facing');
    expect(r.calls.some(c => c.hands[0]?.do === 'use')).toBe(false);
  });
  it('records stage counts, raw pose, material and 25 observed ground columns when geometry is empty', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 1000 });
    const head = headModel.seatedDragonHead(r.d)!.feet;
    for (let x = Math.floor(head.x) - 2; x <= Math.floor(head.x) + 2; x++)
      for (let z = Math.floor(head.z) - 2; z <= Math.floor(head.z) + 2; z++)
        for (let y = Math.floor(head.y) - 2; y <= Math.floor(head.y) + 2; y++) r.blocks.set(key(p(x, y, z)), solid('bedrock'));
    const running = r.run(); await vi.advanceTimersByTimeAsync(1100); const out = await running;
    const info = out.perches[0].layoutDiag;
    expect(info.diag.head_not_air).toBe(125); expect(info.diag.accepted).toBe(0);
    expect(info.diag.candidates).toBe(info.diag.rejected + info.diag.expanded + info.diag.accepted);
    expect(info.body.position).toEqual(r.d.position); expect(info.body.yaw).toBe(r.d.yaw);
    expect(info.seatedDragonHead).toEqual(headModel.seatedDragonHead(r.d));
    expect(info.obsidian).toBe(4); expect(info.clearNowRejected).toBe(0);
    expect(info.groundScan.columns).toHaveLength(25);
    expect(info.groundScan.columns.every((c: any) => c.y === Math.floor(head.y) + 2 && c.name === 'bedrock' && !c.unknownAbove)).toBe(true);
    expect(out.refusals.some((row: any) => row.reason === 'no_reachable_screened_head_layout')).toBe(true);
  });
  it('separates current-cloud rejections from geometry and caps diagnostics at the first twelve perches', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 16_000 });
    r.clouds.push({ x: r.perch.x, y: 70, z: r.perch.z, radius: 50 });
    const running = r.run();
    for (let n = 0; n < 14; n++) {
      r.d.phase = 7; await vi.advanceTimersByTimeAsync(600);
      r.d.phase = 6; await vi.advanceTimersByTimeAsync(400);
    }
    r.disconnect(); await vi.advanceTimersByTimeAsync(300); const out = await running;
    expect(out.perches).toHaveLength(14);
    expect(out.perches.filter((row: any) => row.layoutDiag)).toHaveLength(12);
    for (const row of out.perches.slice(0, 12)) {
      expect(row.layoutDiag.diag.accepted).toBeGreaterThan(0);
      expect(row.layoutDiag.clearNowRejected).toBe(row.layoutDiag.geometryCandidates);
    }
    expect(out.perches.slice(12).every((row: any) => !row.layoutDiag)).toBe(true);
  });
  it('includes the shared knock record on death and removes packet listeners', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 4000 }); r.actor.entity.id = 42;
    const promise = r.run(); await vi.advanceTimersByTimeAsync(100);
    r.actor._client.emit('entity_velocity', { entityId: 42, velocity: { x: 0, y: 1.5, z: 0 } });
    r.actor.entity.onGround = false; r.actor.entity.velocity = new Vec3(0, 1.5, 0); r.actor.entity.position.y = 90;
    await vi.advanceTimersByTimeAsync(50); r.die(); await vi.advanceTimersByTimeAsync(200);
    const out = await promise; expect(out.knocks).toHaveLength(1); expect(out.knocks[0].peak.position.y).toBe(90);
    expect(out.knocks[0].end.outcome).toBe('death'); expect(out.knockRecordErrors).toEqual([]);
    expect(r.actor._client.listenerCount('entity_velocity')).toBe(0); expect(r.actor.listenerCount('physicsTick')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('prepares HP 200, zero crystals, eight beds/sixteen obsidian/iron gear and a single natural-flight reset, with reflexes on', async () => {
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
    expect(gear.mock.calls[0][0]).toEqual(['iron_sword', 'water_bucket', 'shield', 'cobblestone 64', ...Array(8).fill('white_bed'), 'obsidian 16', 'cooked_beef 64']);
    expect(commands.filter(c => c.includes('DragonPhase'))).toEqual(['end data modify entity @dragon DragonPhase set value 0']);
    expect(commands).toContain('end kill @e[type=minecraft:end_crystal]');
    expect(commands).toContain('end data modify entity @dragon Health set value 200.0f');
    expect(protect.mock.calls.map(c => c[0])).toEqual([true, false]);
    expect(standAt).toHaveBeenCalledOnce(); expect(actor.floorReflexes).toBeTruthy();
    actor.floorReflexes = null; await expect(prepare(true, true)).rejects.toThrow('requires floor reflexes ON');
  });
  it('reuses the same layout for three confirmed blasts in one sit, then falls back to sword', async () => {
    vi.useFakeTimers(); const r = rig({ hurt: true }), running = r.run();
    await vi.advanceTimersByTimeAsync(10_000); const out = await running;
    expect(r.deps.prepareKillRun).toHaveBeenCalledWith(true, true);
    expect(out.ok).toBe(true); expect(out.bedsUsed).toBe(3); expect(out.placementAttempts).toBe(3); expect(out.explosionsHit).toBe(3); expect(out.detonations).toBe(3);
    expect(out.windows).toHaveLength(11); expect(out.minHealth).toBe(14); expect(out.bossVerified).toBe(true);
    expect(out.dragonDeadAt).toBeTruthy(); expect(out.killSeconds).toBeLessThan(10);
    for (const b of out.bedTrials) {
      expect(b.useTick - b.placedTick).toBeGreaterThanOrEqual(4);
      expect(b.prediction.tick - b.prediction.observedTick).toBeGreaterThanOrEqual(4);
      expect(b.dragonLoss).toBe(45); expect(b.selfDamage).toBe(2); expect(b.detonationTick).not.toBeNull();
      expect(b.prediction.self.expected).toBeLessThanOrEqual(6); expect(b.prediction.source).toBe('seated_body_position_yaw');
      expect(b.prediction.aheadTicks).toBeGreaterThanOrEqual(4);
      expect(b.phaseAtUse).toBe(7); expect(b.phaseAtPlace).toBe(7);
      expect(b.perch).toBe(1); expect(b.useTick).toBeLessThan(240);
    }
    for (let i = 1; i < out.bedTrials.length; i++) expect(out.bedTrials[i].useTick - out.bedTrials[i - 1].detonationTick).toBeGreaterThanOrEqual(11);
    for (const a of out.actions) {
      expect(a.tick - a.observedTick).toBeGreaterThanOrEqual(4);
      expect(a.seconds - a.observedSeconds).toBeGreaterThanOrEqual(0.1999);
      expect(ACT_HANDS.safeParse(a.hands).success).toBe(true);
      for (const h of a.hands) if (h.do === 'go') expect(goProblem(h)).toBeNull();
    }
    expect(out.phaseTimeline.length).toBeGreaterThan(10);
    expect(out.perches).toHaveLength(1); expect(out.perches[0].steps).toEqual(out.actions);
    expect(out.perches[0].bedsPlaced).toBe(3); expect(out.perches[0].bedsDetonated).toBe(3);
    expect(out.bedTrials.map((b: any) => b.n)).toEqual([1, 2, 3]);
    for (let i = 1; i < out.bedTrials.length; i++) {
      const before = out.bedTrials[i - 1], next = out.bedTrials[i];
      expect(next.head).toEqual(before.head); expect(next.foot).toEqual(before.foot); expect(next.stand).toEqual(before.stand);
      expect(next.plannedTick).toBeGreaterThan(before.detonationTick);
      expect(next.placementCheck.previousDetonationTick).toBe(before.detonationTick);
      expect(next.placementCheck.halves.every((h: any) => h.name === 'air')).toBe(true);
      expect(next.placementCheck.self.expected).toBeLessThanOrEqual(6);
      expect(next.placementCheck.self.expected + 4).toBeLessThan(next.placementCheck.health);
    }
    expect(out.windows.every((w: any) => w.reason === 'three_bed_perch_limit')).toBe(true);
    expect(r.commands).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
  it('uses raw seated body pose even with missing or misleading client head data', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 4000 });
    r.d.headPosition = p(-999, 999, -999);
    r.actor.entities[78] = { id: 78, name: 'ender_dragon_part', position: p(-999, 999, -999) };
    const running = r.run(); await vi.advanceTimersByTimeAsync(4600); const out = await running;
    const trial = out.bedTrials.find((b: any) => b.useRequested);
    expect(trial.prediction.source).toBe('seated_body_position_yaw');
    expect(trial.prediction.predictedHead).toEqual(p(103.5, 73.5, -33));
    for (const a of out.actions) expect(ACT_HANDS.safeParse(a.hands).success).toBe(true);
  });
  it('uses the eight-bed inventory across fresh sits without carrying a previous sit trial into a new one', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 12_000, beds: 8, obsidian: 16, damage: 10 });
    let used = 0;
    r.setHandler(async hands => {
      if (hands[0]?.do !== 'use' || ++used % 3 !== 0) return;
      setTimeout(() => { r.d.phase = 4; }, 10);
      setTimeout(() => { r.d.phase = 6; }, 300);
      setTimeout(() => { r.d.phase = 7; }, 600);
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(12_500); const out = await running;
    expect(out.initial.beds).toBe(8); expect(out.initial.obsidian).toBe(16); expect(out.bedsUsed).toBe(8);
    expect(out.perches.map((p: any) => p.bedsPlaced)).toEqual([3, 3, 2]);
    expect(out.perches.map((p: any) => p.bedsDetonated)).toEqual([3, 3, 2]);
    expect(out.bedTrials.map((b: any) => b.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const perch of out.perches) {
      const first = out.bedTrials.find((b: any) => b.perch === perch.n);
      expect(first.placementCheck.previousTrial).toBeNull();
    }
  });
  it.each(['health', 'screen', 'overlap', 'occupied', 'phase', 'timeout'] as const)('does not place a second bed after the first blast when %s changes', async cause => {
    vi.useFakeTimers(); const r = rig({ limit: cause === 'timeout' ? 14_000 : 4500, obsidian: cause === 'screen' ? 2 : 4 });
    let first = true;
    if (cause === 'timeout') {
      let held = false;
      r.deps.dragonHealthServer.mockImplementation(async () => {
        if (!first && !held) { held = true; await new Promise(resolve => setTimeout(resolve, 12_000)); }
        return r.d.health;
      });
    }
    r.setHandler(async hands => {
      if (hands[0]?.do !== 'use' || !first) return;
      first = false;
      // After the explosion packet and both air updates, before the next delayed placement.
      setTimeout(() => {
        if (cause === 'health') { r.actor.health = 5; r.actor.emit('health'); }
        if (cause === 'screen') for (const [k, block] of r.blocks) if (block.name === 'obsidian') r.blocks.delete(k);
        if (cause === 'overlap') r.d.position.y -= 1;
        if (cause === 'occupied') {
          const place = r.calls.find(c => c.hands[0]?.block === 'white_bed').hands[0].at[0];
          r.blocks.set(key(place), solid('end_stone'));
        }
        if (cause === 'phase') r.d.phase = 4;
      }, 10);
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(cause === 'timeout' ? 14_500 : 5000); const out = await running;
    expect(out.perches[0].bedsPlaced).toBe(1); expect(out.perches[0].bedsDetonated).toBe(1);
    expect(out.bedTrials).toHaveLength(1); expect(r.calls.filter(c => c.hands[0]?.block === 'white_bed')).toHaveLength(1);
    if (cause === 'health') expect(out.refusals.some((f: any) => f.reason === 'self_damage')).toBe(true);
    if (cause === 'overlap') expect(out.refusals.some((f: any) => /_in_dragon$/u.test(f.reason))).toBe(true);
    if (cause === 'occupied') expect(out.refusals.some((f: any) => f.reason === 'bed_cells_not_air')).toBe(true);
    if (cause === 'phase' || cause === 'timeout') expect(out.actions.some((a: any) => a.label === 'leave_on_takeoff')).toBe(true);
    if (cause === 'timeout') expect(out.perches[0].endTick - out.perches[0].startTick).toBe(240);
  });
  it.each(['reflex', 'observation'] as const)('records the first %s interruption of approach with stand distances and phase', async cause => {
    vi.useFakeTimers(); const r = rig({ limit: 1500 });
    let first = true;
    r.setHandler(async (hands, signal) => {
      if (!first || hands[0]?.do !== 'go') return;
      first = false;
      if (cause === 'reflex') {
        r.preempts.push({ seq: 1, at: Date.now(), by: '竜の息・火の玉・止まり木の体から離れる（エンド）', aborted: ['act', 'go'], ids: [] });
        r.entries.push({ seq: 2, at: Date.now(), kind: 'retreat', detail: '竜の頭の1マス内', outcome: 'done' });
      } else r.clouds.push({ ...hands[0].to, radius: 50 });
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(signal.aborted).toBe(cause === 'observation');
      return false;
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(1800); const out = await running;
    const row = out.perches[0].steps.find((s: any) => s.label === 'approach_turned_head');
    expect(row.ok).toBe(false); expect(row.interruption.phase).toBe(7); expect(row.interruption.standChanged).toBe(false);
    expect(row.interruption.stand).toEqual(row.approachObserved.stand);
    expect(row.interruption.tick).toBeLessThan(row.endTick);
    expect(row.interruption.standToDragon).toBe(Math.min(...Object.values(row.interruption.standToParts) as number[]));
    for (const part of ['head', 'neck', 'body'] as const) expect(row.interruption.standToParts[part]).toBeCloseTo(boxDistance(row.interruption.stand, partBox(r.d, part)));
    if (cause === 'reflex') {
      expect(row.interruption.reason).toBe(r.preempts[0].by); expect(row.reflexEntries[0].kind).toBe('retreat');
      expect(row.interruption.allowedFalseTick).toBeNull();
    } else {
      expect(row.cancelled).toBe('observation_changed'); expect(row.interruption.reason).toBe('observation_changed');
      expect(row.interruption.allowedFalseTick).toBe(row.interruption.tick);
    }
  });
  it('rechecks health after the second placement observation delay, before dispatching place', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 4500 });
    let first = true;
    r.setHandler(async hands => {
      if (hands[0]?.do !== 'use' || !first) return;
      first = false;
      setTimeout(() => { r.actor.health = 5; r.actor.emit('health'); }, 180);
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(5000); const out = await running;
    expect(out.bedTrials).toHaveLength(2);
    expect(out.bedTrials[1].placementCheck.reason).toBe('self_damage');
    expect(out.bedTrials[1].placementCheck.health).toBe(5);
    expect(out.bedTrials[1].placeRequestTick).toBeNull(); expect(out.bedTrials[1].placedTick).toBeNull();
    expect(r.calls.filter(c => c.hands[0]?.block === 'white_bed')).toHaveLength(1);
    expect(out.perches[0].bedsPlaced).toBe(1); expect(out.perches[0].bedsDetonated).toBe(1);
  });
  it('keeps approach interruption geometry if the go hand throws', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 1500 });
    r.setHandler(async () => { throw new Error('mock go interrupted'); });
    const running = r.run(); await vi.advanceTimersByTimeAsync(1800); const out = await running;
    const row = out.perches[0].steps[0];
    expect(out.endReason).toBe('script_error'); expect(row.label).toBe('approach_turned_head');
    expect(row.interruption.reason).toContain('mock go interrupted');
    expect(Number.isFinite(row.interruption.standToDragon)).toBe(true); expect(row.interruption.phase).toBe(7);
  });
  it('starts the four-tick placement delay only after the delayed SECOND half is confirmed', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 4000, headDelayMs: 250 });
    const running = r.run(); await vi.advanceTimersByTimeAsync(4600); const out = await running;
    const trial = out.bedTrials.find((b: any) => b.useRequested);
    expect(trial.placedTick - trial.placeRequestTick).toBeGreaterThanOrEqual(5);
    expect(trial.useTick - trial.placedTick).toBeGreaterThanOrEqual(4);
  });
  it('waits through descent/scanning and selects the NEW yaw at phase-7 start, continuing into phase 5', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 5000 }); r.d.phase = 2;
    const running = r.run(); await vi.advanceTimersByTimeAsync(500); r.d.phase = 3;
    await vi.advanceTimersByTimeAsync(500); r.d.phase = 6;
    await vi.advanceTimersByTimeAsync(500);
    expect(r.calls.some(c => c.hands.some((h: any) => h.do === 'use' || h.block === 'white_bed' || h.do === 'attack'))).toBe(false);
    r.d.yaw = Math.PI / 2; r.d.phase = 7;
    await vi.advanceTimersByTimeAsync(700); r.d.phase = 5;
    await vi.advanceTimersByTimeAsync(3000); const out = await running;
    expect(out.perches[0].head.centre).toEqual(p(110, 73.5, -39.5));
    const b = out.bedTrials.find((b: any) => b.useRequested);
    expect(b).toBeTruthy(); expect(b.phaseAtUse).toBe(5);
    expect(Math.abs(b.head.x + 0.5 - 110)).toBeLessThan(2);
  });
  it('vetoes a changed shield after placing a bed, records the reason, and never clicks it', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 4000 });
    r.setHandler(async hands => {
      if (hands[0]?.block === 'white_bed') setTimeout(() => {
        for (const [k, block] of r.blocks) if (block.name === 'obsidian') r.blocks.delete(k);
        r.actor.entity.position.y = 72;
      }, 70);
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(4600); const out = await running;
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
    vi.useFakeTimers(); const r = rig({ limit: 4500 });
    let readCount = 0;
    r.deps.dragonHealthServer.mockImplementation(async () => {
      if (++readCount === 2) {
        r.d.phase = 4;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      return r.d.health;
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(2800);
    expect(r.calls.filter(c => c.hands[0]?.do === 'go').length).toBeGreaterThanOrEqual(2);
    expect(r.calls.some(c => c.hands[0]?.do === 'use')).toBe(false);
    await vi.advanceTimersByTimeAsync(2000); const out = await running;
    expect(out.actions.find((a: any) => a.label === 'leave_on_takeoff')?.seconds).toBeLessThan(2.8);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('records an unconfirmed use separately from a confirmed blast and does not invent damage', async () => {
    vi.useFakeTimers(); const r = rig({ explode: false, limit: 4000 });
    const running = r.run(); await vi.advanceTimersByTimeAsync(4600); const out = await running;
    const trial = out.bedTrials[0];
    expect(trial.useTick).not.toBeNull(); expect(trial.detonationTick).toBeNull();
    expect(trial.notDetonatedReason).toBe('use_without_explosion_confirmation');
    expect(trial.dragonLoss).toBe(0); expect(out.explosionsHit).toBe(0); expect(out.ok).toBe(false);
    expect(out.detonations).toBe(0); expect(r.calls.filter(c => c.hands[0]?.do === 'use')).toHaveLength(1);
    expect(out.windows).toEqual([]);
  });
  it('uses sword on a perch where placement is impossible, records why, then retries beds at the next turned pose', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 6000 });
    let first = true;
    r.setHandler(async hands => {
      if (first && hands[0]?.block === 'white_bed') { first = false; return false; }
      if (hands.some(h => h.do === 'attack')) { r.d.phase = 4; setTimeout(() => { r.d.phase = 6; }, 300); setTimeout(() => { r.d.phase = 7; }, 700); }
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(6100); const out = await running;
    expect(out.bedTrials[0].notDetonatedReason).toBe('placement_failed_or_interrupted');
    expect(out.windows[0].reason).toBe('placement_failed_or_interrupted');
    expect(out.perches.length).toBeGreaterThanOrEqual(2);
    expect(out.bedTrials.some((b: any) => b.perch === 2 && b.useRequested)).toBe(true);
    expect(out.actions.filter((a: any) => a.label === 'iron_sword_head' && a.phase === 6)).toEqual([]);
  });
  it.each(['pose', 'cloud'] as const)('vetoes %s changes after placement without falling back to sword beside an unsafe bed', async cause => {
    vi.useFakeTimers(); const r = rig({ limit: 4000 });
    r.setHandler(async hands => {
      if (hands[0]?.block !== 'white_bed') return;
      setTimeout(() => {
        if (cause === 'pose') r.d.yaw += Math.PI / 4;
        else r.clouds.push({ ...r.actor.entity.position, radius: 7 });
      }, 90);
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(4600); const out = await running;
    expect(out.bedTrials[0].notDetonatedReason).toBe(cause === 'pose' ? 'seated_pose_changed' : 'breath_or_contact_at_operation');
    expect(r.calls.some(c => c.hands[0]?.do === 'use')).toBe(false);
    expect(out.windows).toEqual([]);
  });
  it('vetoes even a well-shielded blast when the latest HP would not leave more than four', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 4000 });
    r.setHandler(async hands => {
      if (hands[0]?.block === 'white_bed') setTimeout(() => { r.actor.health = 5; r.actor.emit('health'); }, 90);
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(4600); const out = await running;
    expect(out.bedTrials[0].notDetonatedReason).toBe('self_damage');
    expect(out.bedTrials[0].latestEstimate.self.shielded).toBeGreaterThan(0.75);
    expect(out.bedTrials[0].latestEstimate.self.expected).toBeLessThanOrEqual(6);
    expect(out.bedTrials[0].latestEstimate.self.expected + 4).toBeGreaterThanOrEqual(5);
    expect(r.calls.some(c => c.hands[0]?.do === 'use')).toBe(false); expect(out.windows).toEqual([]);
  });
  it('ends a delayed before-shot read at 240 ticks and retreats without waiting for telemetry or using sword', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 15_000 });
    let reads = 0;
    r.deps.dragonHealthServer.mockImplementation(async () => {
      if (++reads === 2) await new Promise(resolve => setTimeout(resolve, 12_000));
      return r.d.health;
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(12_500);
    expect(r.calls.some(c => c.hands[0]?.do === 'use')).toBe(false);
    expect(r.calls.at(-1).hands[0].do).toBe('go');
    await vi.advanceTimersByTimeAsync(3000); const out = await running;
    expect(out.perches[0].endTick - out.perches[0].startTick).toBe(240);
    expect(out.perches[0].endReason).toBe('twelve_second_limit'); expect(out.windows).toEqual([]);
    expect(out.actions.find((a: any) => a.label === 'leave_on_takeoff').tick).toBeLessThanOrEqual(246);
  });
  it('moves to a different open footing every three seconds during flight, with schema-valid go seconds', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 10_000 }); r.d.phase = 1;
    const running = r.run(); await vi.advanceTimersByTimeAsync(10_100); const out = await running;
    const moves = out.actions.filter((a: any) => a.label === 'open_wait');
    expect(moves.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < moves.length; i++) {
      expect(moves[i].tick - moves[i - 1].tick).toBeGreaterThanOrEqual(40);
      expect(moves[i].tick - moves[i - 1].tick).toBeLessThanOrEqual(80);
      expect(moves[i].hands[0].to).not.toEqual(moves[i - 1].hands[0].to);
    }
    for (const row of moves) { expect(ACT_HANDS.safeParse(row.hands).success).toBe(true); expect(goProblem(row.hands[0])).toBeNull(); }
    expect(out.anchorReturnAttempts).toBe(0);
  });
  it('walks back after displacement for longer than the shuffle deadline and samples distance during the hand', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 6500 }); r.d.phase = 1;
    r.actor.entity.position.x += 10;
    let returning = false;
    r.setHandler(async (hands, signal) => {
      if (hands[0]?.do === 'go' && hands[0].seconds === 60) {
        returning = true;
        await new Promise(resolve => setTimeout(resolve, 4500));
        expect(signal.aborted).toBe(false); // three seconds must not cut the return
      }
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(6600); const out = await running;
    expect(returning).toBe(true);
    const row = out.actions.find((a: any) => a.label === 'open_wait_return');
    expect(row.ok).toBe(true); expect(row.hands[0].to).toEqual(p(115, 70, -40));
    expect(row.hands[0].seconds).toBe(60); expect(goProblem(row.hands[0])).toBeNull();
    expect(out.anchorReturnAttempts).toBe(1); expect(out.anchorReturnFailures).toBe(0);
    expect(out.maxAnchorDistance).toBe(10); expect(out.anchorOver8Seconds).toBeCloseTo(5, 1);
    const during = out.anchorTimeline.filter((point: any) => point.seconds >= 1 && point.seconds < 4);
    expect(during).toHaveLength(3); expect(during.every((point: any) => point.distance === 10 && point.position.x === 125.5)).toBe(true);
    expect(out.anchorTimeline.at(-1).distance).toBeLessThan(8);
  });
  it.each(['return', 'recover', 'missing_anchor'] as const)('counts an interrupted %s and retains phase/reflex vetoes', async mode => {
    vi.useFakeTimers(); const r = rig({ limit: 1500 }); r.d.phase = 1;
    r.actor.entity.position.x += mode === 'recover' ? 30 : 10;
    r.d.approach.wait = [p(115.5, 70, -39.5)];
    if (mode === 'missing_anchor') r.deps.basinWaitingCell.mockReturnValue(null);
    r.setHandler(async (hands, signal) => {
      if (hands[0]?.do === 'go') {
        r.d.phase = 6; // next observation cancels it even though the return has a longer budget
        await new Promise(resolve => setTimeout(resolve, 200)); expect(signal.aborted).toBe(true);
        return false;
      }
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(1600); const out = await running;
    const label = mode === 'return' ? 'open_wait_return' : 'open_wait_recover';
    expect(out.actions[0].label).toBe(label);
    expect(out.actions[0].cancelled).toBe('observation_changed');
    expect(out.actions[0].hands[0].to).toEqual(p(115, 70, -40));
    expect(out.anchorReturnAttempts).toBe(1); expect(out.anchorReturnFailures).toBe(1);
    if (mode === 'missing_anchor') { expect(out.anchorMissingSeconds).toBeCloseTo(1.5, 1); expect(out.maxAnchorDistance).toBeNull(); }
    expect(r.commands).toEqual([]);
  });
  it('records a failed go that leaves the body outside the waiting area', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 1200 }); r.d.phase = 1; r.actor.entity.position.x += 10;
    r.setHandler(async () => false);
    const running = r.run(); await vi.advanceTimersByTimeAsync(1300); const out = await running;
    expect(out.anchorReturnAttempts).toBeGreaterThan(0); expect(out.anchorReturnFailures).toBe(out.anchorReturnAttempts);
    expect(out.anchorOver8Seconds).toBeCloseTo(1.2, 1); expect(out.maxAnchorDistance).toBe(10);
  });
  it('thins a long anchor timeline to at most 200 points while retaining all sampled distance statistics', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 405_000 }); r.d.phase = 1; r.actor.entity.position.x += 10;
    r.setHandler(async () => false);
    const running = r.run(); await vi.advanceTimersByTimeAsync(405_100); const out = await running;
    expect(out.anchorSamples).toBe(406); expect(out.anchorTimeline.length).toBeLessThanOrEqual(200);
    expect(out.anchorTimelineStrideSeconds).toBe(4);
    expect(out.anchorTimeline[0].seconds).toBe(0); expect(out.anchorTimeline.at(-1).seconds).toBeGreaterThanOrEqual(400);
    expect(out.maxAnchorDistance).toBe(10); expect(out.anchorOver8Seconds).toBeCloseTo(405, 1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels on early takeoff after one strong blast and replans the next seated window instead of continuing the old bed', async () => {
    vi.useFakeTimers(); const r = rig({ damage: 55, limit: 7000 });
    r.setHandler(async hands => {
      if (hands[0]?.do !== 'use') return;
      setTimeout(() => { r.d.phase = 4; }, 10);
      setTimeout(() => { r.d.phase = 6; }, 600);
      setTimeout(() => { r.d.phase = 7; }, 900);
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(7100); const out = await running;
    expect(out.detonations).toBeGreaterThanOrEqual(2);
    expect(new Set(out.bedTrials.filter((b: any) => b.useRequested).map((b: any) => b.perch)).size).toBe(out.detonations);
    expect(out.actions.some((a: any) => a.label === 'leave_on_takeoff')).toBe(true);
    expect(out.windows).toEqual([]);
    expect(out.bedTrials.filter((b: any) => b.useRequested).every((b: any) => b.dragonLoss === 55 || b.dragonHealthServerAfter === 0)).toBe(true);
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
