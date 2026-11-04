import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { EndermanCamp, endermanCampObservation } from '../../src/services/minebot/utils/huntEndermanCamp.js';
import { atRoofCentre } from '../../src/services/minebot/utils/huntEnderman.js';
import { removeRoofSupport } from '../../src/services/minebot/utils/huntEndermanSupport.js';
import { bodyReader } from '../../src/services/minebot/utils/localMap.js';
import { blockInSight, eyeOf } from '../../src/services/minebot/utils/probeTools.js';
import type { StepContext } from '../../src/services/minebot/utils/primitives/common.js';

vi.mock('../../src/services/minebot/utils/primitives/dig.js', () => ({ dig: vi.fn(async (ctx: StepContext, args: { at: Vec3[] }) => {
  expect(blockInSight(bodyReader(ctx.bot), eyeOf(ctx.bot.entity.position), args.at[0]).visible).toBe(true);
  const c = args.at[0];
  ctx.bot.fixtureBlocks[`${c.x},${c.y},${c.z}`] = 'air';
  return { ok: true, text: 'server-confirmed fixture removal' };
}) }));
vi.mock('../../src/services/minebot/utils/primitives/place.js', async importOriginal => ({
  ...await importOriginal<object>(), place: vi.fn(async (ctx: StepContext, args: { at: Vec3[]; block: string }) => {
    const c = args.at[0];
    ctx.bot.fixtureBlocks[`${c.x},${c.y},${c.z}`] = args.block;
    return { ok: true, text: 'fixture placement' };
  }),
}));
import { dig } from '../../src/services/minebot/utils/primitives/dig.js';

function fixture(extra: Record<string, string> = {}, roof = true) {
  const blocks = { ...extra }, controls: Record<string, boolean> = {}, looks: Vec3[] = [];
  const bot: any = {
    entity: { id: 1, position: new Vec3(0.5, 0, 0.5), onGround: true, yaw: 0 }, entities: {}, registry: {},
    gazeGuard: { enabled: true }, inventory: { slots: [], items: () => [{ name: 'cobblestone', count: 64 }] }, fixtureBlocks: blocks,
    blockAt: (p: Vec3) => {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      const name = blocks[`${x},${y},${z}`] ?? (y < 0 ? 'stone'
        : roof && y === 2 && Math.abs(x) <= 1 && Math.abs(z) <= 1 ? 'cobblestone' : 'air');
      return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' };
    },
    lookAt: vi.fn(async (p: Vec3) => { looks.push(p); }),
    setControlState: vi.fn((name: string, value: boolean) => {
      controls[name] = value;
      if (name === 'forward' && value && looks.length) {
        const p = bot.entity.position, to = looks.at(-1)!;
        const dx = to.x - p.x, dz = to.z - p.z, length = Math.hypot(dx, dz);
        if (length) { p.x += dx / length * Math.min(length, 0.04); p.z += dz / length * Math.min(length, 0.04); }
      }
    }),
  };
  const live = { id: 200, name: 'enderman', position: new Vec3(12.5, 0, 0.5), isValid: true };
  bot.entities[live.id] = live;
  const stop = new AbortController();
  const ctx: StepContext = { bot, stop: stop.signal, deadline: Date.now() + 14_000, base: { x: 0, y: 0, z: 0 }, facing: 'north' };
  return { bot, ctx, live, stop, blocks, controls };
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('EndermanCamp terrain-only exit', () => {
  it('actually stares at the same tree-hidden target from outside, then returns before fighting', async () => {
    const f = fixture({ '6,2,0': 'warped_stem' }), camp = new EndermanCamp(f.ctx, f.live), now = Date.now();
    try {
      expect((await camp.advance(f.live, now, 12, false)).kind).toBe('wait');
      const record = endermanCampObservation(f.bot)!;
      expect(record.latest?.eyes.between.some(b => b.name === 'warped_stem')).toBe(true);
      expect(record.latest?.eyes.between.some(b => b.at.y === 2 && Math.abs(b.at.x) <= 1)).toBe(false);
      expect(record.exits).toHaveLength(1);
      const to = record.exits[0].to;
      f.bot.entity.position = new Vec3(to.x + 0.5, to.y, to.z + 0.5);
      await camp.advance(f.live, now + 100, 12, false);
      expect(record.exits[0].result).toBe('staring');
      expect(f.bot.lookAt).toHaveBeenLastCalledWith(f.live.position.offset(0, 2.55, 0), true);
      await camp.advance(f.live, now + 600, 12, false);
      expect(record.exits[0]).toMatchObject({ result: 'returning', reason: 'stared' });
      f.bot.entity.position = new Vec3(0.5, 0, 0.5);
      expect((await camp.advance(f.live, now + 700, 12, true)).kind).toBe('fight');
      expect(record.exits[0].result).toBe('returned');
      expect(f.controls.forward).toBe(false);
    } finally { camp.release(); }
  });
});

describe('temporary roof support visibility', () => {
  it('removes both owned supports before allowing the first stare', async () => {
    const f = fixture({}, false), camp = new EndermanCamp(f.ctx, f.live);
    try {
      for (let i = 0; i < 15 && camp.phase === 'build'; i++) {
        expect((await camp.advance(f.live, Date.now(), 12, false)).kind).toBe('wait');
        expect(endermanCampObservation(f.bot)?.stareAt).toBeNull();
      }
      expect(camp.phase).toBe('provoke');
      expect(endermanCampObservation(f.bot)?.supportsRemoved).toBe(2);
      expect(dig).toHaveBeenCalledTimes(2);
    } finally { camp.release(); }
  });

  it('stops instead of fighting with owned supports still standing when the target becomes angry and close', async () => {
    const f = fixture({}, false), camp = new EndermanCamp(f.ctx, f.live);
    try {
      for (let i = 0; i < 11; i++) await camp.advance(f.live, Date.now(), 12, false);
      const result = await camp.advance(f.live, Date.now(), 2, true);
      expect(result.kind).toBe('stop');
      if (result.kind === 'stop') expect(result.outcome).toMatchObject({ code: 'roof_failed', reason: 'support_unsafe' });
      expect(endermanCampObservation(f.bot)?.supportsRemoved).toBe(0);
      expect(dig).not.toHaveBeenCalled();
    } finally { camp.release(); }
  });

  it('moves within the centre cell to see a corner support hidden by neighbouring head-height blocks', async () => {
    vi.useFakeTimers();
    const f = fixture({ '1,1,1': 'cobblestone', '1,0,1': 'cobblestone', '1,1,0': 'stone', '0,1,1': 'stone' });
    const support = { x: 1, y: 1, z: 1 };
    f.bot.entity.position = new Vec3(0.66, 0, 0.34);
    expect(blockInSight(bodyReader(f.bot), eyeOf(f.bot.entity.position), support).visible).toBe(false);
    const result = removeRoofSupport(f.ctx, { x: 0, y: 0, z: 0 }, support, f.live, f.ctx.deadline);
    await vi.runAllTimersAsync();
    expect((await result).ok).toBe(true);
    expect(dig).toHaveBeenCalledOnce();
    expect(f.bot.setControlState).toHaveBeenCalledWith('forward', true);
    expect(atRoofCentre(f.bot.entity.position, { x: 0, y: 0, z: 0 })).toBe(true);
    expect(f.controls).toMatchObject({ forward: false, sneak: false, jump: false, sprint: false });
  });

  it('does not move when the same support is already visible', async () => {
    const f = fixture({ '-1,1,0': 'cobblestone' });
    expect((await removeRoofSupport(f.ctx, { x: 0, y: 0, z: 0 }, { x: -1, y: 1, z: 0 }, f.live, f.ctx.deadline)).ok).toBe(true);
    expect(f.bot.setControlState).not.toHaveBeenCalledWith('forward', true);
  });

  it('rechecks non-hostility after turning and releases controls when the short correction cannot move', async () => {
    vi.useFakeTimers();
    const f = fixture({ '1,1,1': 'cobblestone', '1,0,1': 'cobblestone', '1,1,0': 'stone', '0,1,1': 'stone' });
    f.bot.entity.position = new Vec3(0.66, 0, 0.34);
    f.bot.setControlState.mockImplementation((name: string, value: boolean) => { f.controls[name] = value; });
    const pending = removeRoofSupport(f.ctx, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, f.live, f.ctx.deadline);
    await vi.runAllTimersAsync();
    expect((await pending).text).toContain('建築期限内に仮柱の見える位置へ寄れなかった');
    expect(dig).not.toHaveBeenCalled();
    expect(f.controls.forward).toBe(false);
    f.bot.lookAt.mockImplementation(async () => {
      f.bot.registry.entitiesByName = { enderman: { metadataKeys: ['creepy'] } };
      Object.assign(f.live, { metadata: [true] });
    });
    expect((await removeRoofSupport(f.ctx, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, f.live, f.ctx.deadline)).ok).toBe(false);
    expect(dig).not.toHaveBeenCalled();
    expect(f.controls.forward).toBe(false);
  });

  it('stops with the support, body position and roof blocker if no small protected shift can expose it', async () => {
    const f = fixture({ '0,3,0': 'cobblestone' });
    const result = await removeRoofSupport(f.ctx, { x: 0, y: 0, z: 0 }, { x: 0, y: 3, z: 0 }, f.live, f.ctx.deadline);
    expect(result.ok).toBe(false);
    expect(result.text).toContain('各軸±0.16mにも見える位置が無い');
    expect(result.text).toContain('(0,2,0) cobblestone');
    expect(result.text).toContain('足 (0.5,0,0.5)');
    expect(dig).not.toHaveBeenCalled();
    expect(f.controls.forward).toBe(false);
  });

  it.each(['airborne', 'pushed', 'cancelled', 'deadline', 'angry', 'changed', 'roof_lost'])('refuses unsafe support correction: %s', async cause => {
    const f = fixture({ '-1,1,0': 'cobblestone' });
    if (cause === 'airborne') f.bot.entity.onGround = false;
    if (cause === 'pushed') f.bot.entity.position.x = 0.8;
    if (cause === 'cancelled') f.stop.abort();
    if (cause === 'deadline') f.ctx.deadline = Date.now();
    if (cause === 'angry') {
      f.bot.registry.entitiesByName = { enderman: { metadataKeys: ['creepy'] } };
      Object.assign(f.live, { metadata: [true] });
    }
    if (cause === 'changed') f.blocks['-1,1,0'] = 'stone';
    if (cause === 'roof_lost') f.blocks['0,2,0'] = 'air';
    const result = await removeRoofSupport(f.ctx, { x: 0, y: 0, z: 0 }, { x: -1, y: 1, z: 0 }, f.live, f.ctx.deadline);
    expect(result.ok).toBe(false);
    expect(dig).not.toHaveBeenCalled();
    expect(f.controls.forward).toBe(false);
  });
});
