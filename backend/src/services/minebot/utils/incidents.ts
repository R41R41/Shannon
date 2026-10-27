import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../../../utils/logger.js';
import type { ActReport } from './actReport.js';
import { blackBoxOf, type BlackBox } from './blackbox.js';
import { SceneSaver, selfNames, type SceneResult } from './sceneSave.js';
import { rconCommand } from '../../integration/minecraftLifecycleNative.js';
import { serverDirectory } from '../../minecraft/freshWorld.js';

const log = createLogger('Minebot:Incident');

/**
 * Failures, written down where they happen (2026-10-28, owner: 「黒箱・現場の保存・止めて直す実走」). An act that did not succeed writes the black box;
 * a heavy one also saves the scene (the world's files around the body) under the same id; and an act whose task asked to be held on a heavy
 * failure (`context.incident.hold`, the operator's `request --hold-on-failure`) stops the world (`/tick freeze`, never with anyone else on the
 * server) and holds the task's next acts until one comes with `context.incident.resume` naming the hold: that one unfreezes the world and runs.
 * The hold is kept in a file, so a body restarted in between (a deploy) is still held when it comes back.
 *
 * Run 44 (hold 1, the coordinator's choice of 2026-10-28): a world that cannot be stopped (someone else on the server, the players not known, the
 * freeze refused) is not held: a hold in a moving world left the body standing at night with no act allowed, and it died. The box and the scene
 * are taken, the act's receipt says why there was no hold (`notHeld`), and the task goes on. A resume, a cancel and a stale hold always send
 * `tick unfreeze` (the world may have been stopped by hand, as for hold 1).
 *
 * Heavy (box and scene): a go stopped `stuck`, `search_timeout`, or `limit_time` with fewer than LOW_STEPS steps; an act that failed after 60 s or
 * more; health at NEAR_DEATH or under, or a death, during the act; the first failure of a kind (hand and code) in the task. A hold stops for all
 * of them but the first of a kind (`holdsFor`, the coordinator's choice of 2026-10-28). The operator's cancel of a held task ends the hold and
 * moves the world again (`cancel`); the body never moves itself back to where the act began.
 */
export const LOW_STEPS = 10;
export const LONG_MS = 60_000;
export const NEAR_DEATH = 4;
/** A fall of health this big within SHARP_MS writes the box (and at NEAR_DEATH or a death, the scene). */
const SHARP_HP = 6, SHARP_MS = 5_000;

export interface Incident { id: string; kind: 'act' | 'health' | 'death'; heavy: boolean; why: string; box: string | null; scene: string | null; held: boolean; frozen: boolean | null; freeze?: string;
  /** A hold that was asked for and not made: the world could not be stopped (the freeze's words). */
  notHeld?: string;
  /** The feet when the act began, and when it ended (the hold's place): a resume reads how far the body is from where the act began. */
  start?: [number, number, number] | null; end?: [number, number, number] | null }
export interface Hold { id: string; task: string; at: string; frozen: boolean; freeze: string; command: string; why: string; start?: [number, number, number] | null }
interface Context { taskId?: string; incident?: { hold?: boolean; resume?: string; cancel?: string } }

/**
 * The heavy failures a hold stops for (2026-10-28, the coordinator's choice): a go stuck, out of search time or at its time with few steps, 60 s or
 * more lost in any hand, near death in the act, a death. The first failure of a kind writes its box and scene but does not hold.
 */
export function holdsFor(reason: string | null): boolean {
  return !!reason && /^(?:go_stuck|go_search_timeout|go_limit_time_low|long:|near_death|death)/u.test(reason);
}

/** The heavy-failure reason of an act's report, or null (light: the box only). */
export function heavyReason(report: Pick<ActReport, 'ok' | 'lines' | 'stoppedBy'>, ms: number, lowestHp: number | null, died: boolean, seen: Set<string>, task: string): string | null {
  if (report.ok) return null;
  if (died) return 'death';
  if (lowestHp !== null && lowestHp <= NEAR_DEATH) return `near_death:${lowestHp}`;
  for (const line of report.lines) {
    if (line.do !== 'go' || line.status === 'done') continue;
    const code = /go 止まった (\w+)/u.exec(line.line)?.[1];
    if (code === 'stuck' || code === 'search_timeout') return `go_${code}`;
    const steps = Number(/道 (\d+) 歩/u.exec(line.line)?.[1] ?? NaN);
    if (code === 'limit_time' && Number.isFinite(steps) && steps < LOW_STEPS) return `go_limit_time_low:${steps}`;
  }
  if (ms >= LONG_MS) return `long:${Math.round(ms / 1000)}s`;
  const failed = report.lines.find(line => line.status !== 'done' && line.status !== 'skipped');
  if (failed) {
    const code = /止まった (\w+)/u.exec(failed.line)?.[1] ?? report.stoppedBy ?? 'failed';
    const key = `${task}|${failed.do}|${code}`;
    if (!seen.has(key)) { seen.add(key); return `first:${failed.do}/${code}`; }
  }
  return null;
}

export class Incidents {
  hold: Hold | null = null;
  private readonly seen = new Set<string>();
  private lowestHp: number | null = null;
  private died = false;
  private readonly falls: Array<[number, number]> = [];
  private lastHealthDump = 0;
  private startFeet: [number, number, number] | null = null;

  constructor(private readonly bot: any, private readonly options: { holdFile: string; scene?: SceneSaver | null; now?: () => number }) {
    try { this.hold = JSON.parse(fs.readFileSync(options.holdFile, 'utf8')) as Hold; } catch { this.hold = null; }
    if (this.hold) log.warn(`⏸ 保留のまま起動した ${this.hold.id}（タスク ${this.hold.task}、世界 ${this.hold.frozen ? '停止中' : '動いている'}）`);
    let last = typeof bot.health === 'number' ? bot.health : 20;
    bot.on?.('health', () => {
      const hp = typeof bot.health === 'number' ? bot.health : last;
      if (this.lowestHp !== null) this.lowestHp = Math.min(this.lowestHp, hp);
      const now = this.now();
      if (hp < last) this.falls.push([now, last - hp]);
      while (this.falls.length && now - this.falls[0]![0] > SHARP_MS) this.falls.shift();
      const fell = this.falls.reduce((sum, [, n]) => sum + n, 0);
      last = hp;
      if ((fell >= SHARP_HP || hp <= NEAR_DEATH) && hp > 0 && now - this.lastHealthDump > 15_000) {
        this.lastHealthDump = now;
        void this.write('health', hp <= NEAR_DEATH, `health ${hp.toFixed(1)} (fell ${fell.toFixed(1)} in ${SHARP_MS / 1000}s)`);
      }
    });
    bot.on?.('death', () => { this.died = true; void this.write('death', true, 'death'); });
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private box(): BlackBox | null { return blackBoxOf(this.bot); }

  /** Before an act: null to run it, or the words of why it is refused (the task is held). A resume names the hold and unfreezes the world. */
  async beforeAct(context: Context | undefined): Promise<string | null> {
    this.lowestHp = typeof this.bot.health === 'number' ? this.bot.health : null;
    this.died = false;
    const feet = this.bot.entity?.position;
    this.startFeet = feet ? [Math.round(feet.x * 100) / 100, Math.round(feet.y * 100) / 100, Math.round(feet.z * 100) / 100] : null;
    const box = this.box();
    if (box && context?.taskId) box.task = context.taskId;
    box?.ensureWrapped();
    const hold = this.hold;
    if (!hold) return null;
    if (context?.incident?.resume === hold.id) {
      const said = await this.unfreeze();
      log.warn(`▶ 保留を解いた ${hold.id}: ${said}`);
      box?.note('resume', { hold: hold.id, unfreeze: said });
      this.clearHold();
      return null;
    }
    if (context?.taskId && context.taskId !== hold.task) {
      // Another task's act: the hold was left by a task that is gone (cancelled while held). The world moves again.
      const said = await this.unfreeze();
      log.warn(`▶ 別のタスクの act が来たので、前のタスクの保留 ${hold.id} を解いた: ${said}`);
      this.clearHold();
      return null;
    }
    return `保留中（${hold.id}: ${hold.why}）。再開の命令（resume）が来るまで動かない`;
  }

  /** After an act: the box (when it did not succeed), the scene (when heavy), and the hold (when the task asked for it). The incident, or null. */
  async afterAct(command: { id: string; context?: Context; arguments?: unknown }, report: ActReport, ms: number): Promise<Incident | null> {
    if (report.ok) return null;
    const task = command.context?.taskId ?? 'no-task';
    const reason = heavyReason(report, ms, this.lowestHp, this.died, this.seen, task);
    const heavy = reason !== null;
    const why = reason ?? `${report.stoppedBy ?? 'failed'}:${(report.lines.find(line => line.status !== 'done')?.line ?? '').slice(0, 80)}`;
    const act = { command: command.id, arguments: command.arguments, ms, ok: report.ok, stoppedBy: report.stoppedBy ?? null, lines: report.lines.map(line => ({ do: line.do, status: line.status, line: line.line })) };
    // A hold stops the world first, so that the scene saved next is the moment of the failure (nothing falls or flows in between).
    const holding = holdsFor(reason) && command.context?.incident?.hold === true;
    const freeze = holding ? (this.options.scene ? await this.options.scene.freeze() : { frozen: false, why: 'no_scene_port' }) : null;
    const incident = await this.write('act', heavy, why, act);
    if (!incident || !holding || !freeze) return incident;
    if (!freeze.frozen) {
      // Not held: the world goes on, and so does the task (the head reads `notHeld` and writes it down).
      log.warn(`⏵ 保留しなかった ${incident.id}（${why}）: 世界を止められない（${freeze.why}）。黒箱と現場は取った`);
      this.box()?.note('hold_skipped', { id: incident.id, freeze: freeze.why });
      return { ...incident, held: false, frozen: false, freeze: freeze.why, notHeld: freeze.why };
    }
    this.hold = { id: incident.id, task, at: new Date(this.now()).toISOString(), frozen: freeze.frozen, freeze: freeze.why, command: command.id, why, start: this.startFeet };
    try { await fs.promises.mkdir(path.dirname(this.options.holdFile), { recursive: true }); await fs.promises.writeFile(this.options.holdFile, JSON.stringify(this.hold)); } catch { /* held in memory */ }
    log.warn(`⏸ 保留した ${incident.id}（${why}）。世界を止めた`);
    this.box()?.note('hold', { id: incident.id, frozen: freeze.frozen, freeze: freeze.why });
    return { ...incident, held: true, frozen: freeze.frozen, freeze: freeze.why };
  }

  /**
   * A held task cancelled by the operator (the head sends a release with `context.incident.cancel`): the world moves again and the hold ends. True
   * when it was this hold.
   */
  async cancel(id: string): Promise<boolean> {
    const hold = this.hold;
    if (!hold || hold.id !== id) return false;
    const said = await this.unfreeze();
    log.warn(`⏹ 保留していたタスクが止められたので、保留 ${hold.id} を解いた: ${said}`);
    this.box()?.note('hold_cancelled', { hold: hold.id, unfreeze: said });
    this.clearHold();
    return true;
  }

  /**
   * `tick unfreeze` whatever the hold says of the world: a hold written as not frozen may stand in a world stopped by hand (run 44, hold 1: the
   * coordinator froze it over RCON after the body died), and an unfreeze of a running world does nothing.
   */
  private async unfreeze(): Promise<string> {
    return this.options.scene ? await this.options.scene.unfreeze() : 'no_scene_port';
  }

  private clearHold(): void {
    this.hold = null;
    try { fs.rmSync(this.options.holdFile, { force: true }); } catch { /* gone */ }
  }

  /** The box, and for a heavy one the scene under the same id. */
  private async write(kind: Incident['kind'], heavy: boolean, why: string, act?: unknown): Promise<Incident | null> {
    const box = this.box();
    const id = `${new Date(this.now()).toISOString().replace(/[-:.]/gu, '').slice(0, 15)}-${kind}-${Math.random().toString(36).slice(2, 7)}`;
    let scene: SceneResult | null = null;
    const p = this.bot.entity?.position;
    if (heavy && this.options.scene && p) {
      try { scene = await this.options.scene.save(id, [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)], String(this.bot.game?.dimension ?? 'overworld'), { box: id, why, task: box?.task ?? null }); }
      catch (error) { log.warn(`現場を保存できなかった ${id}: ${String((error as Error)?.message ?? error).slice(0, 100)}`); }
    }
    const written = box ? await box.dump(kind, why, { id, ...(act !== undefined ? { act } : {}), scene: scene?.ok ? scene.id : null }) : null;
    const end: [number, number, number] | null = p ? [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100, Math.round(p.z * 100) / 100] : null;
    return { id, kind, heavy, why, box: written?.file ?? null, scene: scene?.ok ? scene.dir : null, held: false, frozen: null, start: kind === 'act' ? this.startFeet : null, end };
  }
}

const incidents = new WeakMap<object, Incidents>();
export function incidentsOf(bot: object): Incidents | null { return incidents.get(bot) ?? null; }
export function installIncidents(bot: any, options: ConstructorParameters<typeof Incidents>[1]): Incidents {
  const existing = incidents.get(bot);
  if (existing) return existing;
  const made = new Incidents(bot, options);
  incidents.set(bot, made);
  return made;
}

/**
 * The production options: the hold file beside the body's other saves, and the scene through the lifecycle's RCON (MINEBOT_LIFECYCLE_RCON_PORT and
 * its password file) on the dedicated server's directory (MINEBOT_SCENE_SERVER_DIR, else SERVER_BASE_PATH/shannon-home, else ~/minecraft/shannon-home). Without RCON there is no
 * scene and no freeze: the box is still written, and a hold asked for is not made (the world cannot be stopped; the receipt says so).
 * The body's own names are read at each freeze (`selfNames`): this is called before the login, when the body has no name yet.
 */
export function incidentOptions(bot: any): ConstructorParameters<typeof Incidents>[1] {
  const holdFile = path.resolve(process.env.MINEBOT_INCIDENT_HOLD_FILE ?? 'saves/minecraft/incident-hold.json');
  const port = Number(process.env.MINEBOT_LIFECYCLE_RCON_PORT), passwordFile = process.env.MINEBOT_LIFECYCLE_RCON_PASSWORD_FILE;
  // The production body has no SERVER_BASE_PATH (2026-10-28): the dedicated server's own place under the service user's home is used when it is there.
  const home = path.join(os.homedir(), 'minecraft', 'shannon-home');
  const serverDir = process.env.MINEBOT_SCENE_SERVER_DIR ?? serverDirectory('shannon-home') ?? (fs.existsSync(path.join(home, 'server.properties')) ? home : null);
  let password = '';
  try { password = passwordFile ? fs.readFileSync(passwordFile, 'utf8').trim() : ''; } catch { password = ''; }
  if (!Number.isInteger(port) || !password || !serverDir) return { holdFile, scene: null };
  const scene = new SceneSaver({ command: (text, timeoutMs) => rconCommand({ port, password }, text, undefined, timeoutMs), serverDir,
    root: path.resolve(process.env.MINEBOT_SCENE_DIR ?? 'saves/minecraft/scenes'), self: () => selfNames(bot) });
  return { holdFile, scene };
}
