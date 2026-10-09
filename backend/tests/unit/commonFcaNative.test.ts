import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { bodySkillCatalog, normalizeSkillSchema } from '../../src/services/minebot/integration/commonFca/skillCatalog.js';
import { executeAction, cancelActiveActions, physicalActionBusy } from '../../src/services/minebot/execution/ActionExecution.js';
import { NativeCommonFcaBody } from '../../src/services/minebot/integration/commonFca/nativeBody.js';
import { createBodyImageCapture } from '../../src/services/minebot/integration/commonFca/imageCapture.js';
const context = { scopeKey: 'owner', taskId: 'task1', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 'session1', generation: 1, goal: 'test', completionCondition: 'done' };
const command = (fields = {}): any => ({ schemaVersion: 1, id: 'one', serverId: 'home', connectionId: 'connection1', kind: 'skill', context,
  lease: { id: 'lease1', generation: 1, holder: 'task1' }, deadlineAt: new Date(Date.now() + 2000).toISOString(), skill: 'get-health', arguments: {}, ...fields });
function skill(name: string, params: any[] = []) { return { skillName: name, description: 'test skill', isToolForLLM: true, maxDurationMs: 1000, params,
  run: vi.fn(async () => ({ success: true, result: 'health 20' })) }; }
function fixture() {
  const query = skill('get-health');
  const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, position: new Vec3(0, 65, 0), yaw: 0, pitch: 0, onGround: true },
    health: 20, food: 20, oxygenLevel: 20, game: { dimension: 'overworld' }, entities: {}, inventory: { items: () => [] }, controlState: {},
    instantSkills: { getSkills: () => [query] }, executingSkill: false, interruptExecution: false,
    clearControlStates: vi.fn(function(this: any) { this.controlState = {}; }),
    setControlState: vi.fn(function(this: any, key: string, value: boolean) { this.controlState[key] = value; }),
    look: vi.fn(async () => {}), attack: vi.fn() });
  const body = new NativeCommonFcaBody(bot, { serverId: 'home', capture: async () => ({ dataUrl: 'data:image/jpeg;base64,YQ==', capturedAt: new Date().toISOString() }) });
  return { bot, body, query };
}
describe('common FCA native body', () => {
  it('advertises real bounded schemas, query categories and finite native skills only', () => {
    const query = skill('get-health'), unknown = skill('new-physical-skill'), planner = skill('campaign-planner'), code = skill('run-command');
    const vec = skill('move-to', [{ name: 'target', type: 'Vec3', required: true, description: 'coordinate' }]);
    const catalog = bodySkillCatalog([query, unknown, planner, code, vec, { ...skill('forever'), maxDurationMs: 0 }], {});
    expect(catalog.definitions.map(d => [d.name, d.readOnly])).toEqual([['get-health', true], ['new-physical-skill', false], ['move-to', false]]);
    const schema: any = catalog.definitions[2].inputSchema;
    expect(schema.additionalProperties).toBe(false); expect(schema.properties.target.additionalProperties).toBe(false);
    expect(catalog.resolve('move-to', { target: { x: 1, y: 2, z: 3 } }).args[0]).toBeInstanceOf(Vec3);
    expect(() => catalog.resolve('get-health', { arbitrary: 1 })).toThrow();
    expect(() => catalog.resolve('campaign-planner', {})).toThrow();
    expect(() => normalizeSkillSchema({ $ref: 'thing' })).toThrow();
  });
  it('runs the actual registered skill once and continually samples world state', async () => {
    const { body, bot, query } = fixture();
    const before = body.observe(); bot.health = 7; const after = body.observe();
    expect(after.sequence).toBeGreaterThan(before.sequence); expect(after.facts.danger).toBe(true);
    const result = await body.execute(command(), new AbortController().signal);
    expect(query.run).toHaveBeenCalledTimes(1); expect(result).toMatchObject({ outcome: 'completed', result: 'health 20', inputsReleased: true });
    expect(await body.release(new AbortController().signal)).toBe(true); await body.dispose();
  });
  it('checks current candidate facts and refuses new arguments before motor calls', async () => {
    const { body, bot } = fixture(); const observation = body.observe();
    const draft = body.candidates(observation).find(c => c.operation === 'control')!;
    const candidate = { ...draft, id: 'candidate1', sessionId: context.sessionId, generation: 1, taskRevision: 1, observationSequence: observation.sequence };
    const operation = { schemaVersion: 1, operationId: 'op1', context, candidate, observationSequence: observation.sequence, deadlineAt: new Date(Date.now() + 1500).toISOString() };
    bot.entity.yaw = 0.1;
    await expect(body.execute(command({ kind: 'reflex', operation }), new AbortController().signal)).rejects.toThrow('PRECONDITION');
    bot.entity.yaw = 0; operation.candidate.arguments = { control: 'forward', milliseconds: 99_999 };
    await expect(body.execute(command({ kind: 'reflex', operation }), new AbortController().signal)).rejects.toThrow('NOT_SUPPORTED');
    expect(bot.setControlState).not.toHaveBeenCalled(); await body.dispose();
  });
  it('keeps an unreturned physical action held after cancellation until actual native work settles', async () => {
    const { bot, query } = fixture(); query.skillName = 'mine-block';
    let finish!: () => void;
    query.run = vi.fn(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { success: true, result: 'late work ended' }; });
    const body = new NativeCommonFcaBody(bot, { serverId: 'home', capture: async () => { throw Error('unused'); } });
    const abort = new AbortController(); const pending = body.execute(command({ skill: 'mine-block' }), abort.signal);
    await new Promise(resolve => setTimeout(resolve, 0)); abort.abort();
    expect(await body.release(AbortSignal.timeout(15))).toBe(false);
    finish(); expect(await pending).toMatchObject({ outcome: 'cancelled', inputsReleased: true });
    expect(query.run).toHaveBeenCalledTimes(1); expect(await body.release(new AbortController().signal)).toBe(true);
    await body.dispose();
  });
  it('never treats the legacy 15 second forced-reclaim timer as actual quiescence', async () => {
    vi.useFakeTimers();
    try {
      const { body, bot } = fixture(); let finish!: () => void;
      const work = executeAction(bot, 'mine-block', 0, async () => { await new Promise<void>(resolve => { finish = resolve; }); return { success: true, result: 'ended' }; }, { waitForQuiescence: true });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      cancelActiveActions(bot); await vi.advanceTimersByTimeAsync(16_000);
      expect(physicalActionBusy(bot)).toBe(true);
      const abort = new AbortController(); const release = body.release(abort.signal); abort.abort();
      await vi.advanceTimersByTimeAsync(10); expect(await release).toBe(false);
      finish(); await work; expect(physicalActionBusy(bot)).toBe(false);
      expect(await body.release(new AbortController().signal)).toBe(true); await body.dispose();
    } finally { vi.useRealTimers(); }
  });
  it('read-only capture and queries own no motor inputs while a local safety action remains active', async () => {
    const { bot, body } = fixture(); let finish!: () => void;
    const safety = executeAction(bot, 'auto-swim', 0, async () => { await new Promise<void>(resolve => { finish = resolve; });
      return { success: true, result: 'surfaced' }; }, { waitForQuiescence: true, safetyLease: true, priority: 300 });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(physicalActionBusy(bot)).toBe(true);
    expect(await body.execute(command({ kind: 'capture' }), new AbortController().signal)).toMatchObject({ outcome: 'completed', inputsReleased: true });
    expect(await body.execute(command(), new AbortController().signal)).toMatchObject({ outcome: 'completed', inputsReleased: true });
    expect(physicalActionBusy(bot)).toBe(true);
    const abort = new AbortController(); abort.abort(); expect(await body.release(abort.signal)).toBe(false);
    finish(); await safety; expect(await body.release(new AbortController().signal)).toBe(true); await body.dispose();
  });
  it('rechecks safety ownership after awaited plugin cleanup before clearing controls', async () => {
    const { bot, body } = fixture(); let finish!: () => void; let safety!: Promise<unknown>;
    bot.collectBlock = { cancelTask: async () => {
      safety = executeAction(bot, 'auto-swim', 0, async () => { await new Promise<void>(resolve => { finish = resolve; });
        return { success: true, result: 'surfaced' }; }, { waitForQuiescence: true, safetyLease: true, priority: 300 });
      for (let i = 0; i < 10; i++) await Promise.resolve();
    } };
    expect(await body.release(new AbortController().signal)).toBe(false);
    expect(bot.clearControlStates).not.toHaveBeenCalled();
    finish(); await safety; bot.collectBlock.cancelTask = async () => {};
    expect(await body.release(new AbortController().signal)).toBe(true); await body.dispose();
  });
  it('captures current bot pixels lazily, rejects concurrent or aborted capture and never exposes stale images', async () => {
    const bot = {}; let finish!: () => void;
    const create = vi.fn(async (value: unknown) => { expect(value).toBe(bot); return { capture: async () => { await new Promise<void>(resolve => { finish = resolve; });
      return { dataUrl: 'data:image/jpeg;base64,YQ==', capturedAt: new Date().toISOString() }; }, dispose: vi.fn(async () => {}) }; });
    const images = createBodyImageCapture(bot, { create }); expect(create).not.toHaveBeenCalled();
    const abort = new AbortController(); const pending = images.capture(abort.signal); await new Promise(resolve => setTimeout(resolve, 0));
    await expect(images.capture(new AbortController().signal)).rejects.toThrow('UNAVAILABLE');
    abort.abort(); finish(); await expect(pending).rejects.toThrow(); expect(create).toHaveBeenCalledTimes(1); await images.dispose();
  });
});
