import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { bodySkillCatalog, normalizeSkillSchema } from '../../src/services/minebot/integration/commonFca/skillCatalog.js';
import { executeAction, cancelActiveActions, physicalActionBusy } from '../../src/services/minebot/execution/ActionExecution.js';
import { NativeCommonFcaBody } from '../../src/services/minebot/integration/commonFca/nativeBody.js';
import { createBodyImageCapture, createRenderProcessSession, rendererResolvable } from '../../src/services/minebot/integration/commonFca/imageCapture.js';
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
describe('floor facts for the API fast judgment (ADR-0011 stage 2)', () => {
  it('says facts.floorActive only while a floor reflex or a safety lease holds the body', async () => {
    const { body, bot } = fixture();
    expect(body.observe().facts.floorActive).toBe(false);
    bot.floorReflexes = { retreat: { engaged: true, ticks: 0, cooldown: 0, engagements: 1 }, busy: null, retryAt: 0, engagements: { eat: 0, armor: 0 } };
    expect(body.observe().facts.floorActive).toBe(true);
    bot.floorReflexes.retreat.engaged = false; bot.floorReflexes.busy = 'eat';
    expect(body.observe().facts.floorActive).toBe(true);
    bot.floorReflexes.busy = null; expect(body.observe().facts.floorActive).toBe(false);
    bot.lavaReflex = { engaged: true }; expect(body.observe().facts.floorActive).toBe(true);
    bot.lavaReflex = { engaged: false }; bot.breathingReflex = { engaged: true }; expect(body.observe().facts.floorActive).toBe(true);
    bot.breathingReflex = { engaged: false }; expect(body.observe().facts.floorActive).toBe(false);
    const held = executeAction(bot, 'floor-retreat', 1000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'ok' }), 50)),
      { priority: 350, safetyLease: true, waitForQuiescence: false, legacyExecutingSkill: true });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(body.observe().facts.floorActive).toBe(true);
    await held; expect(body.observe().facts.floorActive).toBe(false); await body.dispose();
  });
  it('marks a swelling or lit creeper as nearbyThreats[].ignited and leaves other mobs without the field', async () => {
    const { body, bot } = fixture();
    bot.registry = { entitiesByName: { creeper: { type: 'hostile' }, zombie: { type: 'hostile' } } };
    const meta = (fuse: unknown, lit: unknown) => { const m: unknown[] = []; m[16] = fuse; m[18] = lit; return m; };
    bot.entities = {
      2: { id: 2, name: 'creeper', position: new Vec3(2, 65, 0), metadata: meta(1, false) },
      3: { id: 3, name: 'creeper', position: new Vec3(3, 65, 0), metadata: meta(-1, false) },
      4: { id: 4, name: 'creeper', position: new Vec3(4, 65, 0) },
      5: { id: 5, name: 'zombie', position: new Vec3(5, 65, 0), metadata: meta(1, true) },
    };
    const threats = (body.observe().state as any).world.nearbyThreats;
    expect(threats.map((t: any) => [t.name, t.ignited])).toEqual([['creeper', true], ['creeper', false], ['creeper', false], ['zombie', undefined]]);
    expect(threats[3]).not.toHaveProperty('ignited');
    bot.entities[3].metadata = meta(-1, true);
    expect((body.observe().state as any).world.nearbyThreats[1].ignited).toBe(true); await body.dispose();
  });
});
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
  it('says the failure kind of the skill on the receipt (no route as the agreed no_path) and gives each skill its own time', async () => {
    const { body, bot, query } = fixture();
    query.run.mockResolvedValueOnce({ success: false, result: 'パスが見つかりません', failureType: 'path_not_found', recoverable: true } as any);
    const failed = await body.execute(command(), new AbortController().signal);
    expect(failed).toMatchObject({ outcome: 'failed', failureType: 'no_path', recoverable: true });
    const done = await body.execute(command({ id: 'skill:two' }), new AbortController().signal);
    expect(done).not.toHaveProperty('failureType');
    expect(bodySkillCatalog([{ ...skill('build-around-self'), maxDurationMs: 300_000 }, { ...skill('huge'), maxDurationMs: 9e9 }], {}).definitions
      .map(d => d.maxDurationMs)).toEqual([300_000, 600_000]);
    expect(bot).toBeTruthy(); await body.dispose();
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
  it('waits, bounded, for a safety reflex that holds the body to end instead of reporting it held', async () => {
    const { bot, body } = fixture();
    // A floor meal over an interrupted action: about 1.6 s in the game, shortened here.
    const safety = executeAction(bot, 'floor-eat', 0, async () => { await new Promise(resolve => setTimeout(resolve, 400));
      return { success: true, result: 'ate' }; }, { waitForQuiescence: false, safetyLease: true, priority: 200 });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(physicalActionBusy(bot)).toBe(true);
    const started = Date.now();
    expect(await body.release(AbortSignal.timeout(50))).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    await safety; await body.dispose();
  });
  it.each([false, true])('reports unavailable capture without physical uncertainty (already cancelled: %s)', async cancelled => {
    const original = fixture(); await original.body.dispose(); const { bot } = original;
    const capture = vi.fn(async () => { throw Error('BODY_CAPTURE_EXACT_VERSION_ASSETS_REQUIRED'); });
    const body = new NativeCommonFcaBody(bot, { serverId: 'home', capture });
    let finish!: () => void;
    const safety = executeAction(bot, 'auto-swim', 0, async () => { await new Promise<void>(resolve => { finish = resolve; });
      return { success: true, result: 'surfaced' }; }, { waitForQuiescence: true, safetyLease: true, priority: 300 });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const abort = new AbortController(); if (cancelled) abort.abort();
    const result = await body.execute(command({ kind: 'capture' }), abort.signal);
    expect(result).toMatchObject({ outcome: cancelled ? 'cancelled' : 'failed', inputsReleased: true, result: 'BODY_CAPTURE_UNAVAILABLE' });
    expect(result.image).toBeUndefined(); expect(body.observe().facts.imageAvailable).toBe(false);
    expect(capture).toHaveBeenCalledTimes(cancelled ? 0 : 1);
    expect(physicalActionBusy(bot)).toBe(true); expect(bot.clearControlStates).not.toHaveBeenCalled();
    const stop = new AbortController(); stop.abort(); expect(await body.release(stop.signal)).toBe(false);
    finish(); await safety; await body.dispose();
  });
  it('advertises an image only after capture succeeds and clears availability when the next capture fails', async () => {
    const original = fixture(); await original.body.dispose();
    const capture = vi.fn().mockResolvedValueOnce({ dataUrl: 'data:image/jpeg;base64,YQ==', capturedAt: new Date().toISOString() })
      .mockRejectedValueOnce(Error('renderer unavailable'));
    const body = new NativeCommonFcaBody(original.bot, { serverId: 'home', capture });
    expect(body.observe().facts.imageAvailable).toBe(false);
    expect((await body.execute(command({ kind: 'capture' }), new AbortController().signal)).outcome).toBe('completed');
    expect(body.observe().facts.imageAvailable).toBe(true);
    expect((await body.execute(command({ kind: 'capture' }), new AbortController().signal)).outcome).toBe('failed');
    expect(body.observe().facts.imageAvailable).toBe(false); await body.dispose();
  });
  it('reports whether a renderer is configured, and leaves the fact unknown when the body cannot tell', async () => {
    const original = fixture(); await original.body.dispose();
    const capture = vi.fn(); let configured = true;
    const body = new NativeCommonFcaBody(original.bot, { serverId: 'home', capture, rendererConfigured: () => configured });
    expect(body.observe().facts.rendererConfigured).toBe(true);
    configured = false; expect(body.observe().facts.rendererConfigured).toBe(false); await body.dispose();
    const unknown = new NativeCommonFcaBody(original.bot, { serverId: 'home', capture });
    expect(unknown.observe().facts.rendererConfigured).toBeNull(); await unknown.dispose();
  });
  it('stops claiming a renderer when its session fails to start, but retries a session that only waited for spawn', async () => {
    const bot = {};
    const notSpawned = vi.fn().mockRejectedValueOnce(Error('BODY_CAPTURE_NOT_SPAWNED'))
      .mockResolvedValueOnce({ capture: async () => ({ dataUrl: 'data:image/jpeg;base64,YQ==', capturedAt: new Date().toISOString() }), dispose: async () => {} });
    const waiting = createBodyImageCapture(bot, { create: notSpawned });
    await expect(waiting.capture(new AbortController().signal)).rejects.toThrow('NOT_SPAWNED');
    expect(waiting.configured).toBe(true);
    await expect(waiting.capture(new AbortController().signal)).resolves.toMatchObject({ dataUrl: expect.any(String) });
    await waiting.dispose(); expect(waiting.configured).toBe(false);
    const broken = vi.fn(async () => { throw Error('BODY_CAPTURE_EXACT_VERSION_ASSETS_REQUIRED'); });
    const images = createBodyImageCapture(bot, { create: broken });
    await expect(images.capture(new AbortController().signal)).rejects.toThrow('EXACT_VERSION');
    expect(images.configured).toBe(false);
    await expect(images.capture(new AbortController().signal)).rejects.toThrow('UNAVAILABLE'); expect(broken).toHaveBeenCalledTimes(1);
  });
  it('starts the renderer ahead of the first capture and reuses that session', async () => {
    const create = vi.fn(async () => ({ capture: async () => ({ dataUrl: 'data:image/jpeg;base64,YQ==', capturedAt: new Date().toISOString() }), dispose: vi.fn(async () => {}) }));
    const images = createBodyImageCapture({}, { create });
    images.prepare(); images.prepare(); expect(create).toHaveBeenCalledTimes(1);
    await expect(images.capture(new AbortController().signal)).resolves.toMatchObject({ dataUrl: expect.any(String) });
    expect(create).toHaveBeenCalledTimes(1); await images.dispose(); images.prepare(); expect(create).toHaveBeenCalledTimes(1);
    const broken = createBodyImageCapture({}, { create: async () => { throw Error('BODY_CAPTURE_RENDERER_EXITED'); } });
    broken.prepare(); await new Promise(resolve => setImmediate(resolve)); expect(broken.configured).toBe(false);
  });
  it('does not claim a renderer whose packages do not resolve', () => {
    expect(rendererResolvable('/nonexistent/renderer')).toBe(false);
    expect(createBodyImageCapture({}, { rendererDirectory: '/nonexistent/renderer' }).configured).toBe(false);
  });
  it('claims a renderer only when the WebGL and canvas bindings that node-canvas-webgl loads are built', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'renderer-')), file = (relative: string, text = '') => {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); writeFileSync(path.join(root, relative), text);
    };
    const pkg = (dir: string, name: string, main = 'index.js') => { file(`${dir}/package.json`, JSON.stringify({ name, main })); file(`${dir}/${main}`); };
    // The renderer process runs under `nice xvfb-run`; stand-ins on PATH keep this independent of the test machine.
    const pathBefore = process.env.PATH; file('bin/xvfb-run'); file('bin/xauth'); file('bin/nice'); process.env.PATH = path.join(root, 'bin');
    try {
      pkg('.', 'prismarine-viewer'); file('viewer/lib/version.js'); file('viewer/index.js');
      pkg('node_modules/three', 'three'); pkg('node_modules/node-canvas-webgl', 'node-canvas-webgl', 'lib/index.js');
      pkg('node_modules/gl', 'gl'); pkg('node_modules/node-canvas-webgl/node_modules/canvas', 'canvas');
      file('node_modules/canvas/build/Release/canvas.node'); // the root canvas the viewer's labels load: built first here
      // A release installed without the native builds: JavaScript present, bindings missing.
      expect(rendererResolvable(root)).toBe(false);
      file('node_modules/gl/build/Release/webgl.node');
      expect(rendererResolvable(root)).toBe(false);
      // node-canvas-webgl draws with its nested canvas: a built top-level copy does not stand in for it.
      pkg('node_modules/canvas', 'canvas');
      expect(rendererResolvable(root)).toBe(false);
      file('node_modules/node-canvas-webgl/node_modules/canvas/build/Release/canvas.node');
      expect(rendererResolvable(root)).toBe(true);
      // The viewer's entity labels need the root canvas built as well.
      rmSync(path.join(root, 'node_modules/canvas/build'), { recursive: true });
      expect(rendererResolvable(root)).toBe(false);
      file('node_modules/canvas/build/Release/canvas.node');
      expect(rendererResolvable(root)).toBe(true);
      process.env.PATH = path.join(root, 'nowhere');
      expect(rendererResolvable(root)).toBe(false);
    } finally { process.env.PATH = pathBefore; rmSync(root, { recursive: true, force: true }); }
  });
  it('renders in a separate process: streams the world, then answers one capture at a time', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'renderer-ipc-'));
    writeFileSync(path.join(root, 'package.json'), '{"name":"prismarine-viewer"}');
    mkdirSync(path.join(root, 'viewer/lib'), { recursive: true });
    writeFileSync(path.join(root, 'viewer/lib/version.js'), "module.exports = { supportedVersions: ['1.21.11'] };");
    writeFileSync(path.join(root, 'viewer/lib/worldView.js'), `class WorldView { constructor(world, d, pos, emitter) { this.emitter = emitter; emitter.on('mouseClick', () => {}); }
      listenToBot() { this.emitter.emit('entity', { id: 7, pos: { x: 1, y: 2, z: 3 } }); } removeListenersFromBot() {} removeAllListeners() {}
      async init() { this.emitter.emit('loadChunk', { x: 0, z: 0, chunk: '{}' }); } async updatePosition() {} }
      module.exports = { WorldView };`);
    const sent: any[] = [];
    const child = Object.assign(new EventEmitter(), { connected: true, send: vi.fn((m: any) => { sent.push(m); if (m.type === 'init') setImmediate(() => child.emit('message', { type: 'ready', id: m.id })); return true; }),
      disconnect: vi.fn(() => { child.connected = false; }), kill: vi.fn(() => true) });
    const bot = Object.assign(new EventEmitter(), { version: '1.21.11', world: {}, entity: { position: new Vec3(1, 64, 2), height: 1.8, yaw: 0.5, pitch: -0.1 } });
    try {
      const session = await createRenderProcessSession(bot, root, () => child as any);
      expect(sent.map(m => m.type === 'event' ? m.name : m.type)).toEqual(['init', 'entity', 'loadChunk']);
      const pending = session.capture(new AbortController().signal); await new Promise(resolve => setImmediate(resolve));
      const request = sent.at(-1); expect(request).toMatchObject({ type: 'capture', pose: { x: 1, z: 2, yaw: 0.5, pitch: -0.1 } });
      expect(request.pose.y).toBeCloseTo(64 + 1.8 * 0.9);
      child.emit('message', { type: 'captured', id: request.id, dataUrl: 'data:image/jpeg;base64,YQ==', capturedAt: '2026-10-14T00:00:00.000Z' });
      await expect(pending).resolves.toEqual({ dataUrl: 'data:image/jpeg;base64,YQ==', capturedAt: '2026-10-14T00:00:00.000Z' });
      const abort = new AbortController(), aborted = session.capture(abort.signal); await new Promise(resolve => setImmediate(resolve));
      abort.abort(); await expect(aborted).rejects.toThrow();
      const failed = session.capture(new AbortController().signal); await new Promise(resolve => setImmediate(resolve));
      child.emit('message', { type: 'failed', id: sent.at(-1).id, error: 'BODY_CAPTURE_GEOMETRY_PENDING' });
      await expect(failed).rejects.toThrow('GEOMETRY_PENDING');
      const lost = session.capture(new AbortController().signal); await new Promise(resolve => setImmediate(resolve));
      child.emit('exit', 1, null); await expect(lost).rejects.toThrow('RENDERER_EXITED code=1');
      // A dead renderer is not fed: the body stops reading chunks for it at once.
      expect(session.alive!()).toBe(false); expect(bot.listenerCount('move')).toBe(0);
      await expect(session.capture(new AbortController().signal)).rejects.toThrow();
      await session.dispose(); expect(child.disconnect).toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('kills a renderer process that does not start, and refuses versions it has no exact assets for', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'renderer-ipc-'));
    writeFileSync(path.join(root, 'package.json'), '{"name":"prismarine-viewer"}');
    mkdirSync(path.join(root, 'viewer/lib'), { recursive: true });
    writeFileSync(path.join(root, 'viewer/lib/version.js'), "module.exports = { supportedVersions: ['1.21.11'] };");
    writeFileSync(path.join(root, 'viewer/lib/worldView.js'), 'module.exports = { WorldView: class {} };');
    const child = Object.assign(new EventEmitter(), { connected: true, disconnect: vi.fn(), kill: vi.fn(() => true),
      send: vi.fn((m: any) => { setImmediate(() => child.emit('message', { type: 'failed', id: m.id, error: 'no display' })); return true; }) });
    const launch = vi.fn(() => child as any);
    try {
      const bot = { version: '1.21.11', world: {}, entity: { position: new Vec3(0, 64, 0) }, on: vi.fn() };
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      await expect(createRenderProcessSession(bot, root, launch)).rejects.toThrow('no display');
      expect(child.disconnect).toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled(); expect(bot.on).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5000); expect(child.kill).toHaveBeenCalledWith('SIGKILL'); vi.useRealTimers();
      await expect(createRenderProcessSession({ ...bot, version: '1.21.10' }, root, launch)).rejects.toThrow('EXACT_VERSION');
      expect(launch).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); }
  });
  it('tears down a renderer that stops answering, and stops claiming it can draw', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'renderer-ipc-'));
    writeFileSync(path.join(root, 'package.json'), '{"name":"prismarine-viewer"}');
    mkdirSync(path.join(root, 'viewer/lib'), { recursive: true });
    writeFileSync(path.join(root, 'viewer/lib/version.js'), "module.exports = { supportedVersions: ['1.21.11'] };");
    writeFileSync(path.join(root, 'viewer/lib/worldView.js'), `class WorldView { constructor(w, d, p, emitter) {} listenToBot() {} removeListenersFromBot() {}
      removeAllListeners() {} async init() {} async updatePosition() {} } module.exports = { WorldView };`);
    const child = Object.assign(new EventEmitter(), { connected: true, disconnect: vi.fn(), kill: vi.fn(() => true),
      send: vi.fn((m: any) => { if (m.type === 'init') setImmediate(() => child.emit('message', { type: 'ready', id: m.id })); return true; }) });
    const bot = Object.assign(new EventEmitter(), { version: '1.21.11', world: {}, entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 } });
    try {
      const images = createBodyImageCapture(bot, { create: b => createRenderProcessSession(b, root, () => child as any) });
      images.prepare(); for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      const first = expect(images.capture(new AbortController().signal)).rejects.toThrow('RENDERER_TIMEOUT');
      await vi.advanceTimersByTimeAsync(5000); await first;
      expect(child.kill).not.toHaveBeenCalled(); expect(images.configured).toBe(true);
      const second = expect(images.capture(new AbortController().signal)).rejects.toThrow('RENDERER_TIMEOUT');
      await vi.advanceTimersByTimeAsync(5000); await second;
      expect(child.kill).toHaveBeenCalledWith('SIGKILL'); expect(images.configured).toBe(false); expect(bot.listenerCount('move')).toBe(0);
      await expect(images.capture(new AbortController().signal)).rejects.toThrow('UNAVAILABLE');
    } finally { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); }
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
