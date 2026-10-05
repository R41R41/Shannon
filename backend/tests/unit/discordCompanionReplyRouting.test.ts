import { beforeEach, describe, expect, it, vi } from 'vitest';
const core = vi.hoisted(() => ({
  reply: vi.fn(async (): Promise<unknown> => ({ status: 'ineligible' })),
  context: vi.fn(async () => ({ status: 'ineligible' })),
}));
vi.mock('../../src/services/discord/client.js', () => ({ DiscordBot: { getInstance: () => ({ getRecentMessages: vi.fn(async () => []) }) } }));
vi.mock('../../src/utils/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }, createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }));
vi.mock('../../src/services/integration/configuredShannonCoreBridge.js', () => ({
  requestShannonCoreDiscordReply: core.reply, readShannonCoreDiscordContext: core.context, mirrorCompletedDiscordTurn: vi.fn(async () => undefined),
}));
import { registerDiscordConversationTransport } from '../../src/services/common/discordConversationPort.js';
import { EventRouter } from '../../src/services/llm/routing/EventRouter.js';

const transport = { reply: vi.fn(async () => undefined), recent: vi.fn(async () => []) };
registerDiscordConversationTransport(transport);

const message = { type: 'text', text: 'マイクラで木材集めといて', userName: 'ライ', userId: '333', guildId: '', guildName: '', channelId: '555', channelName: 'DM', messageId: '901', isDM: true, recentMessages: [] };

describe('EventRouter with SHANNON_CORE_PLATFORM_REPLY', () => {
  beforeEach(() => { core.reply.mockReset(); transport.reply.mockClear(); });

  it('posts her reply from the companion in the same conversation and does not run the legacy graph', async () => {
    core.reply.mockResolvedValue({ status: 'available', reply: '任せてください。', threadId: 't', duplicate: false });
    const invokeGraph = vi.fn(async () => ({}));
    const router = new EventRouter({ invokeGraph, realtimeApi: {}, agentOrchestrator: {}, voiceProcessor: {}, isDevMode: true } as any);
    await (router as any).processDiscordMessage(message);
    expect(core.reply.mock.calls[0]![0]).toMatchObject({ channel: 'discord', text: 'マイクラで木材集めといて', discord: { isDM: true, channelId: '555', messageId: '901' } });
    expect(transport.reply).toHaveBeenCalledOnce();
    expect(transport.reply.mock.calls[0]![1]).toBe('任せてください。');
    expect(invokeGraph).not.toHaveBeenCalled();
  });

  it('keeps the legacy graph when the companion is off, refuses, or fails', async () => {
    for (const status of ['ineligible', 'unavailable']) {
      core.reply.mockResolvedValue({ status });
      const invokeGraph = vi.fn(async () => ({}));
      const router = new EventRouter({ invokeGraph, realtimeApi: {}, agentOrchestrator: {}, voiceProcessor: {}, isDevMode: true } as any);
      await (router as any).processDiscordMessage(message);
      expect(invokeGraph).toHaveBeenCalledOnce();
    }
    expect(transport.reply).not.toHaveBeenCalled();
  });
});
