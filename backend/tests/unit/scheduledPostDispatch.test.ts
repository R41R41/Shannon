import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventRouter } from '../../src/services/llm/routing/EventRouter.js';
import { registerLlmInbound, clearLlmInbound } from '../../src/services/runtime/llmInboundRegistry.js';
import { deliverScheduledPostToLlm } from '../../src/services/runtime/llmInboundDispatch.js';
vi.mock('../../src/services/llm/agents/realtimeApiAgent.js', () => ({ RealtimeAPIService: class {} }));
afterEach(() => clearLlmInbound());
function router(processCreateScheduledPost: ReturnType<typeof vi.fn>, isDevMode = false) {
  return new EventRouter({ isDevMode, agentOrchestrator: { processCreateScheduledPost } as any,
    realtimeApi: {} as any, voiceProcessor: {} as any, invokeGraph: vi.fn() });
}
describe('scheduled dispatch completion', () => {
  it('waits until generation and delivery finish', async () => {
    let finish!: () => void;
    const process = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    registerLlmInbound(router(process));
    let complete = false;
    const delivery = deliverScheduledPostToLlm({ command: 'news_today' } as any).then(() => { complete = true; });
    await Promise.resolve();
    expect(complete).toBe(false);
    finish();
    await delivery;
    expect(complete).toBe(true);
    expect(process).toHaveBeenCalledTimes(1);
  });
  it('propagates delivery failures to the scheduler error handler', async () => {
    registerLlmInbound(router(vi.fn(async () => { throw new Error('delivery failed'); })));
    await expect(deliverScheduledPostToLlm({ command: 'news_today' } as any)).rejects.toThrow('delivery failed');
  });
  it('preserves the development runtime guard', async () => {
    const process = vi.fn();
    registerLlmInbound(router(process, true));
    await deliverScheduledPostToLlm({ command: 'news_today' } as any);
    expect(process).not.toHaveBeenCalled();
  });
});
