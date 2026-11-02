import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { NativeGoalEvidence } from '../../src/services/minebot/integration/commonFca/goalEvidence.js';
import { NativeCommonFcaBody } from '../../src/services/minebot/integration/commonFca/nativeBody.js';
import { madeCommand } from './helpers/madeFor.js';
const context = { scopeKey: 'owner', taskId: 'dragon-task', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 'session1', generation: 1,
  goal: 'エンダードラゴンを倒して', completionCondition: 'native proof' };
function fixture() {
  let now = Date.parse('2026-10-09T00:00:00Z');
  const target = { id: 17, name: 'ender_dragon', uuid: 'dragon-one', position: new Vec3(1, 65, 0) };
  const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, position: new Vec3(0, 65, 0), yaw: 0, pitch: 0, onGround: true },
    entities: { 17: target }, game: { dimension: 'minecraft:the_end' }, health: 20, food: 20, oxygenLevel: 20, controlState: {},
    inventory: { items: () => [{ name: 'diamond', count: 2 }] }, attack: vi.fn(), activateBlock: vi.fn(), _client: new EventEmitter(), clearControlStates: vi.fn(),
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
  it('reports the milestones on the way: the Nether reached stays reached, rods and eyes are counted', () => {
    const f = fixture(); f.bot.game.dimension = 'minecraft:overworld'; f.evidence.begin(f.command());
    expect(f.evidence.snapshot().milestones).toMatchObject({ dimension: 'overworld', netherReached: false, blazeRods: 0 });
    f.bot.game.dimension = 'minecraft:the_nether'; f.bot.emit('game');
    f.bot.inventory.items = () => [{ name: 'blaze_rod', count: 3 }, { name: 'ender_eye', count: 2 }];
    f.bot.game.dimension = 'minecraft:overworld'; f.bot.emit('game');
    expect(f.evidence.snapshot().milestones).toMatchObject({ dimension: 'overworld', netherReached: true, blazeRods: 3, enderEyes: 2 });
    f.bot.inventory.items = () => { throw Error('unreadable'); };
    expect(f.evidence.snapshot().milestones).toMatchObject({ netherReached: true, blazeRods: null });
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
  describe("the body's damage to the dragon, and the death that follows it", () => {
    const head = (f: ReturnType<typeof fixture>) => ({ id: 18, name: 'ender_dragon_part', dragonPart: 'head', dragonId: f.target.id, position: new Vec3(1, 65, 7) });
    it("takes a blow at a part (the id after the body's) that hurt the dragon, and its death after the command and its deadline are long over", () => {
      const f = fixture(); f.evidence.begin(f.command());
      f.bot.attack(head(f)); f.bot.emit('entityHurt', f.target);
      f.advance(9000); f.evidence.begin(f.command({ id: 'later-query', deadlineAt: new Date(f.now() + 5000).toISOString() }));
      f.bot.emit('entityDead', f.target);
      expect(f.evidence.snapshot().boss).toMatchObject({ verified: true, status: 'witnessed', witness: { via: ['sword'], deathSeen: 'entityDead', commandId: 'attack-one', damages: 1 } });
      f.evidence.dispose();
    });
    it('does not count a swing the dragon was not hurt by, nor a hurt long after the swing', () => {
      const f = fixture(); f.evidence.begin(f.command());
      f.bot.attack(f.target); f.advance(2000); f.bot.emit('entityHurt', f.target); f.advance(8000); f.bot.emit('entityDead', f.target);
      expect(f.evidence.snapshot().boss.verified).toBe(false); f.evidence.dispose();
    });
    it("lets the grace end: a death a minute after the last damage is not the body's", () => {
      const f = fixture(); f.evidence.begin(f.command());
      f.bot.attack(head(f)); f.bot.emit('entityHurt', f.target);
      f.advance(59_000); const within = f.evidence.snapshot().boss.verified; expect(within).toBe(false);
      f.advance(2_000); f.bot.emit('entityDead', f.target);
      expect(f.evidence.snapshot().boss.verified).toBe(false); f.evidence.dispose();
    });
    it('takes an arrow the server names the body as the cause of, and not damage another named', () => {
      const f = fixture(); f.bot.entities[49] = { id: 49, name: 'arrow', position: new Vec3(0, 70, 0) }; f.evidence.begin(f.command());
      f.bot._client.emit('damage_event', { entityId: 17, sourceTypeId: 3, sourceCauseId: 99, sourceDirectId: 99 });
      f.bot.emit('entityDead', f.target); expect(f.evidence.snapshot().boss.verified).toBe(false);
      f.bot._client.emit('damage_event', { entityId: 17, sourceTypeId: 3, sourceCauseId: 2, sourceDirectId: 50 });
      f.advance(8000); f.bot.emit('entityDead', f.target);
      expect(f.evidence.snapshot().boss).toMatchObject({ verified: true, witness: { via: ['arrow'] } }); f.evidence.dispose();
    });
    it('takes a bed that blew beside the dragon after the body used it, and not a blast somewhere else', () => {
      const f = fixture(); f.evidence.begin(f.command());
      f.bot._client.emit('explosion', { center: { x: 40, y: 65, z: 40 }, radius: 5 }); f.bot.emit('entityHurt', f.target);
      f.bot.emit('entityDead', f.target); expect(f.evidence.snapshot().boss.verified).toBe(false);
      f.bot.activateBlock({ name: 'white_bed', position: new Vec3(3, 64, 3) });
      f.bot._client.emit('explosion', { center: { x: 3.5, y: 64.5, z: 3.5 }, radius: 5 }); f.bot.emit('entityHurt', f.target);
      f.advance(8000); f.bot.emit('entityDead', f.target);
      expect(f.evidence.snapshot().boss).toMatchObject({ verified: true, witness: { via: ['explosion'] } }); f.evidence.dispose();
    });
    it('takes the end of the death animation (removed with no health left) but not an unload, nor a removal while it is still dying with health', () => {
      const f = fixture(); f.target.metadata = []; f.evidence.begin(f.command());
      f.bot.attack(head(f)); f.bot.emit('entityHurt', f.target); f.bot.emit('entityGone', f.target);
      expect(f.evidence.snapshot().boss.verified).toBe(false);
      // phase 9 with health 1: on its way to die, and the server may as well have dropped it from this client's range
      f.evidence.begin(f.command()); f.target.metadata[16] = 9; f.target.metadata[9] = 1; f.bot.attack(head(f)); f.bot.emit('entityHurt', f.target); f.advance(9000); f.bot.emit('entityGone', f.target);
      expect(f.evidence.snapshot().boss.verified).toBe(false);
      f.evidence.begin(f.command()); f.target.metadata[9] = 0; f.bot.attack(head(f)); f.bot.emit('entityHurt', f.target); f.advance(9000); f.bot.emit('entityGone', f.target);
      expect(f.evidence.snapshot().boss).toMatchObject({ verified: true, witness: { deathSeen: 'dying_gone' } }); f.evidence.dispose();
    });
    it('does not credit damage the server names someone else for, however fresh the body\'s swing was', () => {
      const f = fixture(); f.evidence.begin(f.command());
      f.bot.attack(head(f)); // out of the server's reach: it did nothing
      f.bot._client.emit('damage_event', { entityId: 17, sourceTypeId: 34, sourceCauseId: 99, sourceDirectId: 99 }); f.bot.emit('entityHurt', f.target);
      f.advance(8000);
      f.bot._client.emit('damage_event', { entityId: 17, sourceTypeId: 34, sourceCauseId: 99, sourceDirectId: 99 }); f.bot.emit('entityDead', f.target);
      expect(f.evidence.snapshot().boss.verified).toBe(false); f.evidence.dispose();
    });
    it('credits a bed whose damage is reported before the blast and with no cause, when the blast was at the bed the body used and near the dragon', () => {
      const f = fixture(); f.evidence.begin(f.command());
      f.bot.activateBlock({ name: 'white_bed', position: new Vec3(3, 64, 3) });
      f.bot._client.emit('damage_event', { entityId: 17, sourceTypeId: 9, sourceCauseId: 0, sourceDirectId: 0 }); f.bot.emit('entityHurt', f.target);
      f.bot._client.emit('explosion', { center: { x: 3.5, y: 64.5, z: 3.5 }, radius: 5 });
      f.advance(8000); f.bot.emit('entityDead', f.target);
      expect(f.evidence.snapshot().boss).toMatchObject({ verified: true, witness: { via: ['explosion'] } }); f.evidence.dispose();
    });
    it('does not credit a bed blast that was far from the dragon, nor a cause-less hurt with no bed of the body\'s', () => {
      const f = fixture(); f.evidence.begin(f.command()); f.target.position = new Vec3(100, 65, 100);
      f.bot.activateBlock({ name: 'white_bed', position: new Vec3(3, 64, 3) });
      f.bot._client.emit('damage_event', { entityId: 17, sourceTypeId: 9, sourceCauseId: 0, sourceDirectId: 0 }); f.bot.emit('entityHurt', f.target);
      f.bot._client.emit('explosion', { center: { x: 3.5, y: 64.5, z: 3.5 }, radius: 5 });
      f.bot.emit('entityDead', f.target);
      expect(f.evidence.snapshot().boss.verified).toBe(false);
      const g = fixture(); g.evidence.begin(g.command());
      g.bot._client.emit('damage_event', { entityId: 17, sourceTypeId: 9, sourceCauseId: 0, sourceDirectId: 0 }); g.bot.emit('entityHurt', g.target); g.bot.emit('entityDead', g.target);
      expect(g.evidence.snapshot().boss.verified).toBe(false); f.evidence.dispose(); g.evidence.dispose();
    });
    it('keeps a reconnect unknown, whatever the earlier damage was', () => {
      const f = fixture(); f.evidence.begin(f.command()); f.bot.attack(head(f)); f.bot.emit('entityHurt', f.target); f.bot.emit('entityDead', f.target);
      expect(f.evidence.snapshot().boss.verified).toBe(true);
      f.bot.emit('end'); expect(f.evidence.snapshot().boss).toMatchObject({ verified: false, status: 'unknown' }); f.evidence.dispose();
    });
    it('tells the kill_dragon advancement beside the proof: earned during the connection, earned before it, not earned, or unknown', () => {
      const kill = (done: boolean) => ({ key: 'minecraft:end/kill_dragon', value: [{ criterionIdentifier: 'killed_dragon', criterionProgress: done ? 1700000000000n : undefined }] });
      const f = fixture(); f.evidence.begin(f.command());
      expect(f.evidence.snapshot().boss.advancement.state).toBe('unknown');
      f.bot._client.emit('advancements', { reset: true, progressMapping: [kill(false)] });
      expect(f.evidence.snapshot().boss.advancement.state).toBe('not_earned');
      f.bot._client.emit('advancements', { reset: false, progressMapping: [kill(true)] });
      expect(f.evidence.snapshot().boss.advancement).toMatchObject({ state: 'earned_during_connection' });
      f.evidence.dispose();
      const g = fixture(); g.evidence.begin(g.command());
      g.bot._client.emit('advancements', { reset: true, progressMapping: [kill(true)] });
      expect(g.evidence.snapshot().boss.advancement.state).toBe('earned_before_connection'); g.evidence.dispose();
    });
  });

  it('offers the real read-only query through native execution without motor ownership or model evidence arguments', async () => {
    const f = fixture(); f.evidence.dispose();
    const skill = { skillName: 'attack-entity', description: 'fixture native attack', isToolForLLM: true, maxDurationMs: 1000, params: [],
      run: async () => { f.bot.attack(f.target); f.bot.emit('entityDead', f.target); return { success: true, result: 'action finished' }; } };
    f.bot.instantSkills.getSkills = () => [skill];
    const listenersBefore = f.bot.listenerCount('entityDead');
    const body = new NativeCommonFcaBody(f.bot, { serverId: 'home', now: f.now, capture: async () => { throw Error('unused'); } });
    const command = (patch: Record<string, unknown> = {}): any => ({ ...f.command(), schemaVersion: 1, serverId: 'home', kind: 'skill', skill: 'goal-evidence', arguments: {},
      lease: { id: 'lease', generation: 1, holder: context.taskId }, ...patch });
    expect(body.skills.find(item => item.name === 'goal-evidence')?.readOnly).toBe(true);
    let receipt = await body.execute(command(), new AbortController().signal);
    expect(JSON.parse(receipt.result!).boss.verified).toBe(false);
    // The attack moves the body, so its command carries the life and what its decision read (continue contracts 2, 5); the read-only query does not need them.
    await body.execute(madeCommand(body, command({ skill: 'attack-entity' })), new AbortController().signal);
    receipt = await body.execute(command({ id: 'fresh-query' }), new AbortController().signal);
    expect(receipt).toMatchObject({ outcome: 'completed', inputsReleased: true }); expect(JSON.parse(receipt.result!).boss.verified).toBe(true);
    await expect(body.execute(command({ arguments: { verified: true } }), new AbortController().signal)).rejects.toThrow('EVIDENCE_ARGUMENTS');
    await expect(body.execute(command({ deadlineAt: new Date(f.now() - 1).toISOString() }), new AbortController().signal)).rejects.toThrow('BODY_DEADLINE');
    // The goal evidence's own listener is gone with the body. The one that stays is the connection's death ledger (utils/deathLedger: the deaths this connection
    // saw, kept for the attack hand's `already`; it belongs to the connection and is emptied at its `end`), which the body now starts with it (continue contracts 1).
    await body.dispose(); expect(f.bot.listenerCount('entityDead')).toBe(listenersBefore + 1);
  });
});
