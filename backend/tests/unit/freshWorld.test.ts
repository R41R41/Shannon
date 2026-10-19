import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/minebot/integration/commonFca/imageCapture.js', () => ({
  createBodyImageCapture: () => ({ configured: false, prepare: () => undefined, capture: async () => { throw Error('none'); }, dispose: async () => undefined }),
}));

import {
  FreshWorldRefused, freshWorldId, parseServerProperties, prepareFreshWorld, readWorldIdFile, resolvePlacesWorldId, serverDirectory,
  validLevelName, WORLD_ID_FILE,
} from '../../src/services/minecraft/freshWorld.js';
import { MinecraftLifecycleNative, type LifecycleNativePorts } from '../../src/services/integration/minecraftLifecycleNative.js';
import { LifecycleOperationJournal, MinecraftLifecycleOperator } from '../../src/services/integration/minecraftLifecycleOperator.js';
import { wantsFreshWorld, type MinecraftLifecycleCommand } from '../../src/services/integration/minecraftLifecycleContract.js';
import { createCommonFcaBody } from '../../src/services/minebot/integration/commonFca/createCommonFcaBody.js';

const temporary: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); temporary.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); });
const tmp = (name = 'fresh-world-') => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), name)); temporary.push(dir); return fs.realpathSync(dir); };

const PROPERTIES = 'level-name=shannon_home\nlevel-seed=\nserver-port=25560\nenable-rcon=true\nrcon.port=26560\n';
/** A fake `<base>/shannon-home` with a world (DIM-1, DIM1), a mods directory and the previous world id. */
function fakeServer(properties = PROPERTIES) {
  const base = tmp(), dir = path.join(base, 'shannon-home');
  fs.mkdirSync(path.join(dir, 'shannon_home', 'DIM-1'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'shannon_home', 'DIM1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shannon_home', 'level.dat'), 'x');
  fs.writeFileSync(path.join(dir, 'shannon_home', 'DIM1', 'r.0.0.mca'), 'x');
  fs.mkdirSync(path.join(dir, 'mods')); fs.writeFileSync(path.join(dir, 'mods', 'a.jar'), 'x');
  fs.writeFileSync(path.join(dir, 'server.properties'), properties);
  fs.writeFileSync(path.join(dir, WORLD_ID_FILE), 'shannon-home-20261001T0900\n');
  return { base, dir };
}
const closed = async () => true;
const T = Date.UTC(2026, 9, 19, 3, 4, 0); // 12:04 JST

describe('world id from the file', () => {
  it('prefers a valid file, then a valid env, then the memory context', () => {
    const { dir } = fakeServer();
    expect(resolvePlacesWorldId(dir, 'env-world', 'context-world')).toBe('shannon-home-20261001T0900');
    fs.rmSync(path.join(dir, WORLD_ID_FILE));
    expect(resolvePlacesWorldId(dir, 'env-world', 'context-world')).toBe('env-world');
    expect(resolvePlacesWorldId(dir, undefined, 'context-world')).toBe('context-world');
    expect(resolvePlacesWorldId(dir, '  ', 'context-world')).toBe('context-world');
    expect(resolvePlacesWorldId(dir, 'bad id!', 'context-world')).toBe('context-world');
    expect(resolvePlacesWorldId(null, 'env-world', undefined)).toBe('env-world');
    expect(resolvePlacesWorldId(null, undefined, undefined)).toBeUndefined();
  });
  it('trims the file and ignores invalid, empty, oversize and missing files', () => {
    const { dir } = fakeServer(); const file = path.join(dir, WORLD_ID_FILE);
    fs.writeFileSync(file, '  new-world-1 \r\n'); expect(readWorldIdFile(dir)).toBe('new-world-1');
    for (const bad of ['', '\n', 'has space', '../x', '-leading', 'a/b', 'x'.repeat(129), `${'x'.repeat(600)}`, 'two\nlines']) {
      fs.writeFileSync(file, bad); expect(readWorldIdFile(dir), JSON.stringify(bad.slice(0, 12))).toBeNull();
    }
    fs.rmSync(file); expect(readWorldIdFile(dir)).toBeNull();
    expect(readWorldIdFile(path.join(dir, 'nope'))).toBeNull(); expect(readWorldIdFile(undefined)).toBeNull();
    expect(resolvePlacesWorldId(dir, 'env-world', 'ctx')).toBe('env-world');
  });
  it('is read again every time, never cached', () => {
    const { dir } = fakeServer(); const file = path.join(dir, WORLD_ID_FILE);
    fs.writeFileSync(file, 'world-a\n'); expect(resolvePlacesWorldId(dir, undefined, undefined)).toBe('world-a');
    fs.writeFileSync(file, 'world-b\n'); expect(resolvePlacesWorldId(dir, undefined, undefined)).toBe('world-b');
  });
  it('builds the server directory from SERVER_BASE_PATH at call time and rejects names that are not one plain directory', () => {
    expect(serverDirectory('shannon-home', '/srv/mc')).toBe(path.join('/srv/mc', 'shannon-home'));
    vi.stubEnv('SERVER_BASE_PATH', '/late/base'); expect(serverDirectory('shannon-home')).toBe(path.join('/late/base', 'shannon-home'));
    for (const bad of [undefined, '', '..', '.', 'a/b', '../x']) expect(serverDirectory(bad, '/srv/mc')).toBeNull();
    expect(serverDirectory('shannon-home', '')).toBeNull();
  });
  it('is what the body files its places under at every spawn (file over env over memory)', () => {
    const { base, dir } = fakeServer();
    vi.stubEnv('SERVER_BASE_PATH', base); vi.stubEnv('MINEBOT_PLACES_WORLD_ID', 'env-world');
    const persisted: string[] = [];
    // Each connection is a new bot object that has not spawned yet; `spawn` runs the places persistence.
    const spawnOnce = () => {
      const bot: any = Object.assign(new EventEmitter(), { entity: undefined, health: 0, connectedServerName: 'shannon-home',
        instantSkills: { getSkills: () => [] }, placeMemory: { persistTo: (file: string) => persisted.push(path.basename(file)) } });
      createCommonFcaBody(bot, { url: 'http://127.0.0.1:1', serverId: 'home', serverName: 'shannon-home' }, 'token');
      bot.emit('spawn'); bot.emit('end');
    };
    spawnOnce();
    expect(persisted).toEqual(['home--shannon-home-20261001T0900.json']);
    // A new world while the process lives: the next spawn (a new bot) reads the new file.
    fs.writeFileSync(path.join(dir, WORLD_ID_FILE), 'shannon-home-20261019T1204\n'); spawnOnce();
    expect(persisted[1]).toBe('home--shannon-home-20261019T1204.json');
    fs.rmSync(path.join(dir, WORLD_ID_FILE)); spawnOnce();
    expect(persisted[2]).toBe('home--env-world.json');
  });
});

describe('fresh world id and level name', () => {
  it('formats shannon-home-<JST YYYYMMDDTHHMM>, with -s<seed> when a seed is configured', () => {
    expect(freshWorldId('shannon-home', T)).toBe('shannon-home-20261019T1204');
    expect(freshWorldId('shannon-home', Date.UTC(2026, 9, 19, 16, 0, 59))).toBe('shannon-home-20261020T0100');
    expect(freshWorldId('shannon-home', T, '12345')).toBe('shannon-home-20261019T1204-s12345');
    expect(freshWorldId('shannon-home', T, '-77')).toBe('shannon-home-20261019T1204-s_77');
    expect(freshWorldId('shannon-home', T, ' my seed/../x ')).toBe('shannon-home-20261019T1204-smy_seed____x');
    expect(freshWorldId('shannon-home', T, 'a'.repeat(50))).toBe(`shannon-home-20261019T1204-s${'a'.repeat(32)}`);
  });
  it('parses properties the way the server reads them (last wins, comments ignored)', () => {
    const p = parseServerProperties('# c\r\nlevel-name=a\r\n! x\nlevel-name = b \nlevel-seed=\n');
    expect(p.get('level-name')).toBe('b'); expect(p.get('level-seed')).toBe('');
  });
  it('accepts one plain directory name only', () => {
    expect(validLevelName('shannon_home')).toBe(true); expect(validLevelName('world')).toBe(true);
    for (const bad of [undefined, '', ' ', '.', '..', '../x', 'a/b', 'a\\b', '..hidden', '.hidden', 'a..b', '/abs', 'C:', 'mods', 'Logs', 'x'.repeat(65), 'a\0b', '-rf'])
      expect(validLevelName(bad as string), String(bad)).toBe(false);
  });
});

describe('prepareFreshWorld', () => {
  it('writes the id first, then deletes only the level directory, and leaves everything else', async () => {
    const { dir } = fakeServer(); const lines: string[] = []; const order: string[] = [];
    const real = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      order.push(`rm:${path.basename(String(target))}:id=${fs.readFileSync(path.join(dir, WORLD_ID_FILE), 'utf8').trim()}`);
      return real(target, options);
    });
    const result = await prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed, log: l => lines.push(l) });
    expect(result).toEqual({ worldId: 'shannon-home-20261019T1204', levelName: 'shannon_home', deleted: true });
    expect(order).toEqual(['rm:shannon_home:id=shannon-home-20261019T1204']);
    expect(fs.readFileSync(path.join(dir, WORLD_ID_FILE), 'utf8')).toBe('shannon-home-20261019T1204\n');
    expect(fs.existsSync(path.join(dir, 'shannon_home'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'mods', 'a.jar'))).toBe(true); expect(fs.existsSync(path.join(dir, 'server.properties'))).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(['mods', 'server.properties', WORLD_ID_FILE].sort());
    expect(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8')).toBe(PROPERTIES);
    expect(lines).toEqual(['🌱 新しいワールド: shannon-home-20261019T1204']);
  });
  it('puts a configured seed in the id and leaves level-seed as configured', async () => {
    const { dir } = fakeServer(PROPERTIES.replace('level-seed=', 'level-seed=424242'));
    expect((await prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed })).worldId).toBe('shannon-home-20261019T1204-s424242');
    expect(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8')).toContain('level-seed=424242');
  });
  it('works when the world is already gone, and when the id file never existed', async () => {
    const { dir } = fakeServer(); fs.rmSync(path.join(dir, 'shannon_home'), { recursive: true }); fs.rmSync(path.join(dir, WORLD_ID_FILE));
    expect(await prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed })).toMatchObject({ deleted: false });
    expect(readWorldIdFile(dir)).toBe('shannon-home-20261019T1204');
  });
  it('refuses with nothing changed while anything listens on the game or RCON port, or the port is uncertain', async () => {
    const { dir } = fakeServer();
    for (const portClosed of [async (p: number) => p !== 25560, async (p: number) => p !== 26560, async () => { throw Error('x'); }, async () => false]) {
      await expect(prepareFreshWorld({ serverDir: dir, now: () => T, portClosed })).rejects.toBeInstanceOf(FreshWorldRefused);
    }
    expect(fs.existsSync(path.join(dir, 'shannon_home', 'level.dat'))).toBe(true);
    expect(readWorldIdFile(dir)).toBe('shannon-home-20261001T0900');
  });
  it.each([['empty', 'level-name='], ['missing', ''], ['parent', 'level-name=..'], ['traversal', 'level-name=../shannon-home2'], ['slash', 'level-name=a/b'],
    ['absolute', 'level-name=/etc'], ['mods', 'level-name=mods'], ['dot', 'level-name=.'], ['backslash', 'level-name=a\\b']])('refuses level-name %s and deletes nothing', async (_name, line) => {
    const { dir } = fakeServer(`${line}\nserver-port=25560\n`);
    fs.mkdirSync(path.join(dir, '..', 'shannon-home2'), { recursive: true }); fs.writeFileSync(path.join(dir, '..', 'shannon-home2', 'keep'), 'x');
    await expect(prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed })).rejects.toBeInstanceOf(FreshWorldRefused);
    expect(fs.existsSync(path.join(dir, '..', 'shannon-home2', 'keep'))).toBe(true); expect(fs.existsSync(path.join(dir, 'mods', 'a.jar'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'shannon_home', 'level.dat'))).toBe(true); expect(readWorldIdFile(dir)).toBe('shannon-home-20261001T0900');
  });
  it('refuses a level directory that is a symlink (or junction) and never touches its target', async () => {
    const { dir } = fakeServer(); const outside = tmp('outside-'); fs.writeFileSync(path.join(outside, 'level.dat'), 'precious'); fs.writeFileSync(path.join(outside, 'region'), 'precious');
    fs.rmSync(path.join(dir, 'shannon_home'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'shannon_home'), 'junction');
    await expect(prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed })).rejects.toMatchObject({ reason: 'level_dir_is_symlink' });
    expect(fs.readdirSync(outside).sort()).toEqual(['level.dat', 'region']); expect(readWorldIdFile(dir)).toBe('shannon-home-20261001T0900');
  });
  it('works on a server directory reached through a link, acting on its real directory only', async () => {
    const { dir } = fakeServer(); const link = path.join(tmp('link-'), 'shannon-home'); fs.symlinkSync(dir, link, 'junction');
    const result = await prepareFreshWorld({ serverDir: link, now: () => T, portClosed: closed });
    expect(result.worldId).toBe('shannon-home-20261019T1204'); expect(fs.existsSync(path.join(dir, 'shannon_home'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'mods', 'a.jar'))).toBe(true);
  });
  it('unlinks a symlink inside the world without following it', async () => {
    const { dir } = fakeServer(); const outside = tmp('outside-'); fs.writeFileSync(path.join(outside, 'precious'), 'x');
    fs.symlinkSync(outside, path.join(dir, 'shannon_home', 'DIM1', 'escape'), 'junction');
    await prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed });
    expect(fs.existsSync(path.join(dir, 'shannon_home'))).toBe(false); expect(fs.readFileSync(path.join(outside, 'precious'), 'utf8')).toBe('x');
  });
  it('refuses a level path that is a file, or a non-empty directory that is not a world', async () => {
    const { dir } = fakeServer(); fs.rmSync(path.join(dir, 'shannon_home'), { recursive: true }); fs.writeFileSync(path.join(dir, 'shannon_home'), 'file');
    await expect(prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed })).rejects.toMatchObject({ reason: 'level_dir_not_directory' });
    fs.rmSync(path.join(dir, 'shannon_home')); fs.mkdirSync(path.join(dir, 'shannon_home')); fs.writeFileSync(path.join(dir, 'shannon_home', 'notes.txt'), 'x');
    await expect(prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed })).rejects.toMatchObject({ reason: 'level_dir_not_a_world' });
    expect(fs.existsSync(path.join(dir, 'shannon_home', 'notes.txt'))).toBe(true); expect(readWorldIdFile(dir)).toBe('shannon-home-20261001T0900');
    fs.rmSync(path.join(dir, 'shannon_home', 'notes.txt'));
    expect(await prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed })).toMatchObject({ deleted: true });
  });
  it('refuses when the new id would equal the current one (two fresh worlds in one minute) and when the directory is unreadable', async () => {
    const { dir } = fakeServer(); fs.writeFileSync(path.join(dir, WORLD_ID_FILE), 'shannon-home-20261019T1204\n');
    await expect(prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed })).rejects.toMatchObject({ reason: 'world_id_not_new' });
    expect(fs.existsSync(path.join(dir, 'shannon_home', 'level.dat'))).toBe(true);
    await expect(prepareFreshWorld({ serverDir: path.join(dir, 'missing'), now: () => T, portClosed: closed })).rejects.toBeInstanceOf(FreshWorldRefused);
  });
  it('leaves no temporary file and the old id when the id cannot be written, and deletes nothing', async () => {
    const { dir } = fakeServer(); vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Error('disk'); });
    await expect(prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed })).rejects.toMatchObject({ reason: 'world_id_not_written' });
    expect(fs.readdirSync(dir).sort()).toEqual(['mods', 'server.properties', 'shannon_home', WORLD_ID_FILE].sort());
    expect(readWorldIdFile(dir)).toBe('shannon-home-20261001T0900');
  });
  it('is not a refusal when deleting fails after the id was written', async () => {
    const { dir } = fakeServer(); vi.spyOn(fs.promises, 'rm').mockRejectedValue(Error('EBUSY'));
    const failure = await prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed }).catch(e => e);
    expect(failure).toBeInstanceOf(Error); expect(failure).not.toBeInstanceOf(FreshWorldRefused);
    expect(readWorldIdFile(dir)).toBe('shannon-home-20261019T1204');
  });
});

const botUuid = 'b9191317-c52d-4d67-85fe-ab831e6db146';
function lifecycle(serverDir?: string) {
  let running = false; const effects: string[] = []; let reads = 0;
  const ports: LifecycleNativePorts = { serverId: 'home', botUuid, onlineMode: true,
    processState: async () => { reads++; return running ? 'running' : 'stopped'; },
    command: async text => {
      if (!running) throw Object.assign(Error('closed'), { code: 'ECONNREFUSED' });
      if (text === 'list uuids') return 'There are 0 of a max of 20 players online:';
      effects.push(text); running = false; return 'Stopping the server';
    },
    start: async () => {
      // What the world looks like at the moment the server would start.
      effects.push(serverDir ? `start(id=${readWorldIdFile(serverDir)},world=${fs.existsSync(path.join(serverDir, 'shannon_home'))})` : 'start'); running = true;
    },
    prepareFreshWorld: async () => {
      effects.push('fresh');
      return serverDir ? { worldId: (await prepareFreshWorld({ serverDir, now: () => T, portClosed: closed })).worldId } : { worldId: 'x' };
    },
    botState: () => ({ phase: 'absent', serverId: null, uuid: null }),
    login: async () => undefined, logout: async () => undefined, authorize: async () => true,
  };
  const command = (action: MinecraftLifecycleCommand['action'], options?: unknown, id = `operation:${action}:${Math.random()}`): MinecraftLifecycleCommand => ({
    schemaVersion: 1, id, serverId: 'home', connectionId: 'connection', action,
    authority: { scopeKey: 'owner', origin: 'owner_request', executionId: 'session', lease: { id: 'lease', holder: 'worker', generation: 1 }, sourceIds: ['source:owner'] },
    issuedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 30000).toISOString(), ...(options === undefined ? {} : { options: options as never }) });
  return { ports, native: new MinecraftLifecycleNative(ports), command, effects, run() { running = true; }, get reads() { return reads; } };
}
const signal = () => new AbortController().signal;

describe('fresh-world start through the lifecycle native', () => {
  it('re-checks stopped, writes the id, deletes the world, then starts, and completes as an ordinary start', async () => {
    const { dir } = fakeServer(); const f = lifecycle(dir);
    const receipt = await f.native.execute(f.command('start', { freshWorld: true }), signal());
    expect(receipt).toMatchObject({ outcome: 'completed', code: 'changed', inputsReleased: true });
    expect(receipt.state.running).toBe('running');
    expect(f.effects).toEqual(['fresh', 'start(id=shannon-home-20261019T1204,world=false)']);
    expect(fs.existsSync(path.join(dir, 'mods', 'a.jar'))).toBe(true);
  });
  it('refuses while the server is running: no world touched, no start, and not reported as already_running', async () => {
    const { dir } = fakeServer(); const f = lifecycle(dir); f.run();
    const receipt = await f.native.execute(f.command('start', { freshWorld: true }), signal());
    expect(receipt).toMatchObject({ outcome: 'refused', code: 'error', inputsReleased: true });
    expect(f.effects).toEqual([]); expect(fs.existsSync(path.join(dir, 'shannon_home', 'level.dat'))).toBe(true); expect(readWorldIdFile(dir)).toBe('shannon-home-20261001T0900');
  });
  it('refuses when the stopped state is uncertain, and when it flips to running between the first read and the re-check', async () => {
    const { dir } = fakeServer(); const unknown = lifecycle(dir);
    unknown.ports.processState = async () => { throw Error('systemctl'); };
    expect(await unknown.native.execute(unknown.command('start', { freshWorld: true }), signal())).toMatchObject({ outcome: 'refused', code: 'state_unknown' });
    const flip = lifecycle(dir); let calls = 0;
    flip.ports.processState = async () => { calls++; return calls >= 2 ? 'running' : 'stopped'; };
    flip.ports.command = async text => { if (calls >= 2 && text === 'list uuids') return 'There are 0 of a max of 20 players online:'; throw Object.assign(Error('closed'), { code: 'ECONNREFUSED' }); };
    expect(await flip.native.execute(flip.command('start', { freshWorld: true }), signal())).toMatchObject({ outcome: 'refused', code: 'error' });
    expect(unknown.effects).toEqual([]); expect(flip.effects).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'shannon_home', 'level.dat'))).toBe(true); expect(readWorldIdFile(dir)).toBe('shannon-home-20261001T0900');
  });
  it('refuses when the final authority recheck fails, before any world change', async () => {
    const { dir } = fakeServer(); const f = lifecycle(dir); f.ports.authorize = async () => false;
    expect(await f.native.execute(f.command('start', { freshWorld: true }), signal())).toMatchObject({ outcome: 'cancelled', code: 'authority_revoked' });
    expect(f.effects).toEqual([]); expect(fs.existsSync(path.join(dir, 'shannon_home', 'level.dat'))).toBe(true);
  });
  it('refuses when the port is not supplied, and a refusal from the preparation starts nothing', async () => {
    const none = lifecycle(); delete none.ports.prepareFreshWorld;
    expect(await none.native.execute(none.command('start', { freshWorld: true }), signal())).toMatchObject({ outcome: 'refused', code: 'error' });
    expect(none.effects).toEqual([]);
    const { dir } = fakeServer(PROPERTIES.replace('shannon_home', '../x')); const f = lifecycle(dir);
    expect(await f.native.execute(f.command('start', { freshWorld: true }), signal())).toMatchObject({ outcome: 'refused', code: 'error', inputsReleased: true });
    expect(f.effects).toEqual(['fresh']);
  });
  it('keeps a failure after the id was written unknown, never starting', async () => {
    const f = lifecycle(); f.ports.prepareFreshWorld = async () => { f.effects.push('fresh'); throw Error('EBUSY'); };
    expect(await f.native.execute(f.command('start', { freshWorld: true }), signal())).toMatchObject({ outcome: 'unknown', code: 'error', inputsReleased: false });
    expect(f.effects).toEqual(['fresh']);
  });
  it('treats an absent, malformed or other-action option as an ordinary command', async () => {
    for (const options of [undefined, null, {}, { freshWorld: false }, { freshWorld: 'true' }, { freshWorld: 1 }, { other: true }, 'freshWorld', ['freshWorld'], { freshWorld: [true] }]) {
      const f = lifecycle(); expect(wantsFreshWorld({ action: 'start', options: options as never })).toBe(false);
      const receipt = await f.native.execute(f.command('start', options), signal());
      expect(receipt).toMatchObject({ outcome: 'completed', code: 'changed' }); expect(f.effects).toEqual(['start']);
    }
    const running = lifecycle(); running.run();
    expect((await running.native.execute(running.command('start', { other: 1 }), signal())).code).toBe('already_running');
    // freshWorld on any other action is ignored.
    const stop = lifecycle(); stop.run();
    expect(wantsFreshWorld({ action: 'stop', options: { freshWorld: true } })).toBe(false);
    expect(await stop.native.execute(stop.command('stop', { freshWorld: true }), signal())).toMatchObject({ outcome: 'completed', code: 'changed' });
    expect(stop.effects.some(e => e === 'fresh')).toBe(false);
    expect(wantsFreshWorld({ action: 'start', options: { freshWorld: true } })).toBe(true);
  });
  it('does not repeat a world reset for the same command id', async () => {
    const { dir } = fakeServer(); const f = lifecycle(dir); const command = f.command('start', { freshWorld: true }, 'operation:fresh:1');
    expect((await f.native.execute(command, signal())).outcome).toBe('completed');
    // Same id again with the server stopped again: refused, the new world is left alone.
    fs.mkdirSync(path.join(dir, 'shannon_home')); fs.writeFileSync(path.join(dir, 'shannon_home', 'level.dat'), 'new world');
    await f.native.execute(f.command('stop'), signal());
    expect(await f.native.execute(command, signal())).toMatchObject({ outcome: 'refused', code: 'error' });
    expect(f.effects.filter(e => e === 'fresh')).toHaveLength(1); expect(fs.readFileSync(path.join(dir, 'shannon_home', 'level.dat'), 'utf8')).toBe('new world');
  });
  it('is dispatched once by the operator: a resent command id, after a restart too, never resets again', async () => {
    // The journal fsyncs its directory; Windows refuses that (EPERM), which is not what this test is about.
    const realFsync = fs.fsyncSync.bind(fs);
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { try { realFsync(fd); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; } });
    const { dir } = fakeServer(); const f = lifecycle(dir); const storage = tmp('journal-'); const file = path.join(storage, 'operations.json');
    let sent: MinecraftLifecycleCommand | null = null; const bodies: Array<{ receipts: Array<{ id: string; outcome: string }> }> = [];
    const operatorFor = (journal: LifecycleOperationJournal, native: MinecraftLifecycleNative) => new MinecraftLifecycleOperator({ baseUrl: 'http://127.0.0.1:1', token: 'fixture-only-token', native, journal,
      fetcher: (async (_url: string, init: { body: string }) => {
        const body = JSON.parse(String(init.body)); bodies.push(body);
        if (!sent) sent = { ...f.command('start', { freshWorld: true }, 'operation:fresh:resend'), connectionId: body.connectionId, issuedAt: new Date(Date.now() - 1).toISOString() };
        return new Response(JSON.stringify({ schemaVersion: 1, commands: [{ ...sent, connectionId: body.connectionId }], cancel: [], acknowledged: [] }));
      }) as never });
    const journal = new LifecycleOperationJournal(file), operator = operatorFor(journal, f.native);
    await operator.poll();
    await vi.waitFor(() => expect(journal.entries.get('operation:fresh:resend')?.receipt?.outcome).toBe('completed'));
    expect(journal.entries.get('operation:fresh:resend')?.command.options).toEqual({ freshWorld: true });
    // The API resends the same command (no ack yet) over several polls, and a restart reloads the journal.
    await operator.poll(); await operator.poll();
    const restarted = lifecycle(dir); restarted.ports.prepareFreshWorld = async () => { restarted.effects.push('fresh'); return { worldId: 'x' }; };
    const reloaded = operatorFor(new LifecycleOperationJournal(file), restarted.native);
    await reloaded.poll(); await reloaded.poll();
    expect(f.effects.filter(e => e === 'fresh')).toHaveLength(1); expect(restarted.effects).toEqual([]);
    expect(bodies.at(-1)?.receipts.map(r => r.id)).toContain('operation:fresh:resend');
  });
});
