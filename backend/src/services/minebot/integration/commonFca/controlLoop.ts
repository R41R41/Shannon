import { randomUUID } from 'node:crypto';
import { createLogger } from '../../../../utils/logger.js';
import { companionBaseUrl } from '../CompanionBodyClient.js';
import type { BodyCandidateDraft, BodyObservation, BodyTaskContext } from './bodyControlContract.js';
import { MINECRAFT_CONTROL_PATH, type MinecraftControlCommand as Command, type MinecraftControlReceipt as Receipt,
  type MinecraftControlReply, type MinecraftSkillDefinition } from './minecraftControlContract.js';

export interface CommonFcaActuator {
  observe(): BodyObservation;
  candidates(observation: BodyObservation): readonly BodyCandidateDraft[];
  skills: readonly MinecraftSkillDefinition[];
  execute(command: Command, signal: AbortSignal): Promise<Receipt>;
  /** Cancels/fences old native work and confirms all physical controllers have actually released. */
  release(signal: AbortSignal): Promise<boolean>;
  dispose?(): Promise<void>;
  closeEvidence?(context: BodyTaskContext): void;
}
/**
 * What the loop tells a watcher (the UI mod's view of the task). Read only: a watcher cannot change what the loop does,
 * and one that throws is ignored.
 */
export interface CommonFcaObserver {
  /** The API's command was accepted and starts now. */
  commandStarted?(command: Command): void;
  /** The command ended (or was refused) with this receipt. */
  commandEnded?(command: Command, receipt: Receipt): void;
}
export interface CommonFcaControlOptions {
  baseUrl: string; token: string; serverId: string; actuator: CommonFcaActuator;
  fetcher?: typeof fetch; now?: () => number; connectionId?: string; pollMilliseconds?: number;
  observer?: CommonFcaObserver;
}
const log = createLogger('Minebot:CommonFcaControl');
/** One poll's wait for the API; a slower reply is a failed poll, not lost contact. */
const POLL_TIMEOUT_MS = 5000;
/** How long the API may stay silent before running commands are stopped (an API restart takes about this long). */
const CONTACT_LOSS_MS = 15_000;
const identity = (c: Command) => JSON.stringify([c.lease.id, c.lease.generation, c.lease.holder, c.context.scopeKey, c.context.taskId]);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
export class CommonFcaControlLoop {
  readonly connectionId: string;
  private readonly baseUrl: string;
  private readonly seen = new Set<string>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly active = new Map<string, { controller: AbortController; running: Promise<void> }>();
  private owner: string | null = null;
  private held = false;
  private closedSessions = new Set<string>();
  private readonly leaseGenerations = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private observationTimer?: ReturnType<typeof setInterval>;
  private observation: BodyObservation;
  private polling = false;
  private closed = false;
  /** The catalog the API last acknowledged; a different one (the task changed kind) is sent again, whole. */
  private catalogSent: readonly MinecraftSkillDefinition[] | null = null;
  private readonly lifetime = new AbortController();
  /** When a poll last got a well-formed reply; running commands survive a short loss of contact (see poll). */
  private contactAt = (this.options.now ?? Date.now)();
  constructor(private readonly options: CommonFcaControlOptions) {
    this.baseUrl = companionBaseUrl(options.baseUrl);
    this.connectionId = options.connectionId ?? randomUUID();
    this.observation = options.actuator.observe();
  }
  /** A command, an owner or a held body is the loop's: idle work (a pickup walk) starts only when this is false. */
  get leaseHeld(): boolean { return this.owner !== null || this.held || this.active.size > 0; }
  get busy(): boolean { return this.held || this.active.size > 0 || (Array.isArray(this.observation.state.activeCapabilities) && this.observation.state.activeCapabilities.length > 0); }
  start(): void {
    if (this.timer || this.observationTimer || this.closed) return;
    // Independent of a provider/skill/HTTP wait: the body keeps observing.
    this.observationTimer = setInterval(() => { this.observation = this.options.actuator.observe(); }, 100);
    this.observationTimer.unref();
    const tick = async () => { try { await this.poll(); } catch { /* pending receipts remain until acknowledged */ }
      finally { if (!this.closed) { this.timer = setTimeout(tick, this.options.pollMilliseconds ?? 200); this.timer.unref(); } } };
    void tick();
  }
  async poll(): Promise<void> {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      this.observation = this.options.actuator.observe();
      const sent = [...this.receipts.values()].slice(0, 16);
      const catalog = this.options.actuator.skills;
      const response = await (this.options.fetcher ?? fetch)(`${this.baseUrl}${MINECRAFT_CONTROL_PATH}`, {
        method: 'POST', headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' },
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]),
        body: JSON.stringify({ schemaVersion: 1, serverId: this.options.serverId, connectionId: this.connectionId,
          observation: this.observation, candidates: this.options.actuator.candidates(this.observation),
          ...(this.catalogSent !== catalog ? { skills: catalog } : {}),
          receipts: sent, activeOperationIds: [...this.active.keys()] }),
      });
      if (!response.ok) throw Error('BODY_CONTROL_HTTP');
      const reply = await response.json() as MinecraftControlReply;
      if (this.closed) return;
      if (reply.schemaVersion !== 1 || reply.mode !== 'common-fca' || !Array.isArray(reply.commands)
        || reply.commands.length > 8 || !Array.isArray(reply.cancel) || !Array.isArray(reply.acknowledged)) throw Error('BODY_CONTROL_REPLY');
      this.catalogSent = catalog;
      this.contactAt = (this.options.now ?? Date.now)();
      for (const id of reply.acknowledged) if (sent.some(receipt => receipt.id === id)) this.receipts.delete(id);
      for (const id of reply.cancel) this.active.get(id)?.controller.abort('server_cancel');
      for (const command of reply.commands) this.accept(command);
    } catch (error) {
      // No action replay after lost contact. Command IDs remain tombstoned for this connection.
      this.catalogSent = null;
      // One slow or failed poll is not lost contact: a two-second stall of the API's event loop used to cut every
      // running move (common run 9, 2026-10-14 20:40). Running commands keep their own deadlines; they are stopped
      // only once the API has not answered for CONTACT_LOSS_MS (an API restart, a dead network).
      const silent = (this.options.now ?? Date.now)() - this.contactAt;
      if (silent >= CONTACT_LOSS_MS && this.active.size) {
        log.warn(`API と ${Math.round(silent / 1000)} 秒話せないので、実行中の命令を止める（${this.active.size}件）`);
        for (const value of this.active.values()) value.controller.abort('control_disconnected');
      }
      throw error;
    } finally { this.polling = false; }
  }
  /**
   * How far ahead a command's deadline may lie: the skill's own time from the catalog plus delivery slack. A flat two
   * minutes refused every longer skill once the API set deadlines from the catalog (common run 8: mine-block at three
   * minutes came back BODY_COMMAND_REFUSED, held, and the step ended unknown).
   */
  private acceptWindow(command: Command): number {
    const own = command.kind === 'skill' ? this.options.actuator.skills.find(skill => skill.name === command.skill)?.maxDurationMs : undefined;
    return Math.min(630_000, (typeof own === 'number' && Number.isFinite(own) && own > 0 ? Math.max(own, 120_000) : 120_000) + 30_000);
  }
  private accept(command: Command): void {
    if (!command || !ID.test(command.id) || this.seen.has(command.id)) return;
    if (this.seen.size >= 10_000) { void this.stop(); return; }
    this.seen.add(command.id);
    const now = (this.options.now ?? Date.now)();
    const context = command.context;
    const cleanup = command.kind === 'stop' || command.kind === 'release';
    const valid = command.schemaVersion === 1 && command.serverId === this.options.serverId
      && command.connectionId === this.connectionId && context?.bodyId === this.observation.bodyId
      && ID.test(context.sessionId) && ID.test(context.taskId) && Number.isSafeInteger(context.generation)
      && context.generation >= 0 && Number.isSafeInteger(context.taskRevision) && context.taskRevision >= 0
      && command.lease && ID.test(command.lease.id) && typeof command.lease.holder === 'string'
      && Number.isSafeInteger(command.lease.generation) && Number.isFinite(Date.parse(command.deadlineAt))
      && (cleanup || Date.parse(command.deadlineAt) > now && Date.parse(command.deadlineAt) - now <= this.acceptWindow(command));
    const key = valid ? identity(command) : '';
    const sessionKey = `${key}:${context?.sessionId}`;
    const historicalCleanup = cleanup && this.closedSessions.has(sessionKey);
    if (!valid || (!cleanup && (this.closedSessions.has(sessionKey) || this.held || this.active.size > 0 || this.owner !== null && this.owner !== key
        || command.lease.generation < (this.leaseGenerations.get(command.lease.id) ?? -1)))
      || cleanup && this.owner !== null && this.owner !== key && !this.closedSessions.has(sessionKey)) {
      // A command refused for its own shape (stale connection, a deadline out of reach) never took the body: say so, so the
      // API can treat it as a known failure. One refused because the body is held or another owner has it says not released.
      const refused: Receipt = { id: command.id, connectionId: this.connectionId, outcome: 'failed',
        inputsReleased: !cleanup && !valid && !this.held && this.active.size === 0, observedAt: new Date(now).toISOString(), result: 'BODY_COMMAND_REFUSED' };
      this.receipts.set(command.id, refused);
      if (valid) this.watch(() => this.options.observer?.commandEnded?.(command, refused));
      return;
    }
    if (!cleanup) { this.owner = key; this.leaseGenerations.set(command.lease.id, command.lease.generation); }
    else if (!this.closedSessions.has(sessionKey)) for (const item of this.active.values()) item.controller.abort('owner_release');
    const controller = new AbortController();
    this.watch(() => this.options.observer?.commandStarted?.(command));
    const timeout = setTimeout(() => controller.abort('deadline'), cleanup ? 3000 : Math.max(1, Date.parse(command.deadlineAt) - now));
    const running = Promise.resolve().then(async () => {
      let receipt: Receipt;
      try {
        receipt = cleanup ? await this.cleanup(command, key, controller.signal) : await this.options.actuator.execute(command, controller.signal);
      } catch {
        receipt = { id: command.id, connectionId: this.connectionId, outcome: 'unknown', inputsReleased: false,
          observedAt: new Date((this.options.now ?? Date.now)()).toISOString(), result: 'BODY_EXECUTION_UNKNOWN' };
        if (command.operation) receipt.action = { schemaVersion: 1, operationId: command.operation.operationId, bodyId: command.context.bodyId,
          sessionId: command.context.sessionId, generation: command.context.generation, outcome: 'unknown', inputsReleased: false,
          observedAt: receipt.observedAt, evidenceId: command.id };
        if (command.stop) receipt.stop = { bodyId: command.context.bodyId, sessionId: command.context.sessionId, generation: command.context.generation,
          requestId: command.stop.requestId, state: 'unknown', inputsReleased: false, observedAt: receipt.observedAt };
      }
      if (!historicalCleanup) {
        // Ordinary receipts only release their own inputs. A concurrent failed cleanup
        // remains unknown until a fresh cleanup confirms the whole body is quiescent.
        if (!receipt.inputsReleased) this.held = true;
        else if (cleanup) this.held = false;
        if (!this.held && receipt.inputsReleased && this.owner === key) this.owner = null;
      }
      this.receipts.set(command.id, receipt);
      this.watch(() => this.options.observer?.commandEnded?.(command, receipt));
    }).finally(() => { clearTimeout(timeout); this.active.delete(command.id); });
    this.active.set(command.id, { controller, running });
  }
  /** A watcher never changes what the loop does: its failure is dropped. */
  private watch(notify: () => void): void { try { notify(); } catch { /* the UI mod is optional */ } }
  /**
   * The operator's stop (the UI mod's stop button): running commands are aborted at once, as the API's own cancel does,
   * and end with an honest `cancelled` receipt. The API still owns the task and learns of it from the receipt and the
   * mind's turn; this only lets the body stand still without waiting for them.
   */
  abortActive(reason = 'operator_stop'): number {
    for (const item of this.active.values()) item.controller.abort(reason);
    return this.active.size;
  }
  private async cleanup(command: Command, key: string, signal: AbortSignal): Promise<Receipt> {
    // An old cleanup cannot stop a later owner. It can acknowledge its own already released lease.
    const sessionKey = `${key}:${command.context.sessionId}`;
    const released = this.closedSessions.has(sessionKey) ? true : await this.options.actuator.release(signal);
    if (released) this.options.actuator.closeEvidence?.(command.context);
    if (released && command.kind === 'release') this.closedSessions.add(sessionKey);
    const observedAt = new Date((this.options.now ?? Date.now)()).toISOString();
    return { id: command.id, connectionId: this.connectionId, outcome: released ? 'completed' : 'unknown', inputsReleased: released, observedAt,
      ...(command.stop ? { stop: { bodyId: command.context.bodyId, sessionId: command.context.sessionId,
        generation: command.context.generation, requestId: command.stop.requestId, state: released ? 'stopped' : 'unknown', inputsReleased: released, observedAt } } : {}) };
  }
  async stop(): Promise<boolean> {
    if (this.closed) return !this.held;
    this.closed = true; this.lifetime.abort('body_disconnected');
    clearTimeout(this.timer); clearInterval(this.observationTimer);
    for (const value of this.active.values()) value.controller.abort('body_disconnected');
    const released = await this.options.actuator.release(AbortSignal.timeout(3000)).catch(() => false);
    this.held = !released;
    await this.options.actuator.dispose?.();
    return released;
  }
}
