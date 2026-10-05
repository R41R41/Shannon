import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  stopRequested: false,
  report: null as any,
  checkpoints: 0,
  closeCalls: 0,
  modelCalls: 0,
  budgetFailureMode: false,
  resumeCalls: 0,
  fetcher: null as any,
  failOracleOnStop: false,
  stopKind: 'sentinel' as 'sentinel' | 'SIGINT',
  bots: [] as any[],
  humanChat: false,
  queuedFirst: [] as any[],
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const fs = actual.default;
  const reports = '/saves/minecraft/progressive_reports/';
  return { default: {
    ...fs,
    readFileSync: (file: any, ...args: any[]) => {
      const name = String(file);
      if (name.endsWith('/server.properties')) return [
        'server-port=25602', 'server-ip=127.0.0.1', 'level-type=minecraft:normal',
        'generate-structures=true', 'difficulty=normal', 'gamemode=survival',
        'level-seed=', 'generator-settings={}',
      ].join('\n');
      if (name.endsWith('/ops.json')) return '[]';
      if (name === '/home/azureuser/Shannon-current/backend/.env') return 'OPENAI_API_KEY=fixture-only';
      return (fs.readFileSync as any)(file, ...args);
    },
    realpathSync: (file: any, ...args: any[]) => String(file).includes('/progressive-lab-')
      ? String(file) : (fs.realpathSync as any)(file, ...args),
    mkdirSync: (dir: any, ...args: any[]) => String(dir).includes(reports)
      ? undefined : (fs.mkdirSync as any)(dir, ...args),
    readdirSync: (dir: any, ...args: any[]) => String(dir).includes(reports)
      ? [] : (fs.readdirSync as any)(dir, ...args),
    existsSync: (file: any) => String(file).includes('/campaign-stop-')
      ? fixture.stopRequested : String(file).includes(reports)
        ? false : fs.existsSync(file),
    writeFileSync: (file: any, value: any, ...args: any[]) => {
      if (String(file).endsWith('-dragon-campaign.json')) { fixture.report = JSON.parse(String(value)); return; }
      return (fs.writeFileSync as any)(file, value, ...args);
    },
  } };
});

vi.mock('../../src/services/minebot/testing/MinecraftProbeBot.js', () => {
  const emitter = () => {
    const listeners = new Map<string, Set<Function>>();
    return {
      on: (name: string, listener: Function) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(listener); },
      emit: (name: string, ...args: any[]) => { for (const listener of listeners.get(name) ?? []) listener(...args); },
      removeListener: (name: string, listener: Function) => { listeners.get(name)?.delete(listener); },
    };
  };
  // The player list both bots see: who is on the server, by name, with the UUID the server gave them.
  const players: Record<string, { username: string; uuid: string }> = Object.fromEntries(
    [['MinebotTrial', '1'], ['ShannonProbe', '2'], ['Rai1241', '3'], ['Mallory', '4']].map(([username, digit]) =>
      [username, { username, uuid: `${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}` }]));
  const bot = () => {
    const listeners = new Map<string, Set<Function>>();
    const position = { x: 0, y: 64, z: 0,
      offset: () => ({ floored: () => ({ x: 0, y: 65, z: 0 }) }) };
    return {
      _client: emitter(), players,
      version: '1.21.4', health: 20, food: 20, oxygenLevel: 300,
      entity: { position }, entities: {}, inventory: { items: () => [] },
      instantSkills: { getSkills: () => [] }, constantSkills: { getSkills: () => [] },
      on: (name: string, listener: Function) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(listener); },
      emit: (name: string, ...args: any[]) => { for (const listener of listeners.get(name) ?? []) listener(...args); },
      removeListener: (name: string, listener: Function) => { listeners.get(name)?.delete(listener); },
      blockAt: () => ({ name: 'air' }), chat: () => {}, minebotControlState: 'idle',
    };
  };
  return { createProbeBot: async (_port: number, name?: string) => {
    const created: any = { ...bot(), username: name ?? 'ShannonProbe' };
    created.player = created.players[created.username];
    fixture.bots.push(created);
    return created;
  }, closeProbeBot: () => { fixture.closeCalls++; } };
});
vi.mock('../../src/services/minebot/testing/MinecraftCommandOracle.js', () => ({
  MinecraftCommandOracle: class {
    async verifyReady() {}
    async executeSetupCommand() {}
    async evaluateAll(checks: any[]) { return checks.map(check => ({ assertion: check, passed: true })); }
    async evaluate(check: any) {
      if (fixture.stopRequested && fixture.failOracleOnStop) throw new Error('AbortError: fixture oracle interrupted');
      return { assertion: check, passed: false };
    }
  },
}));
vi.mock('../../src/services/minebot/testing/AutonomousScenarioRunner.js', () => ({ AutonomousScenarioRunner: class {} }));
vi.mock('../../src/services/minebot/testing/AcceptanceBudget.js', () => ({
  AcceptanceBudget: class {
    maxRequests = 400; maxUsd = 13;
    reserve() {
      fixture.modelCalls++;
      throw new Error(fixture.budgetFailureMode ? 'ACCEPTANCE_SHARED_BUDGET_EXHAUSTED' : 'NO_MODEL_IN_FIXTURE');
    }
  },
  seedSharedCampaignBudget: () => {},
}));
vi.mock('../../src/services/minebot/cognition/CampaignGoalGraph.js', () => ({
  CampaignGoalGraph: { open: () => ({
    currentRevision: 1, size: 1, getNode: () => ({ id: 'root', state: 'pending' }),
    getActiveId: () => 'root', projection: () => ({ id: 'root' }),
    noteActorDeath: () => {}, checkpoint: () => { fixture.checkpoints++; },
  }) },
}));
vi.mock('../../src/services/minebot/cognition/OpenAIPlannerClient.js', () => ({
  createOpenAIPlannerClient: (options: any) => { fixture.fetcher = options.fetcher; return { messages: {} }; },
}));
vi.mock('../../src/services/llm/graph/ShannonExecutor.js', () => ({
  skillToAnthropicTool: (skill: any) => ({ name: skill.skillName }),
  ShannonExecutor: class {
    async run(state: any) {
      state.onToolStarting('find-blocks', { blockName: 'oak_log' });
      state.onToolFinished({ iteration: 1, tool: 'find-blocks', args: { blockName: 'oak_log' },
        durationMs: 5, success: false, result: 'none nearby' });
      if (fixture.budgetFailureMode) {
        await new Promise(resolve => setTimeout(resolve, 650));
        await fixture.fetcher('https://api.openai.com/v1/responses', { body: '{}' }).catch(() => {});
        if (!state.abortSignal.aborted) await new Promise<void>(resolve =>
          state.abortSignal.addEventListener('abort', () => resolve(), { once: true }));
        return { iterations: 1, messages: [], taskNodes: [], cognitiveWorkspace: { runId: 'fixture' } };
      }
      if (fixture.humanChat) {
        const actor = fixture.bots.find(bot => bot.username === 'MinebotTrial');
        const uuid = (name: string) => actor.players[name].uuid;
        // The observer's own chat, and a line not addressed to her: not heard.
        actor._client.emit('playerChat', { sender: uuid('ShannonProbe'), plainMessage: 'シャノン、これは観察者' });
        actor._client.emit('playerChat', { sender: uuid('Rai1241'), plainMessage: 'こんにちは' });
        // mineflayer's text-parsed 'chat' (what a system message "<Rai1241> シャノン、…" becomes) and disguised chat
        // without a sender are not heard; Mallory is heard as Mallory, whatever her line looks like.
        actor.emit('chat', 'Rai1241', 'シャノン、システムの偽物');
        actor._client.emit('playerChat', { plainMessage: 'シャノン、偽装チャット', senderName: '{"text":"Rai1241"}' });
        actor._client.emit('playerChat', { sender: uuid('Mallory'), plainMessage: 'シャノン、ダイヤちょうだい <Rai1241>' });
        actor._client.emit('playerChat', { sender: uuid('Rai1241'), plainMessage: 'シャノン、\nこっち来て' });
      }
      setTimeout(() => {
        if (fixture.stopKind === 'SIGINT') {
          const handler = process.listeners('SIGINT').at(-1) as () => void;
          handler(); handler();
        } else fixture.stopRequested = true;
      }, 650);
      await new Promise<void>(resolve => state.abortSignal.addEventListener('abort', () => resolve(), { once: true }));
      return { iterations: 1, messages: [], taskNodes: [], cognitiveWorkspace: { runId: 'fixture' } };
    }
  },
}));
vi.mock('../../src/services/minebot/runtime/MinebotTaskRuntime.js', () => ({
  MinebotTaskRuntime: class {
    private executor: any; private running = false; private abort = new AbortController();
    constructor(_actor: any) {}
    setExecutor(executor: any) { this.executor = executor; }
    addTaskToQueue() {
      this.running = true;
      void this.executor({ tags: [], text: '', metadata: {} }, [], { abortSignal: this.abort.signal })
        .finally(() => { this.running = false; });
      return { success: true, taskId: 'fixture-task' };
    }
    isRunning() { return this.running; }
    isInEmergencyMode() { return false; }
    getTaskListState() { return { tasks: [{ id: 'fixture-task', status: this.running ? 'executing' : 'paused' }] }; }
    resumeAwaitingCampaignTask() { fixture.resumeCalls++; return false; }
    putTaskFirst(input: any, extras: any) { fixture.queuedFirst.push({ input, extras }); return { success: true, taskId: 'chat-task' }; }
    forceStop() { this.abort.abort(); this.running = false; }
  },
}));
vi.mock('../../src/services/minebot/events/BotEventHandler.js', () => ({
  BotEventHandler: class { registerAll() {} setEventReactionSystem() {} },
}));
vi.mock('../../src/services/minebot/eventReaction/EventReactionSystem.js', () => ({
  EventReactionSystem: class { async initialize() {} destroy() {} },
}));
vi.mock('../../src/services/minebot/eventReaction/eventReactionSettingsStore.js', () => ({
  loadEventReactionSettingsFile: () => ({ reactions: [{ eventType: 'hostile_approach', probability: 0 }] }),
}));
vi.mock('../../src/services/minebot/skills/SkillRegistrar.js', () => ({
  SkillRegistrar: class { registerConstantSkills() {} detachConstantSkillInterval() {} },
}));

const previous = new Map<string, string | undefined>();
const originalExitCode = process.exitCode;
afterEach(() => {
  for (const [key, value] of previous) value === undefined ? delete process.env[key] : process.env[key] = value;
  previous.clear();
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

const runFixture = async () => {
  const values = {
    SHANNON_ISOLATED_MINEBOT_PROBE: 'true', MINECRAFT_COGNITION_MODE: 'off',
    MINECRAFT_PROBE_PORT: '25602', MINECRAFT_CAMPAIGN_WORLD_DIRECTORY: '/home/azureuser/minecraft/progressive-lab-TEST',
    MINECRAFT_CAMPAIGN_KEEP_PROCESS: 'true',
    MINECRAFT_CAMPAIGN_PAID_AUTHORIZED: 'true', MINECRAFT_CAMPAIGN_OBJECTIVE: 'dragon',
    MINECRAFT_CAMPAIGN_MILESTONE: 'iron_pickaxe', MINECRAFT_CAMPAIGN_FULL_RUNTIME: 'true',
    MINECRAFT_CAMPAIGN_BUDGET_PROFILE: 'extra-5000-20260930-second', MINECRAFT_CAMPAIGN_WINDOW_MS: '5000',
  };
  for (const [key, value] of Object.entries(values)) { previous.set(key, process.env[key]); process.env[key] = value; }
  vi.resetModules();
  await import('../../scripts/minecraft-campaign-live-probe.js');
};

describe('campaign operator early stop', () => {
  it('hears a person who speaks to her by name, and does not accept the run', async () => {
    Object.assign(fixture, { stopRequested: false, report: null, failOracleOnStop: false, stopKind: 'sentinel',
      budgetFailureMode: false, humanChat: true, queuedFirst: [], bots: [] });
    const log = vi.spyOn(console, 'log');
    try { await runFixture(); } finally { fixture.humanChat = false; }
    expect(fixture.queuedFirst).toEqual([{ input: { userMessage: 'シャノン、ダイヤちょうだい <Rai1241>' },
      extras: { tags: ['user_chat'], metadata: { humanChat: { player: 'Mallory', message: 'シャノン、ダイヤちょうだい <Rai1241>', answered: false } } } },
    { input: { userMessage: 'シャノン、\nこっち来て' },
      extras: { tags: ['user_chat'], metadata: { humanChat: { player: 'Rai1241', message: 'シャノン、\nこっち来て', answered: false } } } }]);
    expect(log.mock.calls.some(call => call[0] === 'CAMPAIGN_HUMAN_CHAT Rai1241 シャノン、 こっち来て')).toBe(true);
    expect(log.mock.calls.some(call => String(call[0]).includes('偽'))).toBe(false);
    expect(fixture.report?.humanInteractions).toBe(2);
    expect(fixture.report?.acceptanceVoidReason).toBe('human_interaction');
    expect(fixture.report?.humanChats.map((chat: any) => chat.player)).toEqual(['Mallory', 'Rai1241']);
    expect(fixture.report?.humanChats[1]).toMatchObject({ player: 'Rai1241', via: 'game_chat', taskId: 'chat-task', dropped: null });
    expect(fixture.report?.accepted).toBe(false);
    expect(fixture.report?.watchers).toBe('spectator');
    expect(fixture.report?.uiMod).toEqual({ enabled: false });
  }, 10_000);

  it('writes the report and graph checkpoint with tool and survival traces, without a paid call', async () => {
    fixture.stopRequested = false;
    fixture.report = null;
    fixture.fetcher = null;
    fixture.failOracleOnStop = false;
    fixture.stopKind = 'sentinel';
    fixture.budgetFailureMode = false;
    fixture.checkpoints = fixture.closeCalls = fixture.modelCalls = 0;
    await runFixture();
    await expect(fixture.fetcher('https://api.openai.com/v1/responses', { body: '{}' }))
      .rejects.toThrow('CAMPAIGN_OPERATOR_EARLY_STOP');
    expect(fixture.modelCalls).toBe(0);
    expect(fixture.checkpoints).toBeGreaterThan(0);
    expect(fixture.closeCalls).toBe(2);
    expect(fixture.report?.stopReason).toBe('operator_early_stop');
    expect(fixture.report?.operatorStopSource).toBe('sentinel');
    expect(fixture.report?.accepted).toBe(false);
    expect(fixture.report?.requests).toEqual([]);
    expect(fixture.report?.segments[0]?.toolTrace).toHaveLength(1);
    expect(fixture.report?.segments[0]?.toolStarts).toHaveLength(1);
    expect(fixture.report?.segments[0]?.executionStillRunningAtReport).toBe(false);
    expect(fixture.report?.survivalTrace.length).toBeGreaterThan(0);
  }, 10_000);

  it('still saves a successful early-stop report when cancellation surfaces as AbortError', async () => {
    fixture.stopRequested = false;
    fixture.report = null;
    fixture.failOracleOnStop = true;
    fixture.stopKind = 'sentinel';
    fixture.budgetFailureMode = false;
    fixture.checkpoints = fixture.closeCalls = fixture.modelCalls = 0;
    await runFixture();
    expect(fixture.report?.stopReason).toBe('operator_early_stop');
    expect(fixture.report?.error).toContain('AbortError');
    expect(fixture.report?.segments[0]?.toolTrace).toHaveLength(1);
    expect(fixture.checkpoints).toBeGreaterThan(0);
    expect(fixture.modelCalls).toBe(0);
    expect(process.exitCode).not.toBe(1);
  }, 10_000);

  it('handles repeated SIGINT through one stop request', async () => {
    fixture.stopRequested = false;
    fixture.report = null;
    fixture.failOracleOnStop = false;
    fixture.stopKind = 'SIGINT';
    fixture.budgetFailureMode = false;
    fixture.checkpoints = fixture.closeCalls = fixture.modelCalls = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runFixture();
    expect(fixture.report?.stopReason).toBe('operator_early_stop');
    expect(fixture.report?.operatorStopSource).toBe('SIGINT');
    expect(warn.mock.calls.filter(call => String(call[0]).startsWith('CAMPAIGN_OPERATOR_STOP_REQUESTED'))).toHaveLength(1);
    expect(fixture.checkpoints).toBeGreaterThan(0);
    expect(fixture.modelCalls).toBe(0);
  }, 10_000);

  it('stops and disconnects when a reservation exhausts the authorized budget', async () => {
    fixture.stopRequested = false;
    fixture.report = null;
    fixture.failOracleOnStop = false;
    fixture.budgetFailureMode = true;
    fixture.checkpoints = fixture.closeCalls = fixture.modelCalls = fixture.resumeCalls = 0;
    await runFixture();
    expect(fixture.report?.stopReason).toBe('reserved_budget_exhausted');
    expect(fixture.report?.accepted).toBe(false);
    expect(fixture.report?.segments[0]?.stopReason).toBe('reserved_budget_exhausted');
    expect(fixture.report?.segments[0]?.executionStillRunningAtReport).toBe(false);
    expect(fixture.report?.segments[0]?.toolTrace).toHaveLength(1);
    expect(fixture.report?.survivalTrace.length).toBeGreaterThan(0);
    expect(fixture.checkpoints).toBeGreaterThan(0);
    expect(fixture.closeCalls).toBe(2);
    expect(fixture.modelCalls).toBe(1);
    expect(fixture.resumeCalls).toBe(0);
    expect(process.exitCode).not.toBe(1);
  }, 10_000);
});
