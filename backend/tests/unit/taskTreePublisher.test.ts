import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.stubGlobal('fetch', fetchMock);
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({
  CONFIG: { UI_MOD_BASE_URL: 'http://127.0.0.1:9999' },
}));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/services/common/webConversationPort.js', () => ({
  createRequestWebConversation: () => ({ publishPlanning: vi.fn(async () => ({ status: 'sent' })) }),
}));
vi.mock('../../src/services/common/discordConversationPort.js', () => ({
  createRequestDiscordConversation: () => ({ publishPlanning: vi.fn(async () => ({ status: 'sent' })) }),
}));

import { TaskTreePublisher } from '../../src/services/llm/graph/nodes/execution/TaskTreePublisher.js';

const taskTree = {
  goal: 'test goal',
  status: 'in_progress',
  strategy: '',
  hierarchicalSubTasks: [],
  currentSubTaskId: null,
  subTasks: null,
} as const;

afterEach(() => {
  fetchMock.mockClear();
});

describe('TaskTreePublisher minebot UI scope', () => {
  it('does not POST to Minebot UI without minecraft envelope scope', () => {
    const publisher = new TaskTreePublisher();
    publisher.publishTaskTree(taskTree as any, {
      platform: 'minecraft',
      channelId: null,
      taskId: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to Minebot UI when envelope includes server/world ids', async () => {
    const publisher = new TaskTreePublisher();
    publisher.publishTaskTree(taskTree as any, {
      platform: 'minecraft',
      channelId: null,
      taskId: 'task-1',
      envelope: {
        channel: 'minecraft',
        requestId: 'req-1',
        minecraft: { serverId: 'server-a', worldId: 'world-a' },
      } as any,
    });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/task');
  });

  it('does not POST detailed logs without minecraft envelope scope', async () => {
    const publisher = new TaskTreePublisher();
    await publisher.postDetailedLogToMinebotUi('goal', 'tool_call', 'info', 'chat', 'running');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
