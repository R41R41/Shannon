import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { combatFootingRisk } from '../../src/services/minebot/utils/combatFooting.js';
import { ReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';
import { fight } from '../../src/services/minebot/utils/primitives/fight.js';

type Cell = { x: number; y: number; z: number; name: string };
const cells = JSON.parse(readFileSync(new URL('../fixtures/run51-hold1-footing.json', import.meta.url), 'utf8')) as Cell[];
const key = (p: { x: number; y: number; z: number }) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
function saved() {
  const blocks = new Map(cells.map(c => [key(c), c.name.split('[')[0]!]));
  const bot = Object.assign(new EventEmitter(), { health: 13, food: 20, entity: { position: new Vec3(5.242, -16, -3.932), yaw: 0, pitch: 0, onGround: true, velocity: new Vec3(0, 0, 0) },
    blockAt(p: Vec3) { const name = blocks.get(key(p)); return name ? { name, position: p.floored(), boundingBox: /air|lava|water/u.test(name) ? 'empty' : 'block' } : null; } });
  return { bot, blocks, enemy: { id: 2442, name: 'skeleton', type: 'hostile', position: new Vec3(4.7, -18, -4.3), height: 1.8, width: 0.6 } };
}
function flat(lavaX: number) {
  const blocks = new Map<string, string>();
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt(p: Vec3) {
    const name = blocks.get(key(p)) ?? (p.y < 64 ? p.x === lavaX ? 'lava' : 'stone' : 'air');
    return { name, boundingBox: /air|lava|water/u.test(name) ? 'empty' : 'block' };
  } };
  return { bot, blocks, enemy: { position: new Vec3(-2.5, 64, 0.5) } };
}
describe('run51 hold1: an enemy hit can push the fight into lava', () => {
  it('reproduces the observed fight position, enemy and saved terrain', () => {
    const f = saved(); expect(combatFootingRisk(f.bot, f.enemy)).toMatchObject({ kind: 'lava', at: { x: 5, y: -17 } });
  });
  it('refuses the real fight hand before it swings or marks combat ownership', async () => {
    const f = saved(), attack = vi.fn(), setControlState = vi.fn();
    const bot = Object.assign(f.bot, { entities: { 2442: f.enemy }, inventory: { items: () => [{ name: 'stone_sword', count: 1 }], slots: [] },
      heldItem: { name: 'stone_sword' }, attack, setControlState, lookAt: vi.fn(), version: '1.21.11' });
    const out = await fight({ bot, stop: new AbortController().signal, deadline: Date.now() + 500, facing: {} as never, base: { x: 5, y: -16, z: -4 } }, { target: '#2442', item: 'stone_sword', retreatHp: 9 });
    expect(out.ok).toBe(false); expect(out.reason).toBe('danger'); expect(out.text).toContain('押される先'); expect(out.text).toContain('lava');
    expect(attack).not.toHaveBeenCalled(); expect(setControlState).not.toHaveBeenCalled(); expect((bot as any).headCombat).toBeUndefined();
  });
  it('allows the same fight footing after the exposed lava floor is filled', () => {
    const f = saved();
    for (let x = 4; x <= 7; x++) for (let z = -5; z <= -2; z++) f.blocks.set(`${x},-17,${z}`, 'cobblestone');
    expect(combatFootingRisk(f.bot, f.enemy)).toBeNull();
  });
  it('checks the enemy-away direction, not every lava cell nearby', () => {
    const safe = flat(-1), exposed = flat(1);
    expect(combatFootingRisk(safe.bot, safe.enemy)).toBeNull();
    expect(combatFootingRisk(exposed.bot, exposed.enemy)?.kind).toBe('lava');
  });
  it('a two-high backstop stops the projected push before the lava', () => {
    const f = flat(1); f.blocks.set('1,64,0', 'cobblestone'); f.blocks.set('1,65,0', 'cobblestone');
    expect(combatFootingRisk(f.bot, f.enemy)).toBeNull();
  });
  it('does not invent danger in unloaded terrain', () => {
    expect(combatFootingRisk({ entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: () => null }, { position: new Vec3(-2.5, 64, 0.5) })).toBeNull();
  });
  it('does not call the start counter a successful lava escape', () => {
    const bot = { lavaReflex: { engagements: 0 } }, ledger = new ReflexLedger(bot);
    bot.lavaReflex.engagements++; ledger.sample();
    const entry = ledger.entriesSince(0)[0]!;
    expect(entry.kind).toBe('lava'); expect(entry.detail).toContain('始まった'); expect(entry.detail).toContain('脱出は未確認'); expect(entry.detail).not.toContain('脱出した');
  });
});
