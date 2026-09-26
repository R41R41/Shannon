import { describe, expect, it, vi } from 'vitest';
import { bindDiscordConversation } from '../../../src/modules/conversation/discordConversation';
import { deliverDiscordPlanning } from '../../../src/services/discord/planningDelivery';

describe('Discord progress delivery', () => {
  it('serializes completion behind a pending send so no progress card remains', async () => {
    let finishSend!: () => void;
    const sentMessage = { id: '20', delete: vi.fn().mockResolvedValue(undefined) };
    const send = vi.fn(() => new Promise(resolve => { finishSend = () => resolve(sentMessage); }));
    const messages = {
      fetch: vi.fn()
        .mockResolvedValueOnce({ find: () => undefined })
        .mockResolvedValueOnce({ find: () => sentMessage }),
    };
    const channel = { isTextBased: () => true, send, messages };
    const client = { user: { id: '999' }, channels: { cache: new Map([['10', channel]]) } } as any;
    const binding = bindDiscordConversation({
      channel: 'discord', requestId: 'request', conversationId: 'conversation', sourceUserId: '1',
      discord: { guildId: '2', channelId: '10', messageId: '11', isDM: false },
    })!;
    const active = { goal: '調査', strategy: '実行中', status: 'in_progress' } as any;
    const completed = { ...active, status: 'completed' };

    const sending = deliverDiscordPlanning(client, binding, active, 'task', () => true);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const completing = deliverDiscordPlanning(client, binding, completed, 'task', () => true);
    finishSend();
    await Promise.all([sending, completing]);

    expect(sentMessage.delete).toHaveBeenCalledTimes(1);
  });
});
