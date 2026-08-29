import { beforeEach, describe, expect, it, vi } from 'vitest';
const legacy = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock('../../src/services/eventBus/index.js', () => ({ getEventBus: () => ({ publish: legacy.publish }) }));
vi.mock('../../src/utils/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
import ChatOnWebTool from '../../src/services/llm/tools/utility/chatOnWeb.js';
import UpdatePlanTool from '../../src/services/llm/tools/utility/updatePlan.js';
import { bindWebConversation, type WebConversationRequest } from '../../src/modules/conversation/webConversation.js';
import { createRequestWebConversation, registerWebConversationTransport, bindRequestWebConversation } from '../../src/services/common/webConversationPort.js';
import { RunToolRegistry } from '../../src/modules/execution/runToolRegistry.js';
import { webDispatcher } from '../../src/services/common/adapters/webDispatcher.js';

const transport = { postMessage: vi.fn(async () => undefined), publishPlanning: vi.fn(async () => undefined) };
registerWebConversationTransport(transport);

function request(session = 'session-a'): WebConversationRequest {
  return {
    channel: 'web',
    requestId: 'request-1',
    conversationId: `web:${session}`,
    sourceUserId: 'user-1',
    metadata: { sessionId: session },
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('Web tools require a request-bound session', () => {
  it('does not post to Web UI without a bound request', async () => {
    await new ChatOnWebTool()._call({ message: 'not authorized' });
    expect(transport.postMessage).not.toHaveBeenCalled();
    expect(legacy.publish).not.toHaveBeenCalled();
  });

  it('binds web ports per run and cannot inherit another session', async () => {
    const registry = new RunToolRegistry<any>([new ChatOnWebTool(), new UpdatePlanTool()]);
    const a = registry.createTools(); const b = registry.createTools();
    bindRequestWebConversation(a, request('session-a')); bindRequestWebConversation(b, request('session-b'));
    const tool = (set: any[], name: string) => set.find(row => row.name === name);
    await tool(a, 'chat-on-web').invoke({ message: 'hello-a' });
    await tool(b, 'chat-on-web').invoke({ message: 'hello-b' });
    expect(transport.postMessage.mock.calls.map(([binding, message]) => [binding.sessionId, message])).toEqual([
      ['session-a', 'hello-a'], ['session-b', 'hello-b'],
    ]);
    expect(() => new RunToolRegistry([{ name: 'bad-web', setWebConversationPort() {} }])).toThrow('createForRun');
  });
});

describe('Web dispatcher uses the request-bound port', () => {
  it('refuses delivery when the envelope is not a web conversation', async () => {
    await expect(webDispatcher.dispatch({ channel: 'discord', requestId: 'x', conversationId: 'y', sourceUserId: 'z', tags: [], timestampIso: '' } as any, { message: 'hi' } as any))
      .rejects.toThrow();
  });

  it('delivers through the transport for a bound web envelope', async () => {
    await webDispatcher.dispatch(request() as any, { message: 'hello web' } as any);
    expect(transport.postMessage).toHaveBeenCalledOnce();
    expect(transport.postMessage.mock.calls[0][1]).toBe('hello web');
  });
});

describe('Web conversation binding', () => {
  it('derives sessionId from conversationId when metadata is absent', () => {
    expect(bindWebConversation({ channel: 'web', requestId: 'r', conversationId: 'web:derived', sourceUserId: 'u' })?.sessionId).toBe('derived');
  });
});
