import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { MinebotConfig, parseUiModBaseUrl } from '../../src/services/minebot/config/MinebotConfig.js';
import { MinebotTaskRuntime } from '../../src/services/minebot/runtime/MinebotTaskRuntime.js';
import { parseCompanionBodySettings, readCompanionBodyToken } from '../../src/services/minebot/integration/companionBodyConfig.js';
import { listenToPlayerChat } from '../../src/services/minebot/integration/gameChat.js';
import { MinebotCompanionBody } from '../../src/services/minebot/integration/MinebotCompanionBody.js';
import { companionBodyNow } from '../../src/services/minebot/integration/companionBodyParts.js';
import type { CompanionRequest, CompanionTurn } from '../../src/services/minebot/integration/CompanionBodyClient.js';
import { bindMinecraftMemory, minecraftMemoryContext } from '../../src/services/minebot/runtime/memoryContext.js';
import { performOpsCommand } from '../../src/services/integration/shannonOpsCommands.js';
import { tmuxListSessionsCommand } from '../../src/services/minecraft/client.js';

const OWNER = 'b9191317-c52d-4d67-85fe-ab831e6db146';
const SELF = '11111111-1111-1111-1111-111111111111';
const MALLORY = '44444444-4444-4444-4444-444444444444';
const REQUEST_ID = '7d0c1c5e-3b0a-4a51-9c58-2f6a8f0f3b11';
const knownServers = {
  '1.19.0-youtube': { port: 25564, version: '1.19.0' }, '1.21.1-play': { port: 25565, version: '1.21.1' },
  '1.21.11-fabric-youtube': { port: 25566, version: '1.21.11' }, '1.21.11-fabric-test': { port: 25567, version: '1.21.11' },
  'shannon-home': { port: 25560, version: '1.21.11' },
};
const settings = {
  url: 'http://127.0.0.1:4329', tokenFile: '/run/companion-body.token', serverId: 'shannon-home', serverName: 'shannon-home',
};
// The identity of shannon-home's world (docs/minebot-companion-body.md); a regenerated world gets a new worldId.
const homeIdentity = (environment: 'dev' | 'prod') => JSON.stringify({ version: 1, environment, bindings: [
  { name: 'shannon-home', host: '127.0.0.1', port: 25560, serverId: 'shannon-home', worldId: 'shannon_home-20261006' }] });

describe('companion body settings', () => {
  const parse = (raw: Record<string, string>) => parseCompanionBodySettings(raw,
    { knownServers, companionWorlds: ['shannon-home'], parseUiModBaseUrl });

  it('is off when nothing is set, and off (fail closed) when anything is missing or unsafe', () => {
    expect(parse({})).toEqual({ enabled: false, reason: null });
    expect(parse({ ...settings, tokenFile: '' })).toEqual({ enabled: false, reason: 'COMPANION_BODY_CONFIG_INCOMPLETE:tokenFile' });
    expect(parse({ ...settings, url: 'https://sh4nnon.com' })).toMatchObject({ enabled: false, reason: 'COMPANION_BODY_URL_MUST_BE_LOOPBACK' });
    // Never the YouTube or shared worlds: neither their names nor their ports.
    expect(parse({ ...settings, serverName: '1.21.11-fabric-youtube' })).toMatchObject({ enabled: false, reason: 'COMPANION_BODY_SERVER_NAME_SHARED' });
    expect(parse({ ...settings, serverName: 'other-home', serverPort: '25566', serverVersion: '1.21.11' }))
      .toMatchObject({ enabled: false, reason: 'COMPANION_BODY_SERVER_PORT_SHARED' });
    expect(parse({ ...settings, serverPort: '25561' })).toMatchObject({ enabled: false, reason: 'COMPANION_BODY_SERVER_PORT_MISMATCH' });
    expect(parse({ ...settings, serverVersion: '1.21.4' })).toMatchObject({ enabled: false, reason: 'COMPANION_BODY_SERVER_VERSION_MISMATCH' });
    expect(parse({ ...settings, serverName: 'other-home' })).toMatchObject({ enabled: false, reason: 'COMPANION_BODY_CONFIG_INCOMPLETE:serverPort' });
    expect(parse({ ...settings, serverName: 'other-home', serverPort: '25590', serverVersion: 'latest' }))
      .toMatchObject({ enabled: false, reason: 'COMPANION_BODY_SERVER_VERSION_INVALID' });
    expect(parse({ ...settings, serverName: 'shannon home' })).toMatchObject({ enabled: false, reason: 'COMPANION_BODY_SERVER_NAME_INVALID' });
    expect(parse({ ...settings, uiModBaseUrl: 'http://10.0.0.5:8095' })).toMatchObject({ enabled: false, reason: 'COMPANION_BODY_UI_MOD_URL_INVALID' });
    // shannon-home's port and version come from the table.
    expect(parse(settings)).toEqual({ enabled: true, url: 'http://127.0.0.1:4329', tokenFile: '/run/companion-body.token',
      serverId: 'shannon-home', serverName: 'shannon-home', serverPort: 25560, serverVersion: '1.21.11', uiModBaseUrl: null });
    expect(parse({ ...settings, serverName: 'other-home', serverPort: '25590', serverVersion: '1.21.11' }))
      .toMatchObject({ enabled: true, serverName: 'other-home', serverPort: 25590 });
  });

  it('shannon-home is in the table at 25560 / 1.21.11 with its UI mod at 8086; the mode is off and the other servers are as before', () => {
    const minebot = new MinebotConfig();
    expect(minebot.COMPANION_BODY).toEqual({ enabled: false, reason: null });
    expect(minebot.MINECRAFT_SERVERS).toEqual({ '1.21.4-test': 25566, '1.19.0-youtube': 25564, '1.21.1-play': 25565,
      '1.21.4-fabric-youtube': 25566, '1.21.11-fabric-youtube': 25566, '1.21.11-fabric-test': 25567, 'shannon-home': 25560 });
    for (const name of Object.keys(minebot.MINECRAFT_SERVERS)) expect(minebot.companionBodyFor(name)).toBeNull();
    expect(minebot.serverVersion('shannon-home')).toBe('1.21.11');
    expect(minebot.serverVersion('1.21.11-fabric-test')).toBe('1.21.11');
    expect(minebot.serverVersion('1.19.0-youtube')).toBe('1.19.0');
    expect(minebot.getUiModBaseUrl('shannon-home')).toBe(`http://${minebot.UI_MOD_HOST}:8086`);
    expect(minebot.getUiModBaseUrl('1.21.11-fabric-test')).toBe(`http://${minebot.UI_MOD_HOST}:8085`);
    expect(minebot.getUiModBaseUrl('1.21.4-test')).toBe(`http://${minebot.UI_MOD_HOST}:8081`);
  });

  it('on: the mode applies to shannon-home only, and may name its UI mod', () => {
    const minebot = new MinebotConfig();
    const before = { ...minebot.MINECRAFT_SERVERS };
    minebot.useCompanionBody(parseCompanionBodySettings({ ...settings, uiModBaseUrl: 'http://127.0.0.1:8086' }, minebot.companionBodyParseOptions()));
    expect(minebot.MINECRAFT_SERVERS).toEqual(before);
    expect(minebot.getUiModBaseUrl('shannon-home')).toBe('http://127.0.0.1:8086');
    expect(minebot.companionBodyFor('shannon-home')?.serverId).toBe('shannon-home');
    expect(minebot.companionBodyFor('1.21.11-fabric-test')).toBeNull();
    expect(minebot.companionBodyFor('1.21.11-fabric-youtube')).toBeNull();
    expect(minebot.getUiModBaseUrl('1.21.11-fabric-test')).toBe(`http://${minebot.UI_MOD_HOST}:8085`);
    // A new server name joins the table with its own port and version.
    const other = new MinebotConfig();
    other.useCompanionBody(parseCompanionBodySettings({ ...settings, serverName: 'other-home', serverPort: '25590', serverVersion: '1.21.4' },
      other.companionBodyParseOptions()));
    expect(other.MINECRAFT_SERVERS['other-home']).toBe(25590);
    expect(other.serverVersion('other-home')).toBe('1.21.4');
  });

  it('with shannon-home\'s world identity configured, its connection binds world memory and the other servers stay unbound', () => {
    const minebot = new MinebotConfig();
    const environment = minebot.IS_DEV ? 'dev' : 'prod';
    const previous = process.env.MINECRAFT_MEMORY_IDENTITIES;
    try {
      expect(minebot.getMemoryIdentity('shannon-home')).toBeNull();
      process.env.MINECRAFT_MEMORY_IDENTITIES = homeIdentity(environment);
      const identity = minebot.getMemoryIdentity('shannon-home');
      expect(identity).toEqual({ serverId: `${environment}:shannon-home`, worldId: 'shannon_home-20261006' });
      for (const name of Object.keys(minebot.MINECRAFT_SERVERS).filter(name => name !== 'shannon-home')) {
        expect(minebot.getMemoryIdentity(name)).toBeNull();
      }
      // What client.ts does on connect: the bot is bound to that world (server, world, dimension).
      const bot = Object.assign(new EventEmitter(), { game: { dimension: 'minecraft:overworld' } });
      bindMinecraftMemory(bot, identity);
      expect(minecraftMemoryContext(bot as any)).toEqual({ serverId: `${environment}:shannon-home`, worldId: 'shannon_home-20261006',
        dimension: 'minecraft:overworld' });
      const other = Object.assign(new EventEmitter(), { game: { dimension: 'minecraft:overworld' } });
      bindMinecraftMemory(other, minebot.getMemoryIdentity('1.21.11-fabric-test'));
      expect(minecraftMemoryContext(other as any)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.MINECRAFT_MEMORY_IDENTITIES;
      else process.env.MINECRAFT_MEMORY_IDENTITIES = previous;
    }
  });

  it('the management window can start the Minebot on shannon-home, and the server is watched on its own tmux socket', async () => {
    const dispatched: any[] = [];
    const statuses: Record<string, string> = { 'minecraft:shannon-home': 'running', 'minebot:bot': 'stopped' };
    const actions = {
      dispatch: async (service: string, command: string, serverName?: string) => {
        dispatched.push([service, command, serverName]);
        if (service === 'minebot:bot' && command === 'start') statuses['minebot:bot'] = 'running';
        return true;
      },
      statusOf: (service: string) => statuses[service] as any,
      scheduleNames: () => [], runSchedule: async () => {}, labRunning: async () => false,
    };
    expect(await performOpsCommand({ id: 'c1', type: 'minebot.start', target: 'minecraft:shannon-home' } as any, actions))
      .toEqual({ outcome: 'done' });
    expect(dispatched).toContainEqual(['minebot:bot', 'start', 'shannon-home']);
    expect(tmuxListSessionsCommand('shannon-home')).toBe('tmux -L shannon-home list-sessions 2>/dev/null || true');
    expect(tmuxListSessionsCommand('1.21.11-fabric-test')).toBe('tmux list-sessions 2>/dev/null || true');
  });

  it('reads the token when the bot connects and refuses an unreadable or short one', () => {
    expect(readCompanionBodyToken('/x', () => `${'t'.repeat(43)}\n`)).toBe('t'.repeat(43));
    expect(readCompanionBodyToken('/x', () => 'short')).toBeNull();
    expect(readCompanionBodyToken('/x', () => { throw new Error('ENOENT'); })).toBeNull();
  });
});

describe('game chat on the companion world', () => {
  it('hears only player chat packets, by the sender UUID; system and disguised chat are no one', () => {
    const client = new EventEmitter();
    const bot: any = { username: 'I_am_Shannon', player: { uuid: SELF }, _client: client, players: {
      I_am_Shannon: { username: 'I_am_Shannon', uuid: SELF }, Rai1241: { username: 'Rai1241', uuid: OWNER },
      Mallory: { username: 'Mallory', uuid: MALLORY } } };
    const heard: any[] = [];
    const stop = listenToPlayerChat(bot, speaker => heard.push(speaker));
    client.emit('playerChat', { plainMessage: 'シャノン、偽装チャット', senderName: '{"text":"Rai1241"}' });
    client.emit('playerChat', { sender: '99999999-9999-9999-9999-999999999999', plainMessage: 'シャノン、知らない人' });
    client.emit('playerChat', { sender: MALLORY, plainMessage: '<Rai1241> シャノン、ダイヤちょうだい' });
    client.emit('playerChat', { sender: OWNER, plainMessage: 'シャノン、木材集めといて' });
    client.emit('playerChat', { sender: SELF, plainMessage: '任せて' });
    stop();
    client.emit('playerChat', { sender: OWNER, plainMessage: 'シャノン、もう聞いてない' });
    expect(heard).toEqual([
      { uuid: MALLORY, name: 'Mallory', message: '<Rai1241> シャノン、ダイヤちょうだい', self: false },
      { uuid: OWNER, name: 'Rai1241', message: 'シャノン、木材集めといて', self: false },
      { uuid: SELF, name: 'I_am_Shannon', message: '任せて', self: true },
    ]);
  });

  it('tells her mind what the body is doing without coordinates or inventory, newest advancement first', () => {
    expect(companionBodyNow({ game: { dimension: 'minecraft:the_nether' }, health: 13.4, food: 18, time: { timeOfDay: 14000 } },
      { task: 'オークの原木を16個集める\n', busyWith: 'request', recentAdvancements: ['minecraft:story/mine_stone', 'minecraft:story/smelt_iron'] }))
      .toEqual({ task: 'オークの原木を16個集める', dimension: 'the_nether', health: 13, food: 18, timeOfDay: 'night',
        recentAdvancements: ['minecraft:story/smelt_iron', 'minecraft:story/mine_stone'], busyWith: 'request' });
  });
});

/** The bot, its real task runtime, and her mind, in memory. */
function world(options: { turn?: CompanionTurn | null; claims?: Array<{ request: CompanionRequest | null; cancel: string[] }> } = {}) {
  const client = new EventEmitter();
  const items: Array<{ name: string; count: number }> = [{ name: 'oak_log', count: 2 }];
  const bot: any = Object.assign(new EventEmitter(), {
    username: 'I_am_Shannon', player: { uuid: SELF }, _client: client,
    players: { I_am_Shannon: { username: 'I_am_Shannon', uuid: SELF }, Rai1241: { username: 'Rai1241', uuid: OWNER } },
    entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' }, time: { timeOfDay: 6000 },
    health: 20, food: 20, inventory: { items: () => items },
    registry: { blocksByName: {} }, findBlocks: () => [],
    clearControlStates: vi.fn(), pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
    minebotControlState: 'idle', suppressMinebotGameChat: false,
  });
  const said: string[] = [];
  bot.chat = (line: string) => said.push(line);
  const calls: any[] = [];
  const claims = [...(options.claims ?? [])];
  const companion = {
    async turn(input: any) { calls.push({ kind: 'turn', ...input }); return options.turn === undefined ? null : options.turn; },
    async died(cause: string, othersPresent: boolean) { calls.push({ kind: 'died', cause, othersPresent }); return true; },
    async claim(holding: readonly string[], _wait?: number, signal?: AbortSignal) {
      calls.push({ kind: 'claim', holding: [...holding] });
      const next = claims.shift();
      if (next) return next;
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, 20); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
      return { request: null, cancel: [] };
    },
    async progress(id: string, phase: string, step?: string) { calls.push({ kind: 'progress', id, phase, ...(step ? { step } : {}) }); return { state: 'running', cancel: false }; },
    async report(id: string, outcome: string, detail: any) { calls.push({ kind: 'report', id, outcome, ...detail }); return { state: outcome, recorded: true }; },
  };
  const runtime = new MinebotTaskRuntime(bot);
  const runs: any[] = [];
  const pushes: any[] = [];
  const fetcher = (async (url: string, init: any) => { pushes.push({ url, body: JSON.parse(init.body) }); return new Response('{}'); }) as unknown as typeof fetch;
  const body = new MinebotCompanionBody(bot, runtime, companion as any, { serverId: 'home-world',
    uiModBaseUrl: () => 'http://127.0.0.1:8095', lineLimit: 72, maxLines: 3, fetcher, loop: { watchMs: 10, retryMs: 10 } });
  // The production executor (SkillAgent): the run's result tells her mind how a request ended.
  let finish: (completed: boolean) => void = () => {};
  runtime.setExecutor(async (envelope: any, _messages, runOptions) => {
    runs.push({ text: envelope.text, tags: envelope.tags, metadata: envelope.metadata });
    runOptions?.onToolStarting?.('collect-block', {});
    const completed = await new Promise<boolean>(resolve => {
      finish = resolve;
      runOptions?.abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
    });
    items[0].count += completed ? 16 : 0;
    const result = { taskTree: { goal: envelope.text, status: completed ? 'completed' : 'error' } };
    body.noteRun(envelope, result);
    return result;
  });
  return { bot, client, runtime, body, calls, said, pushes, runs, finish: (completed: boolean) => finish(completed) };
}

const until = async (check: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

afterEach(() => { vi.restoreAllMocks(); });

describe('the production bot as her Minecraft body', () => {
  it('owner chat: her mind answers with the body\'s present, the reply is said and shown, and her task runs first', async () => {
    const reply = 'いいよ、オークの原木を16個集めてくるね。森はすぐそこだから、そんなに時間はかからないと思う。終わったら声をかけるから、それまで近くで待っていてくれると嬉しいな。夜になる前には戻るね。';
    const w = world({ turn: { reply, intent: { kind: 'task', goal: 'オークの原木を16個集める' }, duplicate: false } });
    w.body.start();
    expect(await w.body.answer({ uuid: OWNER, name: 'Rai1241' }, 'シャノン、木材集めといて')).toBe(true);
    const turn = w.calls.find(call => call.kind === 'turn');
    expect(turn).toMatchObject({ speakerUuid: OWNER, speakerName: 'Rai1241', message: 'シャノン、木材集めといて',
      body: { busyWith: 'idle', health: 20, food: 20, dimension: 'overworld', timeOfDay: 'day' } });
    expect(JSON.stringify(turn.body)).not.toMatch(/position|inventory|oak_log/);
    expect(w.said.length).toBeGreaterThan(1);
    expect(w.said.every(line => line.length <= 72)).toBe(true);
    expect(w.pushes).toEqual([{ url: 'http://127.0.0.1:8095/bot_chat', body: { message: reply } }]);
    await until(() => w.runs.length === 1);
    expect(w.runs[0]).toMatchObject({ text: 'オークの原木を16個集める', tags: expect.arrayContaining(['companion_task']),
      metadata: { companionTask: { player: 'Rai1241', answered: true }, memoryDisabled: true } });
    expect(w.runs[0].metadata.shannonCoreProjection).toContain('もう返事をしている');
    expect(w.body.bodyNow()).toMatchObject({ busyWith: 'request', task: 'オークの原木を16個集める' });
    w.finish(true);
    await w.body.stop();
  });

  it('companion down: the caller answers as before', async () => {
    const w = world({ turn: null });
    w.body.start();
    expect(await w.body.answer({ uuid: OWNER, name: 'Rai1241' }, 'シャノン、こんにちは')).toBe(false);
    expect(w.said).toEqual([]);
    expect(w.runs).toEqual([]);
    await w.body.stop();
  });

  it('a request is claimed, runs as her task ahead of others, and its result is reported with what she gained', async () => {
    const request: CompanionRequest = { id: REQUEST_ID, goal: 'オークの原木を16個集める', surface: 'text',
      createdAt: '2026-10-06T12:00:00.000Z', leaseExpiresAt: '2026-10-06T12:01:30.000Z' };
    const w = world({ claims: [{ request, cancel: [] }] });
    w.body.start();
    await until(() => w.runs.length === 1);
    expect(w.runs[0]).toMatchObject({ text: 'オークの原木を16個集める',
      metadata: { companionTask: { requestId: REQUEST_ID, player: 'owner', answered: true }, memoryDisabled: true } });
    expect(w.runs[0].metadata.shannonCoreProjection).toContain('チャットで返事や報告はしない');
    await until(() => w.calls.some(call => call.kind === 'progress' && call.phase === 'started'));
    expect(w.calls.find(call => call.kind === 'progress' && call.phase === 'started')).toMatchObject({ step: 'collect-block' });
    // The next claim says it still holds the request.
    await until(() => w.calls.filter(call => call.kind === 'claim').some(call => call.holding.includes(REQUEST_ID)));
    w.finish(true);
    await until(() => w.calls.some(call => call.kind === 'report'));
    expect(w.calls.find(call => call.kind === 'report')).toEqual({ kind: 'report', id: REQUEST_ID, outcome: 'done', gained: [{ item: 'oak_log', count: 16 }] });
    expect(w.body.takenRequests).toEqual([expect.objectContaining({ id: REQUEST_ID, outcome: 'done' })]);
    await w.body.stop();
  });

  it('reports her death with its cause, and a request she died on as died', async () => {
    const request: CompanionRequest = { id: REQUEST_ID, goal: '鉄を5個掘る', surface: 'voice',
      createdAt: '2026-10-06T12:00:00.000Z', leaseExpiresAt: '2026-10-06T12:01:30.000Z' };
    const w = world({ claims: [{ request, cancel: [] }] });
    w.bot.players.Rai1241 = { username: 'Rai1241', uuid: OWNER };
    w.body.start();
    await until(() => w.runs.length === 1);
    // Someone else's death, and a system line that only looks like hers, are not her death.
    w.bot.emit('message', { translate: 'death.attack.lava', with: [{ text: 'Rai1241' }] });
    w.bot.emit('death');
    w.bot.emit('message', { translate: 'death.attack.lava', with: [{ text: 'I_am_Shannon' }] });
    w.runtime.failCurrentTaskDueToDeath('溶岩');
    await until(() => w.calls.some(call => call.kind === 'died') && w.calls.some(call => call.kind === 'report'));
    expect(w.calls.filter(call => call.kind === 'died')).toEqual([{ kind: 'died', cause: 'minecraft:lava', othersPresent: true }]);
    expect(w.calls.find(call => call.kind === 'report')).toMatchObject({ id: REQUEST_ID, outcome: 'failed', code: 'died' });
    await w.body.stop();
  });

  it('a cancel from her mind stops the task; a disconnect reports what is left as run over and ends the claim', async () => {
    const OTHER = '9a1b2c3d-4e5f-4a51-9c58-2f6a8f0f3b11';
    const request = (id: string): CompanionRequest => ({ id, goal: '石を10個集める', surface: 'text',
      createdAt: '2026-10-06T12:00:00.000Z', leaseExpiresAt: '2026-10-06T12:01:30.000Z' });
    const w = world({ claims: [{ request: request(REQUEST_ID), cancel: [] }] });
    w.body.start();
    await until(() => w.runs.length === 1);
    (w.body as any).loop.cancelled(REQUEST_ID);
    await until(() => w.calls.some(call => call.kind === 'report'));
    expect(w.calls.find(call => call.kind === 'report')).toMatchObject({ id: REQUEST_ID, outcome: 'stopped', code: 'cancelled' });
    // The task is stopped: nothing of it waits or runs (the runtime shows a removed run as failed until the next one).
    await until(() => !w.runtime.isRunning());
    expect(w.runtime.getTaskListState().tasks.filter(task => ['pending', 'paused', 'executing'].includes(task.status))).toEqual([]);

    const v = world({ claims: [{ request: request(OTHER), cancel: [] }] });
    v.body.start();
    await until(() => v.runs.length === 1);
    v.bot.emit('end');
    await until(() => v.calls.some(call => call.kind === 'report'));
    expect(v.calls.find(call => call.kind === 'report')).toMatchObject({ id: OTHER, outcome: 'failed', code: 'run_over' });
    const claimsAtEnd = v.calls.filter(call => call.kind === 'claim').length;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(v.calls.filter(call => call.kind === 'claim').length).toBe(claimsAtEnd);
    expect(await v.body.answer({ uuid: OWNER, name: 'Rai1241' }, 'シャノン、いる？')).toBe(false);
  });
});


describe('common FCA body presence', () => {
  it('reads shared physical activity instead of the retired local task queue and never claims legacy requests', async () => {
    let busy = true;
    const bot: any = Object.assign(new EventEmitter(), { entity: {}, username: 'I_am_Shannon', health: 20, food: 20, chat: vi.fn() });
    const runtime: any = { getTaskListState: vi.fn(() => { throw Error('LEGACY_TASK_QUEUE_MUST_NOT_BE_READ'); }) };
    const client: any = { claim: vi.fn(), turn: vi.fn(), died: vi.fn(), progress: vi.fn(), report: vi.fn() };
    const body = new MinebotCompanionBody(bot, runtime, client, { serverId: 'home', uiModBaseUrl: () => 'http://127.0.0.1:1',
      commonFca: true, commonFcaBusy: () => busy });
    body.start();
    expect(body.bodyNow()).toMatchObject({ busyWith: 'request' });
    expect(body.bodyNow()).not.toHaveProperty('task');
    busy = false; expect(body.bodyNow()).toMatchObject({ busyWith: 'idle' });
    expect(runtime.getTaskListState).not.toHaveBeenCalled(); expect(client.claim).not.toHaveBeenCalled();
    await body.stop();
  });
});
