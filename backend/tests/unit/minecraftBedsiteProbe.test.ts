import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bedBurstWorld } from '../../src/services/minebot/utils/bedBurstRuntime.js';
import { probeBedsite } from '../../src/services/minebot/utils/probeBedsite.js';
import { runProbe, PROBE_KINDS } from '../../src/services/minebot/instantSkills/probe.js';
import { bedEyeReach, landingBedSelf, landingProjectedRead } from '../../src/services/minebot/utils/dragonBedGeometry.js';
import * as geometry from '../../src/services/minebot/utils/dragonBedGeometry.js';

const target = { x: .5, y: 74, z: .5 };
const solid = { name: 'bedrock', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
const air = { name: 'air', boundingBox: 'empty', shapes: [] };
function fixture(stock = 12, loaded = true) {
  const dragon = { id: 17, name: 'ender_dragon', position: new Vec3(.5, 94, -39.5), yaw: 0, metadata: { 16: 2 } };
  const client: any = new EventEmitter(); client.write = vi.fn();
  const read = (p: any) => !loaded ? null : p.y < 70 || (p.x === 0 && p.z === 0 && p.y < 74) ? solid : air;
  const bot: any = Object.assign(new EventEmitter(), { _client: client, game: { dimension: 'the_end', minY: 0, height: 256 },
    entities: { 17: dragon }, entity: { position: new Vec3(12.5, 70, .5) }, health: 20,
    inventory: { items: () => [{ name: 'obsidian', count: stock }] }, blockAt: read });
  const write = client.write, world = bedBurstWorld(bot); world.dragon(17);
  const tick = async (n = 1, observe = false) => { for (let i = 0; i < n; i++) {
    bot.emit('physicsTick'); if (observe && world.tick() % 3 === 0) {
      dragon.position.z += 1; client.emit('sync_entity_position', { entityId: 17, yaw: 180, dx: 0, dy: 0, dz: 1 / 3 });
    }
    await vi.advanceTimersByTimeAsync(50);
  } };
  return { bot, client, write, dragon, world, read, tick, stock: (value: number) => { stock = value; } };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('public read-only bedsite probe with real compact geometry', () => {
  it('enumerates present low transverse layouts within actual stock and keeps their full collision blueprint for this approach', async () => {
    vi.useFakeTimers(); const f = fixture();
    expect(PROBE_KINDS).toContain('bedsite');
    expect(await probeBedsite(f.bot, '#17')).toMatchObject({ ready: false, code: 'packet_history_pending' });
    await f.tick(18, true);
    const pending = runProbe(f.bot, { kind: 'bedsite', target: '#17' }); await f.tick(29);
    const reply = await pending, report = JSON.parse(reply.result);
    expect(report).toMatchObject({ kind: 'bedsite', ready: true, availableObsidian: 12 });
    expect(report.newObsidian).toBeLessThanOrEqual(12);
    expect(report.options[0].head.y).toBe(target.y - 1);
    expect(report.options[0].foot.z).toBe(report.options[0].head.z);
    expect(report.stand.y).toBe(target.y - 4);
    const option = report.options[0], cached = f.world.site(17, option.foot, option.head)!;
    expect(cached).not.toBeNull(); expect(cached.screen.length + cached.supports.length).toBeGreaterThan(0);
    const cells = [...report.footing, ...report.screen], built = landingProjectedRead(f.read, cells);
    expect(landingBedSelf(built, option.head, option.foot, report.stand).exposure).toBe(0);
    expect(cells.every((p: any) => bedEyeReach(report.stand, p) <= 4.5)).toBe(true);
    expect(f.write).not.toHaveBeenCalled();
    f.dragon.metadata[16] = 3; f.client.emit('entity_metadata', { entityId: 17, metadata: [{ key: 16, value: 3 }] });
    expect(f.world.site(17, option.foot, option.head)).not.toBeNull();
    expect(f.world.site(17, option.foot, option.head)?.readyAt).toBeNull(); // No construction/arrival occurred in this read-only fixture.
    f.dragon.metadata[16] = 0; f.client.emit('entity_metadata', { entityId: 17, metadata: [{ key: 16, value: 0 }] });
    f.dragon.metadata[16] = 2; f.client.emit('entity_metadata', { entityId: 17, metadata: [{ key: 16, value: 2 }] });
    expect(f.world.site(17, option.foot, option.head)).toBeNull(); f.world.stop();
  });
  it('does not invent unread support or extra obsidian and never moves the body', async () => {
    vi.useFakeTimers();
    for (const [stock, loaded] of [[0, true], [12, false]] as const) {
      const f = fixture(stock, loaded); await f.tick(18, true);
      const pending = probeBedsite(f.bot, '#17'); await f.tick(31); const report = await pending;
      expect(report).toMatchObject({ ready: false }); expect(f.write).not.toHaveBeenCalled(); f.world.stop();
    }
  });
  it('requires an exact target and current approach instead of choosing a dragon or waiting for a later landing', async () => {
    vi.useFakeTimers(); const f = fixture();
    expect(await probeBedsite(f.bot, 'ender_dragon')).toMatchObject({ code: 'exact_dragon_id_required' });
    f.dragon.metadata[16] = 3; expect(await probeBedsite(f.bot, '#17')).toMatchObject({ code: 'current_phase2_required' }); f.world.stop();
  });
  it('rechecks materials when stock is spent after a prior read and drops every cached site on a new life', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.tick(18, true); const first = probeBedsite(f.bot, '#17'); await f.tick(29);
    const report: any = await first; expect(report.ready).toBe(true); const option = report.options[0];
    f.stock(0); const second = probeBedsite(f.bot, '#17'); await f.tick(31); expect(await second).toMatchObject({ ready: false });
    f.bot.emit('respawn'); expect(f.world.site(17, option.foot, option.head)).toBeNull(); expect(f.write).not.toHaveBeenCalled(); f.world.stop();
  });
  it('reuses observed construction with zero stock while retaining its real collision cells and phase2 arrival receipt', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.tick(18, true); const first = probeBedsite(f.bot, '#17'); await f.tick(29);
    const before: any = await first, built = [...before.footing, ...before.screen];
    f.bot.blockAt = landingProjectedRead(f.read, built); f.stock(0);
    const second = probeBedsite(f.bot, '#17'); await f.tick(29); const after: any = await second;
    expect(after).toMatchObject({ ready: true, newObsidian: 0, availableObsidian: 0 });
    const option = after.options[0], cached = f.world.site(17, option.foot, option.head)!;
    expect(built.every((p: any) => cached.screen.some(c => c.x === p.x && c.y === p.y && c.z === p.z))).toBe(true);
    f.bot.entity.position = new Vec3(after.stand.x, after.stand.y, after.stand.z);
    f.dragon.metadata[16] = 3; f.client.emit('entity_metadata', { entityId: 17, metadata: [{ key: 16, value: 3 }] });
    expect(f.world.site(17, option.foot, option.head)?.readyAt).not.toBeNull(); expect(f.write).not.toHaveBeenCalled(); f.world.stop();
  });
  it('counts the legacy option-specific bed supports in addition to the shared canopy', async () => {
    vi.useFakeTimers(); const stand = { x: 3.5, y: 70, z: 3.5 }, foot = { x: 3, y: 73, z: 3 }, head = { x: 3, y: 73, z: 2 };
    const screen = [70, 71, 72].map(y => ({ x: 1, y, z: 1 }));
    const supports = [foot, head].map(p => ({ ...p, y: 72 }));
    const plan = { stand, staging: stand, footing: [], screen, options: [{ foot, head, stand, supports, screen,
      headDistance: 0, selfExposure: 0, headDamage: 0, score: 0 }] };
    for (const stock of [4, 5]) {
      const f = fixture(stock); await f.tick(18, true);
      // This test isolates the old solver's separate support reservation from material accounting at the public boundary.
      vi.spyOn(geometry, 'landingFountainStandSearch').mockImplementationOnce(function* () { return plan; });
      const pending = probeBedsite(f.bot, '#17'); await f.tick(); const report: any = await pending;
      if (stock === 4) expect(report).toMatchObject({ ready: false, code: 'materials_changed' });
      else { expect(report).toMatchObject({ ready: true, newObsidian: 5 }); expect(report.options[0].supports).toEqual(supports); }
      expect(f.write).not.toHaveBeenCalled(); f.world.stop();
    }
  });
});
