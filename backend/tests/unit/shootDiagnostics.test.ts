import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchShootDiagnostics, noteShootDiagnostic, hasShootDiagnostics } from '../../src/services/minebot/utils/shootDiagnostics.js';
import { shoot } from '../../src/services/minebot/utils/primitives/shoot.js';
import { createMotorPort, executeAction } from '../../src/services/minebot/execution/ActionExecution.js';

afterEach(() => { vi.useRealTimers(); });
async function trial(observer?: (e: any) => void, unread = false) {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const bow = { name: 'bow', type: 1, count: 1 }, arrows = { name: 'arrow', count: 4 }, writes: any[] = [];
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(.5, 64, .5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true },
    entities: { 9: { id: 9, name: 'end_crystal', position: new Vec3(24.5, 72, .5), width: 2, height: 2 } },
    heldItem: bow, inventory: { items: () => [bow, arrows] }, game: { dimension: 'the_end' },
    blockAt: () => unread ? null : { name: 'air', boundingBox: 'empty', shapes: [] },
    look: async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; writes.push({ op: 'look', yaw, pitch, at: Date.now() }); },
    activateItem: () => writes.push({ op: 'draw', at: Date.now() }),
    deactivateItem: () => { arrows.count--; writes.push({ op: 'release', at: Date.now() }); },
  });
  const close = observer ? watchShootDiagnostics(bot, observer) : () => {};
  try {
    const work = shoot({ bot, stop: new AbortController().signal, deadline: 10_000, facing: 'north', base: { x: 0, y: 64, z: 0 } }, { target: 9 });
    await vi.runAllTimersAsync(); return { result: await work, writes, arrows: arrows.count };
  } finally { close(); }
}

describe('passive shooting notices', () => {
  it('never evaluates a snapshot without an active observer', () => {
    const bot = {}, detail = vi.fn(() => { throw Error('must not run'); }); noteShootDiagnostic(bot, detail);
    expect(detail).not.toHaveBeenCalled(); expect(hasShootDiagnostics(bot)).toBe(false);
  });
  it('isolates observer mutations, exceptions and throwing snapshot getters', () => {
    const bot = {}, seen: any[] = [];
    const a = watchShootDiagnostics(bot, row => { (row.value as any).x = 99; throw Error('observer'); });
    const b = watchShootDiagnostics(bot, row => seen.push(row));
    const original = { stage: 'x', value: { x: 1 } }; noteShootDiagnostic(bot, () => original);
    expect(original.value.x).toBe(1); expect(seen[0].value.x).toBe(1);
    expect(() => noteShootDiagnostic(bot, () => Object.defineProperty({ stage: 'x' }, 'value', { enumerable: true, get() { throw Error('getter'); } }))).not.toThrow();
    a(); b(); expect(hasShootDiagnostics(bot)).toBe(false);
  });
  it('binds the same observer through the existing action motor proxy', async () => {
    const host: any = {}, seen: any[] = [], close = watchShootDiagnostics(host, e => seen.push(e));
    await executeAction(host, 'act', 0, async () => { noteShootDiagnostic(createMotorPort(host), () => ({ stage: 'proxy' })); return { success: true, result: 'ok' }; });
    close(); expect(seen).toEqual([{ stage: 'proxy' }]);
  });
  it('does not let a repeated old disposer remove a newly registered observer', () => {
    const bot = {}, old = vi.fn(), fresh = vi.fn(), stopOld = watchShootDiagnostics(bot, old);
    stopOld(); const stopFresh = watchShootDiagnostics(bot, fresh); stopOld();
    expect(hasShootDiagnostics(bot)).toBe(true); noteShootDiagnostic(bot, () => ({ stage: 'fresh' }));
    expect(old).not.toHaveBeenCalled(); expect(fresh).toHaveBeenCalledTimes(1); expect(fresh).toHaveBeenCalledWith({ stage: 'fresh' });
    stopFresh(); stopFresh(); expect(hasShootDiagnostics(bot)).toBe(false);
  });
  it('does not change actual shoot results, write order, write times or stock when observers mutate and throw', async () => {
    const plain = await trial(), notices: any[] = [];
    const observed = await trial(row => { notices.push(structuredClone(row)); if (row.actor) row.actor.position.x = 999; if (row.aim) row.aim.pitch = 999; throw Error('ignored'); });
    expect(observed).toEqual(plain); expect(notices.filter(row => row.stage !== 'crystal_ray').map(row => row.stage)).toEqual(['aim', 'aim', 'released']);
    expect(notices[0]).toMatchObject({ unreadSamples: 0, blocker: null, checkPoint: 'crystal_check' });
    expect(notices[1]).toMatchObject({ actor: { onGround: true, velocity: { x: 0, y: 0, z: 0 } }, target: { id: 9, entityBoxEstimate: { min: { x: 23.5, y: 72, z: -.5 } } } });
  });
  it('records unloaded ray cells as unknown while retaining the existing release behavior', async () => {
    const notices: any[] = [], observed = await trial(row => notices.push(row), true);
    expect(notices[0].unreadSamples).toBeGreaterThan(0); expect(notices[0].unreadPolicy).toBe('unchanged_not_solid');
    expect(observed.writes.filter(w => w.op === 'release')).toHaveLength(1);
  });
});
