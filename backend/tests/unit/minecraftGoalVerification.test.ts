import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { GoalVerifier, validateGoalContract } from '../../src/services/minebot/cognition/GoalVerifier.js';
import { parseChoiceAnswer, receiptOutcome, supportsControl } from '../../src/services/minebot/cognition/decisionEvidence.js';
import { captureWorldObservation } from '../../src/services/minebot/cognition/worldFrame.js';
import { TaskWorkspace } from '../../src/services/minebot/cognition/TaskWorkspace.js';
import { executeAction, createMotorPort, assertActionActive } from '../../src/services/minebot/execution/ActionExecution.js';
import { bindMinecraftMemory, minecraftMemoryContext, revokeMinecraftMemory } from '../../src/services/minebot/runtime/memoryContext.js';

function bot(): any { return Object.assign(new EventEmitter(), { entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'overworld' },
  inventory: { items: () => [{ name: 'iron_ingot', count: 3 }] }, entities: {}, health: 20, food: 20,
  executingSkill: false, interruptExecution: false }); }
describe('native goal verification and evidence boundaries', () => {
  it('existing inventory is not newly produced output', () => {
    const native = bot(); const verifier = new GoalVerifier(native);
    const contract: any = { goal: 'produce', predicates: [{ kind: 'produced', item: 'iron_ingot', count: 1 }] };
    expect(verifier.verify(contract).status).toBe('mismatch');
    native.inventory.items = () => [{ name: 'iron_ingot', count: 4 }];
    expect(verifier.verify(contract).status).toBe('verified'); verifier.dispose();
  });
  it('unknown inventory and unloaded/cross-dimension blocks never verify', () => {
    const native = bot(); native.inventory = undefined; const verifier = new GoalVerifier(native);
    expect(verifier.verify({ goal: '', predicates: [{ kind: 'inventory', item: 'iron_ingot', count: 1 }] }).status).toBe('unknown');
    expect(verifier.verify({ goal: '', predicates: [{ kind: 'block', block: 'air', dimension: 'nether', position: { x: 0, y: 64, z: 0 } }] }).status).toBe('unknown');
    verifier.dispose();
  });
  it('does not invent a zero baseline when initial inventory was unknown', () => {
    const native = bot(); native.inventory = undefined; const verifier = new GoalVerifier(native);
    native.inventory = { items: () => [{ name: 'iron_ingot', count: 3 }] };
    expect(verifier.verify({ goal: 'produce', predicates: [{ kind: 'produced', item: 'iron_ingot', count: 3 }] }).status).toBe('unknown');
    verifier.dispose();
  });
  it('verifies emergency clearance from native hostile positions, not an arbitrary destination', () => {
    const native = bot(); const verifier = new GoalVerifier(native);
    const contract = validateGoalContract({ goal: 'escape', predicates: [{ kind: 'hostiles_clear', radius: 16 }] }, 'escape');
    native.entities = { creeper: { id: 7, name: 'creeper', position: { x: 12.2, y: 64, z: 0 } } };
    expect(verifier.verify(contract).status).toBe('mismatch');
    native.entities.creeper.position.x = 16.2;
    expect(verifier.verify(contract).status).toBe('verified');
    native.health = 0;
    expect(verifier.verify(contract).status).toBe('mismatch');
    verifier.dispose();
  });
  it('does not certify emergency clearance when hostile locations or entity coverage are unknown', () => {
    const native = bot(); const verifier = new GoalVerifier(native);
    const contract = { goal: 'escape', predicates: [{ kind: 'hostiles_clear' as const, radius: 16 }] };
    native.entities = { zombie: { id: 9, name: 'zombie' } };
    expect(verifier.verify(contract).status).toBe('unknown');
    native.entities = undefined;
    expect(verifier.verify(contract).status).toBe('unknown');
    verifier.dispose();
  });
  it('requires native recovered air, a head out of the water and unobstructed body cells for suffocation clearance', () => {
    const native = bot(); native.entity.isInWater = false; native.oxygenLevel = 4;
    native.blockAt = () => ({ name: 'air', boundingBox: 'empty' });
    const verifier = new GoalVerifier(native);
    const contract = validateGoalContract({ goal: 'breathe', predicates: [{ kind: 'breathing_safe' }] }, 'breathe');
    expect(verifier.verify(contract).status).toBe('mismatch');
    native.oxygenLevel = 20;
    expect(verifier.verify(contract).status).toBe('verified');
    // In the 1.21.11 live campaign, Mineflayer emitted 400 on dry land.
    // The old >20 guard left this safe state unknown until the bot died.
    native.oxygenLevel = 400;
    const dryProof = verifier.verify(contract);
    expect(dryProof.status).toBe('verified');
    expect(dryProof.evidence[0].actual).toMatchObject({ oxygenRaw: 400, oxygen: 20,
      oxygenMax: 20, inWater: false, footBlock: 'air', headBlock: 'air' });
    // Afloat with the head out of the water is safe air; open water has no dry footing to wait for (paid run L21).
    native.entity.isInWater = true;
    native.blockAt = (position: { y: number }) => ({ name: position.y <= 64 ? 'water' : 'air', boundingBox: 'empty' });
    expect(verifier.verify(contract).evidence[0]).toMatchObject({ status: 'verified', actual: { inWater: true, headSubmerged: false } });
    native.blockAt = () => ({ name: 'water', boundingBox: 'empty' });
    expect(verifier.verify(contract).evidence[0]).toMatchObject({ status: 'mismatch', actual: { headSubmerged: true } });
    native.blockAt = (position: { y: number }) => ({ name: position.y <= 64 ? 'water' : 'tall_seagrass', boundingBox: 'empty' });
    expect(verifier.verify(contract).status).toBe('mismatch');
    native.blockAt = () => ({ name: 'air', boundingBox: 'empty' });
    native.entity.isInWater = false;
    native.blockAt = (position: { y: number }) => position.y === 65
      ? { name: 'stone', boundingBox: 'block' }
      : { name: 'air', boundingBox: 'empty' };
    expect(verifier.verify(contract).status).toBe('mismatch');
    native.oxygenLevel = 9;
    native.blockAt = () => ({ name: 'air', boundingBox: 'empty' });
    native.entity.isInWater = true;
    expect(verifier.verify(contract).evidence[0]).toMatchObject({ status: 'mismatch',
      actual: { oxygenRaw: 9, oxygen: 9, inWater: true } });
    verifier.dispose();
  });
  it('accepts the observed live dry-land 400/20 reading only with native air and health proof', () => {
    const native = bot();
    native.entity.position = { x: -19.5, y: 63, z: 108.5 };
    native.entity.isInWater = false;
    native.oxygenLevel = 400;
    native.blockAt = (position: { y: number }) => [63, 64].includes(position.y)
      ? { name: 'air', boundingBox: 'empty' } : null;
    const verifier = new GoalVerifier(native);
    const proof = verifier.verify({ goal: 'escape', predicates: [{ kind: 'breathing_safe' }] });
    expect(proof.status).toBe('verified');
    expect(proof.evidence[0].actual).toMatchObject({ health: 20, oxygenRaw: 400,
      oxygen: 20, inWater: false, footBlock: 'air', headBlock: 'air' });
    native.blockAt = (position: { y: number }) => position.y === 64
      ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
    expect(verifier.verify({ goal: 'escape', predicates: [{ kind: 'breathing_safe' }] }).status).toBe('mismatch');
    verifier.dispose();
  });
  it('never proves breathing safe from missing native oxygen or block coverage', () => {
    const native = bot(); native.entity.isInWater = false; native.oxygenLevel = undefined;
    const verifier = new GoalVerifier(native);
    const contract = { goal: 'breathe', predicates: [{ kind: 'breathing_safe' as const }] };
    expect(verifier.verify(contract).status).toBe('unknown');
    native.oxygenLevel = 20;
    expect(verifier.verify(contract).status).toBe('unknown');
    native.blockAt = () => ({ name: 'air', boundingBox: 'empty' });
    native.health = 0;
    expect(verifier.verify(contract).status).toBe('mismatch');
    verifier.dispose();
  });
  it('unrelated deaths and disappearance do not prove defeat; tracked attack plus death does', () => {
    const native = bot(); const verifier = new GoalVerifier(native);
    const contract: any = { goal: 'defeat', predicates: [{ kind: 'defeated', entityId: 7, dimension: 'overworld' }] };
    native.emit('entityDead', { id: 7 }); expect(verifier.verify(contract).status).toBe('unknown');
    native.emit('minebotTargetAttacked', { id: 7 }); expect(verifier.verify(contract).status).toBe('unknown');
    native.emit('entityDead', { id: 7 }); expect(verifier.verify(contract).status).toBe('verified');
    verifier.dispose(); expect(native.listenerCount('entityDead')).toBe(0);
  });
  it('preserves historical defeat on the same paused contract but rechecks current inventory', () => {
    const native = bot(); const contract: any = { goal: 'defeat and gather', predicates: [
      { kind: 'defeated', entityId: 7, dimension: 'overworld' }, { kind: 'inventory', item: 'bread', count: 1 },
    ] };
    const first = new GoalVerifier(native);
    native.emit('minebotTargetAttacked', { id: 7 }); native.emit('entityDead', { id: 7 });
    const proof = first.verify(contract); expect(proof.status).toBe('mismatch'); first.dispose();
    const resumed = new GoalVerifier(native, undefined, { contract, proof });
    expect(resumed.verify(contract).evidence[0].status).toBe('verified');
    expect(resumed.verify(contract).status).toBe('mismatch');
    native.inventory.items = () => [{ name: 'bread', count: 1 }];
    expect(resumed.verify(contract).status).toBe('verified');
    native.inventory.items = () => [];
    expect(resumed.verify(contract).status).toBe('mismatch'); resumed.dispose();
  });
  it('does not inherit a historical defeat into a different goal or dimension with a reused ID', () => {
    const native = bot(); const contract: any = { goal: 'first', predicates: [{ kind: 'defeated', entityId: 7, dimension: 'overworld' }] };
    const first = new GoalVerifier(native); native.emit('minebotTargetAttacked', { id: 7 }); native.emit('entityDead', { id: 7 });
    const proof = first.verify(contract); first.dispose();
    const resumed = new GoalVerifier(native, undefined, { contract, proof });
    expect(resumed.verify({ ...contract, goal: 'second' }).status).toBe('unknown');
    expect(resumed.verify({ ...contract, predicates: [{ kind: 'defeated', entityId: 7, dimension: 'nether' }] }).status).toBe('unknown');
    resumed.dispose();
  });
  it.each([undefined, { goal: 'different', predicates: [] }, { goal: 'goal', predicates: [{ kind: 'inventory', item: 'iron_ingot', count: -1 }] },
    { goal: 'goal', predicates: [{ kind: 'position', dimension: 'overworld', position: { x: NaN, y: 0, z: 0 }, radius: 1 }] },
    { goal: 'goal', predicates: [{ kind: 'block', dimension: 'overworld', position: { x: 0.5, y: 0, z: 0 }, block: 'air' }] },
    { goal: 'goal', predicates: [{ kind: 'hostiles_clear', radius: 0 }] },
    { goal: 'goal', predicates: [{ kind: 'breathing_safe', minOxygen: 0 }] },
    { goal: 'goal', predicates: [{ kind: 'unsupported' }] }])('rejects invalid contract %#', value => {
    expect(() => validateGoalContract(value, 'goal')).toThrow();
  });
  it.each([
    { choice: 'A', confidence: 0.9 }, { choice: 'A', confidence: NaN, probabilities: { A: 1, B: 0 } },
    { choice: 'C', confidence: 0.9, probabilities: { A: 1, B: 0 } },
    { choice: 'A', confidence: 0.9, probabilities: { A: 0.1, B: 0.9 } },
    { choice: 'A', confidence: 0.9, probabilities: { A: 0.8, B: 0.8 } },
    { choice: 'A', confidence: 0.9, probabilities: { A: 1, B: -0.1 } },
    { choice: 'A', confidence: 0.9, probabilities: { A: 1, B: 0, C: 0 } },
  ])('rejects malformed choice evidence %#', value => expect(() => parseChoiceAnswer(value, ['A', 'B'] as const)).toThrow());
  it('keeps pending external work distinct from a failed action', () => {
    expect(receiptOutcome({ success: false, failureType: 'waiting_external' })).toBe('pending_external');
    expect(receiptOutcome({ success: false, failureType: 'no_path' })).toBe('failed');
  });
  it('never controls from a flat distribution even when a response labels it highly confident', () => {
    const evidence = parseChoiceAnswer({ choice: 'A', confidence: 0.99, probabilities: { A: 0.5, B: 0.5 } }, ['A', 'B'] as const);
    expect(supportsControl(evidence)).toBe(false);
  });
  it('sample timestamps do not change content revisions and plan versions preserve prior evidence', () => {
    const workspace = new TaskWorkspace({ runId: 'test', goal: 'test' }); const native = bot();
    workspace.observeWorld(captureWorldObservation(native)); workspace.observeWorld({ ...captureWorldObservation(native), observedAt: 'later' });
    expect(workspace.worldRevision).toBe(1);
    workspace.projectPlan([{ id: 'iron', goal: 'iron', status: 'completed' }]); workspace.projectPlan([]);
    expect(workspace.snapshot().planRevisions?.[0].plan[0].status).toBe('completed');
  });
  it('motor wrappers keep the native memory identity and revocation fence', () => {
    const native = bot(); const port = createMotorPort(native);
    bindMinecraftMemory(native, { serverId: 'dev:isolated-test', worldId: 'world-test' });
    expect(minecraftMemoryContext(port)?.serverId).toBe('dev:isolated-test');
    revokeMinecraftMemory(native); expect(minecraftMemoryContext(port)).toBeNull();
  });
  it('motor writes are fenced after an awaited body has already settled', async () => {
    const native = bot(); let late!: Promise<void>; let rejected = false; let writes = 0; native.setControlState = () => writes++;
    const port = createMotorPort(native);
    await executeAction(native, 'mine-block', 1000, async () => {
      late = new Promise<void>(resolve => { setTimeout(() => {
        try { port.setControlState('forward', true); } catch { rejected = true; } finally { resolve(); }
      }, 5); });
      return { success: true, result: 'done' };
    });
    await late;
    expect(writes).toBe(0); expect(rejected).toBe(true);
  });
  it('an expired captured motor cannot write from a native emitter outside ALS', async () => {
    const native = bot(); native.setControlState = () => { throw new Error('unexpected write'); }; let port: any;
    await executeAction(native, 'mine-block', 1000, async () => { port = createMotorPort(native); return { success: true, result: 'done' }; });
    expect(() => port.setControlState('forward', true)).toThrow('Motor owner expired');
  });
});
