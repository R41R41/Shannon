import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { MinebotTaskRuntime } from '../../src/services/minebot/runtime/MinebotTaskRuntime.js';
import { CONFIG } from '../../src/services/minebot/config/MinebotConfig.js';

function botFixture(): any {
  return Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' },
    health: 20, food: 20, inventory: { items: () => [] },
    registry: { blocksByName: {} }, findBlocks: () => [],
    clearControlStates: vi.fn(), pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
    minebotControlState: 'idle', suppressMinebotGameChat: false,
  });
}

function envelope(): any {
  return { channel: 'minecraft', requestId: 'main-request', sourceUserId: 'minebot-system',
    conversationId: 'minecraft:unbound', threadId: 'minecraft:unbound', tags: ['minecraft'],
    text: 'エンドラを倒す', minecraft: { dimension: 'overworld', inventory: [] }, metadata: {} };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('MinebotTaskRuntime emergency ownership and continuation', () => {
  it('fences a late preempted run after the emergency takes logical ownership', async () => {
    vi.useFakeTimers();
    const bot = botFixture();
    const runtime: any = new MinebotTaskRuntime(bot);
    const oldRun = deferred<any>();
    const emergencyRun = deferred<any>();
    let calls = 0;
    runtime.setExecutor(async () => ++calls === 1 ? oldRun.promise : emergencyRun.promise);

    const main = runtime.invoke({ taskId: 'main', envelope: envelope(), userMessage: 'エンドラを倒す' });
    const preemption = runtime.interruptForEmergency('敵接近');
    await vi.advanceTimersByTimeAsync(CONFIG.EMERGENCY_INTERRUPT_WAIT_MS + 100);
    await preemption;
    const emergency = runtime.invoke({ taskId: 'emergency', isEmergency: true,
      envelope: envelope(), userMessage: '敵から逃げる' });
    expect(runtime.currentState.taskId).toBe('emergency');

    oldRun.resolve({ taskTree: { goal: 'エンドラを倒す', status: 'in_progress' } });
    await main;
    expect(runtime.currentState.taskId).toBe('emergency');
    expect(runtime.isRunning()).toBe(true);
    expect(bot.minebotControlState).toBe('emergency_llm');
    expect(runtime.abortController?.signal.aborted).toBe(false);

    emergencyRun.resolve({ taskTree: { goal: '敵から逃げる', status: 'completed' } });
    await emergency;
    expect(runtime.currentState.taskId).toBe('emergency');
  });

  it('resumes a paused queue task with its last closed planner turn and workspace', async () => {
    vi.useFakeTimers();
    const runtime: any = new MinebotTaskRuntime(botFixture());
    const checkpoint = { messages: [{ role: 'user', content: 'エンドラを倒す' },
      { role: 'assistant', content: '木を集めた' }, { role: 'user', content: 'tool result: oak_log=4' }],
      taskNodes: [{ id: 'wood', status: 'completed' }],
      cognitiveWorkspace: { runId: 'main-request', goal: 'エンドラを倒す', receipts: [{ id: 'log-4' }] } };
    const originalEnvelope = envelope();
    runtime.taskQueue = [{ id: 'main', status: 'pending', createdAt: 1,
      state: { taskId: 'main', userMessage: 'エンドラを倒す', envelope: originalEnvelope },
      taskTree: { goal: 'エンドラを倒す', status: 'in_progress' } }];
    let calls = 0;
    let resumedEnvelope: any;
    runtime.setExecutor(async (runEnvelope: any, _messages: any, options: any) => {
      calls++;
      if (calls === 1) {
        options.onCheckpoint(checkpoint);
        return await new Promise(resolve => options.abortSignal.addEventListener('abort', () => resolve({
          taskTree: { goal: 'エンドラを倒す', status: 'in_progress' },
          savedMessages: checkpoint.messages, savedTaskNodes: checkpoint.taskNodes,
          savedCognitiveWorkspace: checkpoint.cognitiveWorkspace,
        }), { once: true }));
      }
      resumedEnvelope = runEnvelope;
      return { taskTree: { goal: 'エンドラを倒す', status: 'completed' } };
    });

    const main = runtime.executeNextTask();
    expect(runtime.taskQueue[0].state.continuationCheckpoint).toEqual(checkpoint);
    const preemption = runtime.interruptForEmergency('敵接近');
    await vi.advanceTimersByTimeAsync(100);
    await preemption;
    await main;
    expect(runtime.taskQueue[0].status).toBe('paused');
    const resume = runtime.resumePreviousTask();
    await vi.advanceTimersByTimeAsync(500);
    await resume;
    expect(calls).toBe(2);
    expect(resumedEnvelope.text).toBe('エンドラを倒す');
    expect(resumedEnvelope.metadata.previousMessages).toEqual(checkpoint.messages);
    expect(resumedEnvelope.metadata.previousTaskNodes).toEqual(checkpoint.taskNodes);
    expect(resumedEnvelope.metadata.previousCognitiveWorkspace).toEqual(checkpoint.cognitiveWorkspace);
    expect(originalEnvelope.metadata).toEqual({});
  });

  it('promotes a preempted direct chat task into the resumable queue', async () => {
    vi.useFakeTimers();
    const runtime: any = new MinebotTaskRuntime(botFixture());
    let calls = 0;
    let resumedEnvelope: any;
    runtime.setExecutor(async (runEnvelope: any, _messages: any, options: any) => {
      calls++;
      if (calls === 1) {
        return await new Promise(resolve => options.abortSignal.addEventListener('abort', () => resolve({
          taskTree: { goal: 'エンドラを倒す', status: 'in_progress' },
        }), { once: true }));
      }
      resumedEnvelope = runEnvelope;
      return { taskTree: { goal: 'エンドラを倒す', status: 'completed' } };
    });

    const main = runtime.invoke({ envelope: envelope(), userMessage: 'エンドラを倒す' });
    const directId = runtime.currentState.taskId;
    const preemption = runtime.interruptForEmergency('敵接近');
    await vi.advanceTimersByTimeAsync(100);
    await preemption;
    await main;
    expect(runtime.taskQueue).toHaveLength(1);
    expect(runtime.taskQueue[0]).toMatchObject({ id: directId, status: 'paused',
      state: { userMessage: 'エンドラを倒す' } });

    const resume = runtime.resumePreviousTask();
    await vi.advanceTimersByTimeAsync(500);
    await resume;
    expect(calls).toBe(2);
    expect(resumedEnvelope.text).toBe('エンドラを倒す');
  });

  it('continues an awaiting campaign turn only for its original task, goal and world', async () => {
    const runtime: any = new MinebotTaskRuntime(botFixture());
    const checkpoint = { messages: [{ role: 'user', content: 'エンドラを倒す' }],
      taskNodes: [], cognitiveWorkspace: { runId: 'campaign-run' } };
    runtime.taskQueue = [{ id: 'campaign', status: 'awaiting_user', createdAt: 1,
      state: { taskId: 'campaign', userMessage: 'エンドラを倒す', envelope: envelope(),
        continuationCheckpoint: checkpoint }, taskTree: { goal: 'エンドラを倒す', status: 'in_progress' } }];
    let resumedEnvelope: any;
    runtime.setExecutor(async (runEnvelope: any) => {
      resumedEnvelope = runEnvelope;
      return { taskTree: { goal: 'エンドラを倒す', status: 'completed' } };
    });
    expect(await runtime.resumeAwaitingCampaignTask('wrong', 'エンドラを倒す')).toBe(false);
    expect(await runtime.resumeAwaitingCampaignTask('campaign', '鉄ピッケルを作る')).toBe(false);
    expect(runtime.taskQueue[0].status).toBe('awaiting_user');

    runtime.taskQueue[0].state.envelope.minecraft.serverId = 'dev:another-world';
    await expect(runtime.resumeAwaitingCampaignTask('campaign', 'エンドラを倒す'))
      .rejects.toThrow('MINECRAFT_MEMORY_CONTEXT_CHANGED');
    expect(runtime.taskQueue[0].status).toBe('awaiting_user');
    runtime.taskQueue[0].state.envelope.minecraft.serverId = undefined;

    expect(await runtime.resumeAwaitingCampaignTask('campaign', 'エンドラを倒す')).toBe(true);
    await vi.waitFor(() => expect(resumedEnvelope).toBeDefined());
    expect(resumedEnvelope.text).toBe('エンドラを倒す');
    expect(resumedEnvelope.metadata.previousMessages).toEqual(checkpoint.messages);
    expect(resumedEnvelope.metadata.previousCognitiveWorkspace).toEqual(checkpoint.cognitiveWorkspace);
  });
});
