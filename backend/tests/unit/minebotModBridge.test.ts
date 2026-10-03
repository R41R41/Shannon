import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import type { Server } from 'node:http';

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({
  CONFIG: { MAX_TASK_QUEUE_SIZE: 3, MINEBOT_API_PORT: 0, UI_MOD_BASE_URL: 'http://127.0.0.1:1' },
}));

import {
  BotCommandService,
  isPlayerName,
  parseBotCommand,
  type CommandBotPort,
  type CommandRuntime,
} from '../../src/services/minebot/commands/BotCommandService.js';
import { MinebotHttpServer } from '../../src/services/minebot/http/MinebotHttpServer.js';
import { MinebotTaskRuntime } from '../../src/services/minebot/runtime/MinebotTaskRuntime.js';
import { bindMinecraftMemory } from '../../src/services/minebot/runtime/memoryContext.js';
import { minebotAdapter } from '../../src/services/common/adapters/minebotAdapter.js';

const TOKEN = 'm'.repeat(32);

function fakeRuntime(overrides: Partial<CommandRuntime> = {}): CommandRuntime & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isRunning: () => false,
    forceStop: () => { calls.push('forceStop'); },
    resumeByControl: async () => ({ success: false, reason: 'NO_WAITING_TASK' }),
    getTaskListState: () => ({ currentTaskId: null }),
    removeTask: (id) => { calls.push(`remove:${id}`); return { success: true }; },
    ...overrides,
  };
}

function fakeBot(visible: string[] = []): CommandBotPort & { said: string[]; skills: unknown[][]; followOn: boolean } {
  const bot = {
    said: [] as string[],
    skills: [] as unknown[][],
    followOn: true,
    canSee: (name: string) => visible.includes(name),
    runSkill: async (name: string, ...args: unknown[]) => { bot.skills.push([name, ...args]); return { success: true, result: '' }; },
    disableConstantSkill: (name: string) => {
      if (name !== 'auto-follow' || !bot.followOn) return false;
      bot.followOn = false;
      return true;
    },
    say: (message: string) => { bot.said.push(message); },
  };
  return bot;
}

describe('bot command parsing', () => {
  it('accepts only the known commands and real player names', () => {
    expect(parseBotCommand('STOP')).toBe('STOP');
    expect(parseBotCommand('stop')).toBeNull();
    expect(parseBotCommand('DROP_TABLE')).toBeNull();
    expect(parseBotCommand(undefined)).toBeNull();
    expect(isPlayerName('Steve_01')).toBe(true);
    for (const bad of ['', 'a'.repeat(17), 'has space', 'シャノン', 42, null]) expect(isPlayerName(bad)).toBe(false);
  });
});

describe('BotCommandService', () => {
  it('STOP stops the task, the follow skill and movement, and says so', async () => {
    const runtime = fakeRuntime({ isRunning: () => true });
    const bot = fakeBot();
    const changed = vi.fn(async () => {});
    const result = await new BotCommandService(runtime, bot, changed).run('STOP', 'Steve');
    expect(result.success).toBe(true);
    expect(runtime.calls).toContain('forceStop');
    expect(bot.followOn).toBe(false);
    expect(changed).toHaveBeenCalledOnce();
    expect(bot.skills).toEqual([['stop-movement']]);
    expect(bot.said).toHaveLength(1);
  });

  it('FOLLOW and COME need the player in sight and leave the current task for the player', async () => {
    const hidden = fakeBot();
    const runtime = fakeRuntime({ isRunning: () => true });
    expect((await new BotCommandService(runtime, hidden).run('FOLLOW', 'Steve')).success).toBe(false);
    expect(runtime.calls).not.toContain('forceStop');
    expect(hidden.skills).toEqual([]);

    const seen = fakeBot(['Steve']);
    expect((await new BotCommandService(runtime, seen).run('FOLLOW', 'Steve')).success).toBe(true);
    expect(runtime.calls).toContain('forceStop');
    expect(seen.skills).toEqual([['follow-entity', 'Steve', 3, 0]]);

    const come = fakeBot(['Steve']);
    await new BotCommandService(fakeRuntime(), come).run('COME', 'Steve');
    expect(come.skills).toEqual([['follow-entity', 'Steve', 2, 60_000]]);
  });

  it('RESUME uses the control resume and reports when nothing waits', async () => {
    const resumed = fakeRuntime({ resumeByControl: async () => ({ success: true }) });
    expect((await new BotCommandService(resumed, fakeBot()).run('RESUME', 'Steve')).success).toBe(true);
    expect((await new BotCommandService(fakeRuntime(), fakeBot()).run('RESUME', 'Steve')).success).toBe(false);
  });

  it('CANCEL removes the current task only', async () => {
    const idle = fakeRuntime();
    expect((await new BotCommandService(idle, fakeBot()).run('CANCEL', 'Steve')).success).toBe(false);
    expect(idle.calls).toEqual([]);
    const busy = fakeRuntime({ getTaskListState: () => ({ currentTaskId: 'task-1' }) });
    expect((await new BotCommandService(busy, fakeBot()).run('CANCEL', 'Steve')).success).toBe(true);
    expect(busy.calls).toEqual(['remove:task-1']);
  });
});

describe('MinebotHttpServer mod routes', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); })));
  });

  async function start(configure: (server: MinebotHttpServer) => void) {
    vi.stubEnv('MINEBOT_API_TOKEN', TOKEN);
    const http = new MinebotHttpServer({} as any, async () => {});
    configure(http);
    const listening = (http as any).app.listen(0, '127.0.0.1') as Server;
    servers.push(listening);
    await once(listening, 'listening');
    const base = `http://127.0.0.1:${(listening.address() as { port: number }).port}`;
    return (path: string, body: unknown) => fetch(base + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('/chat_message answers before the bot finishes working on the message', async () => {
    let finish: () => void = () => {};
    const received: string[] = [];
    const post = await start((http) => http.setOnChatMessageCallback(async (sender, message) => {
      received.push(`${sender}:${message}`);
      await new Promise<void>((resolve) => { finish = resolve; });
    }));
    const response = await post('/chat_message', { sender: 'Steve', message: ' こんにちは ' });
    expect(response.status).toBe(202);
    expect(received).toEqual(['Steve:こんにちは']);
    finish();
    expect((await post('/chat_message', { sender: 'Steve', message: '' })).status).toBe(400);
    expect((await post('/chat_message', { sender: 'not a name', message: 'x' })).status).toBe(400);
  });

  it('/bot_command validates input and returns the handler result', async () => {
    const handled: string[] = [];
    const post = await start((http) => http.setOnBotCommandCallback(async (command, sender) => {
      handled.push(`${command}:${sender}`);
      return { success: true, result: 'ok' };
    }));
    const ok = await post('/bot_command', { command: 'COME', sender: 'Steve' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ success: true, result: 'ok' });
    expect((await post('/bot_command', { command: 'EXPLODE', sender: 'Steve' })).status).toBe(400);
    expect((await post('/bot_command', { command: 'COME' })).status).toBe(400);
    expect(handled).toEqual(['COME:Steve']);
  });

  it('/bot_command is unavailable until a handler is set', async () => {
    const post = await start(() => {});
    expect((await post('/bot_command', { command: 'STOP', sender: 'Steve' })).status).toBe(503);
  });
});

describe('MinebotTaskRuntime.resumeByControl', () => {
  const makeBot = () => {
    const bot = Object.assign(new EventEmitter(), {
      game: { dimension: 'minecraft:overworld' }, connectedServerName: 'display',
      inventory: { items: () => [] }, entity: undefined, clearControlStates: () => {},
    });
    bindMinecraftMemory(bot, null);
    return bot;
  };

  it('does nothing when no task waits', async () => {
    const runtime = new MinebotTaskRuntime(makeBot() as any);
    expect(await runtime.resumeByControl()).toEqual({ success: false, reason: 'NO_WAITING_TASK' });
  });

  it('re-runs a waiting task with its own request and a fixed phrase, never new text', async () => {
    const bot = makeBot();
    const runtime = new MinebotTaskRuntime(bot as any);
    const seen: Array<{ text: string; metadata: Record<string, unknown> }> = [];
    let first = true;
    runtime.setExecutor(async (envelope) => {
      seen.push({ text: envelope.text ?? '', metadata: { ...(envelope.metadata ?? {}) } });
      if (first) {
        first = false;
        return { taskTree: { goal: '原木を集める', status: 'in_progress' }, recoveryStatus: 'awaiting_user' };
      }
      return { taskTree: { goal: '原木を集める', status: 'completed' } };
    });
    const envelope = minebotAdapter.toEnvelope({ senderName: 'Steve', senderId: 'Steve', message: '原木を集めて', serverName: 'display' });
    envelope.metadata = { ...envelope.metadata, memoryDisabled: true, marker: 'original' };
    await runtime.invoke({ envelope, userMessage: '原木を集めて', messages: [] });
    expect(runtime.currentState?.recoveryStatus).toBe('awaiting_user');

    expect(await runtime.resumeByControl()).toEqual({ success: true });
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1].text).toContain('続けて');
    expect(seen[1].metadata.marker).toBe('original');
    expect(seen[1].metadata.memoryDisabled).toBe(true);
  });
});
