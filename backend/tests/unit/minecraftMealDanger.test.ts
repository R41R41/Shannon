import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { floorConfig } from '../../src/services/minebot/utils/floorConfig.js';
import { floorEatChoice, installFloorReflexes } from '../../src/services/minebot/utils/floorReflexes.js';

// Codex's review of the 4th release (2026-11-05), 1 and 4: the top-up at food 14 (427f627) must not take the starving body's last raw meal away,
// and a meal under way gives way to the dragon's danger that comes after it was chosen.

const block = (name: string, position: Vec3) => ({ name, position, boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] });
function fixture(patch: Record<string, unknown> = {}) {
  const bot: any = Object.assign(new EventEmitter(), {
    game: { dimension: 'minecraft:the_end' }, health: 20, food: 14,
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), onGround: true, velocity: new Vec3(0, 0, 0) }, entities: {} as Record<string, any>,
    registry: { entitiesByName: { area_effect_cloud: { metadataKeys: ['radius', 'particle'] } } },
    inventory: { items: () => [{ name: 'bread', type: 1, count: 4 }], slots: [] },
    blockAt: (p: Vec3) => block(p.y < 64 ? 'end_stone' : 'air', p),
    look: vi.fn(), setControlState: vi.fn(), clearControlStates: vi.fn(), deactivateItem: vi.fn(),
    // A meal that lasts until it is cut (mineflayer's consume waits for the server's 'consumed').
    equip: vi.fn(async () => undefined), consume: vi.fn(() => new Promise(() => undefined)),
    ...patch,
  });
  return bot;
}
const choice = (health: number, food: number, items: string[], dimension = 'overworld') =>
  floorEatChoice(fixture({ health, food, game: { dimension }, inventory: { items: () => items.map(name => ({ name })), slots: [] } }))?.name ?? null;
async function within(ms: number, check: () => boolean): Promise<boolean> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
  return check();
}

describe('the critical meal comes before the mending meal\'s rules', () => {
  it('starving (food 3) or nearly dead with raw meat or rotten flesh only: the body eats them, as before the top-up', () => {
    expect(choice(20, 3, ['beef'])).toBe('beef');
    expect(choice(20, 3, ['rotten_flesh'])).toBe('rotten_flesh');
    expect(choice(5, 10, ['beef'])).toBe('beef');
    // cooked food is still eaten first
    expect(choice(20, 3, ['beef', 'bread'])).toBe('bread');
  });
  it('a meal that is not critical stays cooked food only', () => {
    expect(choice(20, 14, ['beef'])).toBeNull();
    expect(choice(15, 19, ['beef', 'rotten_flesh'])).toBeNull();
    expect(choice(20, 14, ['bread'])).toBe('bread');
  });
});

describe('a meal under way gives way to the dragon\'s danger', () => {
  it('a cloud laid on the body while it eats: the meal is cut at once (not when consume times out) and the dragon\'s retreat runs', async () => {
    const bot = fixture();
    installFloorReflexes(bot, floorConfig({ MINEBOT_FCA_REFLEXES: 'default' }), { fleeTickMs: 1 });
    bot.emit('physicsTick');
    expect(await within(1000, () => bot.consume.mock.calls.length > 0)).toBe(true);
    expect(bot.floorReflexes.busy).toBe('eat');
    // A quiet tick: nothing comes, the meal goes on.
    bot.emit('physicsTick');
    expect(bot.floorReflexes.busy).toBe('eat');
    bot.entities[20] = { id: 20, name: 'area_effect_cloud', position: new Vec3(0.5, 64, 0.5), metadata: [7, { type: 'dragon_breath' }] };
    bot.emit('physicsTick');
    expect(await within(500, () => bot.floorReflexes.busy !== 'eat')).toBe(true);
    expect(bot.deactivateItem).toHaveBeenCalled();
    const entries = () => bot.reflexLedger.entriesSince(0) as Array<{ kind: string; outcome?: string }>;
    expect(await within(500, () => entries().some(entry => entry.kind === 'eat' && entry.outcome === 'cut'))).toBe(true);
    bot.emit('physicsTick');
    expect(await within(1000, () => entries().some(entry => entry.kind === 'retreat'))).toBe(true);
  });
  it('outside the End, or with no danger, a meal is not cut', async () => {
    const bot = fixture({ game: { dimension: 'overworld' } });
    installFloorReflexes(bot, floorConfig({ MINEBOT_FCA_REFLEXES: 'default' }), { fleeTickMs: 1 });
    bot.emit('physicsTick');
    expect(await within(1000, () => bot.consume.mock.calls.length > 0)).toBe(true);
    bot.entities[20] = { id: 20, name: 'area_effect_cloud', position: new Vec3(0.5, 64, 0.5), metadata: [7, { type: 'dragon_breath' }] };
    for (let i = 0; i < 3; i++) bot.emit('physicsTick');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(bot.floorReflexes.busy).toBe('eat');
    expect(bot.deactivateItem).not.toHaveBeenCalled();
  });
});
