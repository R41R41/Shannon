import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:Scene');

/**
 * The scene of a heavy failure (2026-10-28): the world as it was, copied from the server's own files, so that the replay lab starts from the real
 * ground (not one inferred from the world after the run and a re-generated one) with its creatures, items, falling blocks and flows.
 * `save-all flush` first (the server writes every loaded chunk), then the region, entities and poi files of the chunks within RADIUS_CHUNKS of the
 * body, `level.dat`, and the server log around the moment. What the save cost the server (its "Can't keep up" lines in the following seconds) is
 * read from the log afterwards and written into the manifest.
 */
export const SCENE_RADIUS_CHUNKS = 3;
const KINDS = ['region', 'entities', 'poi'] as const;
const LOG_TAIL_BYTES = 96 * 1024, LOG_LINES = 250;
/** How long after the save the log is read again for the server's lag lines. */
const LAG_LOOK_MS = 8_000;
/** Scenes kept in all (the oldest go first). */
const SCENES_MAX = 40, SCENES_BYTES_MAX = 4_000_000_000;

export interface ScenePorts {
  /** A server command (RCON in production, the lab's operator in the lab); the answer's text. */
  command(text: string, timeoutMs?: number): Promise<string>;
  /** The server's directory (`server.properties`, the world folder by its `level-name`, `logs/latest.log`). */
  serverDir: string;
  /** Where the scenes go. */
  root: string;
  /**
   * The body's own names, read at the moment of each `list` (run 44, hold 1: the names were read when the body was made, before its login gave it
   * one, so its own name counted as someone else's and the world was never frozen). Compared without case.
   */
  self(): ReadonlyArray<string | null | undefined>;
  /** Other names in `list` that are not someone else (the lab's operator); anyone more and the world is not frozen. */
  ignore?: readonly string[];
}
/** The names a mineflayer body goes by: its own (set at login), and its client's (the profile's name with a Microsoft login). */
export function selfNames(bot: any): string[] {
  return [bot?.username, bot?._client?.username, bot?.player?.username].filter((name): name is string => typeof name === 'string' && name.length > 0);
}
export interface SceneResult {
  id: string; dir: string | null; ok: boolean; why: string; saveMs: number; copyMs: number; bytes: number; files: string[];
  dimension: string; center: [number, number, number];
}

export function dimensionFolder(dimension: string): string {
  const name = dimension.replace(/^minecraft:/u, '');
  return name === 'the_nether' ? 'DIM-1' : name === 'the_end' ? 'DIM1' : '';
}
export function levelName(serverDir: string): string {
  try {
    const line = fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8').split(/\r?\n/u).find(entry => entry.startsWith('level-name='));
    const name = line?.slice('level-name='.length).trim();
    return name && /^[A-Za-z0-9_.-]{1,80}$/u.test(name) ? name : 'world';
  } catch { return 'world'; }
}
/** The region files (r.X.Z) that hold the chunks within `radius` chunks of a block position. */
export function regionsAround(x: number, z: number, radius = SCENE_RADIUS_CHUNKS): string[] {
  const cx = Math.floor(x / 16), cz = Math.floor(z / 16), out = new Set<string>();
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) out.add(`r.${Math.floor((cx + dx) / 32)}.${Math.floor((cz + dz) / 32)}.mca`);
  return [...out].sort();
}
async function tail(file: string, bytes: number): Promise<string> {
  try {
    const handle = await fs.promises.open(file, 'r');
    try {
      const { size } = await handle.stat(); const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length); await handle.read(buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } finally { await handle.close(); }
  } catch { return ''; }
}

export class SceneSaver {
  constructor(private readonly ports: ScenePorts) {}

  /** The players on the server other than the body (`list`), or null when it cannot be told. */
  async others(): Promise<string[] | null> {
    try {
      const answer = await this.ports.command('list', 4000);
      const names = /:\s*(.*)$/u.exec(answer.trim())?.[1] ?? '';
      const own = new Set([...this.ports.self(), ...(this.ports.ignore ?? [])].filter((name): name is string => !!name).map(name => name.toLowerCase()));
      return names.split(',').map(name => name.trim()).filter(name => name && !own.has(name.toLowerCase()));
    } catch { return null; }
  }
  /** `/tick freeze` unless anyone else is on the server (then it is not frozen, and that is said). */
  async freeze(): Promise<{ frozen: boolean; why: string }> {
    const others = await this.others();
    if (others === null) return { frozen: false, why: 'players_unknown' };
    if (others.length) return { frozen: false, why: `others_present:${others.slice(0, 4).join(',')}` };
    try { const answer = await this.ports.command('tick freeze', 4000); return { frozen: true, why: answer.slice(0, 120) || 'frozen' }; }
    catch (error) { return { frozen: false, why: `freeze_failed:${String((error as Error)?.message ?? error).slice(0, 80)}` }; }
  }
  async unfreeze(): Promise<string> {
    try { return (await this.ports.command('tick unfreeze', 4000)).slice(0, 120) || 'unfrozen'; }
    catch (error) { return `unfreeze_failed:${String((error as Error)?.message ?? error).slice(0, 80)}`; }
  }

  /** Saves the scene `id` around `center` (a block position) in `dimension`; `meta` goes into its manifest. */
  async save(id: string, center: [number, number, number], dimension: string, meta: Record<string, unknown> = {}): Promise<SceneResult> {
    const dir = path.join(this.ports.root, id.replace(/[^A-Za-z0-9_.-]/gu, '_'));
    const result: SceneResult = { id, dir, ok: false, why: '', saveMs: 0, copyMs: 0, bytes: 0, files: [], dimension, center };
    const startedAt = new Date().toISOString();
    let started = performance.now();
    try {
      const answer = await this.ports.command('save-all flush', 30_000);
      result.saveMs = Math.round(performance.now() - started);
      if (!/saved|Saving/iu.test(answer)) result.why = `save-all: ${answer.slice(0, 80)}`;
    } catch (error) {
      result.saveMs = Math.round(performance.now() - started);
      result.why = `save-all failed: ${String((error as Error)?.message ?? error).slice(0, 80)} (copied as the files were)`;
    }
    started = performance.now();
    try {
      const world = path.join(this.ports.serverDir, levelName(this.ports.serverDir));
      const sub = dimensionFolder(dimension);
      await fs.promises.mkdir(dir, { recursive: true });
      const copy = async (from: string, to: string) => {
        try { await fs.promises.mkdir(path.dirname(to), { recursive: true }); await fs.promises.copyFile(from, to); const s = await fs.promises.stat(to); result.bytes += s.size; result.files.push(path.relative(dir, to)); }
        catch { /* a file that is not there (no entities yet) is not copied */ }
      };
      await copy(path.join(world, 'level.dat'), path.join(dir, 'world', 'level.dat'));
      for (const kind of KINDS) for (const file of regionsAround(center[0], center[2])) {
        await copy(path.join(world, sub, kind, file), path.join(dir, 'world', sub, kind, file));
      }
      const logText = (await tail(path.join(this.ports.serverDir, 'logs', 'latest.log'), LOG_TAIL_BYTES)).split(/\r?\n/u).slice(-LOG_LINES).join('\n');
      await fs.promises.writeFile(path.join(dir, 'server-before.log'), logText);
      result.copyMs = Math.round(performance.now() - started);
      result.ok = result.files.some(file => file.includes('region'));
      if (!result.ok) result.why ||= 'no region file copied';
    } catch (error) {
      result.copyMs = Math.round(performance.now() - started);
      result.why = `copy failed: ${String((error as Error)?.message ?? error).slice(0, 100)}`;
    }
    const manifest = { v: 1, id, at: startedAt, dimension, center, radiusChunks: SCENE_RADIUS_CHUNKS, ...meta, saveMs: result.saveMs, copyMs: result.copyMs,
      bytes: result.bytes, files: result.files, ok: result.ok, why: result.why, lagLines: null as string[] | null };
    try { await fs.promises.writeFile(path.join(dir, 'scene.json'), JSON.stringify(manifest, null, 1)); } catch { /* the files are the scene */ }
    log.info(`🎬 現場を保存した ${id}: ${result.files.length} 個・${Math.round(result.bytes / 1024 / 1024)} MB（save-all ${result.saveMs} ms・写し ${result.copyMs} ms）${result.why ? ` ${result.why}` : ''}`);
    // The server's lag after the save, read a few seconds later (it never holds the caller).
    const savedAt = Date.now();
    setTimeout(() => { void this.lag(dir, manifest, savedAt); }, LAG_LOOK_MS).unref?.();
    void this.tidy().catch(() => undefined);
    return result;
  }

  private async lag(dir: string, manifest: Record<string, unknown>, savedAt: number): Promise<void> {
    const text = await tail(path.join(this.ports.serverDir, 'logs', 'latest.log'), LOG_TAIL_BYTES);
    const lines = text.split(/\r?\n/u).filter(line => /Can't keep up/u.test(line)).slice(-10);
    const since = new Date(savedAt - 2000).toTimeString().slice(0, 8);
    manifest.lagLines = lines.filter(line => (/\[(\d\d:\d\d:\d\d)\]/u.exec(line)?.[1] ?? '') >= since);
    await fs.promises.writeFile(path.join(dir, 'scene.json'), JSON.stringify(manifest, null, 1)).catch(() => undefined);
    await fs.promises.writeFile(path.join(dir, 'server-after.log'), text.split(/\r?\n/u).slice(-80).join('\n')).catch(() => undefined);
  }

  private async tidy(): Promise<void> {
    const entries = (await fs.promises.readdir(this.ports.root, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory());
    const scenes = await Promise.all(entries.map(async entry => {
      const where = path.join(this.ports.root, entry.name);
      const stat = await fs.promises.stat(where).catch(() => null);
      return { where, at: stat?.mtimeMs ?? 0, bytes: await sizeOf(where) };
    }));
    scenes.sort((a, b) => a.at - b.at);
    let total = scenes.reduce((sum, scene) => sum + scene.bytes, 0);
    while (scenes.length > 1 && (scenes.length > SCENES_MAX || total > SCENES_BYTES_MAX)) {
      const gone = scenes.shift()!; total -= gone.bytes; await fs.promises.rm(gone.where, { recursive: true, force: true });
    }
  }
}
async function sizeOf(where: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.promises.readdir(where, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(where, entry.name);
    total += entry.isDirectory() ? await sizeOf(full) : (await fs.promises.stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}
