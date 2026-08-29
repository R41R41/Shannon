import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn(async () => ({ success: true, result: 'ok' })));

vi.mock('../../src/services/runtime/minebotSkillGateway.js', () => ({
  invokeMinebotSkillFromParameters: invoke,
}));
vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { minebotDispatcher } from '../../src/services/common/adapters/minebotDispatcher.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('minebotDispatcher envelope scope', () => {
  it('does not invoke skills without minecraft server/world scope', async () => {
    await minebotDispatcher.dispatch(
      { channel: 'minecraft', requestId: 'req-1' } as any,
      { message: 'hello' } as any,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('invokes skills when envelope includes minecraft scope', async () => {
    await minebotDispatcher.dispatch(
      {
        channel: 'minecraft',
        requestId: 'req-1',
        minecraft: { serverId: 'server-a', worldId: 'world-a' },
      } as any,
      { message: 'hello' } as any,
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0][0]).toBe('chat');
  });
});
