import { describe, expect, it } from 'vitest';
import { MinecraftLifecycleNative, type LifecycleNativePorts } from '../../src/services/integration/minecraftLifecycleNative.js';
import type { MinecraftLifecycleCommand } from '../../src/services/integration/minecraftLifecycleContract.js';
import { SHUTDOWN_QUIET_MS, ShutdownWindow } from '../../src/services/minecraft/shutdownWindow.js';

// 2026-10-21 13:13:57: the lifecycle poll opened RCON connections while the server ran its own `stop`; one client was accepted
// after the server thread had begun to stop, waited for the server thread, and the server thread waited for it. The process never
// ended and systemd SIGKILLed it after 90 s. These tests pin the rule that fixes it: no RCON connection from this body between
// the stop command and the moment the process is seen gone.

const botUuid = 'b9191317-c52d-4d67-85fe-ab831e6db146';
const humanUuid = '11111111-2222-3333-4444-555555555555';
const alone = `There are 1 of a max of 20 players online: Shannon (${botUuid})`;
const withHuman = `There are 2 of a max of 20 players online: Shannon (${botUuid}), Someone (${humanUuid})`;

describe('ShutdownWindow', () => {
  it('is open from begin until that opening is closed, and several openings overlap', () => {
    const window = new ShutdownWindow(() => 0);
    expect(window.active()).toBe(false);
    const first = window.begin(), second = window.begin();
    expect(window.active()).toBe(true);
    first(); first();
    expect(window.active()).toBe(true);
    second();
    expect(window.active()).toBe(false);
  });
  it('drops an opening after SHUTDOWN_QUIET_MS, so a server that never stops is observed again', () => {
    let now = 1000;
    const window = new ShutdownWindow(() => now);
    window.begin();
    now += SHUTDOWN_QUIET_MS - 1; expect(window.active()).toBe(true);
    now += 1; expect(window.active()).toBe(false);
  });
  it('is cleared when the process is gone', () => {
    const window = new ShutdownWindow(() => 0);
    window.begin(); window.begin(); window.clear();
    expect(window.active()).toBe(false);
  });
});

/** A server whose RCON stays accepting until its process is gone, as in the incident. `dyingReads` process reads see it still running. */
function server(options: { dyingReads?: number; stopReply?: 'accepted' | 'declined' | Error } = {}) {
  const log: string[] = [];
  let stopSent = false, processReads = 0, gone = false, humanJoined = false;
  const dyingReads = options.dyingReads ?? 3;
  let connectionsDuringShutdown = 0;
  const ports: LifecycleNativePorts = { serverId: 'home', botUuid, onlineMode: true,
    processState: async () => {
      if (stopSent && !gone && ++processReads > dyingReads) gone = true;
      return gone ? 'stopped' : 'running';
    },
    command: async text => {
      log.push(text);
      if (gone) throw Object.assign(Error('refused'), { code: 'ECONNREFUSED' });
      if (stopSent && options.stopReply !== 'declined') connectionsDuringShutdown += 1;
      if (text === 'list uuids') return humanJoined ? withHuman : alone;
      const reply = options.stopReply ?? 'accepted';
      if (reply instanceof Error) throw reply;
      if (reply === 'declined') { humanJoined = true; return ''; } // someone joined between the snapshot and the guarded stop
      stopSent = true; return 'Stopping the server';
    },
    start: async () => undefined, login: async () => undefined, logout: async () => undefined,
    botState: () => ({ phase: 'joined', serverId: 'home', uuid: botUuid }),
    authorize: async () => true,
  };
  const command = (): MinecraftLifecycleCommand => ({ schemaVersion: 1, id: 'operation:stop', serverId: 'home', connectionId: 'connection', action: 'stop',
    authority: { scopeKey: 'owner', origin: 'own_time', executionId: 'session', lease: { id: 'lease', holder: 'worker', generation: 1 }, sourceIds: ['source:own_time'] },
    issuedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 30000).toISOString() });
  return { ports, command, log, connectionsDuringShutdown: () => connectionsDuringShutdown, stopSent: () => stopSent };
}

describe('the body stays off RCON while the server stops itself', () => {
  it('opens no RCON connection between its accepted stop and the process being gone, then completes', async () => {
    const s = server({ dyingReads: 4 }), native = new MinecraftLifecycleNative(s.ports);
    // The operator polls every 500 ms whatever else is going on; it must not connect either.
    const polls: unknown[] = [];
    const poller = setInterval(() => { void native.observe().then(state => polls.push(state)); }, 20);
    const receipt = await native.execute(s.command(), new AbortController().signal);
    clearInterval(poller);
    expect(receipt).toMatchObject({ outcome: 'completed', code: 'changed' });
    expect(receipt.state.running).toBe('stopped');
    expect(receipt.stopGuard).toMatchObject({ admissionClosed: true, otherPlayers: 0 });
    expect(s.connectionsDuringShutdown()).toBe(0);
    // After the stop command, the only RCON traffic is the refused connection that proves the stopped process.
    const afterStop = s.log.slice(s.log.findIndex(text => text.endsWith('run stop')) + 1);
    expect(afterStop.every(text => text === 'list uuids')).toBe(true);
    expect(afterStop.length).toBeGreaterThan(0);
  });
  it('reports the running state as unknown, not as zero players, while the process is still going down', async () => {
    const s = server({ dyingReads: 1000 }), native = new MinecraftLifecycleNative(s.ports), controller = new AbortController();
    const running = native.execute(s.command(), controller.signal);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(s.stopSent()).toBe(true);
    const during = await native.observe();
    expect(during).toMatchObject({ running: 'unknown', otherPlayers: null });
    expect(s.connectionsDuringShutdown()).toBe(0);
    controller.abort('test_done');
    expect((await running).outcome).toBe('unknown');
  });
  it('polls RCON again when the server declined the guarded stop and keeps running', async () => {
    const s = server({ stopReply: 'declined' }), native = new MinecraftLifecycleNative(s.ports);
    const receipt = await native.execute(s.command(), new AbortController().signal);
    expect(receipt.outcome).toBe('refused');
    s.log.length = 0;
    expect(await native.observe()).toMatchObject({ running: 'running' });
    expect(s.log).toEqual(['list uuids']);
  });
  it.each(['LIFECYCLE_RCON_UNAVAILABLE', 'LIFECYCLE_RCON_AUTH', 'LIFECYCLE_RCON_CONFIG'])('polls RCON again after %s, which proves the stop was never delivered', async code => {
    const s = server({ stopReply: new Error(code) }), native = new MinecraftLifecycleNative(s.ports);
    await native.execute({ ...s.command(), deadlineAt: new Date(Date.now() + 400).toISOString() }, new AbortController().signal);
    s.log.length = 0;
    expect((await native.observe()).running).toBe('running');
    expect(s.log).toEqual(['list uuids']);
  });
  it.each(['LIFECYCLE_RCON_TIMEOUT', 'LIFECYCLE_RCON_CLOSED', 'LIFECYCLE_RCON_ABORTED'])('stays off RCON after %s, because the stop may have run', async code => {
    const s = server({ stopReply: new Error(code) }), native = new MinecraftLifecycleNative(s.ports);
    await native.execute({ ...s.command(), deadlineAt: new Date(Date.now() + 400).toISOString() }, new AbortController().signal);
    s.log.length = 0;
    expect((await native.observe()).running).toBe('unknown');
    expect(s.log).toEqual([]);
  });
  it('uses a shared window: another stop path (the registered stop script) keeps the native off RCON too', async () => {
    const s = server(), window = new ShutdownWindow(), native = new MinecraftLifecycleNative({ ...s.ports, shutdown: window });
    const release = window.begin();
    expect(await native.observe()).toMatchObject({ running: 'unknown', otherPlayers: null });
    expect(s.log).toEqual([]);
    release();
    expect((await native.observe()).running).toBe('running');
    expect(s.log).toEqual(['list uuids']);
  });
  it('clears the window when it sees the process stopped, so the next start is observed normally', async () => {
    const s = server(), window = new ShutdownWindow(), native = new MinecraftLifecycleNative({ ...s.ports, shutdown: window,
      processState: async () => 'stopped', command: async () => { throw Object.assign(Error('refused'), { code: 'ECONNREFUSED' }); } });
    window.begin();
    // A stop was accepted elsewhere and the process is gone: the stopped observation closes the window.
    expect((await native.observe()).running).toBe('stopped');
    expect(window.active()).toBe(false);
  });
});
