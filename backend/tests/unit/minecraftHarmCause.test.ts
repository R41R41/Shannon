import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { harmCause } from '../../src/services/minebot/utils/harm.js';
import { installHitRecord } from '../../src/services/minebot/utils/hitRecord.js';
import { CombatEventHandler } from '../../src/services/minebot/eventReaction/handlers/CombatEventHandler.js';
import { drawLocalMap, type MapBlock } from '../../src/services/minebot/utils/localMap.js';

// run62 #12: nine deaths' damage reached the head as `unknown` while the body stood on magma. The cause is read from the body's state.
function body(blocks: Record<string, string>, extra: Record<string, unknown> = {}, entity: Record<string, unknown> = {}): any {
  return {
    entity: { id: 7, position: new Vec3(0.5, 70, 0.5), metadata: [0], effects: {}, ...entity },
    blockAt: (cell: Vec3) => ({ name: blocks[`${cell.x},${cell.y},${cell.z}`] ?? 'air' }),
    food: 20, oxygenLevel: 20, registry: { effects: { 20: { name: 'wither' }, 19: { name: 'poison' } } }, ...extra,
  };
}

describe('harmCause: what hurt the body when no attacker is named (run62 #12)', () => {
  it('names the magma cell under the body, also under only its edge', () => {
    expect(harmCause(body({ '0,69,0': 'magma_block' }))).toBe('hot_floor@0,69,0');
    // Centre over air (a broken portal's rim), only the body's width over magma.
    const rim = body({ '1,69,0': 'magma_block' }, {}, { position: new Vec3(0.75, 70, 0.5) });
    expect(harmCause(rim)).toBe('hot_floor@1,69,0');
  });
  it('lava, fire, burning, wither, poison, hunger, drowning and a buried head each have their code', () => {
    expect(harmCause(body({}, {}, { isInLava: true }))).toBe('lava');
    expect(harmCause(body({ '0,70,0': 'fire' }))).toBe('in_fire');
    expect(harmCause(body({}, {}, { metadata: [0x01] }))).toBe('on_fire');
    expect(harmCause(body({}, {}, { effects: { 20: { id: 20 } } }))).toBe('wither');
    expect(harmCause(body({}, {}, { effects: { 19: { id: 19 } } }))).toBe('poison');
    expect(harmCause(body({}, { food: 0 }))).toBe('starve');
    expect(harmCause(body({}, { oxygenLevel: 0 }, { isInWater: true }))).toBe('drown');
    expect(harmCause(body({ '0,71,0': 'gravel' }))).toBe('suffocation');
  });
  it('says environment, never unknown, when the state shows nothing (a fall is over when it is felt)', () => {
    expect(harmCause(body({ '0,69,0': 'stone' }))).toBe('environment');
    expect(harmCause({} as any)).toBe('environment');
  });
});

describe('the hit record names the cause, never unknown', () => {
  it('a damage_event with no source on magma is hot_floor@x,y,z; an id no longer in the table is entity_gone', () => {
    const client = new EventEmitter();
    const bot: any = Object.assign(new EventEmitter(), body({ '0,69,0': 'magma_block' }, { health: 20, _client: client, entities: {} }));
    const record = installHitRecord(bot, () => 1_700_000_000_000);
    client.emit('damage_event', { entityId: 7, sourceCauseId: 0, sourceDirectId: 0 });
    client.emit('damage_event', { entityId: 7, sourceCauseId: 43, sourceDirectId: 43 });
    const hits = record.recent();
    expect(hits.map(hit => hit.attackerType)).toEqual(['hot_floor@0,69,0', 'entity_gone']);
    expect(hits.some(hit => hit.attackerType === 'unknown')).toBe(false);
  });
});

describe('the urgent message carries the cause and the reflex holding the body', () => {
  it('no attacker: 原因 and the reflex; with an attacker: the reflex too', () => {
    const lone = CombatEventHandler.buildEmergencyMessage({ eventType: 'damage', timestamp: 0, damage: 1, damagePercent: 5, currentHealth: 12, consecutiveCount: 1,
      cause: 'hot_floor@0,69,0', reflex: 'lava-escape' } as any)!;
    expect(lone).toContain('原因: hot_floor@0,69,0');
    expect(lone).toContain('反射 lava-escape が身体を握っています');
    expect(lone).not.toContain('分かりません');
    const hit = CombatEventHandler.buildEmergencyMessage({ eventType: 'damage', timestamp: 0, damage: 3, damagePercent: 15, currentHealth: 10, consecutiveCount: 1,
      possibleSource: 'zombie（約2m）', reflex: 'floor-flee' } as any)!;
    expect(hit).toContain('反射 floor-flee が身体を握っています');
    // An old event without a cause still names one.
    expect(CombatEventHandler.buildEmergencyMessage({ eventType: 'damage', timestamp: 0, damage: 1, damagePercent: 5, currentHealth: 12, consecutiveCount: 1 } as any))
      .toContain('原因: environment');
  });
});

describe('the map shows the magma under @', () => {
  it('the layer under the feet draws M below the self cell, in rock and under the sky', () => {
    const read = (x: number, y: number, z: number): MapBlock => y === 69 && x === 0 && z === 0 ? { name: 'magma_block', solid: true }
      : y <= 69 ? { name: 'stone', solid: true } : { name: 'air', solid: false };
    for (const mode of ['layers', 'surface'] as const) {
      const lines = drawLocalMap({ feet: { x: 0, y: 70, z: 0 }, read }, { mode, radius: 2, topRadius: 2 }).split('\n');
      const under = lines.indexOf('y=69');
      expect(under).toBeGreaterThan(0);
      const row = lines.slice(under).find(line => /^\s*0 /.test(line))!;
      const self = lines.slice(lines.indexOf('y=70')).find(line => /^\s*0 /.test(line))!;
      expect(row[self.indexOf('@')]).toBe('M');
    }
  });
});
