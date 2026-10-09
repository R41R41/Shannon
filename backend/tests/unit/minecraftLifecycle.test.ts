import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { guardedStopCommand, MinecraftLifecycleNative, nativePlayers, rconCommand, type LifecycleNativePorts } from '../../src/services/integration/minecraftLifecycleNative.js';
import { LifecycleOperationJournal, MinecraftLifecycleOperator } from '../../src/services/integration/minecraftLifecycleOperator.js';
import type { MinecraftLifecycleCommand } from '../../src/services/integration/minecraftLifecycleContract.js';

const botUuid = 'b9191317-c52d-4d67-85fe-ab831e6db146', humanUuid = '11111111-2222-3333-4444-555555555555';
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
function fixture() {
  let running = true, players: string[] = [], bot: 'joined' | 'absent' | 'unknown' = 'absent', permitted = true, race = false;
  const effects: string[] = [];
  const ports: LifecycleNativePorts = { serverId: 'home', botUuid, onlineMode: true,
    processState: async () => running ? 'running' : 'stopped',
    command: async text => {
      if (!running) throw Object.assign(Error('closed'), { code: 'ECONNREFUSED' });
      if (text === 'list uuids') return `There are ${players.length} of a max of 20 players online: ${players.map(uuid => `player (${uuid})`).join(', ')}`;
      if (race) players.push(humanUuid);
      effects.push(text);
      if (players.every(uuid => uuid === botUuid)) { running = false; bot = 'absent'; return 'Stopping the server'; }
      return '';
    },
    start: async () => { effects.push('start'); running = true; },
    botState: () => ({ phase: bot, serverId: bot === 'absent' ? null : 'home', uuid: bot === 'joined' ? botUuid : null }),
    login: async () => { effects.push('login'); bot = 'joined'; players.push(botUuid); },
    logout: async () => { effects.push('logout'); bot = 'absent'; players = players.filter(uuid => uuid !== botUuid); },
    authorize: async () => permitted,
  };
  const native = new MinecraftLifecycleNative(ports);
  const command = (action: MinecraftLifecycleCommand['action']): MinecraftLifecycleCommand => ({ schemaVersion: 1, id: `operation:${action}`, serverId: 'home', connectionId: 'connection', action,
    authority: { scopeKey: 'owner', origin: 'own_time', executionId: 'session', lease: { id: 'lease', holder: 'worker', generation: 1 }, sourceIds: ['source:own_time'] }, issuedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 30000).toISOString() });
  return { ports, native, command, effects, stopped() { running = false; }, human() { players.push(humanUuid); }, joined() { bot = 'joined'; players.push(botUuid); }, race() { race = true; }, revoke() { permitted = false; } };
}
describe('native Minecraft lifecycle', () => {
  it('constructs one native server-thread stop predicate from authoritative UUID, exempting nobody offline', () => {
    expect(guardedStopCommand(botUuid, true)).toBe('execute unless entity @a[nbt=!{UUID:[I;-1189539049,-986886809,-2046907517,510505286]}] run stop');
    expect(guardedStopCommand(botUuid, false)).toBe('execute unless entity @a run stop');
    expect(() => guardedStopCommand('Shannon" run stop', true)).toThrow('INVALID');
  });
  it('does not infer no humans from an unavailable/malformed native player list', async () => {
    expect(nativePlayers('There are 1 of a max of 20 players online: Shannon')).toBeNull();
    expect(nativePlayers('There are 2 of a max of 20 players online: Shannon (' + botUuid + ')')).toBeNull();
    expect(nativePlayers('There are 0 of a max of 20 players online: ')).toEqual([]);
    const f = fixture(); f.ports.command = async () => 'unavailable';
    expect((await f.native.observe()).running).toBe('unknown');
    const r = await f.native.execute(f.command('stop'), new AbortController().signal);
    expect(r.outcome).toBe('refused'); expect(f.effects).toEqual([]);
  });
  it('rejects absent, future and invalid original command clocks before native effects', async () => {
    const f = fixture(); f.stopped();
    for (const issuedAt of ['', new Date(Date.now() + 60000).toISOString(), 'invalid']) {
      const r = await f.native.execute({ ...f.command('start'), issuedAt }, new AbortController().signal);
      expect(r.outcome).toBe('cancelled'); expect(f.effects).toEqual([]);
    }
    const c = f.command('start'), r = await f.native.execute(c, new AbortController().signal);
    expect(r.outcome).toBe('completed');
    expect(Date.parse(r.state.observedAt)).toBeGreaterThanOrEqual(Date.parse(c.issuedAt));
    expect(Date.parse(r.observedAt)).toBeGreaterThanOrEqual(Date.parse(c.issuedAt));
  });
  it('starts only stopped worlds and treats already-running state as an idempotent no-op', async () => {
    const f = fixture();
    expect((await f.native.execute(f.command('start'), new AbortController().signal)).code).toBe('already_running');
    expect(f.effects).toEqual([]); f.stopped();
    expect((await f.native.execute(f.command('start'), new AbortController().signal)).code).toBe('changed');
    expect(f.effects).toEqual(['start']);
  });
  it('keeps login distinct from start, verifies native UUID and logout state', async () => {
    const f = fixture(), signal = new AbortController().signal;
    expect((await f.native.execute(f.command('login'), signal)).state.bot).toBe('joined');
    expect(f.effects).toEqual(['login']);
    expect((await f.native.execute(f.command('login'), signal)).code).toBe('already_joined');
    expect((await f.native.execute(f.command('logout'), signal)).state.bot).toBe('absent');
    expect(f.effects).toEqual(['login', 'logout']);
  });
  it('refuses humans and catches a new human between the initial snapshot and native stop', async () => {
    const f = fixture(); f.human();
    expect((await f.native.execute(f.command('stop'), new AbortController().signal)).code).toBe('players_present');
    expect(f.effects).toEqual([]);
    const racing = fixture(); racing.race();
    expect((await racing.native.execute(racing.command('stop'), new AbortController().signal)).outcome).toBe('refused');
    expect((await racing.native.observe()).running).toBe('running');
    expect(racing.effects).toHaveLength(1); expect(racing.effects[0]).toContain('execute unless entity');
  });
  it('stops with the configured bot alone and records native shutdown proof', async () => {
    const f = fixture(); f.joined();
    const r = await f.native.execute(f.command('stop'), new AbortController().signal);
    expect(r.outcome).toBe('completed'); expect(r.state.running).toBe('stopped');
    expect(r.stopGuard).toMatchObject({ admissionClosed: true, otherPlayers: 0 });
  });
  it('never promotes a coincidentally stopped process to native atomic guard proof', async () => {
    const f = fixture(), original = f.ports.command;
    f.ports.command = async (text, signal) => {
      if (text === 'list uuids') return original(text, signal);
      f.stopped(); throw Error('lost native command acknowledgement');
    };
    const r = await f.native.execute(f.command('stop'), new AbortController().signal);
    expect(r.outcome).toBe('unknown'); expect(r.inputsReleased).toBe(false); expect(r.stopGuard).toBeUndefined();
  });
  it('rechecks revoked original authority after fresh reads and before any native effect', async () => {
    const f = fixture(); f.revoke(); f.stopped();
    expect((await f.native.execute(f.command('start'), new AbortController().signal)).code).toBe('authority_revoked');
    expect(f.effects).toEqual([]);
  });
  it('preserves the machine admission guard and rechecks authority only after its awaited read', async () => {
    const f = fixture(); f.stopped();
    f.ports.admission = async () => false;
    expect((await f.native.execute(f.command('start'), new AbortController().signal)).outcome).toBe('refused');
    expect(f.effects).toEqual([]);
    f.ports.admission = async () => { f.revoke(); return true; };
    expect((await f.native.execute(f.command('start'), new AbortController().signal)).code).toBe('authority_revoked');
    expect(f.effects).toEqual([]);
  });
  it('retains unknown after a handed-out action is interrupted, without recreating it', async () => {
    const f = fixture(), controller = new AbortController();
    f.ports.login = async () => { f.effects.push('login'); controller.abort(); };
    const receipt = await f.native.execute(f.command('login'), controller.signal);
    expect(receipt.outcome).toBe('unknown'); expect(receipt.inputsReleased).toBe(false); expect(f.effects).toEqual(['login']);
  });
});
describe('operator durable dispatch', () => {
  function journal() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-test-')); temporary.push(dir); return { dir, journal: new LifecycleOperationJournal(path.join(dir, 'operations.json')) }; }
  it('writes before effects and does not replay a begin left by an interrupted operator', async () => {
    const f = fixture(), storage = journal(), command = f.command('login'); storage.journal.begin(command);
    const recovered = new LifecycleOperationJournal(path.join(storage.dir, 'operations.json'));
    const bodies: unknown[] = [];
    const operator = new MinecraftLifecycleOperator({ baseUrl: 'http://127.0.0.1:1', token: 'fixture-only-token', native: f.native, journal: recovered,
      fetcher: (async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ schemaVersion: 1, commands: [], cancel: [], acknowledged: [] })); }) as typeof fetch });
    await operator.poll();
    expect(recovered.entries.get(command.id)?.receipt?.outcome).toBe('unknown');
    expect(recovered.held).toBe(true); expect(f.effects).toEqual([]);
    expect(recovered.entries.get(command.id)?.command.authority.origin).toBe('own_time');
    expect(JSON.stringify(bodies)).toContain('unknown');
    expect(recovered.begin(command)).toBe(false);
  });
  it('replays an immutable result receipt after transport recovery, without another native operation', async () => {
    const f = fixture(), storage = journal(), command = f.command('login'); storage.journal.begin(command);
    const receipt = await f.native.execute(command, new AbortController().signal); storage.journal.settle(receipt);
    const operator = new MinecraftLifecycleOperator({ baseUrl: 'http://127.0.0.1:1', token: 'fixture-only-token', native: f.native, journal: storage.journal,
      fetcher: (async () => new Response(JSON.stringify({ schemaVersion: 1, commands: [], cancel: [], acknowledged: [receipt.id] }))) as typeof fetch });
    await operator.poll(); await operator.poll(); expect(f.effects).toEqual(['login']);
    expect(storage.journal.entries.get(command.id)?.receipt).toEqual(receipt);
  });
});
const rconFrame = (id: number, type: number, text: string) => {
  const body = Buffer.from(text), result = Buffer.alloc(body.length + 14);
  result.writeInt32LE(body.length + 10, 0); result.writeInt32LE(id, 4); result.writeInt32LE(type, 8); body.copy(result, 12); return result;
};
async function withRconServer(handler: (socket: import('node:net').Socket) => void, test: (port: number) => Promise<void>) {
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.on('error', () => undefined); socket.on('close', () => sockets.delete(socket)); handler(socket); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await test((server.address() as { port: number }).port); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
function rconRequests(socket: import('node:net').Socket, handler: (id: number, type: number, body: string, pipelined: boolean) => void) {
  let incoming = Buffer.alloc(0);
  socket.on('data', bytes => {
    incoming = Buffer.concat([incoming, bytes]);
    while (incoming.length >= 4 && incoming.length >= incoming.readInt32LE(0) + 4) {
      const size = incoming.readInt32LE(0), frame = incoming.subarray(0, size + 4); incoming = incoming.subarray(size + 4);
      handler(frame.readInt32LE(4), frame.readInt32LE(8), frame.toString('utf8', 12, frame.length - 2), incoming.length > 0);
    }
  });
}
describe('bounded native RCON transport', () => {
  it('serializes the marker after one command response, assembling fragmented and multiple packets', async () => {
    const ids: number[] = [];
    await withRconServer(socket => rconRequests(socket, (id, type, body, pipelined) => {
      ids.push(id);
      // The real Minecraft transport rejects a command plus marker batched in one read.
      if (pipelined) { socket.destroy(); return; }
      if (id === 1) { expect(type).toBe(3); socket.write(Buffer.concat([rconFrame(1, 0, ''), rconFrame(1, 2, '')])); }
      if (id === 2) {
        expect(type).toBe(2); expect(body).toBe('list uuids');
        const response = rconFrame(2, 0, 'There are 0 of a max of 20 ');
        socket.write(response.subarray(0, 7)); socket.write(Buffer.concat([response.subarray(7), rconFrame(2, 0, 'players online: ')]));
      }
      if (id === 3) { expect(body).toBe(''); socket.write(rconFrame(3, 0, 'Unknown command')); }
    }), async port => { expect(await rconCommand({ port, password: 'fixture-password' }, 'list uuids')).toBe('There are 0 of a max of 20 players online: '); });
    expect(ids).toEqual([1, 2, 3]);
  });
  it('keeps a close before the marker unknown with partial response and never replays the command', async () => {
    let commands = 0;
    await withRconServer(socket => rconRequests(socket, id => {
      if (id === 1) socket.write(rconFrame(1, 2, ''));
      if (id === 2) { commands++; socket.end(rconFrame(2, 0, 'Stopping the server')); }
    }), async port => {
      await expect(rconCommand({ port, password: 'fixture-password' }, 'execute unless entity @a run stop')).rejects.toMatchObject({ message: 'LIFECYCLE_RCON_CLOSED', responseText: 'Stopping the server' });
    });
    expect(commands).toBe(1);
  });
  it('rejects failed authentication before sending a native command', async () => {
    const ids: number[] = [];
    await withRconServer(socket => rconRequests(socket, id => { ids.push(id); socket.write(rconFrame(-1, 2, '')); }), async port => {
      await expect(rconCommand({ port, password: 'fixture-password' }, 'list uuids')).rejects.toThrow('LIFECYCLE_RCON_AUTH');
    });
    expect(ids).toEqual([1]);
  });
  it.each(['wrong-id', 'wrong-type', 'bad-terminator', 'oversize'])('rejects %s responses instead of manufacturing an observation', async scenario => {
    let commands = 0;
    await withRconServer(socket => rconRequests(socket, id => {
      if (id === 1) socket.write(rconFrame(1, 2, ''));
      if (id === 2) {
        commands++;
        const response = rconFrame(scenario === 'wrong-id' ? 9 : 2, scenario === 'wrong-type' ? 2 : 0, 'There are 0 of a max of 20 players online: ');
        if (scenario === 'bad-terminator') response[response.length - 1] = 1;
        if (scenario === 'oversize') response.writeInt32LE(262145, 0);
        socket.write(response);
      }
    }), async port => { await expect(rconCommand({ port, password: 'fixture-password' }, 'list uuids')).rejects.toThrow('LIFECYCLE_RCON_PACKET'); });
    expect(commands).toBe(1);
  });
  it('preserves bounded timeout with no command retry', async () => {
    let commands = 0;
    await withRconServer(socket => rconRequests(socket, id => {
      if (id === 1) socket.write(rconFrame(1, 2, ''));
      if (id === 2) commands++;
    }), async port => { await expect(rconCommand({ port, password: 'fixture-password' }, 'list uuids')).rejects.toThrow('LIFECYCLE_RCON_TIMEOUT'); });
    expect(commands).toBe(1);
  });
});
