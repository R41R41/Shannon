import { randomUUID } from 'node:crypto';
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
export interface CommonFcaControlOptions {
  baseUrl: string; token: string; serverId: string; actuator: CommonFcaActuator;
  fetcher?: typeof fetch; now?: () => number; connectionId?: string; pollMilliseconds?: number;
}
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
  private catalogSent = false;
  private readonly lifetime = new AbortController();
  constructor(private readonly options: CommonFcaControlOptions) {
    this.baseUrl = companionBaseUrl(options.baseUrl);
    this.connectionId = options.connectionId ?? randomUUID();
    this.observation = options.actuator.observe();
  }
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
      const response = await (this.options.fetcher ?? fetch)(`${this.baseUrl}${MINECRAFT_CONTROL_PATH}`, {
        method: 'POST', headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' },
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(2000)]),
        body: JSON.stringify({ schemaVersion: 1, serverId: this.options.serverId, connectionId: this.connectionId,
          observation: this.observation, candidates: this.options.actuator.candidates(this.observation),
          ...(!this.catalogSent ? { skills: this.options.actuator.skills } : {}),
          receipts: sent, activeOperationIds: [...this.active.keys()] }),
      });
      if (!response.ok) throw Error('BODY_CONTROL_HTTP');
      const reply = await response.json() as MinecraftControlReply;
      if (this.closed) return;
      if (reply.schemaVersion !== 1 || reply.mode !== 'common-fca' || !Array.isArray(reply.commands)
        || reply.commands.length > 8 || !Array.isArray(reply.cancel) || !Array.isArray(reply.acknowledged)) throw Error('BODY_CONTROL_REPLY');
      this.catalogSent = true;
      for (const id of reply.acknowledged) if (sent.some(receipt => receipt.id === id)) this.receipts.delete(id);
      for (const id of reply.cancel) this.active.get(id)?.controller.abort('server_cancel');
      for (const command of reply.commands) this.accept(command);
    } catch (error) {
      // No action replay after lost contact. Command IDs remain tombstoned for this connection.
      this.catalogSent = false;
      for (const value of this.active.values()) value.controller.abort('control_disconnected');
      throw error;
    } finally { this.polling = false; }
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
      && (cleanup || Date.parse(command.deadlineAt) > now && Date.parse(command.deadlineAt) - now <= 120_000);
    const key = valid ? identity(command) : '';
    const sessionKey = `${key}:${context?.sessionId}`;
    const historicalCleanup = cleanup && this.closedSessions.has(sessionKey);
    if (!valid || (!cleanup && (this.closedSessions.has(sessionKey) || this.held || this.active.size > 0 || this.owner !== null && this.owner !== key
        || command.lease.generation < (this.leaseGenerations.get(command.lease.id) ?? -1)))
      || cleanup && this.owner !== null && this.owner !== key && !this.closedSessions.has(sessionKey)) {
      this.receipts.set(command.id, { id: command.id, connectionId: this.connectionId, outcome: 'failed',
        inputsReleased: false, observedAt: new Date(now).toISOString(), result: 'BODY_COMMAND_REFUSED' });
      return;
    }
    if (!cleanup) { this.owner = key; this.leaseGenerations.set(command.lease.id, command.lease.generation); }
    else if (!this.closedSessions.has(sessionKey)) for (const item of this.active.values()) item.controller.abort('owner_release');
    const controller = new AbortController();
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
    }).finally(() => { clearTimeout(timeout); this.active.delete(command.id); });
    this.active.set(command.id, { controller, running });
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
