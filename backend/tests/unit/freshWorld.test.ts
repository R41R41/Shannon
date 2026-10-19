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
  validLevelName, WORLD_ID, WORLD_ID_FILE,
} from '../../src/services/minecraft/freshWorld.js';
import { MinecraftLifecycleNative, type LifecycleNativePorts } from '../../src/services/integration/minecraftLifecycleNative.js';
import { LifecycleOperationJournal, MinecraftLifecycleOperator } from '../../src/services/integration/minecraftLifecycleOperator.js';
import { lifecycleCapabilities, validLifecyclePoll, wantsFreshWorld, type MinecraftLifecycleCommand } from '../../src/services/integration/minecraftLifecycleContract.js';
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
    expect(freshWorldId('shannon-home', T, '-77')).toBe('shannon-home-20261019T1204-s-77');
    // Not trimmed (the server-side script does not trim): blanks at the ends become '-' like any other character.
    expect(freshWorldId('shannon-home', T, ' my seed/../x ')).toBe('shannon-home-20261019T1204-s-my-seed----x-');
    expect(freshWorldId('shannon-home', T, ' ')).toBe('shannon-home-20261019T1204-s-');
    // One '-' per Unicode code point, not per UTF-16 unit (an emoji is one), and the cut is 32 code points.
    expect(freshWorldId('shannon-home', T, 'a😀b')).toBe('shannon-home-20261019T1204-sa-b');
    expect(freshWorldId('shannon-home', T, '日本')).toBe('shannon-home-20261019T1204-s--');
    expect(freshWorldId('shannon-home', T, '😀'.repeat(40))).toBe(`shannon-home-20261019T1204-s${'-'.repeat(32)}`);
    expect(freshWorldId('shannon-home', T, 'a'.repeat(50))).toBe(`shannon-home-20261019T1204-s${'a'.repeat(32)}`);
  });
  it('only makes ids the reader accepts (the same pattern as MINEBOT_PLACES_WORLD_ID), whatever the seed', () => {
    const { dir } = fakeServer();
    for (const seed of ['', '0', '-77', '12345', 'hello world', ' my seed/../x ', 'a:b_c.d', 'ü日本', '-', '--', 'a'.repeat(200), '9223372036854775807', '$(rm -rf)']) {
      const id = freshWorldId('shannon-home', T, seed);
      expect(WORLD_ID.test(id), id).toBe(true); expect(id.length).toBeLessThanOrEqual(128);
      fs.writeFileSync(path.join(dir, WORLD_ID_FILE), id + '\n'); expect(readWorldIdFile(dir), id).toBe(id);
    }
  });
  it('parses properties the way the server reads them (last wins, comments ignored)', () => {
    const p = parseServerProperties('# c\r\nlevel-name=a\r\n! x\nlevel-name = b\nlevel-seed=\n');
    expect(p.get('level-name')).toBe('b'); expect(p.get('level-seed')).toBe('');
    // Only the line ending goes (CRLF, LF, lone CR), and the blanks Java skips before the value; trailing blanks are the value's.
    const q = parseServerProperties('level-name=world \r\nlevel-seed=  12 3 \rserver-port=25560\t\n');
    expect(q.get('level-name')).toBe('world '); expect(q.get('level-seed')).toBe('12 3 '); expect(q.get('server-port')).toBe('25560\t');
  });
  it('accepts one plain directory name only', () => {
    expect(validLevelName('shannon_home')).toBe(true); expect(validLevelName('world')).toBe(true);
    for (const bad of [undefined, '', ' ', '.', '..', '../x', 'a/b', 'a\\b', '..hidden', '.hidden', 'a..b', '/abs', 'C:', 'mods', 'Logs', 'x'.repeat(65), 'a\0b', '-rf', 'world ', ' world',
      'config', 'plugins', 'libraries', 'versions', 'crash-reports', 'world-id', 'World-Id', '.fabric'])
      expect(validLevelName(bad as string), String(bad)).toBe(false);
  });
});

describe('prepareFreshWorld', () => {
  const MOVED = 'shannon_home.before-regen-20261019T1204';
  it('writes the id first, then moves (renames, never copies or deletes) only the level directory, and leaves everything else', async () => {
    const { dir } = fakeServer(); const lines: string[] = []; const order: string[] = [];
    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.basename(String(from)) === 'shannon_home') order.push(`rename:${path.basename(String(to))}:id=${fs.readFileSync(path.join(dir, WORLD_ID_FILE), 'utf8').trim()}`);
      return realRename(from, to);
    });
    const rm = vi.spyOn(fs.promises, 'rm'), rmSync = vi.spyOn(fs, 'rmSync'), cp = vi.spyOn(fs, 'cpSync');
    const result = await prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed, log: l => lines.push(l) });
    expect(result).toEqual({ worldId: 'shannon-home-20261019T1204', levelName: 'shannon_home', movedTo: MOVED });
    expect(order).toEqual([`rename:${MOVED}:id=shannon-home-20261019T1204`]);
    expect(rm).not.toHaveBeenCalled(); expect(cp).not.toHaveBeenCalled();
    expect(rmSync.mock.calls.filter(([target]) => String(target).includes('shannon_home'))).toEqual([]);
    expect(fs.readFileSync(path.join(dir, WORLD_ID_FILE), 'utf8')).toBe('shannon-home-20261019T1204\n');
    expect(fs.existsSync(path.join(dir, 'shannon_home'))).toBe(false);
    // The old world is whole under its new name, next to the server files.
    expect(fs.readFileSync(path.join(dir, MOVED, 'level.dat'), 'utf8')).toBe('x'); expect(fs.existsSync(path.join(dir, MOVED, 'DIM1', 'r.0.0.mca'))).toBe(true);
    expect(fs.existsSync(path.join(dir, MOVED, 'DIM-1'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'mods', 'a.jar'))).toBe(true); expect(fs.existsSync(path.join(dir, 'server.properties'))).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(['mods', 'server.properties', MOVED, WORLD_ID_FILE].sort());
    expect(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8')).toBe(PROPERTIES);
    expect(lines).toEqual(['🌱 新しいワールド: shannon-home-20261019T1204', `📦 旧ワールドを退避: ${MOVED}`]);
  });
  it('picks the first free moved name (-2, -3 ...) and never overwrites an earlier moved world', async () => {
    const { dir } = fakeServer();
    for (const taken of [MOVED, `${MOVED}-2`]) { fs.mkdirSync(path.join(dir, taken)); fs.writeFileSync(path.join(dir, taken, 'earlier'), taken); }
    expect((await prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed })).movedTo).toBe(`${MOVED}-3`);
    expect(fs.readFileSync(path.join(dir, MOVED, 'earlier'), 'utf8')).toBe(MOVED); expect(fs.readFileSync(path.join(dir, `${MOVED}-2`, 'earlier'), 'utf8')).toBe(`${MOVED}-2`);
    expect(fs.existsSync(path.join(dir, `${MOVED}-3`, 'level.dat'))).toBe(true);
  });
  it('puts a configured seed in the id and leaves level-seed as configured', async () => {
    const { dir } = fakeServer(PROPERTIES.replace('level-seed=', 'level-seed=424242'));
    expect((await prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed })).worldId).toBe('shannon-home-20261019T1204-s424242');
    expect(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8')).toContain('level-seed=424242');
  });
  it('works when the world is already gone, and when the id file never existed', async () => {
    const { dir } = fakeServer(); fs.rmSync(path.join(dir, 'shannon_home'), { recursive: true }); fs.rmSync(path.join(dir, WORLD_ID_FILE));
    expect(await prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed })).toMatchObject({ movedTo: null });
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
    ['absolute', 'level-name=/etc'], ['mods', 'level-name=mods'], ['dot', 'level-name=.'], ['backslash', 'level-name=a\\b']])('refuses level-name %s and moves nothing', async (_name, line) => {
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
  it('moves a world that holds a symlink as it is, without following it', async () => {
    const { dir } = fakeServer(); const outside = tmp('outside-'); fs.writeFileSync(path.join(outside, 'precious'), 'x');
    fs.symlinkSync(outside, path.join(dir, 'shannon_home', 'DIM1', 'escape'), 'junction');
    await prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed });
    expect(fs.existsSync(path.join(dir, 'shannon_home'))).toBe(false); expect(fs.readFileSync(path.join(outside, 'precious'), 'utf8')).toBe('x');
    expect(fs.lstatSync(path.join(dir, MOVED, 'DIM1', 'escape')).isSymbolicLink()).toBe(true);
  });
  it('refuses a level path that is a file, or a non-empty directory that is not a world', async () => {
    const { dir } = fakeServer(); fs.rmSync(path.join(dir, 'shannon_home'), { recursive: true }); fs.writeFileSync(path.join(dir, 'shannon_home'), 'file');
    await expect(prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed })).rejects.toMatchObject({ reason: 'level_dir_not_directory' });
    fs.rmSync(path.join(dir, 'shannon_home')); fs.mkdirSync(path.join(dir, 'shannon_home')); fs.writeFileSync(path.join(dir, 'shannon_home', 'notes.txt'), 'x');
    await expect(prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed })).rejects.toMatchObject({ reason: 'level_dir_not_a_world' });
    expect(fs.existsSync(path.join(dir, 'shannon_home', 'notes.txt'))).toBe(true); expect(readWorldIdFile(dir)).toBe('shannon-home-20261001T0900');
    fs.rmSync(path.join(dir, 'shannon_home', 'notes.txt'));
    expect(await prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed })).toMatchObject({ movedTo: MOVED });
  });
  it('refuses when the new id would equal the current one (two fresh worlds in one minute) and when the directory is unreadable', async () => {
    const { dir } = fakeServer(); fs.writeFileSync(path.join(dir, WORLD_ID_FILE), 'shannon-home-20261019T1204\n');
    await expect(prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed })).rejects.toMatchObject({ reason: 'world_id_not_new' });
    expect(fs.existsSync(path.join(dir, 'shannon_home', 'level.dat'))).toBe(true);
    await expect(prepareFreshWorld({ serverDir: path.join(dir, 'missing'), now: () => T, portClosed: closed })).rejects.toBeInstanceOf(FreshWorldRefused);
  });
  it('leaves no temporary file and the old id when the id cannot be written, and moves nothing', async () => {
    const { dir } = fakeServer(); vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Error('disk'); });
    await expect(prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed })).rejects.toMatchObject({ reason: 'world_id_not_written' });
    expect(fs.readdirSync(dir).sort()).toEqual(['mods', 'server.properties', 'shannon_home', WORLD_ID_FILE].sort());
    expect(readWorldIdFile(dir)).toBe('shannon-home-20261001T0900');
  });
  it('is a refusal, with the previous id put back, when moving fails after the id was written (the world did not move)', async () => {
    const { dir } = fakeServer(); const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { if (path.basename(String(from)) === 'shannon_home') throw Error('EBUSY'); return realRename(from, to); });
    await expect(prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed })).rejects.toMatchObject({ reason: 'level_dir_not_moved' });
    // Nothing is changed: the old id byte for byte, the world where it was, no temporary file.
    expect(fs.readFileSync(path.join(dir, WORLD_ID_FILE), 'utf8')).toBe('shannon-home-20261001T0900\n');
    expect(fs.existsSync(path.join(dir, 'shannon_home', 'level.dat'))).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(['mods', 'server.properties', 'shannon_home', WORLD_ID_FILE].sort());
  });
  it('removes the id file again when there was none before the failed move, and restores an unusable old file exactly', async () => {
    const realRename = fs.renameSync.bind(fs);
    const none = fakeServer(); fs.rmSync(path.join(none.dir, WORLD_ID_FILE));
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { if (path.basename(String(from)) === 'shannon_home') throw Error('EBUSY'); return realRename(from, to); });
    await expect(prepareFreshWorld({ serverDir: none.dir, now: () => T, portClosed: closed })).rejects.toBeInstanceOf(FreshWorldRefused);
    expect(fs.readdirSync(none.dir).sort()).toEqual(['mods', 'server.properties', 'shannon_home'].sort());
    const odd = fakeServer(); fs.writeFileSync(path.join(odd.dir, WORLD_ID_FILE), '  not a valid id!  \n\n');
    await expect(prepareFreshWorld({ serverDir: odd.dir, now: () => T, portClosed: closed })).rejects.toBeInstanceOf(FreshWorldRefused);
    expect(fs.readFileSync(path.join(odd.dir, WORLD_ID_FILE), 'utf8')).toBe('  not a valid id!  \n\n');
  });
  it('stays unknown (a plain error) only when the previous id cannot be put back either', async () => {
    const { dir } = fakeServer(); const realRename = fs.renameSync.bind(fs); let ids = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.basename(String(from)) === 'shannon_home') throw Error('EBUSY');
      if (path.basename(String(to)) === WORLD_ID_FILE && ++ids > 1) throw Error('disk');
      return realRename(from, to);
    });
    const failure = await prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed }).catch(e => e);
    expect(failure).toBeInstanceOf(Error); expect(failure).not.toBeInstanceOf(FreshWorldRefused);
  });
  it('refuses an id file it cannot read, and a level-name or port value with a blank at its end, changing nothing', async () => {
    const unreadable = fakeServer(); fs.rmSync(path.join(unreadable.dir, WORLD_ID_FILE)); fs.mkdirSync(path.join(unreadable.dir, WORLD_ID_FILE));
    await expect(prepareFreshWorld({ serverDir: unreadable.dir, now: () => T, portClosed: closed })).rejects.toMatchObject({ reason: 'world_id_unreadable' });
    for (const [name, properties, reason] of [['level-name', PROPERTIES.replace('level-name=shannon_home', 'level-name=shannon_home '), 'level_name_invalid'],
      ['server-port', PROPERTIES.replace('server-port=25560', 'server-port=25560 '), 'port_unreadable'],
      ['rcon.port', PROPERTIES.replace('rcon.port=26560', 'rcon.port=26560\t'), 'port_unreadable']] as const) {
      const { dir } = fakeServer(properties);
      await expect(prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed }), name).rejects.toMatchObject({ reason });
      expect(fs.existsSync(path.join(dir, 'shannon_home', 'level.dat')), name).toBe(true); expect(readWorldIdFile(dir), name).toBe('shannon-home-20261001T0900');
    }
  });
  it('checks the guard immediately before the id is written and again before the move; either stop changes nothing', async () => {
    const { dir } = fakeServer(); const seen: string[] = [];
    // Stops at the first check: nothing is written.
    await expect(prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed, guard: { stop: () => 'aborted' } })).rejects.toMatchObject({ reason: 'aborted' });
    expect(readWorldIdFile(dir)).toBe('shannon-home-20261001T0900'); expect(fs.existsSync(path.join(dir, 'shannon_home', 'level.dat'))).toBe(true);
    // Authority gone while it was asked: nothing is written.
    await expect(prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed, guard: { stop: () => null, authorized: async () => false } })).rejects.toMatchObject({ reason: 'not_authorized' });
    // Stops between the id write and the move (the second synchronous check): the previous id is put back, the world has not moved.
    let calls = 0;
    const guard = { stop: () => { calls++; seen.push(`stop${calls}:id=${readWorldIdFile(dir)}`); return calls >= 3 ? 'deadline' : null; }, authorized: async () => true };
    await expect(prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed, guard })).rejects.toMatchObject({ reason: 'deadline' });
    expect(seen).toEqual(['stop1:id=shannon-home-20261001T0900', 'stop2:id=shannon-home-20261001T0900', 'stop3:id=shannon-home-20261019T1204']);
    expect(fs.readFileSync(path.join(dir, WORLD_ID_FILE), 'utf8')).toBe('shannon-home-20261001T0900\n'); expect(fs.existsSync(path.join(dir, 'shannon_home', 'level.dat'))).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(['mods', 'server.properties', 'shannon_home', WORLD_ID_FILE].sort());
    // A guard that never stops lets it through.
    expect((await prepareFreshWorld({ serverDir: dir, now: () => T, portClosed: closed, guard: { stop: () => null, authorized: async () => true } })).worldId).toBe('shannon-home-20261019T1204');
  });
});

describe('a world-id file that cannot be used', () => {
  it('is reported (and the fallback used), while a missing file is silent', () => {
    const { dir } = fakeServer(); const file = path.join(dir, WORLD_ID_FILE); const reasons: string[] = [];
    const warn = (reason: string) => reasons.push(reason);
    expect(resolvePlacesWorldId(dir, 'env-world', undefined, warn)).toBe('shannon-home-20261001T0900');
    fs.writeFileSync(file, 'not valid!\n'); expect(resolvePlacesWorldId(dir, 'env-world', undefined, warn)).toBe('env-world');
    fs.writeFileSync(file, 'x'.repeat(600)); expect(resolvePlacesWorldId(dir, 'env-world', undefined, warn)).toBe('env-world');
    fs.rmSync(file); fs.mkdirSync(file); expect(resolvePlacesWorldId(dir, 'env-world', undefined, warn)).toBe('env-world');
    fs.rmdirSync(file); expect(resolvePlacesWorldId(dir, 'env-world', undefined, warn)).toBe('env-world');
    expect(reasons).toEqual(['invalid_id', 'oversize', 'unreadable']);
  });
  it('is logged as a warning at the spawn that fell back', async () => {
    const { logger } = await import('../../src/utils/logger.js');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { base, dir } = fakeServer(); vi.stubEnv('SERVER_BASE_PATH', base); vi.stubEnv('MINEBOT_PLACES_WORLD_ID', 'env-world');
    fs.writeFileSync(path.join(dir, WORLD_ID_FILE), 'bad id\n');
    const persisted: string[] = [];
    const bot: any = Object.assign(new EventEmitter(), { entity: undefined, health: 0, connectedServerName: 'shannon-home',
      instantSkills: { getSkills: () => [] }, placeMemory: { persistTo: (file: string) => persisted.push(path.basename(file)) } });
    createCommonFcaBody(bot, { url: 'http://127.0.0.1:1', serverId: 'home', serverName: 'shannon-home' }, 'token');
    bot.emit('spawn'); bot.emit('end');
    expect(persisted).toEqual(['home--env-world.json']);
    expect(warn).toHaveBeenCalledTimes(1); expect(String(warn.mock.calls[0]?.[0])).toContain('invalid_id');
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
    prepareFreshWorld: async (_signal, guard) => {
      effects.push('fresh');
      if (!serverDir) return { worldId: 'x', movedTo: null };
      const { worldId, movedTo } = await prepareFreshWorld({ serverDir, now: () => T, portClosed: closed, guard });
      return { worldId, movedTo };
    },
    botState: () => ({ phase: 'absent', serverId: null, uuid: null }),
    login: async () => undefined, logout: async () => undefined, authorize: async () => true,
  };
  const command = (action: MinecraftLifecycleCommand['action'], options?: unknown, id = `operation:${action}:${Math.random()}`, origin: 'owner_request' | 'own_time' = 'owner_request'): MinecraftLifecycleCommand => ({
    schemaVersion: 1, id, serverId: 'home', connectionId: 'connection', action,
    authority: { scopeKey: 'owner', origin, executionId: 'session', lease: { id: 'lease', holder: 'worker', generation: 1 }, sourceIds: ['source:owner'] },
    issuedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 30000).toISOString(), ...(options === undefined ? {} : { options: options as never }) });
  return { ports, native: new MinecraftLifecycleNative(ports), command, effects, run() { running = true; }, get reads() { return reads; } };
}
const signal = () => new AbortController().signal;

describe('fresh-world start through the lifecycle native', () => {
  it('re-checks stopped, writes the id, moves the world aside, then starts, and completes as an ordinary start', async () => {
    const { dir } = fakeServer(); const f = lifecycle(dir);
    const receipt = await f.native.execute(f.command('start', { freshWorld: true }), signal());
    expect(receipt).toMatchObject({ outcome: 'completed', code: 'changed', inputsReleased: true });
    expect(receipt.state.running).toBe('running');
    // The receipt says which world this is and where the old one was kept.
    expect(receipt).toMatchObject({ worldId: 'shannon-home-20261019T1204', movedTo: 'shannon_home.before-regen-20261019T1204' });
    expect(f.effects).toEqual(['fresh', 'start(id=shannon-home-20261019T1204,world=false)']);
    expect(fs.existsSync(path.join(dir, 'mods', 'a.jar'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'shannon_home.before-regen-20261019T1204', 'level.dat'))).toBe(true);
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
  it('keeps a failure whose state is not known unknown, never starting', async () => {
    const f = lifecycle(); f.ports.prepareFreshWorld = async () => { f.effects.push('fresh'); throw Error('EBUSY'); };
    const receipt = await f.native.execute(f.command('start', { freshWorld: true }), signal());
    expect(receipt).toMatchObject({ outcome: 'unknown', code: 'error', inputsReleased: false });
    expect(receipt).not.toHaveProperty('worldId');
    expect(f.effects).toEqual(['fresh']);
  });
  it('is refused/error with nothing changed when the move fails after the id was written (the id is put back, the server never started)', async () => {
    const { dir } = fakeServer(); const f = lifecycle(dir); const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { if (path.basename(String(from)) === 'shannon_home') throw Error('EBUSY'); return realRename(from, to); });
    const receipt = await f.native.execute(f.command('start', { freshWorld: true }), signal());
    expect(receipt).toMatchObject({ outcome: 'refused', code: 'error', inputsReleased: true });
    expect(receipt).not.toHaveProperty('worldId');
    expect(f.effects).toEqual(['fresh']);
    expect(fs.readFileSync(path.join(dir, WORLD_ID_FILE), 'utf8')).toBe('shannon-home-20261001T0900\n'); expect(fs.existsSync(path.join(dir, 'shannon_home', 'level.dat'))).toBe(true);
  });
  it('stops at the guard when the command is aborted or past its deadline just before the change, and when the permit is gone', async () => {
    const { dir } = fakeServer(); const controller = new AbortController();
    const aborted = lifecycle(dir);
    // The signal fires after the final authority check, while the preparation runs (before the id is written).
    const real = aborted.ports.prepareFreshWorld!; aborted.ports.prepareFreshWorld = async (s, guard) => { controller.abort('authority_revoked'); return real(s, guard); };
    expect(await aborted.native.execute(aborted.command('start', { freshWorld: true }), controller.signal)).toMatchObject({ outcome: 'refused', code: 'error' });
    expect(fs.existsSync(path.join(dir, 'shannon_home', 'level.dat'))).toBe(true); expect(readWorldIdFile(dir)).toBe('shannon-home-20261001T0900');
    const late = lifecycle(dir); let clock = Date.now() + 5000; late.ports.now = () => clock;
    const prepare = late.ports.prepareFreshWorld!; late.ports.prepareFreshWorld = async (s, guard) => { clock += 60_000; return prepare(s, guard); };
    expect(await late.native.execute(late.command('start', { freshWorld: true }), signal())).toMatchObject({ outcome: 'refused', code: 'error' });
    expect(late.effects).toEqual(['fresh']); expect(readWorldIdFile(dir)).toBe('shannon-home-20261001T0900');
    const revoked = lifecycle(dir); let permits = 0; revoked.ports.authorize = async () => ++permits < 2;
    expect(await revoked.native.execute(revoked.command('start', { freshWorld: true }), signal())).toMatchObject({ outcome: 'refused', code: 'error' });
    expect(permits).toBe(2); expect(revoked.effects).toEqual(['fresh']); expect(fs.existsSync(path.join(dir, 'shannon_home', 'level.dat'))).toBe(true);
  });
  it('applies it only to the owner\'s own request: her own time is refused, nothing changed', async () => {
    const { dir } = fakeServer(); const f = lifecycle(dir);
    expect(await f.native.execute(f.command('start', { freshWorld: true }, undefined, 'own_time'), signal())).toMatchObject({ outcome: 'refused', code: 'error', inputsReleased: true });
    expect(f.effects).toEqual([]); expect(fs.existsSync(path.join(dir, 'shannon_home', 'level.dat'))).toBe(true); expect(readWorldIdFile(dir)).toBe('shannon-home-20261001T0900');
    // An ordinary start from her own time is still an ordinary start.
    expect(await f.native.execute(f.command('start', undefined, undefined, 'own_time'), signal())).toMatchObject({ outcome: 'completed', code: 'changed' });
  });
  it('advertises the capability only when the fresh-world port is wired, in every poll, and the API contract accepts the poll', async () => {
    const wired = lifecycle(); expect(wired.native.capabilities()).toEqual(['freshWorld']);
    const bare = lifecycle(); delete bare.ports.prepareFreshWorld; expect(bare.native.capabilities()).toEqual([]);
    const bodies: any[] = [];
    const operator = new MinecraftLifecycleOperator({ baseUrl: 'http://127.0.0.1:1', token: 'fixture-only-token', native: wired.native,
      journal: new LifecycleOperationJournal(path.join(tmp('journal-'), 'operations.json')),
      fetcher: (async (_url: string, init: { body: string }) => { bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ schemaVersion: 1, commands: [], cancel: [], acknowledged: [] })); }) as never });
    await operator.poll(); await operator.poll();
    expect(bodies.map(b => b.capabilities)).toEqual([['freshWorld'], ['freshWorld']]);
    for (const body of bodies) expect(validLifecyclePoll(body, Date.now())).toBe(true);
  });
  it('validates the poll\'s capabilities and the receipt\'s world fields, and ignores nothing malformed', () => {
    const state = { serverId: 'home', observedAt: new Date().toISOString(), running: 'running', bot: 'absent', otherPlayers: 0 };
    const receipt = { id: 'a', connectionId: 'c', serverId: 'home', action: 'start', outcome: 'completed', code: 'changed', observedAt: state.observedAt, inputsReleased: true, state };
    const poll = (patch: object = {}, receiptPatch: object = {}) => ({ schemaVersion: 1, connectionId: 'c', sequence: 0, states: [state], receipts: [{ ...receipt, ...receiptPatch }], ...patch });
    const now = Date.now();
    expect(validLifecyclePoll(poll(), now)).toBe(true);
    expect(validLifecyclePoll(poll({ capabilities: [] }), now)).toBe(true);
    expect(validLifecyclePoll(poll({ capabilities: ['freshWorld', 'somethingElse'] }), now)).toBe(true);
    // A malformed capability list is not a reason to lose the channel: the poll stands and only well-formed names count.
    for (const odd of [[1], ['has space'], ['a'.repeat(33)], Array.from({ length: 17 }, (_, i) => `c${i}`)]) expect(validLifecyclePoll(poll({ capabilities: odd }), now), JSON.stringify(odd)).toBe(true);
    expect([...lifecycleCapabilities({ capabilities: ['freshWorld', 'has space', 1 as never, 'a'.repeat(33), 'x_y'] })]).toEqual(['freshWorld']);
    expect([...lifecycleCapabilities(null)]).toEqual([]); expect([...lifecycleCapabilities({})]).toEqual([]);
    for (const bad of ['freshWorld', {}, null, Array.from({ length: 65 }, (_, i) => `c${i}`)]) expect(validLifecyclePoll(poll({ capabilities: bad }), now), JSON.stringify(bad)).toBe(false);
    expect(validLifecyclePoll(poll({}, { worldId: 'shannon-home-20261019T1204', movedTo: 'shannon_home.before-regen-20261019T1204' }), now)).toBe(true);
    expect(validLifecyclePoll(poll({}, { worldId: 'shannon-home-20261019T1204', movedTo: null }), now)).toBe(true);
    for (const bad of [{ worldId: 5 }, { worldId: '../x' }, { worldId: '' }, { movedTo: 5 }, { movedTo: '../x' }, { movedTo: 'a/b' }, { movedTo: '' }]) expect(validLifecyclePoll(poll({}, bad), now), JSON.stringify(bad)).toBe(false);
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
    const restarted = lifecycle(dir); restarted.ports.prepareFreshWorld = async () => { restarted.effects.push('fresh'); return { worldId: 'x', movedTo: null }; };
    const reloaded = operatorFor(new LifecycleOperationJournal(file), restarted.native);
    await reloaded.poll(); await reloaded.poll();
    expect(f.effects.filter(e => e === 'fresh')).toHaveLength(1); expect(restarted.effects).toEqual([]);
    expect(bodies.at(-1)?.receipts.map(r => r.id)).toContain('operation:fresh:resend');
  });
});
