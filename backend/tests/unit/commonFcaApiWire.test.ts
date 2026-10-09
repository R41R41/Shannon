/** Manual cross-repository contract check. FCA_API_WIRE_ROOT points at an unmodified API source snapshot. */
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it, expect } from 'vitest';
import { CommonFcaControlLoop, type CommonFcaActuator } from '../../src/services/minebot/integration/commonFca/controlLoop.js';
const source = process.env.FCA_API_WIRE_ROOT;
describe.skipIf(!source)('real common-FCA API / Minebot JSON contract', () => {
  it('runs skill, physical stop, ephemeral capture, reflex and release across both actual transports', async () => {
    const { MinecraftControl } = await import(pathToFileURL(`${source}/src/surfaces/minecraft/minecraftControl.ts`).href);
    const { MinecraftControlStore } = await import(pathToFileURL(`${source}/src/surfaces/minecraft/store/minecraftControlStore.ts`).href);
    const db = new DatabaseSync(':memory:');
    const configuration = { deviceId: 'minebot', ownerScopeKey: 'owner', servers: new Map([['world', { serverId: 'world', onlineMode: true, ownerUuid: 'owner' }]]) };
    const store = new MinecraftControlStore(db), control = new MinecraftControl(store, configuration, { now: Date.now, ownerAlone: () => true, leaseValid: () => true, pollMilliseconds: 1 });
    let sequence = 0, count = 0, releases = 0;
    const context = { scopeKey: 'owner', taskId: 'task', taskRevision: 1, bodyId: 'minecraft:world', sessionId: 'session', generation: 1, goal: 'mine stone', completionCondition: 'observe inventory', taskState: { phase: 'executing', progress: 'bounded current task',
      activeAction: { name: 'mc.mine-block', operationId: 'tool:1', input: { block: 'stone' } }, recentResults: [] } };
    const observe = () => ({ schemaVersion: 1 as const, bodyId: 'minecraft:world', sequence: ++sequence, stateAt: new Date().toISOString(), receivedAt: new Date().toISOString(), connected: true, state: { health: 20 }, facts: { alive: true } });
    const actuator: CommonFcaActuator = { observe, candidates: () => [], skills: [{ name: 'dig', description: 'dig', readOnly: false, inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
      async release() { releases++; return true; }, async execute(command) {
        count++;
        expect(command.context.taskState).toEqual(context.taskState);
        const observedAt = new Date().toISOString();
        return { id: command.id, connectionId: command.connectionId, outcome: 'completed', inputsReleased: true, observedAt, result: 'actual native fake receipt',
          ...(command.kind === 'capture' ? { image: { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', capturedAt: observedAt } } : {}),
          ...(command.operation ? { action: { schemaVersion: 1 as const, operationId: command.operation.operationId, bodyId: context.bodyId, sessionId: context.sessionId, generation: 1, outcome: 'completed' as const, inputsReleased: true, observedAt, evidenceId: command.id } } : {}) };
      } };
    const loop = new CommonFcaControlLoop({ baseUrl: 'http://127.0.0.1:9999', token: 'isolated-fake-token', serverId: 'world', connectionId: 'connection', actuator,
      fetcher: async (_url, init) => new Response(JSON.stringify(control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, JSON.parse(String(init?.body)))), { status: 200 }) });
    const issue = async (id: string, kind: string, extra: object = {}) => {
      let done = false;
      const result = control.command({ id, kind, context, lease: { id: 'lease', holder: 'holder', generation: 1 }, ...extra }).finally(() => { done = true; });
      for (let index = 0; index < 100 && !done; index++) { await loop.poll(); await delay(2); }
      if (!done) throw Error('WIRE_ACK_TIMEOUT'); return result;
    };
    try {
      await loop.poll();
      expect((await issue('skill', 'skill', { skill: 'dig', arguments: {} })).outcome).toBe('completed');
      expect((await issue('stop', 'stop', { stop: { context, requestId: 'stop:req', reason: 'handoff' } })).stop.state).toBe('stopped');
      await issue('capture', 'capture');
      const image = control.observe(context.bodyId).image;
      expect(control.image(image.ref)).toContain('data:image/jpeg');
      const candidate = { id: 'candidate:1', kind: 'action', label: 'jump', operation: 'control', arguments: { control: 'jump', milliseconds: 150 }, preconditions: [{ key: 'alive', value: true }], maxDurationMs: 1500, expiresAt: new Date(Date.now() + 5000).toISOString(), sessionId: 'session', generation: 1, taskRevision: 1, observationSequence: sequence };
      const receipt = await issue('reflex', 'reflex', { operation: { schemaVersion: 1, operationId: 'action:1', context, candidate, observationSequence: sequence, deadlineAt: new Date(Date.now() + 1500).toISOString() } });
      expect(receipt.action.operationId).toBe('action:1');
      expect((await issue('release', 'release', { stop: { context, requestId: 'release:req', reason: 'return' } })).stop.inputsReleased).toBe(true);
      expect(store.safe('task')).toBe(true); expect(count).toBe(3); expect(releases).toBe(2);
      expect(JSON.stringify(db.prepare('SELECT * FROM fca_body_operations').all())).not.toContain('/9j/2Q');
      await loop.poll(); expect(count).toBe(3);
      expect((await issue('normal-after-reflex', 'skill', { context: { ...context, sessionId: 'normal-step' }, skill: 'dig', arguments: {} })).outcome).toBe('completed');
      expect(count).toBe(4); expect(store.safe('task')).toBe(true);
    } finally { await loop.stop(); db.close(); }
  });
});
