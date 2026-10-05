import { describe, expect, it } from 'vitest';
import { MinebotTaskRuntime } from '../../src/services/minebot/runtime/MinebotTaskRuntime.js';

describe('Minebot emergency task ownership', () => {
  it('keeps a preempted main task paused until emergency work resumes it', () => {
    const runtime: any = new MinebotTaskRuntime({} as any);
    runtime.taskQueue = [{ id: 'main', status: 'paused', createdAt: 1,
      state: { userMessage: 'dragon goal' }, taskTree: { goal: 'dragon goal', status: 'in_progress' } }];
    runtime.currentState = { taskId: 'main', createdAt: 1, recoveryStatus: 'idle',
      taskTree: { goal: 'dragon goal', status: 'in_progress' } };
    runtime.isEmergencyMode = true;

    runtime.handleTaskCompletion('main');

    expect(runtime.taskQueue).toHaveLength(1);
    expect(runtime.taskQueue[0].status).toBe('paused');
  });
});
