/** Manual cross-repository contract check. FCA_API_WIRE_ROOT points at an unmodified API source snapshot. */
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it, expect } from 'vitest';
import { CommonFcaControlLoop, type CommonFcaActuator } from '../../src/services/minebot/integration/commonFca/controlLoop.js';
const source = process.env.FCA_API_WIRE_ROOT;
describe.skipIf(!source)('real common-FCA API / Minebot JSON contract', () => {
  it.each([true, false])('runs skill, stop, capture, reflex protocol and release across both transports (images: %s)', async images => {
    const { MinecraftControl } = await import(pathToFileURL(`${source}/src/surfaces/minecraft/minecraftControl.ts`).href);
    const { MinecraftControlStore } = await import(pathToFileURL(`${source}/src/surfaces/minecraft/store/minecraftControlStore.ts`).href);
    const db = new DatabaseSync(':memory:');
    const configuration = { deviceId: 'minebot', ownerScopeKey: 'owner', servers: new Map([['world', { serverId: 'world', onlineMode: true, ownerUuid: 'owner' }]]) };
    const store = new MinecraftControlStore(db), control = new MinecraftControl(store, configuration, { now: Date.now, ownerAlone: () => true, leaseValid: () => true, pollMilliseconds: 1 });
    let sequence = 0, count = 0, releases = 0;
    const context = { scopeKey: 'owner', taskId: 'task', taskRevision: 1, bodyId: 'minecraft:world', sessionId: 'session', generation: 1, goal: 'mine stone', completionCondition: 'observe inventory', taskState: { phase: 'executing', progress: 'bounded current task',
      activeAction: { name: 'mc.mine-block', operationId: 'tool:1', input: { block: 'stone' } }, recentResults: [] } };
    const observe = () => ({ schemaVersion: 1 as const, bodyId: 'minecraft:world', sequence: ++sequence, stateAt: new Date().toISOString(), receivedAt: new Date().toISOString(), connected: true, state: { health: 20 }, facts: { alive: true, imageAvailable: images } });
    const actuator: CommonFcaActuator = { observe, candidates: () => [], skills: [{ name: 'dig', description: 'dig', readOnly: false, inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
      async release() { releases++; return true; }, async execute(command) {
        count++;
        expect(command.context.taskState).toEqual(context.taskState);
        const observedAt = new Date().toISOString();
        return { id: command.id, connectionId: command.connectionId, outcome: command.kind === 'capture' && !images ? 'failed' : 'completed', inputsReleased: true, observedAt, result: 'actual native fake receipt',
          ...(command.kind === 'capture' && images ? { image: { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', capturedAt: observedAt } } : {}),
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
      const capture = await issue('capture', 'capture');
      expect(capture).toMatchObject({ outcome: images ? 'completed' : 'failed', inputsReleased: true });
      const image = control.observe(context.bodyId).image;
      if (images) expect(control.image(image.ref)).toContain('data:image/jpeg');
      else {
        expect(image).toBeUndefined(); expect(control.observe(context.bodyId).facts.imageAvailable).toBe(false);
        const { runReflexSession } = await import(pathToFileURL(source + '/src/mind/action/reflex/reflexController.ts').href);
        const imageContext = { ...context, sessionId: 'image-required-session' };
        const lease = { id: 'lease', holder: 'holder', generation: 1 };
        let closed = false, decisions = 0, actions = 0;
        const stop = async (request: any, kind: string) => (await issue('image-required-' + kind, kind, { context: imageContext, stop: request })).stop;
        const result = await runReflexSession({ context: imageContext, requiresImage: true, limits: {
          maxDurationMs: 10000, maxDecisions: 2, maxActions: 2, maxActionMs: 1500, maxStateAgeMs: 3000, maxImageAgeMs: 1000,
        } }, {
          now: Date.now, current: async () => true, event: async () => {},
          selector: { choose: async () => { decisions++; return null; } },
          handoff: { inspect: async () => 'new', prepare: async () => true,
            stopNormal: request => stop(request, 'stop'), acquire: async () => lease, valid: async () => true,
            finish: async () => {}, returnStopped: async (_request, receipt) => receipt },
          body: {
            observe: async () => {
              if (!closed) expect((await issue('image-required-capture', 'capture', { context: imageContext })).outcome).toBe('failed');
              return control.observe(context.bodyId);
            },
            candidates: () => [], validate: () => true,
            execute: async () => { actions++; throw Error('image-required action must not execute'); },
            releaseInputs: async request => { const ack = await stop(request, 'release'); closed = true; return ack; },
          },
        });
        expect(result).toMatchObject({ reason: 'observation_unavailable', control: 'returned', decisions: 0, actions: [] });
        expect(decisions).toBe(0); expect(actions).toBe(0);
      }
      const candidate = { id: 'candidate:1', kind: 'action', label: 'jump', operation: 'control', arguments: { control: 'jump', milliseconds: 150 }, preconditions: [{ key: 'alive', value: true }], maxDurationMs: 1500, expiresAt: new Date(Date.now() + 5000).toISOString(), sessionId: 'session', generation: 1, taskRevision: 1, observationSequence: sequence };
      const receipt = await issue('reflex', 'reflex', { operation: { schemaVersion: 1, operationId: 'action:1', context, candidate, observationSequence: sequence, deadlineAt: new Date(Date.now() + 1500).toISOString() } });
      expect(receipt.action.operationId).toBe('action:1');
      expect((await issue('release', 'release', { stop: { context, requestId: 'release:req', reason: 'return' } })).stop.inputsReleased).toBe(true);
      expect(store.safe('task')).toBe(true); expect(count).toBe(images ? 3 : 4); expect(releases).toBe(images ? 2 : 4);
      expect(JSON.stringify(db.prepare('SELECT * FROM fca_body_operations').all())).not.toContain('/9j/2Q');
      await loop.poll(); expect(count).toBe(images ? 3 : 4);
      expect((await issue('normal-after-reflex', 'skill', { context: { ...context, sessionId: 'normal-step' }, skill: 'dig', arguments: {} })).outcome).toBe('completed');
      expect(count).toBe(images ? 4 : 5); expect(store.safe('task')).toBe(true);
    } finally { await loop.stop(); db.close(); }
  });
});
