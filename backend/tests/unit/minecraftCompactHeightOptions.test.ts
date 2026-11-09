import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: {} }));
import { bedBodyBox, bedCanReplace, bedCellSupported, bedEyeReach, landingBedSelf, landingCompactStandSearch,
  landingProjectedRead, supportedBedCells, type BedSearch } from '../../src/services/minebot/utils/dragonBedGeometry.js';
import { boxesOverlap, type P3 } from '../../src/services/minebot/utils/dragonParts.js';
import { bedBurstWorld } from '../../src/services/minebot/utils/bedBurstRuntime.js';
import { probeBedsite } from '../../src/services/minebot/utils/probeBedsite.js';

const target = { x: .5, y: 74, z: .5 };
const solid = { name: 'bedrock', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
const air = { name: 'air', boundingBox: 'empty', shapes: [] };
const key = (p: P3) => `${p.x},${p.y},${p.z}`;
const union = (...groups: P3[][]) => [...new Map(groups.flat().map(p => [key(p), p])).values()];
const terrain = (p: P3) => p.y < target.y - 4 || (p.x === 0 && p.z === 0 && p.y < target.y) ? solid : air;
const history = [0, 3, 6, 9, 12, 15].map(tick => ({ tick, phase: 2, yaw: 0,
  position: { x: .5, y: 94, z: -39.5 + tick / 3 } }));
const drain = <T>(search: BedSearch<T>): T => { let r = search.next(); while (!r.done) r = search.next(); return r.value; };
const planFor = (read = terrain, budget = 12) => drain(landingCompactStandSearch(target, target, read, budget, 20, history))!;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('compact public options retain another existing height without selecting or firing it', () => {
  it('keeps a construction-eligible upper alternative that the old first-valid return discarded', () => {
    const plan = planFor(), lower = plan.options[0];
    expect(lower.head.y).toBe(73); expect(lower.stand.y).toBe(70);
    const head = { ...lower.head, y: 74 }, foot = { ...lower.foot, y: 74 };
    const base = union(plan.footing, plan.screen), projectedBase = landingProjectedRead(terrain, base);
    const tops = [head, foot].map(p => ({ ...p, y: p.y - 1 }));
    const extra = supportedBedCells(tops, projectedBase, 4)!;
    expect(extra).not.toBeNull();
    const construction = union(base, extra), built = landingProjectedRead(terrain, construction);
    expect(construction.length).toBeLessThanOrEqual(12);
    expect([head, foot].every(p => bedCanReplace(terrain(p)))).toBe(true);
    expect([head, foot, ...construction].every(p => bedEyeReach(plan.stand, p) <= 4.5)).toBe(true);
    for (let i = 0; i < extra.length; i++) expect(bedCellSupported(landingProjectedRead(projectedBase, extra.slice(0, i)), extra[i])).toBe(true);
    expect(construction.every(p => !boxesOverlap(bedBodyBox(plan.stand),
      { minX: p.x, maxX: p.x + 1, minY: p.y, maxY: p.y + 1, minZ: p.z, maxZ: p.z + 1 }))).toBe(true);
    expect(landingBedSelf(built, head, foot, plan.stand)).toMatchObject({ exposure: 0, expected: 1 });
    // These independent unchanged construction checks establish a real alternative on the same synthetic terrain.
    // They do not establish phase3 contact, dragon E/D, two timing windows, physical build or native survival.
    const upper = plan.options.find(p => p.head.y === target.y);
    expect(upper).toBeDefined();
    expect(upper!.stand).toEqual(lower.stand); expect(upper!.foot).toEqual(foot); expect(upper!.head).toEqual(head);
    expect(upper!.supports).toEqual(expect.arrayContaining(extra));
    expect(plan.screen.some(p => key(p) === key(lower.head) || key(p) === key(lower.foot))).toBe(false);
    expect(lower.supports.some(p => key(p) === key(lower.head) || key(p) === key(lower.foot))).toBe(false);
    expect(plan.options[0]).toEqual(lower);
  });

  it('keeps the lower-only option when the extra two supports exceed actual stock', () => {
    const full = planFor(), base = union(full.footing, full.screen);
    const small = planFor(terrain, base.length);
    expect(small.options).toHaveLength(1); expect(small.options[0]).toEqual(full.options[0]);
    expect(small.screen).toEqual(full.screen); expect(small.stand).toEqual(full.stand);
  });

  it('does not offer a higher bed in occupied cells or unread space', () => {
    for (const blocked of [solid, null]) {
      const read = (p: P3) => p.y === target.y ? blocked : terrain(p);
      const plan = planFor(read as any);
      expect(plan.options).toHaveLength(1); expect(plan.options[0].head.y).toBe(73);
    }
  });

  it('does not turn the old lower drop4 into a new upper drop5', () => {
    const deeper = (p: P3) => p.y < target.y - 5 || p.y === target.y - 3
      || (p.x === 0 && p.z === 0 && p.y < target.y) ? solid : air;
    const plan = planFor(deeper);
    expect(plan).not.toBeNull(); expect(plan.options[0].head.y - plan.stand.y).toBe(4);
    expect(plan.options).toHaveLength(1);
  });

  it('exposes both exact blueprints but marks only the actually built one prepared at phase3', async () => {
    vi.useFakeTimers();
    for (const selectedHeight of [73, 74]) {
      const client: any = new EventEmitter(), write = vi.fn(); client.write = write;
      const dragon = { id: 17, name: 'ender_dragon', position: new Vec3(.5, 94, -39.5), yaw: 0, metadata: { 16: 2 } };
      const bot: any = Object.assign(new EventEmitter(), { _client: client, entities: { 17: dragon },
        game: { dimension: 'the_end', minY: 0, height: 256 }, entity: { position: new Vec3(12.5, 70, .5) }, health: 20,
        inventory: { items: () => [{ name: 'obsidian', count: 12 }] }, blockAt: terrain });
      const world = bedBurstWorld(bot); world.dragon(17);
      const ticks = async (n: number) => { for (let i = 0; i < n; i++) {
        bot.emit('physicsTick'); if (world.tick() % 3 === 0) {
          dragon.position.z += 1; client.emit('sync_entity_position', { entityId: 17, yaw: 180, dx: 0, dy: 0, dz: 1 / 3 });
        }
        await vi.advanceTimersByTimeAsync(50);
      } };
      await ticks(18); const pending = probeBedsite(bot, '#17'); await ticks(29); const report: any = await pending;
      expect(report.options.map((p: any) => p.head.y)).toEqual([73, 74]);
      const selected = report.options.find((p: any) => p.head.y === selectedHeight);
      const unselected = report.options.find((p: any) => p.head.y !== selectedHeight);
      expect(report.assumptions).toContain('not_ready_to_fire');
      for (const option of report.options) expect(world.site(17, option.foot, option.head)?.readyAt).toBeNull();
      const construction = union(report.footing, report.screen, selected.supports);
      expect(construction.length).toBeLessThanOrEqual(12);
      bot.blockAt = landingProjectedRead(terrain, construction); bot.entity.position = new Vec3(report.stand.x, report.stand.y, report.stand.z);
      dragon.metadata[16] = 3; client.emit('entity_metadata', { entityId: 17, metadata: [{ key: 16, value: 3 }] });
      expect(world.site(17, selected.foot, selected.head)?.readyAt).not.toBeNull();
      expect(world.site(17, unselected.foot, unselected.head)?.readyAt).toBeNull();
      expect(write).not.toHaveBeenCalled(); world.stop();
    }
  });
});
