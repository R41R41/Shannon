import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { primitiveCandidates, primitiveState, executePrimitive } from '../../src/services/minebot/integration/commonFca/primitives.js';
import type { BodyObservation } from '../../src/services/minebot/integration/commonFca/bodyControlContract.js';
function fixture() {
  const stone = { position: new Vec3(2, 64, 0), name: 'stone', stateId: 1, boundingBox: 'block', face: 1 };
  const air = { position: new Vec3(2, 65, 0), name: 'air', stateId: 0, boundingBox: 'empty' };
  const pickaxe = { slot: 36, name: 'iron_pickaxe' };
  const bot: any = { entity: { position: new Vec3(0, 65, 0) }, inventory: { items: () => [pickaxe], slots: { 36: pickaxe } },
    heldItem: { name: 'cobblestone' }, registry: { blocksByName: { cobblestone: {} } }, entities: { 9: { id: 9, type: 'hostile', name: 'zombie', position: new Vec3(1, 65, 0) } },
    blockAtCursor: () => stone, canDigBlock: () => true, blockAt: (p: Vec3) => p.y === 64 ? stone : air,
    setControlState: vi.fn(), clearControlStates: vi.fn(), look: vi.fn(async () => {}), equip: vi.fn(async () => {}),
    activateItem: vi.fn(), deactivateItem: vi.fn(), attack: vi.fn(), activateBlock: vi.fn(async () => {}),
    dig: vi.fn(async () => {}), stopDigging: vi.fn(), placeBlock: vi.fn(async () => {}) };
  const snapshot = primitiveState(bot);
  const observation: BodyObservation = { schemaVersion: 1, bodyId: 'minecraft:home', connected: true, sequence: 1,
    stateAt: new Date().toISOString(), receivedAt: new Date().toISOString(), state: JSON.parse(JSON.stringify({ primitives: snapshot.state })),
    facts: { connected: true, alive: true, onGround: true, yaw: 0, pitch: 0, equipped: 'cobblestone', ...snapshot.facts } };
  return { bot, stone, observation, candidates: primitiveCandidates(observation, Date.now()) };
}
describe('observed bounded Minecraft primitives', () => {
  it('offers resolved controls, pitch, equipment, target clicks and valid adjacent placement with current facts', () => {
    const { candidates, observation } = fixture();
    expect(new Set(candidates.filter(c => c.kind === 'action').map(c => c.operation)))
      .toEqual(new Set(['control', 'look', 'equip', 'use-item', 'attack', 'activate-block', 'dig', 'place']));
    expect(candidates.find(c => JSON.stringify(c.arguments.controls) === '["forward","jump"]')?.preconditions)
      .toContainEqual({ key: 'onGround', value: true });
    expect(candidates.find(c => c.operation === 'place')?.arguments).toEqual({ position: { x: 2, y: 64, z: 0 }, face: [0, 1, 0] });
    for (const candidate of candidates) {
      expect(candidate.preconditions.every(p => observation.facts[p.key] === p.value)).toBe(true);
      expect(Date.parse(candidate.expiresAt) - Date.now()).toBeGreaterThan(4500);
      if (candidate.kind === 'action') expect(candidate.maxDurationMs).toBe(1500);
    }
  });
  it('executes short holds with release and calls only the bound slot/block/face/entity', async () => {
    const { bot, candidates } = fixture(); const signal = new AbortController().signal;
    for (const operation of ['equip', 'use-item', 'attack', 'activate-block', 'dig', 'place', 'control']) {
      await executePrimitive(bot, bot, candidates.find(c => c.operation === operation)!, signal);
    }
    expect(bot.equip).toHaveBeenCalledWith(bot.inventory.slots[36], 'hand');
    expect(bot.placeBlock).toHaveBeenCalledWith(expect.objectContaining({ name: 'stone' }), new Vec3(0, 1, 0));
    expect(bot.attack).toHaveBeenCalledWith(bot.entities[9]);
    expect(bot.deactivateItem).toHaveBeenCalledTimes(1); expect(bot.stopDigging).toHaveBeenCalledTimes(1); expect(bot.clearControlStates).toHaveBeenCalledTimes(1);
  });
  it('omits block operations when unloaded or placement space is occupied', () => {
    const { bot, observation } = fixture(); bot.blockAtCursor = () => null;
    observation.state = JSON.parse(JSON.stringify({ primitives: primitiveState(bot).state }));
    expect(primitiveCandidates(observation, Date.now()).some(c => ['place', 'dig', 'activate-block'].includes(c.operation ?? ''))).toBe(false);
  });
});
