import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ process: vi.fn(), shell: vi.fn((_command: string) => '') }));
vi.mock('../../src/services/minecraft/serverProcessStatus.js', () => ({ shannonHomeProcessStatus: mocks.process }));
vi.mock('child_process', () => ({ exec: (text: string, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
  callback(null, { stdout: mocks.shell(text), stderr: '' });
} }));
vi.mock('../../src/services/common/BaseClient.js', () => ({ BaseClient: class {} }));
vi.mock('../../src/config/env.js', () => ({ config: { minecraft: { serverBasePath: '/registered-worlds' } } }));
vi.mock('../../src/services/runtime/serviceCommandRegistry.js', () => ({ registerServiceCommandHandler: vi.fn() }));
vi.mock('../../src/services/web/webNotificationHub.js', () => ({ emitWebServiceStatus: vi.fn() }));
vi.mock('../../src/utils/logger.js', () => ({ logger: { info: vi.fn() } }));
import { MinecraftClient } from '../../src/services/minecraft/client.js';

beforeEach(() => vi.clearAllMocks());
describe('home-only management status with the existing desktop vocabulary', () => {
  it.each(['running', 'stopped'])('projects a confirmed %s home state', async state => {
    mocks.process.mockResolvedValue(state);
    expect(await new MinecraftClient('minecraft', true).getServerStatus('shannon-home')).toBe(state);
    expect(mocks.shell).not.toHaveBeenCalled();
  });
  it('projects unknown as connecting and refuses a new start without invoking a script', async () => {
    mocks.process.mockResolvedValue('unknown');
    const client = new MinecraftClient('minecraft', true);
    expect(await client.getServerStatus('shannon-home')).toBe('connecting');
    expect(await client.startServer('shannon-home')).toMatchObject({ success: false });
    expect(await client.stopServer('shannon-home')).toMatchObject({ success: false });
    expect(mocks.shell).not.toHaveBeenCalled();
  });
  it('preserves the registered start wrapper when home is confirmed stopped', async () => {
    mocks.process.mockResolvedValue('stopped');
    mocks.shell.mockReturnValue('');
    expect(await new MinecraftClient('minecraft', true).startServer('shannon-home')).toMatchObject({ success: true });
    expect(mocks.shell).toHaveBeenCalledWith('cd /registered-worlds/shannon-home && ./start.sh ');
  });
  it('preserves other registered servers and their existing tmux lookup', async () => {
    mocks.shell.mockReturnValue('minecraft-test: 1 windows');
    expect(await new MinecraftClient('minecraft', true).getServerStatus('1.21.4-test')).toBe('running');
    expect(mocks.process).not.toHaveBeenCalled();
    expect(mocks.shell).toHaveBeenCalledWith('tmux list-sessions 2>/dev/null || true');
  });
});
