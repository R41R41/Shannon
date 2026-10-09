import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { NativeGoalEvidence } from '../../src/services/minebot/integration/commonFca/goalEvidence.js';
import { NativeCommonFcaBody } from '../../src/services/minebot/integration/commonFca/nativeBody.js';
const context = { scopeKey: 'owner', taskId: 'dragon-task', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 'session1', generation: 1,
  goal: 'エンダードラゴンを倒して', completionCondition: 'native proof' };
function fixture() {
  let now = Date.parse('2026-10-09T00:00:00Z');
  const target = { id: 17, name: 'ender_dragon', uuid: 'dragon-one', position: new Vec3(1, 65, 0) };
  const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, position: new Vec3(0, 65, 0), yaw: 0, pitch: 0, onGround: true },
    entities: { 17: target }, game: { dimension: 'minecraft:the_end' }, health: 20, food: 20, oxygenLevel: 20, controlState: {},
    inventory: { items: () => [{ name: 'diamond', count: 2 }] }, attack: vi.fn(), clearControlStates: vi.fn(),
    instantSkills: { getSkills: () => [] } });
  const evidence = new NativeGoalEvidence(bot, () => now);
  const command = (patch: Record<string, unknown> = {}): any => ({ id: 'attack-one', context, connectionId: 'connection1', deadlineAt: new Date(now + 5000).toISOString(), ...patch });
  return { bot, target, evidence, command, advance: (milliseconds: number) => { now += milliseconds; }, now: () => now };
}
describe('task-bound native Minecraft goal evidence', () => {
  it('requires actual native attack and native death, with independent task/session/connection provenance', () => {
    const f = fixture(); f.evidence.begin(f.command());
    f.bot.emit('minebotTargetAttacked', f.target); f.bot.emit('entityDead', f.target);
    expect(f.evidence.snapshot().boss.verified).toBe(false);
    f.bot.attack(f.target); expect(f.evidence.snapshot().boss.verified).toBe(false);
    f.bot.emit('entityDead', f.target);
    expect(f.evidence.snapshot()).toMatchObject({ taskId: context.taskId, connectionId: 'connection1', inventory: { coverage: 'known', counts: { diamond: 2 } },
      boss: { verified: true, witness: { sessionId: 'session1', generation: 1, entityUuid: 'dragon-one', commandId: 'attack-one' } } });
    f.evidence.dispose();
  });
  it('keeps witnessed proof across segments of the exact original task but refuses changed task/scope/goal/criteria/body and reconnect', () => {
    const f = fixture(); f.evidence.begin(f.command()); f.bot.attack(f.target); f.bot.emit('entityDead', f.target);
    f.evidence.begin(f.command({ context: { ...context, sessionId: 'session2', generation: 2 } }));
    expect(f.evidence.snapshot().boss).toMatchObject({ verified: true, witness: { sessionId: 'session1' } });
    for (const patch of [{ taskId: 'other-task' }, { scopeKey: 'other-owner' }, { goal: 'a changed goal' }, { completionCondition: 'other criteria' }, { bodyId: 'minecraft:other' }]) {
      f.evidence.begin(f.command({ context: { ...context, ...patch } })); expect(f.evidence.snapshot().boss.verified).toBe(false);
    }
    f.evidence.begin(f.command()); expect(f.evidence.snapshot().boss.verified).toBe(true);
    f.evidence.begin(f.command({ connectionId: 'connection2' })); expect(f.evidence.snapshot().boss.verified).toBe(false);
    f.evidence.dispose();
  });
  it.each(['session', 'generation', 'cancel', 'deadline', 'unload', 'respawn', 'wrong-dimension', 'reused-id', 'changed-uuid', 'disconnected'])(
    'never combines attack and death across %s', cause => {
      const f = fixture(); f.evidence.begin(f.command()); f.bot.attack(f.target);
      let dead = f.target;
      if (cause === 'session') f.evidence.begin(f.command({ context: { ...context, sessionId: 'session2' } }));
      if (cause === 'generation') f.evidence.begin(f.command({ context: { ...context, generation: 2 } }));
      if (cause === 'cancel') f.evidence.cancel(context);
      if (cause === 'deadline') f.advance(5001);
      if (cause === 'unload') f.bot.emit('entityGone', f.target);
      if (cause === 'respawn') f.bot.emit('respawn');
      if (cause === 'wrong-dimension') f.bot.game.dimension = 'overworld';
      if (cause === 'reused-id') dead = { ...f.target };
      if (cause === 'changed-uuid') f.target.uuid = 'other-dragon';
      if (cause === 'disconnected') f.bot.emit('end');
      f.bot.emit('entityDead', dead); expect(f.evidence.snapshot().boss.verified).toBe(false); f.evidence.dispose();
    });
  it('does not accept a failed attack, unloaded target, old death or missing inventory as success', () => {
    const f = fixture(); f.bot.emit('entityDead', f.target); f.evidence.begin(f.command());
    const other = { ...f.target }; f.bot.attack(other); f.bot.emit('entityDead', other);
    expect(f.evidence.snapshot().boss.verified).toBe(false);
    f.bot.inventory.items = () => { throw Error('unavailable'); };
    expect(f.evidence.snapshot().inventory).toEqual({ coverage: 'unknown', counts: {} }); f.evidence.dispose();
    const original = f.bot.attack; f.bot.attack = () => { throw Error('protocol failed'); };
    const evidence = new NativeGoalEvidence(f.bot, f.now); evidence.begin(f.command());
    expect(() => f.bot.attack(f.target)).toThrow('protocol failed'); f.bot.emit('entityDead', f.target);
    expect(evidence.snapshot().boss.verified).toBe(false); evidence.dispose(); f.bot.attack = original;
  });
  it('closes only the current exact session and generation after successful physical cleanup', () => {
    const f = fixture(); f.evidence.begin(f.command({ context: { ...context, generation: 2 } })); f.bot.attack(f.target);
    f.evidence.cancel(context); // Historical generation must not erase the new owner's witness.
    f.bot.emit('entityDead', f.target); expect(f.evidence.snapshot().boss.verified).toBe(true);
    f.evidence.begin(f.command({ context: { ...context, taskId: 'second-task' } })); f.bot.attack(f.target);
    f.evidence.cancel({ ...context, taskId: 'second-task' });
    f.bot.emit('entityDead', f.target); expect(f.evidence.snapshot().boss.verified).toBe(false); f.evidence.dispose();
  });
  it('offers the real read-only query through native execution without motor ownership or model evidence arguments', async () => {
    const f = fixture(); f.evidence.dispose();
    const skill = { skillName: 'attack-entity', description: 'fixture native attack', isToolForLLM: true, maxDurationMs: 1000, params: [],
      run: async () => { f.bot.attack(f.target); f.bot.emit('entityDead', f.target); return { success: true, result: 'action finished' }; } };
    f.bot.instantSkills.getSkills = () => [skill];
    const body = new NativeCommonFcaBody(f.bot, { serverId: 'home', now: f.now, capture: async () => { throw Error('unused'); } });
    const command = (patch: Record<string, unknown> = {}): any => ({ ...f.command(), schemaVersion: 1, serverId: 'home', kind: 'skill', skill: 'goal-evidence', arguments: {},
      lease: { id: 'lease', generation: 1, holder: context.taskId }, ...patch });
    expect(body.skills.find(item => item.name === 'goal-evidence')?.readOnly).toBe(true);
    let receipt = await body.execute(command(), new AbortController().signal);
    expect(JSON.parse(receipt.result!).boss.verified).toBe(false);
    await body.execute(command({ skill: 'attack-entity' }), new AbortController().signal);
    receipt = await body.execute(command({ id: 'fresh-query' }), new AbortController().signal);
    expect(receipt).toMatchObject({ outcome: 'completed', inputsReleased: true }); expect(JSON.parse(receipt.result!).boss.verified).toBe(true);
    await expect(body.execute(command({ arguments: { verified: true } }), new AbortController().signal)).rejects.toThrow('EVIDENCE_ARGUMENTS');
    await body.dispose(); expect(f.bot.listenerCount('entityDead')).toBe(0);
  });
});
