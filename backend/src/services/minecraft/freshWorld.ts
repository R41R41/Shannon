import fs from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';

/**
 * A fresh world for the dedicated home server (the owner's request): the world gets a new id, the old world directory is
 * moved aside (renamed to `<level-name>.before-regen-<JST YYYYMMDDTHHMM>` in the same server directory; nothing is deleted,
 * owner's decision of 2026-10-19) and the server starts on a new map. The same steps are done by the server-side
 * `new-world.sh`; keep the id format, the file path, the moved name and the safety checks identical.
 *
 * Nothing here takes a path or a name from a model or an API caller: the directory is the configured server directory and the
 * only directory ever moved is the one `level-name` names in that server's own `server.properties`.
 */

/** The places-memory world id (the same rule createCommonFcaBody has always applied to MINEBOT_PLACES_WORLD_ID). */
export const WORLD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** `<server directory>/world-id`: one line, the id the body keys its places memory by. Written by a fresh world, read at every spawn. */
export const WORLD_ID_FILE = 'world-id';
/**
 * Names in a server install that are never a world, whatever `level-name` says. The first nine are the server-side script's own
 * reserved list (`new-world.sh`: mods, config, logs, plugins, libraries, versions, crash-reports, world-id, .fabric); the rest are
 * further install directories.
 */
const RESERVED_NAMES = new Set(['mods', 'config', 'logs', 'plugins', 'libraries', 'versions', 'crash-reports', 'world-id', '.fabric',
  'defaultconfigs', 'resourcepacks', 'datapacks', 'backups', 'world-backups', 'cache', 'tmp', 'bin', 'jre', 'java']);

export function worldIdFilePath(serverDir: string): string { return path.join(serverDir, WORLD_ID_FILE); }

/** The server directory for a server name under SERVER_BASE_PATH (read now, not at module load), or null when either is unusable. */
export function serverDirectory(serverName: string | undefined, base: string | undefined = process.env.SERVER_BASE_PATH): string | null {
  const name = serverName?.trim(), root = base?.trim();
  if (!name || !root || name !== path.basename(name) || name === '.' || name === '..') return null;
  return path.join(root, name);
}

/**
 * The world id the operator wrote for this server, or null (no file, unreadable, oversize, or not a valid id). Synchronous and
 * uncached on purpose: it is read at every bot spawn, so a world made while the process runs is picked up by the next spawn.
 * A file that exists but cannot be used is reported to `onInvalid` (the caller falls back to the env value or the context's id,
 * which would otherwise file a new world's places under the old name without anyone knowing).
 */
export function readWorldIdFile(serverDir: string | null | undefined, onInvalid?: (reason: 'unreadable' | 'oversize' | 'invalid_id') => void): string | null {
  if (!serverDir) return null;
  let text: string;
  try { text = fs.readFileSync(worldIdFilePath(serverDir), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onInvalid?.('unreadable');
    return null;
  }
  if (text.length > 512) { onInvalid?.('oversize'); return null; }
  const id = text.trim();
  if (WORLD_ID.test(id)) return id;
  onInvalid?.('invalid_id');
  return null;
}

/** Priority: a valid world-id file, else a valid MINEBOT_PLACES_WORLD_ID, else the memory context's id. */
export function resolvePlacesWorldId(serverDir: string | null | undefined, envValue: string | undefined, contextWorldId: string | undefined,
  onInvalid?: (reason: 'unreadable' | 'oversize' | 'invalid_id') => void): string | undefined {
  const fromFile = readWorldIdFile(serverDir, onInvalid);
  if (fromFile) return fromFile;
  const fromEnv = envValue?.trim();
  if (fromEnv && WORLD_ID.test(fromEnv)) return fromEnv;
  return contextWorldId || undefined;
}

/** JST `YYYYMMDDTHHMM`. */
export function jstStamp(nowMs: number): string {
  const jst = new Date(nowMs + 9 * 3600_000).toISOString(); // 2026-10-19T12:34:56.789Z, shifted to JST
  return `${jst.slice(0, 4)}${jst.slice(5, 7)}${jst.slice(8, 10)}T${jst.slice(11, 13)}${jst.slice(14, 16)}`;
}

/**
 * `<prefix>-<JST YYYYMMDDTHHMM>` plus `-s<seed>` when `level-seed` is set. The seed is not trimmed (the server-side script does not
 * trim it): every Unicode code point outside A-Za-z0-9- becomes one `-` (a space at either end too, and an emoji is one `-`, not
 * two), at most 32 of them; so -77 gives `-s-77`.
 */
export function freshWorldId(prefix: string, nowMs: number, seed = ''): string {
  const stamp = jstStamp(nowMs);
  const suffix = Array.from(seed, ch => /^[A-Za-z0-9-]$/.test(ch) ? ch : '-').slice(0, 32).join('');
  const id = `${prefix}-${stamp}${suffix ? `-s${suffix}` : ''}`;
  if (!WORLD_ID.test(id)) throw new FreshWorldRefused('world_id_invalid');
  return id;
}

/** Nothing was changed: the world, the id file and the server are as they were. */
export class FreshWorldRefused extends Error {
  constructor(readonly reason: string) { super(`FRESH_WORLD_REFUSED:${reason}`); }
}

/**
 * Java properties as the server reads them: `key=value`, `#`/`!` comments, the last occurrence wins. Only the line ending is
 * stripped from a value (and the blanks before it, as Java skips them): trailing blanks stay, because the server keeps them, so
 * `level-name=world ` names a directory this code must not treat as `world`.
 */
export function parseServerProperties(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r\n|\r|\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const split = trimmed.indexOf('=');
    if (split < 0) continue;
    map.set(trimmed.slice(0, split).trim(), trimmed.slice(split + 1).trimStart());
  }
  return map;
}

/** A port as the server parses it (`Integer.parseInt`): digits only, no blank on either side. */
function portNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
}

/** True only when the connection is actively refused; a listener, a timeout or any other error is "not proven closed". */
export function tcpRefused(port: number, host = '127.0.0.1', timeoutMs = 1500): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    const done = (value: boolean) => { clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.on('connect', () => done(false));
    socket.on('error', error => done((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'));
  });
}

/**
 * What the caller can still tell the preparation while it runs. `stop` is synchronous on purpose (it is asked between two file
 * steps): a reason to stop now (aborted, past the command's deadline) or null. `authorized` is asked once, before the first change.
 */
export interface FreshWorldGuard {
  stop(): string | null;
  authorized?(): Promise<boolean>;
}

export interface FreshWorldOptions {
  /** The server's own directory (holds server.properties, the world directory and world-id). */
  serverDir: string;
  now?: () => number;
  /** True only when the port is proven closed. Default: a refused local TCP connection. */
  portClosed?: (port: number) => Promise<boolean>;
  log?: (line: string) => void;
  /** Checked immediately before the id is written and again immediately before the world is moved (then the id is put back). */
  guard?: FreshWorldGuard;
}
/** `movedTo`: the name (in the server directory) the old world was moved to, or null when there was no world directory. */
export interface FreshWorldResult { worldId: string; levelName: string; movedTo: string | null }

/** `level-name` accepted as a single plain directory name. */
export function validLevelName(value: string | undefined): value is string {
  if (!value || value !== value.trim() || value.length > 64) return false;
  if (value === '.' || value === '..' || value.includes('..') || /[\\/\0:]/.test(value) || value.startsWith('.') || value.startsWith('-')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(value) && !RESERVED_NAMES.has(value.toLowerCase());
}

/**
 * Prepare a fresh world. The caller has already established, from a fresh read, that the server is stopped; this re-checks the
 * listeners and then, in this order: validate everything, write `world-id` atomically (temp + rename), move the level
 * directory to `<level-name>.before-regen-<JST stamp>` (-2, -3 ... if taken). It throws FreshWorldRefused before any change, and
 * also when a step after the id was written fails while the server is provably still stopped: the previous id is put back (or the
 * file removed if there was none) and the world has not moved, so nothing is changed. Any other error means the state is not
 * known (the id could not be put back, or the world moved and something else is wrong).
 * `level-seed` is left as configured (empty = random).
 */
export async function prepareFreshWorld(options: FreshWorldOptions): Promise<FreshWorldResult> {
  const portClosed = options.portClosed ?? (port => tcpRefused(port));
  const now = options.now ?? Date.now;
  let root: string, properties: Map<string, string>;
  try {
    root = fs.realpathSync(options.serverDir);
    properties = parseServerProperties(fs.readFileSync(path.join(root, 'server.properties'), 'utf8'));
  } catch { throw new FreshWorldRefused('server_directory_unreadable'); }

  // The server must not be listening: the game port and the RCON port both refuse connections.
  const gamePort = portNumber(properties.get('server-port'), 25565);
  const ports = [gamePort];
  if (properties.get('enable-rcon') === 'true') ports.push(portNumber(properties.get('rcon.port'), Number.NaN));
  if (!ports.every(p => Number.isInteger(p) && p >= 1 && p <= 65535)) throw new FreshWorldRefused('port_unreadable');
  for (const port of ports) if (!await portClosed(port).catch(() => false)) throw new FreshWorldRefused('server_listening');

  const levelName = properties.get('level-name');
  if (!validLevelName(levelName)) throw new FreshWorldRefused('level_name_invalid');
  const levelDir = path.join(root, levelName);
  if (path.dirname(levelDir) !== root || path.basename(levelDir) !== levelName) throw new FreshWorldRefused('level_dir_outside_server');
  try {
    const existing = lstat(levelDir);
    if (existing) {
      // Never follow a link, never move a file, and only move what is recognizably a world (or an empty directory).
      if (existing.isSymbolicLink()) throw new FreshWorldRefused('level_dir_is_symlink');
      if (!existing.isDirectory()) throw new FreshWorldRefused('level_dir_not_directory');
      const levelDat = lstat(path.join(levelDir, 'level.dat'));
      if (!(levelDat?.isFile()) && fs.readdirSync(levelDir).length > 0) throw new FreshWorldRefused('level_dir_not_a_world');
    }
  } catch (error) { throw error instanceof FreshWorldRefused ? error : new FreshWorldRefused('level_dir_unreadable'); }

  const nowMs = now();
  const worldId = freshWorldId(path.basename(options.serverDir), nowMs, properties.get('level-seed') ?? '');
  // What the id file holds now, byte for byte, so that it can be put back exactly: null = there is no file.
  const file = worldIdFilePath(root), temporary = `${file}.${process.pid}.tmp`;
  let before: string | null;
  try { before = fs.readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new FreshWorldRefused('world_id_unreadable'); before = null; }
  if (before !== null && before.trim() === worldId) throw new FreshWorldRefused('world_id_not_new');
  // Where the old world goes: a sibling in the same server directory, a name that is free now (-2, -3 ... when it is taken).
  let movedTo: string | null = null;
  if (lstat(levelDir)) {
    try {
      const base = `${levelName}.before-regen-${jstStamp(nowMs)}`;
      for (let n = 1; n <= 1000 && !movedTo; n++) { const name = n === 1 ? base : `${base}-${n}`; if (!lstat(path.join(root, name))) movedTo = name; }
    } catch { throw new FreshWorldRefused('backup_name_unreadable'); }
    if (!movedTo) throw new FreshWorldRefused('backup_name_taken');
  }

  // The command may have been aborted, run past its deadline or lost its authority while the checks above waited.
  const stopReason = (): string | null => options.guard?.stop() ?? null;
  const beforeChange = stopReason();
  if (beforeChange) throw new FreshWorldRefused(beforeChange);
  if (options.guard?.authorized && !await options.guard.authorized().catch(() => false)) throw new FreshWorldRefused('not_authorized');
  const beforeWrite = stopReason();
  if (beforeWrite) throw new FreshWorldRefused(beforeWrite);

  /** Writes `text` to the id file atomically (temp, fsync, rename). */
  const writeId = (text: string): void => {
    const fd = fs.openSync(temporary, 'w', 0o644);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    try { const dir = fs.openSync(root, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch { /* best effort */ }
  };
  /**
   * Puts the id file back as it was (the old text, or no file). Used when the world has not moved and the server is provably
   * still stopped: then nothing is changed and the failure is a refusal. A failure to put it back leaves the state unknown.
   */
  const restoreId = (): void => {
    try {
      if (before === null) fs.rmSync(file, { force: true });
      else writeId(before);
    } catch { throw Error('FRESH_WORLD_ID_NOT_RESTORED'); }
  };

  // The id first: a body that spawns after this point never files its places under the old world's name.
  try { writeId(`${worldId}\n`); }
  catch {
    try { fs.rmSync(temporary, { force: true }); } catch { /* nothing else to undo */ }
    throw new FreshWorldRefused('world_id_not_written');
  }

  // One rename inside the server directory (never a copy, never a delete); the old world stays whole under its new name. Until
  // it has happened, any failure puts the previous id back and is a refusal: the world is where it was and the server is stopped.
  // The ports are read again here, right before the rename: the first read is before the authorization round trip and the id write,
  // and a server started by someone else in between must never have its world moved from under it.
  for (const port of ports) {
    if (!await portClosed(port).catch(() => false)) { restoreId(); throw new FreshWorldRefused('server_listening'); }
  }
  const beforeMove = stopReason();
  if (beforeMove) { restoreId(); throw new FreshWorldRefused(beforeMove); }
  const last = lstat(levelDir);
  if (last) {
    if (last.isSymbolicLink() || !last.isDirectory() || !movedTo || lstat(path.join(root, movedTo))) { restoreId(); throw new FreshWorldRefused('level_dir_changed'); }
    try { fs.renameSync(levelDir, path.join(root, movedTo)); }
    catch {
      // A rename either happened or it did not; the level directory still being there proves it did not.
      const still = lstat(levelDir);
      if (still && !lstat(path.join(root, movedTo))) { restoreId(); throw new FreshWorldRefused('level_dir_not_moved'); }
      throw Error('FRESH_WORLD_MOVE_UNKNOWN');
    }
  } else movedTo = null;
  if (lstat(levelDir)) throw Error('FRESH_WORLD_LEVEL_DIR_REMAINS');
  options.log?.(`🌱 新しいワールド: ${worldId}`);
  if (movedTo) options.log?.(`📦 旧ワールドを退避: ${movedTo}`);
  return { worldId, levelName, movedTo };
}

function lstat(target: string): fs.Stats | null {
  try { return fs.lstatSync(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
