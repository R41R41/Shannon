import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({
  CONFIG: { MAX_TASK_QUEUE_SIZE: 3, MINEBOT_API_PORT: 0, UI_MOD_BASE_URL: 'http://127.0.0.1:1', resolveMinecraftName: (name: string) => name },
}));

import { CommonFcaUiModBridge, describeCommand } from '../../src/services/minebot/integration/commonFca/uiModBridge.js';
import { createFcaUiControls, type FcaUiControlsOptions } from '../../src/services/minebot/integration/commonFca/uiModControls.js';
import { CommonFcaControlLoop, type CommonFcaActuator } from '../../src/services/minebot/integration/commonFca/controlLoop.js';
import type { MinecraftControlCommand } from '../../src/services/minebot/integration/commonFca/minecraftControlContract.js';
import { MinebotHttpServer } from '../../src/services/minebot/http/MinebotHttpServer.js';
import { notifyUiModVoiceTranscript } from '../../src/services/minebot/integration/uiModVoice.js';

const NOW = Date.parse('2026-10-17T10:00:00Z');
const context = (fields = {}) => ({ scopeKey: 'owner', taskId: 'task1', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 'session1',
  generation: 1, goal: '木を10個集める', completionCondition: '原木が10個以上', ...fields });
const command = (id: string, fields: Record<string, unknown> = {}): MinecraftControlCommand => ({ schemaVersion: 1, id, serverId: 'home',
  connectionId: 'connection1', kind: 'skill', context: context(), lease: { id: 'lease1', generation: 1, holder: 'task1' },
  deadlineAt: new Date(NOW + 60_000).toISOString(), skill: 'mine-block', arguments: { block: 'oak_log' }, ...fields } as MinecraftControlCommand);
const receipt = (id: string, fields = {}) => ({ id, connectionId: 'connection1', outcome: 'completed' as const, inputsReleased: true,
  observedAt: new Date(NOW).toISOString(), ...fields });

/** Records what the bridge posts to the mod, as parsed JSON per route. */
function modSpy() {
  const posts: Array<{ route: string; body: any }> = [];
  const fetcher = vi.fn(async (url: string, init: any) => { posts.push({ route: new URL(url).pathname, body: JSON.parse(init.body) }); return new Response('{}'); });
  const last = (route: string) => posts.filter(post => post.route === route).at(-1)?.body;
  return { fetcher: fetcher as unknown as typeof fetch, posts, last };
}
const flush = async () => { await vi.advanceTimersByTimeAsync(600); };

describe('common FCA task view for the UI mod', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows the running task, its steps and results, and clears the current task when it is released', async () => {
    const spy = modSpy();
    const bridge = new CommonFcaUiModBridge({ baseUrl: () => 'http://127.0.0.1:8086', fetcher: spy.fetcher });
    bridge.commandStarted(command('c1'));
    await flush();
    expect(spy.last('/task')).toMatchObject({ goal: '木を10個集める', strategy: '原木が10個以上', status: 'in_progress', currentSubTaskId: 's1',
      hierarchicalSubTasks: [{ id: 's1', goal: 'mine-block {"block":"oak_log"}', status: 'in_progress' }] });
    expect(spy.last('/task_list')).toMatchObject({ currentTaskId: 'task1', tasks: [{ id: 'task1', status: 'executing' }] });

    bridge.commandEnded(command('c1'), receipt('c1', { result: '4個掘った' }));
    bridge.commandStarted(command('c2', { skill: 'mine-block', arguments: { block: 'birch_log' } }));
    bridge.commandEnded(command('c2'), receipt('c2', { outcome: 'failed', result: 'NO_BLOCK', failureType: 'not_found' }));
    await flush();
    expect(spy.last('/task').hierarchicalSubTasks.map((step: any) => [step.status, step.result])).toEqual([['completed', '4個掘った'], ['error', 'NO_BLOCK']]);

    bridge.commandStarted(command('r', { kind: 'release' }));
    bridge.commandEnded(command('r', { kind: 'release' }), receipt('r'));
    await flush();
    expect(spy.last('/task')).toMatchObject({ status: 'completed' });
    expect(spy.last('/task_list')).toMatchObject({ currentTaskId: null, tasks: [] });
    expect(bridge.currentTaskId()).toBeNull();
    bridge.stop();
  });

  it('shows a cancelled task as aborted, and a new task replaces the old view', async () => {
    const spy = modSpy();
    const bridge = new CommonFcaUiModBridge({ baseUrl: () => 'http://127.0.0.1:8086', fetcher: spy.fetcher });
    bridge.commandStarted(command('c1'));
    const stop = command('s', { kind: 'stop', stop: { requestId: 'x', reason: 'cancel', context: context() } });
    bridge.commandStarted(stop); bridge.commandEnded(stop, receipt('s'));
    await flush();
    expect(spy.last('/task')).toMatchObject({ status: 'aborted' });
    bridge.commandStarted(command('n1', { context: context({ taskId: 'task2', goal: '家に帰る' }) }));
    await flush();
    expect(spy.last('/task')).toMatchObject({ goal: '家に帰る', status: 'in_progress', hierarchicalSubTasks: [{ id: 's1' }] });
    expect(bridge.currentTaskId()).toBe('task2');
    bridge.stop();
  });

  it('seeds the steps from the API on a reconnect, and stops showing a task that has gone quiet', async () => {
    const spy = modSpy();
    const bridge = new CommonFcaUiModBridge({ baseUrl: () => 'http://127.0.0.1:8086', fetcher: spy.fetcher });
    bridge.start();
    bridge.commandStarted(command('c1', { context: context({ taskState: { phase: 'running', progress: '3/10', recentResults: [{ name: 'goto', ok: true, summary: '着いた' }] } }) }));
    bridge.commandEnded(command('c1'), receipt('c1'));
    await flush();
    expect(spy.last('/task')).toMatchObject({ currentThinking: '3/10' });
    expect(spy.last('/task').hierarchicalSubTasks[0]).toMatchObject({ goal: 'goto', status: 'completed', result: '着いた' });
    await vi.advanceTimersByTimeAsync(130_000);
    expect(spy.last('/task_list')).toMatchObject({ currentTaskId: null });
    expect(spy.last('/task')).toMatchObject({ status: 'in_progress' });
    bridge.stop();
  });

  it('sends the developer log in batches, none lost, and never throws when the mod is down', async () => {
    const spy = modSpy();
    const bridge = new CommonFcaUiModBridge({ baseUrl: () => 'http://127.0.0.1:8086', fetcher: spy.fetcher });
    for (let i = 0; i < 5; i++) { bridge.commandStarted(command(`c${i}`)); bridge.commandEnded(command(`c${i}`), receipt(`c${i}`)); }
    await flush(); await flush();
    const lines = spy.posts.filter(post => post.route === '/task_logs').flatMap(post => post.body.logs);
    expect(lines).toHaveLength(10);
    expect(lines[0]).toMatchObject({ phase: 'tool_call', level: 'info', source: 'body' });
    expect(lines[1]).toMatchObject({ phase: 'tool_result', level: 'success' });
    const down = new CommonFcaUiModBridge({ baseUrl: () => 'http://127.0.0.1:1', fetcher: (async () => { throw new Error('refused'); }) as unknown as typeof fetch });
    expect(() => down.commandStarted(command('x'))).not.toThrow();
    await flush();
    bridge.stop(); down.stop();
  });

  it('describes a command in a few words', () => {
    expect(describeCommand({ kind: 'skill', skill: 'get-health', arguments: {} } as any)).toBe('get-health');
    expect(describeCommand({ kind: 'stop' } as any)).toBe('stop');
  });
});

describe('the control loop tells its watcher and can be stood still', () => {
  it('reports start and end of each command, ignores a watcher that throws, and abortActive cancels what runs', async () => {
    let done!: () => void;
    const actuator: CommonFcaActuator = { skills: [], observe: () => ({ schemaVersion: 1, bodyId: 'minecraft:home', sequence: 1, stateAt: new Date(NOW).toISOString(),
      receivedAt: new Date(NOW).toISOString(), state: {}, facts: {}, connected: true }), candidates: () => [], release: async () => true,
    execute: async (c, signal) => { await new Promise<void>(resolve => { done = resolve; signal.addEventListener('abort', () => resolve()); });
      return { id: c.id, connectionId: c.connectionId, outcome: signal.aborted ? 'cancelled' : 'completed', inputsReleased: true, observedAt: new Date(NOW).toISOString() }; } };
    const events: string[] = [];
    const loop = new CommonFcaControlLoop({ baseUrl: 'http://127.0.0.1:3000', token: 'fake-device-token', serverId: 'home', connectionId: 'connection1',
      now: () => NOW, actuator,
      observer: { commandStarted: c => { events.push(`start:${c.id}`); throw new Error('watcher failed'); }, commandEnded: (c, r) => { events.push(`end:${c.id}:${r.outcome}`); } },
      fetcher: vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, mode: 'common-fca', commands: [command('one', { deadlineAt: new Date(NOW + 1000).toISOString() })], cancel: [], acknowledged: [] }))) as any });
    await loop.poll(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(events).toEqual(['start:one']);
    expect(loop.abortActive()).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events).toEqual(['start:one', 'end:one:cancelled']);
    done?.(); await loop.stop();
  });
});

describe('what the mod buttons mean for the FCA body', () => {
  const setup = (overrides: Partial<FcaUiControlsOptions> = {}) => {
    const said: Array<[string, string]> = [];
    const told: string[] = [];
    const options: FcaUiControlsOptions = {
      say: async (speaker, message) => { said.push([speaker.name, message]); return true; },
      uuidOf: name => (name === 'Rai1241' ? 'uuid-rai' : undefined),
      humans: () => ['Rai1241'], abortActive: vi.fn(() => 1), currentTaskId: () => 'task1', taskList: () => ({ tasks: [] }),
      tell: message => { told.push(message); }, ...overrides,
    };
    return { controls: createFcaUiControls(options), said, told, options };
  };

  it('says each order to her mind in fixed words, and stops the body first for stop and cancel', async () => {
    const { controls, said, options } = setup();
    expect(await controls.command('FOLLOW', 'Rai1241')).toMatchObject({ success: true });
    expect(await controls.command('STOP', 'Rai1241')).toMatchObject({ success: true });
    expect(await controls.command('RESUME', '')).toMatchObject({ success: true });
    expect(said).toEqual([['Rai1241', 'ついてきて'], ['Rai1241', '止まって'], ['Rai1241', '続けて']]);
    expect(options.abortActive).toHaveBeenCalledTimes(1);
  });

  it('still stands still when her mind cannot be reached, but reports other orders as unavailable', async () => {
    const { controls, told } = setup({ say: async () => false });
    expect(await controls.command('STOP', 'Rai1241')).toMatchObject({ success: true });
    expect(told).toEqual(['止まったよ。']);
    expect(await controls.command('COME', 'Rai1241')).toMatchObject({ success: false, status: 503 });
    expect(await controls.command('COME', 'Nobody')).toMatchObject({ success: false, status: 409 });
  });

  it('gives items and switches follow only for the one player on the server; other skills are refused', async () => {
    const { controls, said } = setup();
    expect(await controls.giveItem('minecraft:oak_log', 8)).toMatchObject({ success: true });
    expect(said.at(-1)).toEqual(['Rai1241', 'oak_logを8個ちょうだい']);
    expect(await controls.switchSkill('auto-follow', true)).toMatchObject({ success: true });
    expect(said.at(-1)).toEqual(['Rai1241', 'ついてきて']);
    expect(await controls.switchSkill('auto-eat', true)).toMatchObject({ status: 409 });
    const crowded = setup({ humans: () => ['Rai1241', 'Other'] });
    expect(await crowded.controls.giveItem('stone', 1)).toMatchObject({ success: false, status: 409 });
  });

  it('acts for the player the mod names, even with several players on the server; a bad name falls back to the one player', async () => {
    const crowded = setup({ humans: () => ['Rai1241', 'Other'], uuidOf: name => `uuid-${name}` });
    expect(await crowded.controls.giveItem('minecraft:stone', 3, 'Other')).toMatchObject({ success: true });
    expect(crowded.said.at(-1)).toEqual(['Other', 'stoneを3個ちょうだい']);
    expect(await crowded.controls.switchSkill('auto-follow', false, 'Rai1241')).toMatchObject({ success: true });
    expect(crowded.said.at(-1)).toEqual(['Rai1241', '止まって']);
    expect(await crowded.controls.taskAction('delete', 'task1', 'Other')).toMatchObject({ success: true });
    expect(crowded.said.at(-1)).toEqual(['Other', '今の作業をやめて']);
    // Not a player name: ignored, and with two players there is no one to say it for.
    expect(await crowded.controls.giveItem('stone', 1, 'bad name!')).toMatchObject({ success: false, status: 409 });
    expect(await crowded.controls.taskAction('delete', 'task1', '')).toMatchObject({ success: false, status: 409 });
    const alone = setup();
    expect(await alone.controls.giveItem('stone', 1, 'bad name!')).toMatchObject({ success: true });
    expect(alone.said.at(-1)).toEqual(['Rai1241', 'stoneを1個ちょうだい']);
  });

  it('cancels only the task the mod is showing, and leaves ordering to her mind', async () => {
    const { controls, said } = setup();
    expect(await controls.taskAction('delete', 'other')).toMatchObject({ status: 404 });
    expect(await controls.taskAction('delete', 'task1')).toMatchObject({ success: true });
    expect(said.at(-1)?.[1]).toBe('今の作業をやめて');
    expect(await controls.taskAction('prioritize', 'task1')).toMatchObject({ status: 409 });
  });
});

describe('the HTTP routes the mod calls on the FCA body', () => {
  let server: MinebotHttpServer | null = null;
  afterEach(async () => { server?.getServer()?.closeAllConnections(); await server?.stop(); server = null; });

  async function start(chat: (sender: string, message: string) => Promise<void> = async () => {}, fca = true, humans = ['Rai1241']) {
    const sent: string[] = [];
    const speakers: string[] = [];
    const controls = createFcaUiControls({ say: async (speaker, message) => { speakers.push(speaker.name); sent.push(message); return true; }, uuidOf: () => 'uuid', humans: () => humans,
      abortActive: () => 0, currentTaskId: () => 'task1', taskList: () => ({ tasks: [], emergencyTask: null, currentTaskId: null }), tell: () => {} });
    server = new MinebotHttpServer({} as any, async () => {}, async () => {}, { machineToken: () => 'm'.repeat(32) });
    if (fca) server.setFcaControls(controls);
    server.setOnChatMessageCallback(chat);
    server.start(0);
    const http = server.getServer() as Server;
    await once(http, 'listening');
    const port = (http.address() as any).port;
    const call = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { authorization: `Bearer ${'m'.repeat(32)}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { call, sent, speakers };
  }

  it('answers /chat_message at once with 202 and validates it', async () => {
    let release!: () => void;
    const handled: string[] = [];
    const { call } = await start(async (sender, message) => { handled.push(`${sender}:${message}`); await new Promise<void>(resolve => { release = resolve; }); });
    const accepted = await call('/chat_message', { sender: 'Rai1241', message: ' こんにちは ' });
    expect(accepted.status).toBe(202);
    expect(handled).toEqual(['Rai1241:こんにちは']);
    release();
    expect((await call('/chat_message', { sender: 'bad name!', message: 'x' })).status).toBe(400);
    expect((await call('/chat_message', { sender: 'Rai1241', message: '' })).status).toBe(400);
  });

  it('says it for the player the mod names in `sender`, and needs no one-player guess then', async () => {
    const { call, sent, speakers } = await start(async () => {}, true, ['Rai1241', 'Other']);
    expect((await call('/throw_item', { itemName: 'minecraft:stick', count: 2 })).status).toBe(409);
    expect((await call('/throw_item', { itemName: 'minecraft:stick', count: 2, sender: 'Other' })).status).toBe(200);
    expect((await call('/constant_skill_switch', { skillName: 'auto-follow', status: 'true', sender: 'Rai1241' })).status).toBe(200);
    expect((await call('/task_delete', { taskId: 'task1', sender: 'Other' })).status).toBe(200);
    expect((await call('/task_prioritize', { taskId: 'task1', sender: 'Other' })).status).toBe(409);
    expect((await call('/task_delete', { taskId: 'task1', sender: 'bad name!' })).status).toBe(409);
    expect(speakers).toEqual(['Other', 'Rai1241', 'Other']);
    expect(sent).toEqual(['stickを2個ちょうだい', 'ついてきて', '今の作業をやめて']);
  });

  it('routes the orders to her mind, refuses the old runtime settings, and answers 404 to /bot_command on the old body', async () => {
    const { call, sent } = await start();
    expect((await call('/bot_command', { command: 'FOLLOW', sender: 'Rai1241' })).status).toBe(200);
    expect(sent).toEqual(['ついてきて']);
    expect((await call('/bot_command', { command: 'DROP', sender: 'Rai1241' })).status).toBe(400);
    expect((await call('/task_continue', {})).status).toBe(200);
    expect(sent.at(-1)).toBe('続けて');
    expect((await call('/task_delete', { taskId: 'task1' })).status).toBe(200);
    expect((await call('/task_prioritize', { taskId: 'task1' })).status).toBe(409);
    expect((await call('/reaction_setting_update', { eventType: 'damage' })).status).toBe(409);
    expect((await call('/constant_skill_switch', { skillName: 'auto-eat', status: 'true' })).status).toBe(409);
    expect((await call('/throw_item', { itemName: 'minecraft:stick', count: 2 })).status).toBe(200);
    expect(await (await call('/task_list')).json()).toMatchObject({ currentTaskId: null });
    await server!.stop(); server = null;
    const old = await start(async () => {}, false);
    expect((await old.call('/bot_command', { command: 'STOP', sender: 'Rai1241' })).status).toBe(404);
  });
});

describe('voice transcript for the speaker in Minecraft', () => {
  it('posts the words with the resolved Minecraft name, skips empty text, and ignores a missing mod', async () => {
    const calls: any[] = [];
    const fetcher = vi.fn(async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('{}'); });
    await notifyUiModVoiceTranscript({ text: ' シャノン、木を集めて ', discordName: 'ryo07010', mode: 'minebot' }, fetcher as unknown as typeof fetch);
    expect(calls[0].url).toBe('http://127.0.0.1:1/voice_transcript');
    expect(calls[0].body).toEqual({ text: 'シャノン、木を集めて', speaker: 'ryo07010', mcUsername: 'ryo07010', mode: 'minebot' });
    await notifyUiModVoiceTranscript({ text: '   ', discordName: 'x', mode: 'chat' }, fetcher as unknown as typeof fetch);
    expect(calls).toHaveLength(1);
    await expect(notifyUiModVoiceTranscript({ text: 'やあ', discordName: 'x', mode: 'chat' }, (async () => { throw new Error('down'); }) as unknown as typeof fetch)).resolves.toBeUndefined();
  });
});
