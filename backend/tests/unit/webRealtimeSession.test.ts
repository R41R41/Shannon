import { afterEach, describe, expect, it, vi } from 'vitest';

const emitPostMessage = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/web/webNotificationHub.js', () => ({
  getWebNotificationHub: () => ({ emitPostMessage }),
}));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn(), success: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { RealtimeAPIService } from '../../src/services/llm/agents/realtimeApiAgent.js';
import { EventRouter } from '../../src/services/llm/routing/EventRouter.js';
import { acquireWebRealtimeInput, clearWebRealtimeInputLockForTests } from '../../src/services/web/webRealtimeInputLock.js';

afterEach(() => {
  RealtimeAPIService.clearResponseSessionIdForTests();
  clearWebRealtimeInputLockForTests();
  vi.clearAllMocks();
});

describe('EventRouter realtime session routing', () => {
  it('includes the bound web session id in realtime hub payloads', () => {
    const realtimeApi = RealtimeAPIService.getInstance();
    realtimeApi.setResponseSessionId('session-a');
    const router = new EventRouter({
      isDevMode: true,
      realtimeApi,
      agentOrchestrator: {} as any,
      voiceProcessor: {} as any,
      invokeGraph: vi.fn(),
    });
    router.setupRealtimeAPICallback();
    realtimeApi.onTextResponse?.('hello');
    expect(emitPostMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'realtime_text',
      realtime_text: 'hello',
      sessionId: 'session-a',
    }));
  });

  it('rejects a second realtime owner while the lock is held', async () => {
    acquireWebRealtimeInput('session-a');
    const realtimeApi = {
      setResponseSessionId: vi.fn(),
      getResponseSessionId: vi.fn(() => 'session-b'),
      inputAudioBufferAppend: vi.fn(async () => undefined),
      inputAudioBufferCommit: vi.fn(async () => undefined),
      inputText: vi.fn(async () => undefined),
      vadModeChange: vi.fn(async () => undefined),
      setTextCallback: vi.fn(),
      setTextDoneCallback: vi.fn(),
      setAudioCallback: vi.fn(),
      setAudioDoneCallback: vi.fn(),
      setUserTranscriptCallback: vi.fn(),
    };
    const router = new EventRouter({
      isDevMode: true,
      realtimeApi: realtimeApi as any,
      agentOrchestrator: {} as any,
      voiceProcessor: {} as any,
      invokeGraph: vi.fn(),
    });
    await (router as any).processWebMessage({
      type: 'realtime_audio',
      command: 'realtime_audio_append',
      realtime_audio: 'abc',
      sessionId: 'session-b',
    });
    expect(realtimeApi.inputAudioBufferAppend).not.toHaveBeenCalled();
  });
});
