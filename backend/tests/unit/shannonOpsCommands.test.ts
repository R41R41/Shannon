import { describe, expect, it, vi } from 'vitest';
import {
  createOpsCommandPuller, opsCommandAllowed, performOpsCommand,
  type OpsCommandActions, type OpsObservedStatus,
} from '../../src/services/integration/shannonOpsCommands.js';

function actions(initial: Record<string, OpsObservedStatus>, overrides: Partial<OpsCommandActions> = {}) {
  const state = { ...initial };
  const calls: string[] = [];
  const value: OpsCommandActions = {
    async dispatch(service, command) {
      calls.push(`${service}:${command}`);
      if (!(service in state)) return false;
      if (command === 'start') state[service] = 'running';
      if (command === 'stop') state[service] = 'stopped';
      return true;
    },
    statusOf: service => state[service],
    scheduleNames: () => ['twitter:fortune'],
    runSchedule: async name => { calls.push(`schedule:${name}`); },
    labRunning: async () => false,
    ...overrides,
  };
  return { value, calls };
}

describe('Shannon operations commands', () => {
  it('keeps its own allowlist', () => {
    expect(opsCommandAllowed({ id: '1', type: 'service.stop', target: 'discord' })).toBe(false);
    expect(opsCommandAllowed({ id: '1', type: 'service.start', target: 'discord' })).toBe(true);
    expect(opsCommandAllowed({ id: '1', type: 'service.start', target: 'minebot' })).toBe(false);
    expect(opsCommandAllowed({ id: '1', type: 'service.start', target: 'minebot:bot' })).toBe(false);
    expect(opsCommandAllowed({ id: '1', type: 'service.stop', target: 'minebot:bot' })).toBe(true);
    expect(opsCommandAllowed({ id: '1', type: 'minecraft.start', target: 'minecraft:progressive-lab-1' })).toBe(false);
    expect(opsCommandAllowed({ id: '1', type: 'minecraft.stop', target: 'progressive-lab-1' })).toBe(false);
    expect(opsCommandAllowed({ id: '1', type: 'minecraft.start', target: 'minecraft:1.21.1-play' })).toBe(true);
    expect(opsCommandAllowed({ id: '1', type: 'minecraft.start', target: '1.21.1-play' })).toBe(false);
    expect(opsCommandAllowed({ id: '1', type: 'service.restart' as never, target: 'twitter' })).toBe(false);
  });

  it('starts and stops a service and tells what was already so', async () => {
    const { value, calls } = actions({ youtube: 'stopped', twitter: 'running' });
    await expect(performOpsCommand({ id: '1', type: 'service.start', target: 'youtube' }, value)).resolves.toEqual({ outcome: 'done' });
    expect(calls).toEqual(['youtube:status', 'youtube:start', 'youtube:status']);
    await expect(performOpsCommand({ id: '2', type: 'service.start', target: 'twitter' }, value)).resolves.toEqual({ outcome: 'refused', code: 'already_running' });
    await expect(performOpsCommand({ id: '3', type: 'service.stop', target: 'twitter' }, value)).resolves.toEqual({ outcome: 'done' });
    await expect(performOpsCommand({ id: '4', type: 'service.stop', target: 'twitter' }, value)).resolves.toEqual({ outcome: 'refused', code: 'already_stopped' });
    await expect(performOpsCommand({ id: '5', type: 'service.start', target: 'notion' }, value)).resolves.toEqual({ outcome: 'refused', code: 'not_registered' });
    await expect(performOpsCommand({ id: '6', type: 'service.stop', target: 'discord' }, value)).resolves.toEqual({ outcome: 'refused', code: 'not_allowed' });
  });

  it('does not start a Minecraft server during a paid lab run, and never touches a lab server', async () => {
    const lab = actions({ 'minecraft:1.21.1-play': 'stopped' }, { labRunning: async () => true });
    await expect(performOpsCommand({ id: '1', type: 'minecraft.start', target: 'minecraft:1.21.1-play' }, lab.value)).resolves.toEqual({ outcome: 'refused', code: 'lab_running' });
    expect(lab.calls).toEqual([]);
    // Stopping is not held back by a lab run.
    const running = actions({ 'minecraft:1.21.1-play': 'running' }, { labRunning: async () => true });
    await expect(performOpsCommand({ id: '2', type: 'minecraft.stop', target: 'minecraft:1.21.1-play' }, running.value)).resolves.toEqual({ outcome: 'done' });
    const free = actions({ 'minecraft:1.21.1-play': 'stopped' });
    await expect(performOpsCommand({ id: '3', type: 'minecraft.start', target: 'minecraft:1.21.1-play' }, free.value)).resolves.toEqual({ outcome: 'done' });
  });

  it('reports a start that did not take as failed, and an error as failed', async () => {
    const stuck = actions({ youtube: 'stopped' }, { dispatch: async () => true });
    await expect(performOpsCommand({ id: '1', type: 'service.start', target: 'youtube' }, stuck.value)).resolves.toEqual({ outcome: 'failed', code: 'error' });
    const broken = actions({ youtube: 'stopped' }, { dispatch: async () => { throw new Error('boom'); } });
    await expect(performOpsCommand({ id: '2', type: 'service.start', target: 'youtube' }, broken.value)).resolves.toEqual({ outcome: 'failed', code: 'error' });
  });

  it('runs only a schedule that exists', async () => {
    const { value, calls } = actions({});
    await expect(performOpsCommand({ id: '1', type: 'schedule.run', target: 'twitter:fortune' }, value)).resolves.toEqual({ outcome: 'done' });
    await expect(performOpsCommand({ id: '2', type: 'schedule.run', target: 'twitter:unknown' }, value)).resolves.toEqual({ outcome: 'refused', code: 'not_registered' });
    expect(calls).toEqual(['schedule:twitter:fortune']);
  });

  it('claims one command, performs it and reports the code', async () => {
    const { value } = actions({ youtube: 'stopped' });
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(init.body as string) });
      return url.endsWith('/claim')
        ? new Response(JSON.stringify({ command: requests.length === 1 ? { id: 'c-1', type: 'service.start', target: 'youtube' } : null }), { status: 200 })
        : new Response('{}', { status: 200 });
    });
    const config = { url: 'http://127.0.0.1:4319/v1/platform/turns', token: 'a'.repeat(32), timeoutMs: 3_000 };
    const puller = createOpsCommandPuller(config, value, fetcher as unknown as typeof fetch)!;
    await expect(puller.pull()).resolves.toBe('performed');
    expect(requests).toEqual([
      { url: 'http://127.0.0.1:4319/v1/platform/ops/commands/claim', body: { scopeKey: 'owner' } },
      { url: 'http://127.0.0.1:4319/v1/platform/ops/commands/c-1/report', body: { scopeKey: 'owner', outcome: 'done' } },
    ]);
    await expect(puller.pull()).resolves.toBe('idle');
    expect(createOpsCommandPuller({ ...config, token: 'short' }, value)).toBeNull();
  });

  it('reports a command that takes too long as a timeout', async () => {
    const slow = actions({ youtube: 'stopped' }, { dispatch: () => new Promise(() => undefined) });
    const reports: unknown[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
      if (url.endsWith('/claim')) return new Response(JSON.stringify({ command: { id: 'c-2', type: 'service.start', target: 'youtube' } }), { status: 200 });
      reports.push(JSON.parse(init.body as string));
      return new Response('{}', { status: 200 });
    };
    const puller = createOpsCommandPuller({ url: 'http://127.0.0.1:4319/v1/platform/turns', token: 'a'.repeat(32), timeoutMs: 3_000, performMilliseconds: 20 }, slow.value, fetcher as unknown as typeof fetch)!;
    await expect(puller.pull()).resolves.toBe('performed');
    expect(reports).toEqual([{ scopeKey: 'owner', outcome: 'failed', code: 'timeout' }]);
  });
});
