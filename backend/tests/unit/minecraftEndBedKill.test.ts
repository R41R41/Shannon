import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { z } from 'zod';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: {} }));
import * as geometry from '../../src/services/minebot/utils/dragonBedGeometry.js';
import * as burst from '../../src/services/minebot/utils/bedBurst.js';
import * as headModel from '../../src/services/minebot/utils/dragonHeadModel.js';
import * as landingModel from '../../src/services/minebot/utils/dragonLandingPath.js';
import { partBox, boxDistance, boxesOverlap, inflate, isPerched, type P3 } from '../../src/services/minebot/utils/dragonParts.js';
import { dragonHazards } from '../../src/services/minebot/utils/dragonDanger.js';
import { bedHalves } from '../../src/services/minebot/utils/bedRules.js';
import { knockGeometry, recordEndKnocks } from '../../src/services/minebot/utils/endKnockRecord.js';

const source = fs.readFileSync(new URL('../../scripts/minecraft-end-fight-probe.ts', import.meta.url), 'utf8');
const section = '// ' + source.split('// ===== end_bed_kill:')[1].split('// ===== end end_bed_kill =====')[0];
const compiled = ts.transpileModule(section, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const bedUseRefusal: (input: any) => string | null = new Function('scenes', compiled + '\nreturn bedUseRefusal;')({});
const bedSwordAllowed: (beds: number, unavailable: boolean) => boolean = new Function('scenes', compiled + '\nreturn bedSwordAllowed;')({});
const bedPlacementRefusal: (input: any) => string | null = new Function('scenes', compiled + '\nreturn bedPlacementRefusal;')({});
const bedLeaveReason: (input: any) => string | null = new Function('scenes', compiled + '\nreturn bedLeaveReason;')({});
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
    expect(diag.stand_candidates).toBe(diag.stand_not_open + diag.stand_no_floor + diag.stand_next_to_fire + diag.stand_in_reflex_zone + diag.stand_not_clear + diag.stand_out_of_reach + diag.stand_passed);
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

describe('takeoff evacuation destinations and time reserve', () => {
  it.each([0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 2])('selects farthest observed open ground beyond 14 m and the wing boxes (yaw %s)', yaw => {
    const body = { position: p(103.5, 72, -39.5), yaw, phase: 5 };
    const anchor = p(Math.floor(body.position.x + 12 * Math.cos(yaw)) + 0.5, 70, Math.floor(body.position.z - 12 * Math.sin(yaw)) + 0.5);
    const read = (v: P3) => v.y < 70 ? solid('end_stone') : air();
    const to = geometry.bedLeaveCell(body, [anchor], body.position, read)!;
    expect(to).toBeTruthy();
    const state = geometry.bedLeaveState(body, to);
    expect(state.bodyDistance).toBeGreaterThanOrEqual(14); expect(state.safe).toBe(true);
    expect(knockGeometry(to, body).parts.some(part => part.pushOverlap)).toBe(false);
    expect(dragonHazards({ game: { dimension: 'the_end' }, entity: { position: new Vec3(to.x, to.y, to.z) },
      entities: { 1: { name: 'ender_dragon', ...body, position: new Vec3(body.position.x, body.position.y, body.position.z), metadata: { 16: 5 } } }, blockAt: read }, { along: [to] })).toEqual([]);
    const candidates = [anchor, ...geometry.bedOpenWaitCells(anchor, anchor, read)];
    expect(state.bodyDistance).toBeCloseTo(Math.max(...candidates.map(at => geometry.bedLeaveState(body, at).bodyDistance)));
    expect(geometry.bedLeaveState(body, p(body.position.x + 8, 170, body.position.z)).safe).toBe(false);
  });
  it('rejects even the farther candidate inside a CURRENT wing push box', () => {
    const body = { position: p(103.5, 72, -39.5), yaw: 0, phase: 7 };
    const current = { ...body, position: p(110, 72, -39.5), phase: 4 };
    const side = p(119.5, 70, -39.5), behind = p(103.5, 70, -55.5);
    const read = (v: P3) => v.y < 70 ? solid('end_stone') : air();
    expect(geometry.bedLeaveState(body, side).safe).toBe(true);
    expect(geometry.bedLeaveState(body, side, current).wingPushOverlap).toBe(true);
    const to = geometry.bedLeaveCell(body, [side, behind], body.position, read, [], undefined, current)!;
    expect(to).not.toEqual(side); expect(geometry.bedLeaveState(body, to, current).safe).toBe(true);
    expect(knockGeometry(to, current).parts.some(part => part.pushOverlap)).toBe(false);
  });
  it('rejects unknown floors, roofs, and clouds instead of falling back to the old unsafe anchor', () => {
    const body = { position: p(103.5, 72, -39.5), yaw: 0, phase: 5 }, anchor = p(115.5, 70, -39.5);
    expect(geometry.bedLeaveCell(body, [anchor], anchor, () => null)).toBeNull();
    expect(geometry.bedLeaveCell(body, [anchor], anchor, v => v.y < 70 || v.y === 75 ? solid('end_stone') : air())).toBeNull();
    expect(geometry.bedLeaveCell(body, [anchor], anchor, v => v.y < 70 ? solid('end_stone') : air(), [{ ...anchor, radius: 50 }])).toBeNull();
  });
  it.each([0, 5, 14, 30, 1000])('allocates 10–20 seconds inside the actual go schema for %s metres', metres => {
    const seconds = geometry.bedLeaveSeconds(p(0, 0, 0), p(metres, 0, 0));
    expect(seconds).toBeGreaterThanOrEqual(10); expect(seconds).toBeLessThanOrEqual(20);
    const hand = { do: 'go', to: p(metres, 0, 0), range: 0.5, maxDrop: 1, seconds };
    expect(ACT_HANDS.safeParse([hand]).success).toBe(true); expect(goProblem(hand)).toBeNull();
  });
  const early = { now: 50, startTick: 0, endTick: null, phase: 7, phaseStart: 0, bedsPlaced: 2, bedsDetonated: 2, bedsRemaining: 6, pending: false, failedBed: false };
  it('permits an early third bed, but gives its construction/use time to the exit near either deadline', () => {
    expect(bedLeaveReason(early)).toBeNull();
    expect(bedLeaveReason({ ...early, now: 99 })).toBeNull();
    expect(bedLeaveReason({ ...early, now: 100 })).toBe('third_bed_exit_budget');
    expect(bedLeaveReason({ ...early, now: 60, phase: 5 })).toBe('third_bed_exit_budget');
    expect(bedLeaveReason({ ...early, bedsPlaced: 3, bedsDetonated: 3 })).toBe('three_bed_perch_limit');
    expect(bedLeaveReason({ ...early, bedsPlaced: 3, pending: true })).toBeNull();
    expect(bedLeaveReason({ ...early, bedsRemaining: 0 })).toBe('beds_exhausted');
    expect(bedLeaveReason({ ...early, pending: true, failedBed: true })).toBe('unusable_bed');
    expect(bedLeaveReason({ ...early, bedsPlaced: 0, now: 140 })).toBe('leave_time_reserve');
    expect(bedLeaveReason({ ...early, bedsPlaced: 0, phase: 5, now: 100 })).toBe('flame_midpoint');
  });
  it('uses carried damage rather than a three-bed counter in M2 and keeps the flame/time escape reserve', () => {
    expect(bedLeaveReason({ ...early, bedsPlaced: 4, bedsDetonated: 4, seatedDamage: 49 })).toBeNull();
    expect(bedLeaveReason({ ...early, seatedDamage: 50 })).toBeNull();
    expect(bedLeaveReason({ ...early, bedsPlaced: 1, bedsDetonated: 1, seatedDamage: 50.01 })).toBe('seated_damage_over_50');
    expect(bedLeaveReason({ ...early, seatedDamage: NaN })).toBe('seated_damage_unknown');
    expect(bedLeaveReason({ ...early, seatedDamage: 1, phase: 5, now: 100 })).toBe('flame_midpoint');
    expect(bedLeaveReason({ ...early, seatedDamage: 1, now: 140 })).toBe('leave_time_reserve');
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
  let handler: ((hands: any[], signal: AbortSignal) => Promise<void | boolean | { ok: boolean; lines: string[]; ms?: number }>) | undefined;
  const clouds: any[] = [];
  actor.entities = { 77: d };
  const deps = { ...geometry, ...headModel, ...burst, ...landingModel, boxesOverlap, dragonPhaseOf: (_bot: any, dragon: any) => dragon?.phase ?? null, hasActiveSafetyLease: () => false, activeActionCapabilities: () => [] as string[], knockGeometry, dragonEntity: () => d, Vec3, partBox, boxDistance, dragonHazards, isPerched, bedHalves, actor, actorDeaths: 0, disconnected, scenes, KILL_LIMIT_MS: options.limit ?? 10_000,
    END: 'execute in minecraft:the_end run',
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
      const reply = handler ? await handler(hands, signal) : undefined;
      if (reply === false) return { ok: false, lines: ['mock refused'], ms: 0 };
      if (reply && typeof reply === 'object') return { ms: 0, ...reply };
      if (signal.aborted) return { ok: false, lines: ['aborted'], ms: 0 };
      for (const hand of hands) {
        if (hand.do === 'equip') actor.heldItem = { name: hand.item };
        if (hand.do === 'go') actor.entity.position = new Vec3(hand.to.x + 0.5, hand.to.y, hand.to.z + 0.5);
        if (hand.do === 'dig') for (const cell of hand.at) t.blocks.set(key(cell), air());
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
  const run = async (keepCrystals = false, raw = false, phase3 = false) => { try { return await api.run(keepCrystals, raw, phase3); } finally { clearInterval(pump); } };
  const rawWrites: Array<{ name: string; data: any; at: number }> = [];
  const enableRaw = (wrongFacing = false) => {
    let serverYaw = 0;
    actor.look = async (yaw: number, pitch: number) => { actor.entity.yaw = yaw; actor.entity.pitch = pitch; };
    actor.setControlState = vi.fn();
    actor._client.write = (name: string, data: any) => {
      rawWrites.push({ name, data, at: Date.now() });
      if (name === 'look') serverYaw = data.yaw;
      if (name !== 'block_place') return;
      const yawAtWrite = serverYaw;
      setTimeout(() => {
        const existing = bedHalves(t.read(data.location), data.location);
        if (existing && options.explode !== false) {
          actor._client.emit('explosion', { center: geometry.bedCentre(existing.head) });
          t.blocks.delete(key(existing.foot)); t.blocks.delete(key(existing.head));
          d.health = Math.max(0, d.health - (options.damage ?? 45));
          actor._client.emit('entity_metadata', { entityId: 77, metadata: [{ key: 9, value: d.health }] });
          if (d.health === 0) actor.emit('entityDead', { id: 77 });
        } else if (data.cursorY === 1) {
          const cell = { ...data.location, y: data.location.y + 1 };
          const facing = ['south', 'west', 'north', 'east'][((Math.round(yawAtWrite / 90) + (wrongFacing ? 1 : 0)) % 4 + 4) % 4];
          const [dx, dz] = ({ north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] } as Record<string, number[]>)[facing];
          const pillow = { ...cell, x: cell.x + dx, z: cell.z + dz };
          for (const [part, v] of [['foot', cell], ['head', pillow]] as const) {
            const block = { name: 'white_bed', position: v, getProperties: () => ({ part, facing }), shapes: [[0, 0, 0, 1, 0.5625, 1]] };
            t.blocks.set(key(v), block); actor.emit('blockUpdate', null, block);
          }
          beds--; actor.heldItem = null;
        }
      }, 0);
    };
  };
  return { run, enableRaw, rawWrites, actor, d, deps, calls, commands, clouds, ...t, materials: () => ({ cobblestone, obsidian }), disconnect: api.disconnect, die: api.die, setHandler: (f: typeof handler) => { handler = f; }, counts, preempts, entries };
}

describe('bed fire geometry and approach decisions', () => {
  it.each(['fire', 'soul_fire'])('excludes all body-cell neighbours including upper/lower diagonals for %s', name => {
    const stand = p(103.5, 70, -39.5);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 2; dy++) {
      const fire = p(103 + dx, 70 + dy, -40 + dz);
      expect(geometry.bedStandFires(v => key(v) === key(fire) ? { name } : air(), stand)).toEqual([fire]);
    }
    expect(geometry.bedStandFires(() => null, stand)).toEqual([]);
    expect(geometry.bedStandFires(v => v.x === 105 ? { name } : air(), stand)).toEqual([]);
  });
  it('counts stand_next_to_fire, preserving other non-adjacent layouts and search accounting', () => {
    const d = { position: p(103.5, 74, -39.5), yaw: 0, phase: 7 }, t = terrain();
    const original = geometry.seatedBedLayouts(d, t.read, 4, 64), stand = original[0].stand;
    const fire = p(Math.floor(stand.x) - 1, stand.y + 1, Math.floor(stand.z) - 1);
    t.blocks.set(key(fire), { name: 'fire' });
    const diag: Record<string, number> = {}, next = geometry.seatedBedLayouts(d, t.read, 4, 64, 20, diag);
    expect(next.some(l => key(l.stand) === key(stand))).toBe(false);
    expect(diag.stand_next_to_fire).toBeGreaterThan(0);
    expect(diag.candidates).toBe(diag.rejected + diag.expanded + diag.accepted);
    expect(next.every(l => !geometry.bedStandFires(t.read, l.stand).length)).toBe(true);
  });
  it('allows fire by a bed/support/wall; a fire IN a placement cell is explicitly deferred for cleanup', () => {
    const d = { position: p(103.5, 74, -39.5), yaw: 0, phase: 7 }, t = terrain();
    const original = geometry.seatedBedLayouts(d, t.read, 4, 64);
    const l = original.find(l => [l.head, l.foot, ...l.supportBlocks, ...l.screen]
      .some(cell => !geometry.bedStandFires(v => key(v) === key(cell) ? { name: 'fire' } : air(), l.stand).length))!;
    const cell = [l.head, l.foot, ...l.supportBlocks, ...l.screen].find(cell =>
      !geometry.bedStandFires(v => key(v) === key(cell) ? { name: 'fire' } : air(), l.stand).length)!;
    t.blocks.set(key(cell), { name: 'soul_fire', shapes: [], boundingBox: 'empty' });
    const found = geometry.seatedBedLayouts(d, t.read, 4, 64).find(n => key(n.stand) === key(l.stand) && key(n.head) === key(l.head) && key(n.foot) === key(l.foot));
    expect(found).toBeTruthy(); expect(found!.fireToClear).toContainEqual(cell);
  });
  it('orders named blockers, stand neighbours and blast residue, deduplicating and ignoring non-fire', () => {
    const blocks = new Map<string, any>(), named = p(108, 70, -40), stand = p(103.5, 70, -39.5), neighbour = p(104, 70, -40), residue = p(100, 70, -40), far = p(150, 70, -40);
    for (const [cell, name] of [[named, 'soul_fire'], [neighbour, 'fire'], [residue, 'fire'], [far, 'fire']] as const) blocks.set(key(cell), { name });
    const read = (v: P3) => blocks.get(key(v)) ?? solid();
    expect(geometry.bedFireTargets(read, p(99, 70, -41), [named, named, p(109, 70, -40)], [stand, stand], geometry.bedCentre(residue)))
      .toEqual([named, neighbour, residue]);
    expect(geometry.bedFireTargets(read, stand, [], [], null)).toEqual([]);
  });
  it('does not reject a layout just because a bed or wall has a fire neighbour outside the stand neighbourhood', () => {
    const d = { position: p(103.5, 74, -39.5), yaw: 0, phase: 7 }, t = terrain();
    const layouts = geometry.seatedBedLayouts(d, t.read, 4, 64), l = layouts[0];
    const occupied = new Set([l.head, l.foot, ...l.supportBlocks, ...l.screen].map(key));
    const neighbours = [l.head, l.foot, ...l.screen].flatMap(cell => [p(cell.x + 1, cell.y, cell.z), p(cell.x, cell.y, cell.z + 1)]);
    const fire = neighbours.find(cell => !occupied.has(key(cell)) && t.read(cell).name === 'air'
      && !geometry.bedStandFires(v => key(v) === key(cell) ? { name: 'fire' } : air(), l.stand).length)!;
    expect(fire).toBeTruthy(); t.blocks.set(key(fire), { name: 'fire', boundingBox: 'empty', shapes: [] });
    expect(geometry.seatedBedLayouts(d, t.read, 4, 64).some(n => key(n.stand) === key(l.stand)
      && key(n.head) === key(l.head) && key(n.foot) === key(l.foot))).toBe(true);
  });
  it('counts identical stand/fire pairs independently and excludes on the second failure', () => {
    const history = new Map<string, geometry.BedFireFailure>(), stand = p(103.5, 70, -39.5), fire = p(104, 70, -40);
    geometry.bedRecordFireFailure(history, stand, fire);
    geometry.bedRecordFireFailure(history, stand, p(103, 70, -41));
    expect(geometry.bedFireStandExcluded(history.values(), stand)).toBe(false);
    expect(geometry.bedRecordFireFailure(history, stand, fire).count).toBe(2);
    expect(geometry.bedFireStandExcluded(history.values(), stand)).toBe(true);
    expect(geometry.bedFireStandExcluded(history.values(), p(103.5, 71, -39.5))).toBe(false);
    const lines = ['go 止まった unsafe: 行き先 (103,70,-40) はsoul_fire の隣。火 (104,70,-40) は dig で消せる'];
    expect(geometry.bedUnsafeFire(lines)).toEqual(fire);
    expect(geometry.bedUnsafeFire(['unsafe: lava。火 (104,70,-40) は dig'])).toBeNull();
    expect(geometry.bedUnsafeFire(['火 (104,70,-40) は dig で消せる'])).toBeNull();
  });
  it.each([['breath'], ['head'], ['neck'], ['body'], ['wing1'], ['wing2'], ['fireball']])('keeps the exact clearNow hazard %s separate from the tick limit', hazard => {
    const gate = geometry.bedApproachGate({ now: 99, startTick: 0, windowOpen: true, samePerch: true, clearHazards: [hazard] });
    expect(gate.allowed).toBe(false); expect(gate.tickLimitExceeded).toBe(false); expect(gate.clearNowFalse).toBe(true);
    expect(gate.clearHazards).toEqual([hazard]); expect(gate.causes).toEqual(['clear_now_false']);
    const both = geometry.bedApproachGate({ now: 100, startTick: 0, windowOpen: true, samePerch: true, clearHazards: [hazard] });
    expect(both.causes).toEqual(['approach_tick_limit', 'clear_now_false']);
  });
  it('classifies deadline-only and closed/changed windows, without inventing a danger', () => {
    expect(geometry.bedApproachGate({ now: 100, startTick: 0, windowOpen: true, samePerch: true, clearHazards: [] }))
      .toMatchObject({ allowed: false, tickLimitExceeded: true, clearNowFalse: false, causes: ['approach_tick_limit'] });
    expect(geometry.bedApproachGate({ now: 20, startTick: 0, windowOpen: false, samePerch: false, clearHazards: [] }).causes)
      .toEqual(['perch_changed', 'window_closed']);
  });
  it('reports observed breath, forecast breath and head/neck contacts using the unchanged clear predicate', () => {
    const d = { position: p(103.5, 74, -39.5), yaw: 0, phase: 7 }, t = terrain();
    const stand = geometry.seatedBedLayouts(d, t.read, 4, 64)[0].stand;
    expect(geometry.bedOperationHazards(d, stand, [{ ...stand, radius: 7 }])).toContain('breath');
    expect(geometry.bedOperationHazards(d, headModel.seatedDragonHead(d)!.cloud)).toContain('breath_forecast');
    const box = partBox(d, 'neck');
    expect(geometry.bedOperationHazards(d, p((box.minX + box.maxX) / 2, box.minY, (box.minZ + box.maxZ) / 2))).toContain('neck');
    expect(geometry.bedOperationClear(d, stand)).toBe(true);
  });
  it('chooses the next distinct clear stand, respecting exclusion and the pending bed pair', () => {
    const d = { position: p(103.5, 74, -39.5), yaw: 0, phase: 7 }, t = terrain(), here = p(115.5, 70, -39.5);
    const layouts = geometry.seatedBedLayouts(d, t.read, 4, 64), first = geometry.bedNextLayout(layouts, here, new Set(), () => true)!;
    const next = geometry.bedNextLayout(layouts, here, new Set([key(first.stand)]), () => true)!;
    expect(next).toBeTruthy(); expect(next.stand).not.toEqual(first.stand);
    expect(geometry.bedNextLayout(layouts, here, new Set(), () => false)).toBeNull();
    expect(geometry.bedNextLayout(layouts, here, new Set(), () => true, { head: p(0, 0, 0), foot: p(1, 0, 0) })).toBeNull();
    expect(geometry.bedApproachRetryTicks(next.stand, next.stand)).toBe(8);
  });
});

describe('end_bed_kill scene with mocked I/O', () => {
  it('switches to a distinct next stand when breath arrives during approach, within the unchanged deadline', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 2500 }); let first = true;
    r.setHandler(async (hands, signal) => {
      if (!first || hands[0]?.do !== 'go') return;
      first = false; const stand = p(hands[0].to.x + 0.5, hands[0].to.y, hands[0].to.z + 0.5);
      const layouts = geometry.seatedBedLayouts(r.d, r.read, 4, 64);
      const cloud = Array.from({ length: 32 }, (_, i) => ({ x: stand.x + 7 * Math.cos(i * Math.PI / 16), y: stand.y, z: stand.z + 7 * Math.sin(i * Math.PI / 16), radius: 7 }))
        .find(c => layouts.some(l => key(l.stand) !== key(stand) && geometry.bedOperationClear(r.d, l.stand, [c])))!;
      expect(cloud).toBeTruthy(); r.clouds.push(cloud);
      await new Promise(resolve => setTimeout(resolve, 150)); expect(signal.aborted).toBe(true); return false;
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(3000); const out = await running;
    const approaches = out.perches[0].steps.filter((s: any) => s.label === 'approach_turned_head');
    expect(approaches.length).toBeGreaterThanOrEqual(2);
    expect(approaches[0].interruption).toMatchObject({ tickLimitExceeded: false, clearNowFalse: true, clearHazards: ['breath'] });
    expect(approaches[1].hands[0].to).not.toEqual(approaches[0].hands[0].to);
    expect(out.perches[0].layoutSwitches[0]).toMatchObject({ trigger: 'breath', switched: true });
    expect(out.perches[0].approachTiming.attempts).toBe(approaches.length);
  });
  it('records the first deadline failure independently and never retries past 100 ticks', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 6500 }); let first = true;
    r.setHandler(async (hands, signal) => {
      if (!first || hands[0]?.do !== 'go') return;
      first = false; await new Promise(resolve => setTimeout(resolve, 5100)); expect(signal.aborted).toBe(true);
      return { ok: false, lines: ['aborted'], ms: 5100 };
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(7000); const out = await running;
    const approaches = out.perches[0].steps.filter((s: any) => s.label === 'approach_turned_head');
    expect(approaches).toHaveLength(1);
    expect(approaches[0].interruption).toMatchObject({ elapsedTicks: 100, tickLimitExceeded: true, clearNowFalse: false, causes: ['approach_tick_limit'] });
    expect(out.perches[0].approachTiming.ms).toEqual([5100]); expect(out.operationBudget.approachByTick).toBe(100);
  });
  it('declines a breath alternative when the remaining approach ticks cannot cover the walk', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 5500 }); let first = true;
    r.setHandler(async (hands, signal) => {
      if (!first || hands[0]?.do !== 'go') return;
      first = false;
      await new Promise(resolve => setTimeout(resolve, 4000));
      const stand = p(hands[0].to.x + 0.5, hands[0].to.y, hands[0].to.z + 0.5);
      const layouts = geometry.seatedBedLayouts(r.d, r.read, 4, 64);
      const cloud = Array.from({ length: 32 }, (_, i) => ({ x: stand.x + 7 * Math.cos(i * Math.PI / 16), y: stand.y, z: stand.z + 7 * Math.sin(i * Math.PI / 16), radius: 7 }))
        .find(c => layouts.some(l => key(l.stand) !== key(stand) && geometry.bedOperationClear(r.d, l.stand, [c])))!;
      r.clouds.push(cloud); await new Promise(resolve => setTimeout(resolve, 150)); expect(signal.aborted).toBe(true); return false;
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(6000); const out = await running;
    expect(out.perches[0].layoutSwitches[0]).toMatchObject({ trigger: 'breath', switched: false, reason: 'insufficient_approach_ticks' });
    expect(out.perches[0].steps.filter((s: any) => s.label === 'approach_turned_head')).toHaveLength(1);
  });
  it('defers a fire occupying a placement cell until a later wait, with no seated dig or placement', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 1200 });
    const first = geometry.bedNextLayout(geometry.seatedBedLayouts(r.d, r.read, 4, 64), r.actor.entity.position, new Set(), () => true)!;
    expect(geometry.bedStandFires(v => key(v) === key(first.head) ? { name: 'fire' } : air(), first.stand)).toEqual([]);
    r.blocks.set(key(first.head), { name: 'fire', boundingBox: 'empty', shapes: [] });
    const running = r.run(); await vi.advanceTimersByTimeAsync(1600); const out = await running;
    expect(out.refusals.some((f: any) => f.reason === 'placement_fire_requires_wait_cleanup')).toBe(true);
    expect(r.calls.some(c => c.hands.some((h: any) => h.do === 'dig' || h.do === 'place'))).toBe(false);
  });
  it('rechecks the reused layout for fire created by the confirmed blast before starting a repeat', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 4500 }); let planted = false;
    r.setHandler(async hands => {
      if (hands[0]?.do !== 'use' || planted) return;
      planted = true; const foot = bedHalves(r.read(hands[0].at[0]), hands[0].at[0])!.foot;
      r.actor._client.once('explosion', () => setTimeout(() => r.blocks.set(key(foot), { name: 'fire', boundingBox: 'empty', shapes: [] }), 60));
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(5000); const out = await running;
    expect(out.detonations).toBe(1);
    expect(out.refusals.some((f: any) => f.reason === 'placement_fire_requires_wait_cleanup')).toBe(true);
    expect(r.calls.filter(c => c.hands.some((h: any) => h.block === 'white_bed'))).toHaveLength(1);
    expect(r.calls.some(c => c.hands.some((h: any) => h.do === 'dig'))).toBe(false);
  });
  it('excludes a repeatedly refused stand on the second identical unsafe fire receipt and uses the next stand', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 2500 }); let failures = 0;
    r.setHandler(async hands => {
      if (hands[0]?.do !== 'go' || failures >= 2) return;
      failures++;
      return { ok: false, ms: 3, lines: ['go 止まった unsafe: 行き先 はfire の隣。火 (104,70,-40) は dig で消せる'] };
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(3000); const out = await running;
    const owner = out.perches[0], approaches = owner.steps.filter((s: any) => s.label === 'approach_turned_head');
    expect(owner.fire.unsafeFailures.map((f: any) => f.count)).toEqual([1, 2]);
    expect(owner.fire.excludedStands).toHaveLength(1);
    expect(approaches[1].hands[0].to).toEqual(approaches[0].hands[0].to);
    expect(approaches[2].hands[0].to).not.toEqual(approaches[0].hands[0].to);
  });
  it.each(['cleared', 'failed', 'unconfirmed', 'slow', 'phase_closed', 'hazard'] as const)('cleans blast fire only in waiting phases, bounded by four attempts/eight seconds (%s)', async mode => {
    vi.useFakeTimers(); const r = rig({ limit: 18_000 }); let planted = false;
    r.setHandler(async (hands, signal) => {
      const h = hands[0];
      if (h?.do === 'use' && !planted) {
        planted = true; const halves = bedHalves(r.read(h.at[0]), h.at[0])!;
        for (let i = -2; i <= 2; i++) r.blocks.set(key(p(halves.head.x + i, 70, halves.head.z + 4)), { name: i % 2 ? 'soul_fire' : 'fire', boundingBox: 'empty', shapes: [] });
        setTimeout(() => { r.d.phase = 0; }, 80);
        if (mode === 'cleared') setTimeout(() => { r.d.phase = 1; }, 9000); // same wait: the cap must not reset on a phase change
      }
      if (h?.do === 'dig') {
        expect(r.d.phase).toBe(0);
        if (mode === 'failed') return false;
        if (mode === 'unconfirmed') return { ok: true, ms: 0, lines: ['receipt without block update'] };
        if (mode === 'slow' || mode === 'phase_closed' || mode === 'hazard') {
          if (mode === 'phase_closed') setTimeout(() => { r.d.phase = 6; }, 100);
          if (mode === 'hazard') setTimeout(() => r.clouds.push({ ...r.actor.entity.position, radius: 50 }), 100);
          await new Promise(resolve => setTimeout(resolve, mode === 'slow' ? 8100 : 200));
          expect(signal.aborted).toBe(true); return false;
        }
      }
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(19_000); const out = await running;
    expect(planted).toBe(true); expect(out.fireWaits).toHaveLength(1);
    const batch = out.fireWaits[0], digs = out.actions.filter((a: any) => a.label === 'clear_waiting_fire');
    expect(batch.attempts.length).toBeLessThanOrEqual(4); expect(digs.length).toBeGreaterThan(0);
    expect(out.perches[0].fire.waits[0]).toBe(batch);
    expect(digs.every((d: any) => d.phase === 0)).toBe(true);
    if (mode === 'cleared') { expect(out.fireCleared).toBe(4); expect(batch.ms).toBeLessThanOrEqual(8000); }
    else { expect(out.fireCleared).toBe(0); expect(out.fireFailures).toBeGreaterThan(0); }
    if (mode === 'slow') { expect(digs).toHaveLength(1); expect(batch.endReason).toBe('time_limit'); }
    if (mode === 'phase_closed') expect(batch.endReason).toBe('wait_closed');
    if (mode === 'hazard') expect(batch.endReason).toBe('body_hazard');
  });
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
    r.actor.entity.position.x += 4; // evacuations can finish between these deliberately rapid mock sits
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
    commands.length = 0; await prepare(true, true, true); // end_bed_crystals: the crystals stay, everything else is the same
    expect(commands).not.toContain('end kill @e[type=minecraft:end_crystal]');
    expect(commands).toContain('end data modify entity @dragon Health set value 200.0f');
    actor.floorReflexes = null; await expect(prepare(true, true)).rejects.toThrow('requires floor reflexes ON');
  });
  it('reuses the same layout for three confirmed blasts, then evacuates without another attack', async () => {
    vi.useFakeTimers(); const r = rig({ hurt: true }), running = r.run();
    await vi.advanceTimersByTimeAsync(10_500); const out = await running;
    expect(r.deps.prepareKillRun).toHaveBeenCalledWith(true, true);
    expect(out.ok).toBe(false); expect(out.bedsUsed).toBe(3); expect(out.placementAttempts).toBe(3); expect(out.explosionsHit).toBe(3); expect(out.detonations).toBe(3);
    expect(out.windows).toEqual([]); expect(out.minHealth).toBe(14); expect(out.bossVerified).toBe(false);
    expect(out.killSeconds).toBeNull(); expect(out.dragonHealthEnd).toBe(65);
    expect(out.perches[0].leave.reason).toBe('three_bed_perch_limit');
    expect(out.perches[0].leave.goCount).toBe(1); expect(out.perches[0].leave.goResults[0].safe).toBe(true);
    expect(out.actions.at(-1).label).toBe('leave_on_takeoff');
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
    expect(out.perches[0].leave.startTick).toBeGreaterThanOrEqual(out.bedTrials[2].detonationTick);
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
    if (cause === 'timeout') expect(out.perches[0].endTick - out.perches[0].startTick).toBe(140);
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
    expect(row.interruption.contactGeometry.map((p: any) => p.part)).toEqual(['head', 'neck', 'body', 'wing1', 'wing2']);
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
  it('reissues evacuation after limit_time and a reflex stop, continuing throughout phase 4 until actual clearance', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 2500 }); let exits = 0, approach = true;
    r.setHandler(async (hands, signal) => {
      const hand = hands[0];
      if (approach) {
        approach = false; r.d.phase = 4;
        await new Promise(resolve => setTimeout(resolve, 100)); expect(signal.aborted).toBe(true); return false;
      }
      if (hand.do !== 'go' || hand.seconds < 10) return;
      if (++exits <= 2) return { ok: false, lines: [exits === 1 ? 'go stopped: limit_time; 13m remaining' : 'go stopped: reflex preempted'] };
      expect(signal.aborted).toBe(false);
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(2800); const out = await running;
    const leave = out.perches[0].leave;
    expect(leave.startPhase).toBe(4); expect(leave.goCount).toBe(3);
    expect(leave.goResults.map((row: any) => row.ok)).toEqual([false, false, true]);
    expect(leave.goResults[0].lines.join()).toContain('limit_time');
    expect(leave.goResults[1].lines.join()).toContain('reflex');
    expect(leave.goResults[2].bodyDistance).toBeGreaterThanOrEqual(14); expect(leave.goResults[2].wingPushOverlap).toBe(false);
    expect(leave.goResults[2].safe).toBe(true); expect(leave.safeTick).not.toBeNull();
    expect(leave.phase4.tick).toBe(out.transitions.find((t: any) => t.phase === 4).tick);
    expect(leave.phase4.bodyDistance).toBe(12); expect(out.leaveFailures).toBe(1);
    expect(out.actions.filter((a: any) => a.label === 'leave_on_takeoff')).toHaveLength(3);
    expect(out.actions.at(-1).label).toBe('leave_on_takeoff'); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not treat ok=true short of 14 m, or a thrown go, as successful evacuation', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 2500 }); let exits = 0;
    r.setHandler(async hands => {
      const hand = hands[0];
      if (hand.do === 'go' && hand.seconds === 5) { r.d.phase = 4; return false; }
      if (hand.do !== 'go' || hand.seconds < 10) return;
      if (++exits === 1) {
        r.actor.entity.position = new Vec3(r.d.position.x + 8, 70, r.d.position.z);
        return { ok: true, lines: ['mock arrived but still close'] };
      }
      if (exits === 2) throw new Error('mock route interrupted');
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(2800); const out = await running;
    const leave = out.perches[0].leave;
    expect(leave.goCount).toBe(3); expect(leave.goResults[0]).toMatchObject({ ok: true, safe: false, bodyDistance: 8 });
    expect(leave.goResults[1].error).toContain('mock route interrupted'); expect(leave.goResults[2].safe).toBe(true);
    expect(out.endReason).toBe('time_limit'); expect(vi.getTimerCount()).toBe(0);
  });
  it('leaves by the flame midpoint, holds its safe position until takeoff ends, and records phase-4 clearance once', async () => {
    vi.useFakeTimers(); const r = rig({ beds: 0, limit: 7500 });
    r.setHandler(async hands => { if (hands.some(h => h.do === 'attack')) return false; });
    const running = r.run(); await vi.advanceTimersByTimeAsync(100); r.d.phase = 5;
    await vi.advanceTimersByTimeAsync(5800); r.d.phase = 4;
    await vi.advanceTimersByTimeAsync(1900); const out = await running;
    const leave = out.perches[0].leave, flame = out.transitions.find((t: any) => t.phase === 5);
    expect(leave.reason).toBe('flame_midpoint'); expect(leave.startPhase).toBe(5);
    expect(leave.startTick - flame.tick).toBe(100); expect(leave.safeTick).toBeLessThan(leave.phase4.tick);
    expect(leave.phase4.bodyDistance).toBeGreaterThanOrEqual(14); expect(leave.phase4.wingPushOverlap).toBe(false);
    expect(out.leaveFailures).toBe(0); expect(leave.goCount).toBe(1);
    expect(out.actions.filter((a: any) => a.tick > leave.safeTick)).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
  it('gives the third bed time to evacuation while a slow after-blast health read is still pending', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 9000 }); let used = 0, readDone = false, held = false;
    r.setHandler(async hands => { if (hands[0]?.do === 'use') used++; });
    r.deps.dragonHealthServer.mockImplementation(async () => {
      if (used >= 2 && !held) { held = true; await new Promise(resolve => setTimeout(resolve, 4000)); readDone = true; }
      return r.d.health;
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(5400);
    expect(used).toBe(2); expect(readDone).toBe(false);
    expect(r.calls.some(c => c.hands[0]?.do === 'go' && c.hands[0].seconds >= 10)).toBe(true);
    await vi.advanceTimersByTimeAsync(4000); const out = await running;
    expect(out.perches[0].leave.reason).toBe('third_bed_exit_budget');
    expect(out.perches[0].leave.startTick - out.perches[0].startTick).toBe(100);
    expect(out.perches[0].bedsPlaced).toBe(2); expect(out.windows).toEqual([]);
  });
  it('still verifies a kill that occurs on the third confirmed blast', async () => {
    vi.useFakeTimers(); const r = rig({ damage: 70 }); const running = r.run();
    await vi.advanceTimersByTimeAsync(10_500); const out = await running;
    expect(out.ok).toBe(true); expect(out.bossVerified).toBe(true); expect(out.detonations).toBe(3);
    expect(out.dragonDeadAt).toBeTruthy(); expect(out.killSeconds).toBeLessThan(10);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('evacuates after the last carried bed instead of starting sword combat in that window', async () => {
    vi.useFakeTimers(); const r = rig({ beds: 1, limit: 4000 }); const running = r.run();
    await vi.advanceTimersByTimeAsync(4500); const out = await running;
    expect(out.perches[0].bedsDetonated).toBe(1); expect(out.perches[0].leave.reason).toBe('beds_exhausted');
    expect(out.perches[0].leave.goResults.at(-1).safe).toBe(true); expect(out.windows).toEqual([]);
  });
  it('records a phase-4 wing-box overlap and waits for an observed clear destination when clouds block all exits', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 2500 }); r.d.position.y = 72;
    r.actor.entity.position = new Vec3(r.d.position.x + 10.5, 70, r.d.position.z);
    r.clouds.push({ ...r.d.position, radius: 50 }); let first = true;
    r.setHandler(async () => { if (first) { first = false; r.d.phase = 4; return false; } });
    // No safe bed/basin exists under this cloud, so sample the takeoff independently.
    const running = r.run(); await vi.advanceTimersByTimeAsync(100); r.d.phase = 4;
    await vi.advanceTimersByTimeAsync(600);
    expect(r.calls.some(c => c.hands[0]?.seconds >= 10)).toBe(false);
    r.clouds.length = 0;
    await vi.advanceTimersByTimeAsync(2100); const out = await running;
    expect(out.perches[0].leave.phase4).toMatchObject({ bodyDistance: 10.5, wingPushOverlap: true, safe: false });
    expect(out.leaveFailures).toBe(1); expect(out.refusals.some((f: any) => f.reason === 'no_observed_retreat')).toBe(true);
    expect(out.perches[0].leave.goResults.at(-1).safe).toBe(true); expect(vi.getTimerCount()).toBe(0);
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
    const veto = out.actions.find((a: any) => a.label === 'use_seated_head_bed' && a.ok === false);
    expect(out.perches[0].leave.startTick - veto.endTick).toBeLessThanOrEqual(1);
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
  it('ends a delayed before-shot read with 100 ticks left and retreats without waiting for telemetry or using sword', async () => {
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
    expect(out.perches[0].endTick - out.perches[0].startTick).toBe(140);
    expect(out.perches[0].endReason).toBe('leave_time_reserve'); expect(out.windows).toEqual([]);
    expect(out.actions.find((a: any) => a.label === 'leave_on_takeoff').tick).toBeLessThanOrEqual(146);
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
    const entries = ['end_bed_kill', 'dragon_kill_bed', 'end_bed_crystals_raw', 'end_bed_kill_raw', 'end_bed_crystals_p3'];
    for (const wanted of [['end_bed_kill'], ['enter', 'end_bed_kill']]) expect(choose(wanted, entries, { errors: [] }, 0)).toBe(false);
    for (const wanted of [['enter', 'end_bed_kill', 'bed'], ['end_bed_kill', 'dragon_kill_bed']]) expect(choose(wanted, entries, { errors: [] }, 0)).toBe(true);
    for (const name of ['end_bed_kill_raw', 'end_bed_crystals_raw', 'end_bed_crystals_p3']) {
      expect(choose([name], entries, { errors: [] }, 0)).toBe(false);
      expect(choose(['enter', name], entries, { errors: [] }, 0)).toBe(false);
      expect(choose([name, 'bed'], entries, { errors: [] }, 0)).toBe(true);
    }
    expect(source).toContain("wanted.some(name => killEntries.includes(name)) ? path.join(worldDirectory, 'report.json')");
    expect(ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).diagnostics).toEqual([]);
  });
});

function landingRig(options: Parameters<typeof rig>[0] & { landingHeight?: number; packetEveryAfterEquip?: number; phase3DelayMs?: number } = {}) {
  const { landingHeight = 2, packetEveryAfterEquip = 3, phase3DelayMs = 150, ...rest } = options;
  const r = rig({ limit: 18_000, beds: 8, obsidian: 16, damage: 55, ...rest });
  r.deps.ask.mockResolvedValue('Test passed, count: 10');
  r.enableRaw(); r.actor.player = { ping: 0 }; r.d.phase = 2;
  r.d.position = new Vec3(r.perch.x, r.perch.y + 3, r.perch.z - 20);
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) r.blocks.set(key(p(Math.floor(r.perch.x) + dx, 69, Math.floor(r.perch.z) + dz)), solid('bedrock'));
  let ticks = 0, switched = false, equippedAt: number | null = null;
  const positions = () => {
    ticks++;
    if (r.actor.heldItem?.name === 'white_bed') equippedAt ??= ticks;
    const spacing = equippedAt !== null && ticks - equippedAt >= 6 ? packetEveryAfterEquip : 3;
    if (ticks % spacing === 0) r.actor._client.emit('rel_entity_move', { entityId: 77 });
  };
  r.actor.on('physicsTick', positions);
  r.setHandler(async hands => {
    if (!switched && hands.some(h => h.do === 'equip' && h.item === 'white_bed')) {
      switched = true;
      setTimeout(() => {
        r.d.phase = 3;
        r.d.position = new Vec3(r.perch.x, r.perch.y + landingHeight, r.perch.z - 6.5);
      }, phase3DelayMs);
    }
  });
  const run = async () => { try { return await r.run(true, true, true); } finally { r.actor.removeListener('physicsTick', positions); } };
  return { ...r, run };
}

describe('M2 raw observation adapter', () => {
  it('uses only real position updates, corrects float-degree sync yaw, retains lpVec3 velocity and removes every listener', () => {
    const observe = new Function('scenes', 'dragonPhaseOf', compiled + '\nreturn observeDragonLanding;')({}, (_bot: any, e: any) => e?.phase ?? null);
    let tick = 10;
    const d = { position: p(13, 77, -49), yaw: 7, phase: 3 }, bot = { _client: new EventEmitter(), entities: { 77: d } };
    const poses: any[] = [], health = vi.fn(), changed = vi.fn();
    const recorder = observe(bot, () => tick, 77, (s: any) => poses.push(s), health, changed);
    bot._client.emit('sync_entity_position', { entityId: 88, yaw: 90 }); expect(poses).toEqual([]);
    bot._client.emit('sync_entity_position', { entityId: 77, yaw: 270, dx: 0, dy: -0.1, dz: 0.2 });
    expect(poses[0]).toMatchObject({ tick: 10, yaw: -Math.PI / 2, velocity: { x: 0, y: -0.1, z: 0.2 } });
    tick = 11; bot._client.emit('entity_velocity', { entityId: 77, velocity: { x: 0, y: 0.33, z: 0.2 } });
    expect(poses[1]).toMatchObject({ tick: 10, velocityTick: 11, velocity: { y: 0.33 } }); // position time is unchanged
    tick = 13; d.position = p(13, 76.8, -48.4); bot._client.emit('rel_entity_move', { entityId: 77 });
    expect(poses.at(-1)).toMatchObject({ tick: 13, yaw: -Math.PI / 2, position: d.position });
    expect(poses.at(-1).velocity).toBeUndefined(); // no stale velocity reused as a fresh observation
    bot._client.emit('update_time', { age: 1000n });
    expect(recorder.evidence.timeAnchors[0]).toMatchObject({ tick: 13, age: '1000' });
    d.phase = 6; bot._client.emit('entity_metadata', { entityId: 77, metadata: [{ key: 9, value: 145 }, { key: 16, value: 6 }] });
    expect(health).toHaveBeenCalledWith(145, 6); expect(changed).toHaveBeenCalledTimes(1);
    bot._client.emit('rel_entity_move', { entityId: 77 }); expect(poses).toHaveLength(3);
    recorder.stop(); expect(bot._client.eventNames()).toEqual([]); expect(d.yaw).toBe(7);
  });
});

describe('M2 through the real probe loop with packet observations', () => {
  it('retains completed preparation through r245-style receipt-age-four gaps until the phase-3 entry', async () => {
    vi.useFakeTimers(); const r = landingRig({ packetEveryAfterEquip: 5, phase3DelayMs: 1500 });
    const running = r.run(); await vi.advanceTimersByTimeAsync(19_000); const out = await running;
    expect(out.error).toBeUndefined();
    expect(out.refusals.some((r: any) => r.reason === 'landing_prepared_waiting_for_packet')).toBe(true);
    expect(out.landing[0].readyBeforePhase3).toBe(true);
    expect(out.landing[0].readyTickAtEntry).toBe(out.landingPreparation[0].readyTick);
    expect(out.landing[0].readiness).toEqual({ completedInPhase2: true, beforeEntry: true, targetObserved: true, sameTarget: true, ready: true });
    expect(out.landing[0].shots.length).toBeGreaterThan(0);
    const ready = out.landingPreparation[0].readyTick;
    expect(out.actions.some((a: any) => a.label.startsWith('open_wait') && a.tick > ready && a.tick < out.landing[0].startTick)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a ping requiring more than the 1..3 tick firing horizon', async () => {
    vi.useFakeTimers(); const r = landingRig({ limit: 3000 }); r.actor.player.ping = 100;
    const running = r.run(); await vi.advanceTimersByTimeAsync(4000); const out = await running;
    expect(out.landing[0].readyBeforePhase3).toBe(true);
    expect(out.landing[0].shots).toEqual([]);
    expect(out.refusals.some((r: any) => r.reason === 'landing_latency_unknown_or_over_near_horizon')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('builds/equips in phase 2, lands four raw hits at detonation+10, records server HP and cleans up listeners', async () => {
    vi.useFakeTimers(); const r = landingRig();
    const running = r.run(); await vi.advanceTimersByTimeAsync(19_000); const out = await running;
    expect(out.error).toBeUndefined();
    expect(out.landingPreparation[0]?.reason).toBe('ready_in_phase2');
    expect(out.landing).toHaveLength(1);
    const l = out.landing[0];
    expect(l.readyBeforePhase3).toBe(true);
    expect(l.shots).toHaveLength(4);
    expect(l.shots.map((s: any) => s.phaseAtUse)).toEqual([3, 3, 3, 3]);
    expect(l.shots.every((s: any) => s.burst.placeToUseTicks === 0)).toBe(true);
    expect(l.shots.map((s: any) => s.serverDragonLoss)).toEqual([55, 55, 55, 35]);
    expect(l.shots.slice(1).map((s: any) => s.useTick - s.previousDetonationTick)).toEqual([10, 10, 10]);
    expect(l.shots.every((s: any) => s.prediction.self.exposure === 0)).toBe(true);
    expect(l.predictions.length).toBeGreaterThan(0); expect(l.errors.length).toBeGreaterThan(0);
    expect(l.pushExtendedLanding).toBeNull();
    expect(out.operationBudget.bedsPerPerch).toBeUndefined();
    expect(r.calls.flatMap(c => c.hands).some(h => h.do === 'attack')).toBe(false);
    expect(r.actor._client.listenerCount('rel_entity_move')).toBe(0);
    expect(r.actor._client.listenerCount('entity_metadata')).toBe(0);
    expect(out.bossVerified).toBe(true); expect(out.ok).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps a phase-3 arrival without completed phase-2 construction silent and leaves using the existing go', async () => {
    vi.useFakeTimers(); const r = landingRig({ limit: 2500 }); r.d.phase = 3;
    r.d.position = new Vec3(r.perch.x, r.perch.y + 2, r.perch.z - 6.5);
    r.actor.entity.position = new Vec3(r.perch.x + 2, r.perch.y - 4, r.perch.z);
    const running = r.run(); await vi.advanceTimersByTimeAsync(3000); const out = await running;
    expect(out.error).toBeUndefined(); expect(out.landing[0].readyBeforePhase3).toBe(false);
    expect(out.detonations).toBe(0); expect(r.rawWrites.some(w => w.name === 'block_place')).toBe(false);
    expect(out.actions.some((a: any) => a.label === 'leave_on_takeoff')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('selects five instead of four when the forecast plus error exceeds 2.07 m and keeps every +10 slot', async () => {
    vi.useFakeTimers(); const r = landingRig({ landingHeight: 2.5, damage: 42 });
    const running = r.run(); await vi.advanceTimersByTimeAsync(19_000); const out = await running;
    expect(out.error).toBeUndefined(); expect(out.landing[0].trainBeds).toBe(5);
    expect(out.landing[0].shots).toHaveLength(5);
    expect(out.landing[0].shots.slice(1).map((s: any) => s.useTick - s.previousDetonationTick)).toEqual([10, 10, 10, 10]);
    expect(out.ok).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['fire', 'reflex', 'phase6'] as const)('stops the landing train after its first hit on %s', async change => {
    vi.useFakeTimers(); const r = landingRig({ limit: 12_000 });
    let interrupted = false;
    r.actor._client.on('entity_metadata', (packet: any) => {
      if (interrupted || !packet.metadata?.some((m: any) => m.key === 9 && m.value < 200)) return;
      interrupted = true;
      if (change === 'fire') r.blocks.set(key(p(Math.floor(r.actor.entity.position.x) + 1, r.actor.entity.position.y, Math.floor(r.actor.entity.position.z))), { name: 'fire' });
      if (change === 'reflex') r.actor.floorReflexes = { busy: true };
      if (change === 'phase6') { r.d.phase = 6; r.actor._client.emit('entity_metadata', { entityId: 77, metadata: [{ key: 16, value: 6 }] }); }
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(13_000); const out = await running;
    expect(out.error).toBeUndefined(); expect(out.landing[0].shots).toHaveLength(1);
    expect(r.rawWrites.filter(w => w.name === 'block_place')).toHaveLength(2);
    if (change === 'phase6') {
      expect(out.transitions.some((p: any) => p.phase === 6)).toBe(true);
      expect(out.landing[0].nextPhase).toBe(6);
      expect(out.landing[0].shots[0].phase3RemainingTicks).toBeGreaterThanOrEqual(0);
      expect(out.landing[0].shots[0].burst.observationInterrupted).toBe('phase_metadata_changed');
      expect(out.seatedBudget).toEqual([]); // the phase-3 hit is not a seated hit just because HP arrived in phase 6
    }
    expect(vi.getTimerCount()).toBe(0);
  });
  it('refuses a server count other than ten without arming the landing recorder', async () => {
    vi.useFakeTimers(); const r = landingRig(); r.deps.ask.mockResolvedValue('Test passed, count: 9');
    await expect(r.run()).rejects.toThrow('ten_server_counted_crystals');
    expect(r.actor._client.listenerCount('rel_entity_move')).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('switches from landing to the seated cumulative budget through phase 6 -> 7', async () => {
    vi.useFakeTimers(); const r = landingRig({ limit: 13_000 }); let switched = false;
    r.actor._client.on('entity_metadata', (packet: any) => {
      if (switched || !packet.metadata?.some((m: any) => m.key === 9 && m.value < 200)) return;
      switched = true; r.d.phase = 6;
      r.actor._client.emit('entity_metadata', { entityId: 77, metadata: [{ key: 16, value: 6 }] });
      setTimeout(() => { r.d.phase = 7; r.actor._client.emit('entity_metadata', { entityId: 77, metadata: [{ key: 16, value: 7 }] }); }, 500);
    });
    const running = r.run(); await vi.advanceTimersByTimeAsync(14_000); const out = await running;
    expect(out.error).toBeUndefined(); expect(out.landing[0].shots).toHaveLength(1);
    expect(out.perches.some((p: any) => p.kind === 'seated' && p.plannedSeatedDamage)).toBe(true);
    expect(out.landing[0].nextPhase).toBe(6);
    expect(out.bedTrials.filter((t: any) => t.useRequested).every((t: any) => [3, 5, 7].includes(t.phaseAtUse))).toBe(true);
    expect(out.operationBudget.seatedDamageLimit).toBe(50); expect(out.operationBudget.bedsPerPerch).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('raw bed scenes through the actual endBedKill loop', () => {
  it.each([false, true])('uses synchronous raw pairs with detonation+10 repeats (keepCrystals=%s)', async keepCrystals => {
    vi.useFakeTimers(); const r = rig({ limit: 8000 }); r.enableRaw();
    const originalWrite = r.actor._client.write, before = r.actor._client.listenerCount('position');
    const running = r.run(keepCrystals, true); await vi.advanceTimersByTimeAsync(8500); const out = await running;
    expect(out.error).toBeUndefined();
    expect(r.deps.prepareKillRun).toHaveBeenCalledWith(...(keepCrystals ? [true, true, true] : [true, true]));
    expect(out.style).toBe(keepCrystals ? 'end_bed_crystals_raw' : 'end_bed_kill_raw');
    const trials = out.bedTrials.filter((t: any) => t.burst?.useTick !== null);
    expect(trials).toHaveLength(3);
    for (const t of trials) {
      expect(t.burst.classification).toMatchObject({ used: 'explosion_confirmed', orientation: 'confirmed', reasons: [] });
      expect(t.placeRequestTick).toBe(t.useTick); expect(t.burst.placeToUseTicks).toBe(0);
      expect(t.burst.sent.map((s: any) => s.stage)).toEqual(['unsneak', 'look', 'place', 'use']);
      expect(t.latestEstimate.self.expected).toBeLessThanOrEqual(6);
    }
    for (let i = 1; i < trials.length; i++) expect(trials[i].useTick - trials[i - 1].detonationTick).toBe(10);
    expect(out.orientationMismatches).toBe(0); expect(out.burstFailures).toEqual({});
    expect(r.calls.flatMap(c => c.hands).some(h => h.do === 'use' || h.block === 'white_bed')).toBe(false);
    expect(r.actor._client.write).toBe(originalWrite); expect(r.actor._client.listenerCount('position')).toBe(before);
  });
  it('counts wrong facing from block updates despite immediate explosion/removal, then leaves', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 6500 }); r.enableRaw(true);
    const running = r.run(false, true); await vi.advanceTimersByTimeAsync(7000); const out = await running;
    expect(out.error).toBeUndefined(); expect(out.orientationMismatches).toBe(1);
    expect(out.burstFailures.orientation_mismatch).toBe(1);
    expect(out.bedTrials).toHaveLength(1); expect(out.perches[0].leave.startTick).not.toBeNull();
  });
  it('classifies placement without explosion, refuses a repeat, and leaves the bed behind', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 6500, explode: false }); r.enableRaw();
    const running = r.run(false, true); await vi.advanceTimersByTimeAsync(7000); const out = await running;
    expect(out.error).toBeUndefined(); expect(out.bedTrials).toHaveLength(1);
    expect(out.burstFailures.use_without_explosion).toBe(1);
    expect(out.bedTrials[0].unusedBedLeft).toBe(true);
  });
  it('gives existing reflex/action owners all packet authority', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 6500 }); r.enableRaw();
    r.actor.floorReflexes = { busy: true };
    const running = r.run(false, true); await vi.advanceTimersByTimeAsync(7000); const out = await running;
    expect(out.error).toBeUndefined(); expect(r.rawWrites.filter(w => w.name === 'block_place')).toEqual([]);
    expect(out.burstFailures.reflex_or_action_owns_body).toBe(1);
  });
  it('does not change look if a reflex takes the body while equip is finishing', async () => {
    vi.useFakeTimers(); const r = rig({ limit: 6500 }); r.enableRaw(); const look = vi.spyOn(r.actor, 'look');
    r.setHandler(async hands => { if (hands.some(h => h.do === 'equip' && h.item === 'white_bed')) r.actor.floorReflexes = { busy: true }; });
    const running = r.run(false, true); await vi.advanceTimersByTimeAsync(7000); const out = await running;
    expect(look).not.toHaveBeenCalled(); expect(r.rawWrites.filter(w => w.name === 'block_place')).toEqual([]);
    expect(out.burstFailures.reflex_or_action_owns_body).toBe(1);
  });
  it.each(['low_health', 'screen_removed'])('rechecks the unchanged self-damage bounds at dispatch: %s', async change => {
    vi.useFakeTimers(); const r = rig({ limit: 6500 }); r.enableRaw();
    r.setHandler(async hands => {
      if (hands.some(h => h.do === 'equip' && h.item === 'white_bed')) {
        if (change === 'low_health') r.actor.health = 5; // self=1, +4 == health must refuse
        else for (const [cell, block] of r.blocks) if (block.name === 'obsidian') r.blocks.delete(cell);
      }
    });
    const running = r.run(false, true); await vi.advanceTimersByTimeAsync(7000); const out = await running;
    expect(out.error).toBeUndefined(); expect(r.rawWrites.filter(w => w.name === 'block_place')).toEqual([]);
    expect(out.burstFailures.self_damage).toBe(1);
  });
});
