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
/** How long after the last act a death outside an act still holds that act's task (the task that asked to be held). */
const ASKED_FOR_MS = 10 * 60_000;
/** A fall of health this big within SHARP_MS writes the box (and at NEAR_DEATH or a death, the scene). */
const SHARP_HP = 6, SHARP_MS = 5_000;

export interface Incident { id: string; kind: 'act' | 'health' | 'death' | 'head'; heavy: boolean; why: string; box: string | null; scene: string | null; held: boolean; frozen: boolean | null; freeze?: string;
  /** A hold that was asked for and not made: the world could not be stopped (the freeze's words). */
  notHeld?: string;
  /**
   * Run 45 (holds 3 to 5): the act a resume sent again failed for the reason it was held for: no hold again (the world goes on, the head decides
   * with the result). The id of the hold it was sent again for.
   */
  repeated?: string;
  /** The feet when the act began, and when it ended (the hold's place): a resume reads how far the body is from where the act began. */
  start?: [number, number, number] | null; end?: [number, number, number] | null }
export interface Hold { id: string; task: string; at: string; frozen: boolean; freeze: string; command: string; why: string; start?: [number, number, number] | null }
/**
 * What a release naming a hold did (run 44, resume 1: the head's resume and cancel come as a release before anything else is sent): `done` when the
 * body holds nothing of it any more (this hold ended now, or there was none), `hold` the id of a hold it still keeps (another one), `unfreeze` the
 * server's words for `tick unfreeze` (sent unless another hold is kept).
 */
export interface HoldRelease { done: boolean; hold: string | null; unfreeze: string | null }
/** Amendment A-12 (body): a hold the head asks for (`context.incident.take`): its own id, the reason in the operator's words, and the last rows of its decision record (at most TAKE_NOTES). */
export interface IncidentTakeInput { id: string; why: string; notes?: string[] }
export const TAKE_NOTES = 20;
/** What a take did: `done` when the body keeps the hold (or the incident is written without a hold: `held` false and `notHeld` says why), false when another hold is kept (`hold`). */
export interface IncidentTake { done: boolean; hold: string | null; incident: Incident | null; again?: boolean }
interface Context { taskId?: string; incident?: { hold?: boolean; resume?: string; cancel?: string; take?: IncidentTakeInput } }
/** The file-safe form of an id (the box's file name and the scene's directory): the hold itself keeps the id the head gave. */
const fileSafe = (id: string): string => id.replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 100);
/** The take as the head sent it, checked: an id (1 to 150 characters) and a reason; the notes are the last TAKE_NOTES lines, each cut at 400 characters. Null when it is not one. */
export function readTake(value: unknown): IncidentTakeInput | null {
  const take = value as Partial<IncidentTakeInput> | null | undefined;
  if (!take || typeof take.id !== 'string' || take.id.length < 1 || take.id.length > 150 || typeof take.why !== 'string') return null;
  const notes = Array.isArray(take.notes) ? take.notes.filter((line): line is string => typeof line === 'string').slice(-TAKE_NOTES).map(line => line.slice(0, 400)) : [];
  return { id: take.id, why: take.why.slice(0, 400), ...(notes.length ? { notes } : {}) };
}

/**
 * The heavy failures a hold stops for (2026-10-28, the coordinator's choice): a go stuck, out of search time or at its time with few steps, 60 s or
 * more lost in any hand, near death in the act, a death. The first failure of a kind writes its box and scene but does not hold.
 */
export function holdsFor(reason: string | null): boolean {
  return !!reason && /^(?:go_stuck|go_search_timeout|go_limit_time_low|long:|explained:|near_death|death)/u.test(reason);
}

/** The kind of a heavy-failure reason (`go_limit_time_low:3` and `go_limit_time_low:7` are one kind). */
export function reasonKind(reason: string): string {
  return reason.split(':')[0]!;
}

/**
 * Run 47 (after hold 9): a stop whose cause the body names itself and whose way out is a word to the planner (the exposure guard's threat_exposed; a go held in flowing water; a place that is
 * dug but beside water or under gravel, or a block canDig lacks; a cannot_dig that says what to add) is given back to the LLM the first time at a place, not held; the second time at the same
 * place it is held (`explained:`).
 */
export function explainedStop(line: { do: string; line: string }): { code: string; where: string } | null {
  const code = /止まった (\w+)/u.exec(line.line)?.[1];
  if (!code) return null;
  const text = line.line;
  const explained = code === 'threat_exposed'
    || (line.do === 'vertical' && code === 'falling_above')
    || (line.do === 'go' && code === 'stuck' && /流れる水の中|置いたブロックが世界に現れない/u.test(text))
    || (line.do === 'go' && code === 'dead_end' && /掘ると流れ込む|掘ると落ちてくる|canDig に無い|canDig に \S+ を許せば|道は流れる水を天井/u.test(text))
    || (code === 'cannot_dig' && /canDig に \S+ を足/u.test(text));
  if (!explained) return null;
  const cell = /\((-?\d+),(-?\d+),(-?\d+)\)/u.exec(text);
  return { code, where: cell ? `${cell[1]},${cell[2]},${cell[3]}` : '' };
}
/**
 * A line of a hand that failed with the work moving (steps, digs, levels, blocks laid, obsidian made counted in its own words): the length of the act is the work's, not a stall
 * (run 47 hold 4, run 48 hold 3: an obsidian hand that made and took one in 61 s, held as `long`).
 */
const progressed = (line: Pick<ActReport['lines'][number], 'line' | 'progress'>): boolean => {
  const progress = line.progress, work = progress?.work;
  if ((progress?.unit !== 'second' && (progress?.done ?? 0) > 0) || (work?.dug ?? 0) > 0 || (work?.placedConfirmed ?? 0) > 0) return true;
  return [/(?:道|段) (\d+)/u, /掘 (\d+)/u, /置 (\d+)/u, /黒曜石 (\d+) 個/u, /個のうち (\d+) 個/u, /(\d+) 個(?:を)?(?:掘|採|拾|作)/u]
    .some(pattern => Number(pattern.exec(line.line)?.[1] ?? 0) > 0);
};

/** The heavy-failure reason of an act's report, or null (light: the box only). */
export function heavyReason(report: Pick<ActReport, 'ok' | 'lines' | 'stoppedBy'>, ms: number, lowestHp: number | null, died: boolean, seen: Set<string>, task: string): string | null {
  if (report.ok) return null;
  if (died) return 'death';
  if (lowestHp !== null && lowestHp <= NEAR_DEATH) return `near_death:${lowestHp}`;
  // The stops the body explains: the first at a place goes back to the LLM, the second at the same place is held.
  for (const line of report.lines) {
    if (line.status === 'done' || line.status === 'skipped') continue;
    const said = explainedStop(line);
    if (!said) continue;
    const key = `${task}|explained|${line.do}|${said.code}|${said.where}`;
    if (!seen.has(key)) { seen.add(key); return null; }
    return `explained:${line.do}/${said.code}`;
  }
  for (const line of report.lines) {
    if (line.do !== 'go' || line.status === 'done') continue;
    if (explainedStop(line)) continue;
    const code = /go 止まった (\w+)/u.exec(line.line)?.[1];
    if (code === 'stuck' || code === 'search_timeout') return `go_${code}`;
    const steps = Number(/道 (\d+) 歩/u.exec(line.line)?.[1] ?? NaN);
    if (code === 'limit_time' && Number.isFinite(steps) && steps < LOW_STEPS) return `go_limit_time_low:${steps}`;
  }
  // Runs 47-48: a hand that failed after a long time with the work moving (steps, digs, levels, blocks, obsidian) is the clock's: the planner carries it on from the result.
  if (ms >= LONG_MS && !report.lines.some(line => line.status !== 'done' && line.status !== 'skipped' && progressed(line))) return `long:${Math.round(ms / 1000)}s`;
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
  /** The scene port (RCON), for the server's tick (continue contracts, 8); null without one. */
  sceneSaver(): SceneSaver | null { return this.options.scene ?? null; }
  private readonly seen = new Set<string>();
  private lowestHp: number | null = null;
  private died = false;
  private readonly falls: Array<[number, number]> = [];
  private lastHealthDump = 0;
  private startFeet: [number, number, number] | null = null;
  /** Run 45: an act runs (between its beforeAct and its end): a death or near death in it is the act's (afterAct holds for it). */
  private inAct = false;
  /** Run 45: the task of the last act, whether it asked to be held, and when (a death outside an act holds for it within ASKED_FOR_MS). */
  private asked: { task: string; hold: boolean; at: number } | null = null;
  /** Run 45: the hold a resume ended last (its id and reason), until the act sent again for it ends (`context.incident.resume` names it). */
  private resumed: { id: string; why: string } | null = null;

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
        const outside = !this.inAct && hp <= NEAR_DEATH;
        void this.write('health', hp <= NEAR_DEATH, `health ${hp.toFixed(1)} (fell ${fell.toFixed(1)} in ${SHARP_MS / 1000}s)`)
          .then(incident => (outside ? this.holdOutside(incident, `near_death:${hp.toFixed(1)}`) : undefined)).catch(() => undefined);
      }
    });
    bot.on?.('death', () => {
      this.died = true;
      const outside = !this.inAct;
      void this.write('death', true, 'death').then(incident => (outside ? this.holdOutside(incident, 'death') : undefined)).catch(() => undefined);
    });
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private box(): BlackBox | null { return blackBoxOf(this.bot); }

  /** Before an act: null to run it, or the words of why it is refused (the task is held). A resume names the hold and unfreezes the world. */
  async beforeAct(context: Context | undefined): Promise<string | null> {
    this.lowestHp = typeof this.bot.health === 'number' ? this.bot.health : null;
    this.died = false;
    if (context?.taskId) this.asked = { task: context.taskId, hold: context.incident?.hold === true, at: this.now() };
    const feet = this.bot.entity?.position;
    this.startFeet = feet ? [Math.round(feet.x * 100) / 100, Math.round(feet.y * 100) / 100, Math.round(feet.z * 100) / 100] : null;
    const box = this.box();
    if (box && context?.taskId) box.task = context.taskId;
    box?.ensureWrapped();
    const hold = this.hold;
    if (!hold) { this.inAct = true; return null; }
    if (context?.incident?.resume === hold.id) {
      this.resumed = { id: hold.id, why: hold.why };
      const said = await this.unfreeze();
      log.warn(`▶ 保留を解いた ${hold.id}: ${said}`);
      box?.note('resume', { hold: hold.id, unfreeze: said });
      this.clearHold();
      this.inAct = true;
      return null;
    }
    if (context?.taskId && context.taskId !== hold.task) {
      // Another task's act: the hold was left by a task that is gone (cancelled while held). The world moves again.
      const said = await this.unfreeze();
      log.warn(`▶ 別のタスクの act が来たので、前のタスクの保留 ${hold.id} を解いた: ${said}`);
      this.clearHold();
      this.inAct = true;
      return null;
    }
    return `保留中（${hold.id}: ${hold.why}）。再開の命令（resume）が来るまで動かない`;
  }

  /** After an act: the box (when it did not succeed), the scene (when heavy), and the hold (when the task asked for it). The incident, or null. */
  async afterAct(command: { id: string; context?: Context; arguments?: unknown }, report: ActReport, ms: number): Promise<Incident | null> {
    this.inAct = false;
    // Run 45: the act a resume sent again (it names the hold the resume ended).
    const resumedFor = command.context?.incident?.resume;
    const again = resumedFor && this.resumed?.id === resumedFor ? this.resumed : null;
    if (resumedFor) this.resumed = null;
    if (report.ok) return null;
    const task = command.context?.taskId ?? 'no-task';
    const reason = heavyReason(report, ms, this.lowestHp, this.died, this.seen, task);
    const heavy = reason !== null;
    const why = reason ?? `${report.stoppedBy ?? 'failed'}:${(report.lines.find(line => line.status !== 'done')?.line ?? '').slice(0, 80)}`;
    const act = { command: command.id, arguments: command.arguments, ms, ok: report.ok, stoppedBy: report.stoppedBy ?? null, lines: report.lines.map(line => ({ do: line.do, status: line.status, line: line.line })) };
    // A hold stops the world first, so that the scene saved next is the moment of the failure (nothing falls or flows in between).
    // Run 45 (holds 3 to 5): sent again by a resume and failed for the same reason (its kind: go_stuck, go_limit_time_low, long, ...): the operator's
    // fix did not help, and a hold again only waits for the same resume. No hold: the head decides with the result.
    const repeated = again !== null && reason !== null && holdsFor(reason) && reasonKind(reason) === reasonKind(again.why);
    const holding = holdsFor(reason) && command.context?.incident?.hold === true && !repeated;
    const freeze = holding ? (this.options.scene ? await this.options.scene.freeze() : { frozen: false, why: 'no_scene_port' }) : null;
    const incident = await this.write('act', heavy, why, act);
    if (incident && repeated && command.context?.incident?.hold === true) {
      log.warn(`⏵ 保留しなかった ${incident.id}（${why}）: 保留 ${again!.id} から出し直した act が同じ理由で失敗。判断に任せる`);
      this.box()?.note('hold_not_again', { id: incident.id, hold: again!.id, why });
      return { ...incident, repeated: again!.id };
    }
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
   * Amendment A-12 (body): the head found a stall itself (`context.incident.take` = { id, why, notes? } on a release or an act) and asks the body to hold the task as it holds for
   * a heavy failure: the world is stopped first (`/tick freeze`, never with anyone else on the server), then the scene is saved and the box written (with the head's reason and
   * the rows of its decision record), then the hold is kept (and written to the hold file) under the head's own id, which the head's resume and cancel name. A world that cannot be
   * stopped is not held (the box and the scene are taken, `notHeld` says why). The same take again is the same hold; a take while another hold is kept changes nothing.
   */
  async take(context: Context | undefined): Promise<IncidentTake | null> {
    const take = readTake(context?.incident?.take);
    if (!take) return null;
    const hold = this.hold;
    if (hold) {
      if (hold.id === take.id) {
        // Run 47: the head asks again for the hold the body kept across a restart (the server's freeze did not outlast it): the world is stopped again.
        const again = this.options.scene ? await this.options.scene.freeze() : null;
        if (again?.frozen && (!hold.frozen || hold.freeze !== again.why)) {
          this.hold = { ...hold, frozen: true, freeze: again.why };
          try { await fs.promises.writeFile(this.options.holdFile, JSON.stringify(this.hold)); } catch { /* held in memory */ }
          log.warn(`⏸ 保留 ${hold.id} の頼みが来たので、世界を止め直した`);
          this.box()?.note('hold_refrozen', { id: hold.id, freeze: again.why });
        }
        return { done: true, hold: hold.id, incident: null, again: true };
      }
      log.warn(`保留の頼み ${take.id} が来たが、体は保留 ${hold.id} を持っている: そのまま`);
      return { done: false, hold: hold.id, incident: null };
    }
    const task = context?.taskId ?? 'no-task';
    const feet = this.bot.entity?.position;
    const start: [number, number, number] | null = feet ? [Math.round(feet.x * 100) / 100, Math.round(feet.y * 100) / 100, Math.round(feet.z * 100) / 100] : null;
    const box = this.box();
    if (box && context?.taskId) box.task = context.taskId;
    // The world is stopped first, so that the scene saved next is the moment of the stall.
    const freeze = this.options.scene ? await this.options.scene.freeze() : { frozen: false, why: 'no_scene_port' };
    const written = await this.write('head', true, take.why, undefined, { id: fileSafe(take.id), head: { id: take.id, why: take.why, ...(take.notes ? { notes: take.notes } : {}) } });
    if (!written) return { done: true, hold: null, incident: null };
    const incident: Incident = { ...written, id: take.id };
    if (!freeze.frozen) {
      log.warn(`⏵ 頭の頼みを保留しなかった ${take.id}（${take.why}）: 世界を止められない（${freeze.why}）。黒箱と現場は取った`);
      box?.note('hold_skipped', { id: take.id, freeze: freeze.why, head: true });
      return { done: true, hold: null, incident: { ...incident, held: false, frozen: false, freeze: freeze.why, notHeld: freeze.why } };
    }
    this.hold = { id: take.id, task, at: new Date(this.now()).toISOString(), frozen: true, freeze: freeze.why, command: '', why: take.why, start };
    try { await fs.promises.mkdir(path.dirname(this.options.holdFile), { recursive: true }); await fs.promises.writeFile(this.options.holdFile, JSON.stringify(this.hold)); } catch { /* held in memory */ }
    log.warn(`⏸ 頭の頼みで保留した ${take.id}（${take.why}）。世界を止めた`);
    box?.note('hold', { id: take.id, frozen: true, freeze: freeze.why, head: true });
    return { done: true, hold: take.id, incident: { ...incident, held: true, frozen: true, freeze: freeze.why } };
  }

  /**
   * A held task cancelled by the operator (the head sends a release with `context.incident.cancel`): the world moves again and the hold ends.
   * `done` when it was this hold, or when there was none (the world is moved anyway: it may have been stopped by hand).
   */
  async cancel(id: string): Promise<HoldRelease> { return this.release(id, 'cancel'); }
  /**
   * Run 44, resume 1: the head's resume comes as a release naming the hold before the held act is sent again (the act once carried the resume, and
   * a body restarted in between kept refusing every act when that act never reached it). The hold ends and the world moves.
   */
  async resume(id: string): Promise<HoldRelease> { return this.release(id, 'resume'); }
  /** An act ended however it ended (its afterAct may not come: a throw, a refusal before its hands). */
  endAct(): void { this.inAct = false; }
  /**
   * Run 45 (+929: she died between two acts, the reflexes alone at a zombie, and nothing was held): a death, or health at NEAR_DEATH or under,
   * outside an act holds the task of the last act when it asked to be held (within ASKED_FOR_MS) and the world can be stopped; when it cannot,
   * nothing is held (as in an act). The head learns of it from the frame (`incidentHold`) or the next act's refusal, and holds the task too.
   */
  private async holdOutside(incident: Incident | null, why: string): Promise<void> {
    const asked = this.asked;
    if (!incident || this.hold || !asked?.hold || this.now() - asked.at > ASKED_FOR_MS) return;
    const freeze = this.options.scene ? await this.options.scene.freeze() : { frozen: false, why: 'no_scene_port' };
    if (!freeze.frozen) {
      log.warn(`⏵ act の外の ${why} を保留しなかった ${incident.id}: 世界を止められない（${freeze.why}）`);
      this.box()?.note('hold_skipped', { id: incident.id, freeze: freeze.why, outside: true });
      return;
    }
    this.hold = { id: incident.id, task: asked.task, at: new Date(this.now()).toISOString(), frozen: true, freeze: freeze.why, command: '', why, start: null };
    try { await fs.promises.mkdir(path.dirname(this.options.holdFile), { recursive: true }); await fs.promises.writeFile(this.options.holdFile, JSON.stringify(this.hold)); } catch { /* held in memory */ }
    log.warn(`⏸ act の外の ${why} で保留した ${incident.id}（タスク ${asked.task}）。世界を止めた`);
    this.box()?.note('hold', { id: incident.id, frozen: true, freeze: freeze.why, outside: true });
  }
  /** The hold as the observation says it (the head compares it with its own), or null. */
  held(): { id: string; task: string; why: string } | null {
    return this.hold ? { id: this.hold.id, task: this.hold.task, why: this.hold.why } : null;
  }
  private async release(id: string, how: 'cancel' | 'resume'): Promise<HoldRelease> {
    const hold = this.hold;
    if (hold && hold.id !== id) {
      log.warn(`保留 ${id} を解く命令（${how}）が来たが、体の保留は ${hold.id}: そのまま`);
      return { done: false, hold: hold.id, unfreeze: null };
    }
    const said = await this.unfreeze();
    if (hold) {
      log.warn(`${how === 'cancel' ? '⏹ 保留していたタスクが止められたので' : '▶ 再開の命令で'}、保留 ${hold.id} を解いた: ${said}`);
      this.box()?.note(how === 'cancel' ? 'hold_cancelled' : 'resume', { hold: hold.id, unfreeze: said });
      this.resumed = how === 'resume' ? { id: hold.id, why: hold.why } : null;
      this.clearHold();
    } else log.warn(`保留 ${id} を解く命令（${how}）が来たが、体は保留していない: 世界だけ動かした（${said}）`);
    return { done: true, hold: null, unfreeze: said };
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
  private async write(kind: Incident['kind'], heavy: boolean, why: string, act?: unknown, given?: { id: string; head?: unknown }): Promise<Incident | null> {
    const box = this.box();
    const id = given?.id ?? `${new Date(this.now()).toISOString().replace(/[-:.]/gu, '').slice(0, 15)}-${kind}-${Math.random().toString(36).slice(2, 7)}`;
    let scene: SceneResult | null = null;
    const p = this.bot.entity?.position;
    if (heavy && this.options.scene && p) {
      try { scene = await this.options.scene.save(id, [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)], String(this.bot.game?.dimension ?? 'overworld'), { box: id, why, task: box?.task ?? null }); }
      catch (error) { log.warn(`現場を保存できなかった ${id}: ${String((error as Error)?.message ?? error).slice(0, 100)}`); }
    }
    const written = box ? await box.dump(kind, why, { id, ...(act !== undefined ? { act } : {}), ...(given?.head !== undefined ? { head: given.head } : {}), scene: scene?.ok ? scene.id : null }) : null;
    const end: [number, number, number] | null = p ? [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100, Math.round(p.z * 100) / 100] : null;
    return { id, kind, heavy, why, box: written?.file ?? null, scene: scene?.ok ? scene.dir : null, held: false, frozen: null, start: kind === 'act' ? this.startFeet : null, end };
  }
}

/** An act's result JSON with the incident the receipt carries (`incident`: what the head reads to hold the task); the text as it was without one. */
export function withIncidentText(text: string, incident: Incident | null): string {
  if (!incident) return text;
  try {
    return JSON.stringify({ ...JSON.parse(text), incident: { id: incident.id, heavy: incident.heavy, why: incident.why, held: incident.held,
      frozen: incident.frozen, ...(incident.freeze ? { freeze: incident.freeze } : {}), ...(incident.notHeld ? { notHeld: incident.notHeld } : {}),
      ...(incident.repeated ? { repeated: incident.repeated } : {}),
      box: incident.box !== null, scene: incident.scene !== null,
      ...(incident.start ? { start: incident.start } : {}), ...(incident.end ? { end: incident.end } : {}) } });
  } catch { return text; }
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
