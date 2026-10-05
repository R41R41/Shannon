import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { MinebotTaskRuntime } from '../../src/services/minebot/runtime/MinebotTaskRuntime.js';

function botFixture(): any {
  return Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' },
    health: 20, food: 20, inventory: { items: () => [] },
    registry: { blocksByName: {} }, findBlocks: () => [],
    clearControlStates: vi.fn(), pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
    minebotControlState: 'idle', suppressMinebotGameChat: false,
  });
}

afterEach(() => { vi.useRealTimers(); });

describe('a person speaking during a long task', () => {
  it('runs their task first and resumes the paused task from its checkpoint, in order', async () => {
    vi.useFakeTimers();
    const runtime = new MinebotTaskRuntime(botFixture());
    const runs: Array<{ text?: string; tags: string[]; metadata: any }> = [];
    const answers: Array<() => void> = [];
    const checkpoint = { messages: [{ role: 'user', content: 'エンドラを倒す' }, { role: 'assistant', content: '木を集めた' }],
      taskNodes: [], cognitiveWorkspace: { runId: 'campaign-run' } };
    runtime.setExecutor(async (envelope: any, _messages, options) => {
      runs.push({ text: envelope.text, tags: envelope.tags, metadata: envelope.metadata });
      if (envelope.tags.includes('user_chat')) {
        await new Promise<void>(resolve => answers.push(resolve));
        return { taskTree: { goal: envelope.text, status: 'completed' } };
      }
      if (runs.filter(run => !run.tags.includes('user_chat')).length === 1) {
        options!.onCheckpoint!(checkpoint as any);
        return new Promise(resolve => options!.abortSignal!.addEventListener('abort',
          () => resolve({ taskTree: { goal: 'エンドラを倒す', status: 'in_progress' } })));
      }
      return new Promise(() => {});
    });

    const campaign = runtime.addTaskToQueue({ userMessage: 'エンドラを倒す' });
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.isRunning()).toBe(true);

    const first = runtime.putTaskFirst({ userMessage: 'シャノン、こっち来て' },
      { tags: ['user_chat'], metadata: { humanChat: { player: 'Rai1241', message: 'シャノン、こっち来て' } } });
    expect(first.success).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(runs).toHaveLength(2);
    expect(runs[1].tags).toContain('user_chat');
    expect(runs[1].metadata.humanChat).toEqual({ player: 'Rai1241', message: 'シャノン、こっち来て' });
    const status = () => Object.fromEntries(runtime.getTaskListState().tasks.map(task => [task.id, task.status]));
    expect(status()[campaign.taskId!]).toBe('paused');

    // A second message waits behind the first and still goes ahead of the campaign; the answer in progress is not cut off.
    const second = runtime.putTaskFirst({ userMessage: 'シャノン、ありがとう' }, { tags: ['user_chat'] });
    expect(runtime.getTaskListState().tasks.map(task => task.id)).toEqual([first.taskId, second.taskId, campaign.taskId]);
    expect(runs).toHaveLength(2);

    answers.shift()!();
    await vi.advanceTimersByTimeAsync(600);
    expect(runs).toHaveLength(3);
    expect(runs[2].text).toBe('シャノン、ありがとう');
    answers.shift()!();
    await vi.advanceTimersByTimeAsync(600);
    expect(runs).toHaveLength(4);
    expect(runs[3].text).toBe('エンドラを倒す');
    expect(runs[3].tags).not.toContain('user_chat');
    expect(runs[3].metadata.previousMessages).toEqual(checkpoint.messages);
    expect(runs[3].metadata.previousCognitiveWorkspace).toEqual(checkpoint.cognitiveWorkspace);
    expect(runtime.getTaskListState().tasks.map(task => [task.id, task.status])).toEqual([[campaign.taskId, 'executing']]);
  });

  it('starts at once when nothing runs, ahead of a task waiting for a reply', async () => {
    vi.useFakeTimers();
    const runtime = new MinebotTaskRuntime(botFixture());
    const texts: string[] = [];
    runtime.setExecutor(async (envelope: any) => {
      texts.push(envelope.text);
      return envelope.tags.includes('user_chat') ? { taskTree: { goal: envelope.text, status: 'completed' } }
        : { recoveryStatus: 'awaiting_user', taskTree: { goal: envelope.text, status: 'in_progress' } };
    });
    const campaign = runtime.addTaskToQueue({ userMessage: 'エンドラを倒す' });
    await vi.advanceTimersByTimeAsync(600);
    expect(runtime.getTaskListState().tasks.find(task => task.id === campaign.taskId)?.status).toBe('awaiting_user');
    runtime.putTaskFirst({ userMessage: 'シャノン、元気？' }, { tags: ['user_chat'] });
    await vi.advanceTimersByTimeAsync(600);
    expect(texts).toEqual(['エンドラを倒す', 'シャノン、元気？']);
    // The campaign is still waiting for its owner (the probe) to continue it, not consumed by the chat.
    expect(runtime.getTaskListState().tasks.find(task => task.id === campaign.taskId)?.status).toBe('awaiting_user');
    expect(await runtime.resumeAwaitingCampaignTask(campaign.taskId!, 'エンドラを倒す')).toBe(true);
  });
});
