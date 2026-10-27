import { randomUUID } from 'node:crypto';
import { createLogger } from '../../../../utils/logger.js';
import { companionBaseUrl } from '../CompanionBodyClient.js';
import type { BodyCandidateDraft, BodyObservation, BodyTaskContext } from './bodyControlContract.js';
import type { BodyEventSource } from './bodyEvents.js';
import { LiveSpeechCourier } from '../../../common/liveSpeech.js';
import type { LiveRoom, LiveSpeechReceipt } from '../../../common/liveSpeech.js';
import { MINECRAFT_CONTROL_PATH, type MinecraftControlCommand as Command, type MinecraftControlReceipt as Receipt,
  type MinecraftControlReply, type MinecraftQueueProgress, type MinecraftSkillDefinition } from './minecraftControlContract.js';
import { BodyQueue, droppedBecause, EXPIRED_TEXT, notStarted, QUEUE_ACCEPT_WINDOW_MS, readEnvelope, type QueueEnvelope } from './bodyQueue.js';
import type { ActCondition } from '../../utils/actConditions.js';

export interface CommonFcaActuator {
  observe(): BodyObservation;
  candidates(observation: BodyObservation): readonly BodyCandidateDraft[];
  skills: readonly MinecraftSkillDefinition[];
  execute(command: Command, signal: AbortSignal): Promise<Receipt>;
  /** Cancels/fences old native work and confirms all physical controllers have actually released. */
  release(signal: AbortSignal): Promise<boolean>;
  dispose?(): Promise<void>;
  closeEvidence?(context: BodyTaskContext): void;
  /** What changed while a command runs (needs, progress, a stall), sent with each poll until the API takes it (mb-arch stage 1). */
  events?: BodyEventSource;
  /** Task queue: whether a condition (an item's `pre`) holds now, and in words what is lacking when it does not. Absent: a `pre` cannot be checked. */
  check?(condition: ActCondition): { ok: boolean; words: string };
  /** Task queue: how far the running act is (its hand, its pass), without the command's id. */
  progress?(): Omit<MinecraftQueueProgress, 'id'> | null;
  /** The fix run (2026-10-28): a release that names a hold (`context.incident.cancel`) ends it and moves the world again. */
  cancelIncident?(id: string): Promise<boolean>;
}
/**
 * What the loop tells a watcher (the UI mod's view of the task). Read only: a watcher cannot change what the loop does,
 * and one that throws is ignored.
 */
export interface CommonFcaObserver {
  /** A queue item was accepted and waits behind the one running. */
  commandQueued?(command: Command): void;
  /** The API's command was accepted and starts now. */
  commandStarted?(command: Command): void;
  /** The command ended (or was refused) with this receipt. */
  commandEnded?(command: Command, receipt: Receipt): void;
}
export interface CommonFcaControlOptions {
  baseUrl: string; token: string; serverId: string; actuator: CommonFcaActuator;
  fetcher?: typeof fetch; now?: () => number; connectionId?: string; pollMilliseconds?: number;
  observer?: CommonFcaObserver;
  /** Her live lines (session dc-live): taken from a reply, told in the next polls. Default: the Discord sink registered at start-up, if any. */
  speech?: LiveSpeechCourier;
}
const log = createLogger('Minebot:CommonFcaControl');
/**
 * r10 (run 34): the API hands the body one command in a reply, and a receipt reaches it with the next poll, one poll period (200 ms) after the
 * command ended. A step's four or five probes (sight, around, column, path ...) therefore took 200 to 400 ms each, one after the other, and the
 * fifth passed the one second the head waits for them: the head cancelled the ones unanswered and closed the step with their commands unsettled
 * (FCA_BODY_OUTCOME_UNKNOWN, seven times, then a stop). A command that ends has its receipt sent at once (the next poll is made now, not in
 * 200 ms), and for HOT_WINDOW_MS after a command came or ended the polls come every HOT_POLL_MS (a probe asked for just after an act ended was
 * picked up up to 200 ms late). A hot poll reuses an observation made less than OBSERVATION_REUSE_MS ago (the loop makes one every 100 ms).
 */
const HOT_POLL_MS = 50;
const HOT_WINDOW_MS = 1200;
const OBSERVATION_REUSE_MS = 100;
/** One poll's wait for the API; a slower reply is a failed poll, not lost contact. */
const POLL_TIMEOUT_MS = 5000;
/** How long the API may stay silent before running commands are stopped (an API restart takes about this long). */
const CONTACT_LOSS_MS = 15_000;
/** After an API answered a poll that carried events without taking them (an older API), they are offered again this much later. */
const EVENTS_RETRY_MS = 60_000;
const identity = (c: Command) => JSON.stringify([c.lease.id, c.lease.generation, c.lease.holder, c.context.scopeKey, c.context.taskId]);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
export class CommonFcaControlLoop {
  readonly connectionId: string;
  private readonly baseUrl: string;
  private readonly seen = new Set<string>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly active = new Map<string, { controller: AbortController; running: Promise<void> }>();
  /** The task queue's items (one runs, up to two wait), and the read-only commands running beside the owner's (they are no part of the queue). */
  private readonly queue = new BodyQueue();
  private readonly beside = new Set<string>();
  private owner: string | null = null;
  private held = false;
  private closedSessions = new Set<string>();
  private readonly leaseGenerations = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private observationTimer?: ReturnType<typeof setInterval>;
  private observation: BodyObservation;
  private polling = false;
  private closed = false;
  /** r10: the next poll is made at once (a receipt is ready); polls are hot (every HOT_POLL_MS) until this wall-clock time; when the observation was made. */
  private quick = false;
  private hotUntil = 0;
  private observedAt = 0;
  /** The catalog the API last acknowledged; a different one (the task changed kind) is sent again, whole. */
  private catalogSent: readonly MinecraftSkillDefinition[] | null = null;
  private readonly lifetime = new AbortController();
  /** When a poll last got a well-formed reply; running commands survive a short loss of contact (see poll). */
  private contactAt = (this.options.now ?? Date.now)();
  /** Events are sent until an API answers without taking them; then again after EVENTS_RETRY_MS (it may have been updated). */
  private eventsRetryAt = 0;
  private readonly speech: LiveSpeechCourier;
  constructor(private readonly options: CommonFcaControlOptions) {
    this.baseUrl = companionBaseUrl(options.baseUrl);
    this.connectionId = options.connectionId ?? randomUUID();
    this.observation = options.actuator.observe();
    this.speech = options.speech ?? new LiveSpeechCourier();
  }
  /** A command, an owner or a held body is the loop's: idle work (a pickup walk) starts only when this is false. */
  get leaseHeld(): boolean { return this.owner !== null || this.held || this.active.size > 0 || this.queue.busy; }
  /** Stopped: its bot ended, or a newer connection's loop replaced it (`createCommonFcaBody`). */
  get stopped(): boolean { return this.closed; }
  get busy(): boolean { return this.held || this.active.size > 0 || this.queue.busy || (Array.isArray(this.observation.state.activeCapabilities) && this.observation.state.activeCapabilities.length > 0); }
  start(): void {
    if (this.timer || this.observationTimer || this.closed) return;
    // Independent of a provider/skill/HTTP wait: the body keeps observing.
    this.observationTimer = setInterval(() => {
      this.observation = this.options.actuator.observe();
      this.observedAt = performance.now();
      try { this.options.actuator.events?.tick(); } catch { /* events never stop the body observing */ }
    }, 100);
    this.observationTimer.unref();
    void this.tick();
  }
  private readonly tick = async (): Promise<void> => {
    // A poll made at once or in a hot window reuses a fresh observation (the observation is not what the poll is for).
    const reuse = this.quick || performance.now() < this.hotUntil;
    this.quick = false;
    let answered = false;
    try { await this.poll(reuse); answered = true; } catch { /* pending receipts remain until acknowledged */ }
    finally {
      if (!this.closed) {
        const base = this.options.pollMilliseconds ?? 200;
        this.schedule(!answered ? base : this.quick ? 0 : performance.now() < this.hotUntil ? Math.min(base, HOT_POLL_MS) : base);
      }
    }
  };
  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(this.tick, delay);
    this.timer.unref();
  }
  /** A command came or ended: polls are hot for a while; with `receipt`, the next poll is now (the receipt goes out and the next command may come in). */
  private hurry(receipt: boolean): void {
    this.hotUntil = performance.now() + HOT_WINDOW_MS;
    if (!receipt || this.closed || !this.timer) return;
    this.quick = true;
    if (!this.polling) this.schedule(0);
  }
  async poll(reuse = false): Promise<void> {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      if (!(reuse && performance.now() - this.observedAt < OBSERVATION_REUSE_MS)) { this.observation = this.options.actuator.observe(); this.observedAt = performance.now(); }
      this.dropExpired();
      const sent = [...this.receipts.values()].slice(0, 16);
      const catalog = this.options.actuator.skills;
      const now = (this.options.now ?? Date.now)();
      const events = this.options.actuator.events && now >= this.eventsRetryAt ? this.options.actuator.events.pending() : [];
      const response = await (this.options.fetcher ?? fetch)(`${this.baseUrl}${MINECRAFT_CONTROL_PATH}`, {
        method: 'POST', headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' },
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]),
        body: JSON.stringify({ schemaVersion: 1, serverId: this.options.serverId, connectionId: this.connectionId,
          observation: this.observation, candidates: this.options.actuator.candidates(this.observation),
          ...(this.catalogSent !== catalog ? { skills: catalog } : {}),
          receipts: sent, activeOperationIds: [...this.active.keys()], queuedOperationIds: this.queue.ids(), ...this.queueFields(),
          ...(events.length ? { events } : {}), ...this.liveFields() }),
      });
      if (!response.ok) throw Error('BODY_CONTROL_HTTP');
      const reply = await response.json() as MinecraftControlReply;
      if (this.closed) return;
      if (reply.schemaVersion !== 1 || reply.mode !== 'common-fca' || !Array.isArray(reply.commands)
        || reply.commands.length > 8 || !Array.isArray(reply.cancel) || !Array.isArray(reply.acknowledged)) throw Error('BODY_CONTROL_REPLY');
      this.catalogSent = catalog;
      this.contactAt = (this.options.now ?? Date.now)();
      for (const id of reply.acknowledged) if (sent.some(receipt => receipt.id === id)) this.receipts.delete(id);
      if (typeof reply.eventsThrough === 'number') this.options.actuator.events?.acknowledge(reply.eventsThrough);
      else if (events.length) this.eventsRetryAt = now + EVENTS_RETRY_MS;
      for (const id of reply.cancel) this.cancelOne(id);
      for (const command of reply.commands) this.accept(command);
      this.speech.accept(reply.speech);
    } catch (error) {
      // No action replay after lost contact. Command IDs remain tombstoned for this connection.
      this.catalogSent = null;
      // One slow or failed poll is not lost contact: a two-second stall of the API's event loop used to cut every
      // running move (common run 9, 2026-10-14 20:40). Running commands keep their own deadlines; they are stopped
      // only once the API has not answered for CONTACT_LOSS_MS (an API restart, a dead network).
      const silent = (this.options.now ?? Date.now)() - this.contactAt;
      if (silent >= CONTACT_LOSS_MS && (this.active.size || this.queue.waiting.length)) {
        log.warn(`API と ${Math.round(silent / 1000)} 秒話せないので、実行中の命令を止める（${this.active.size}件、待ち ${this.queue.waiting.length}件）`);
        this.dropWaiting('捨てた: API と話せなくなった。手は動いていない');
        for (const value of this.active.values()) value.controller.abort('control_disconnected');
      }
      throw error;
    } finally { this.polling = false; }
  }
  /** The room and the receipts of her live lines, for a poll; nothing without a sink (the field is absent, as an older body's). */
  private liveFields(): { liveRoom?: LiveRoom; speechReceipts?: LiveSpeechReceipt[] } {
    if (!this.speech.active) return {};
    const room = this.speech.room(), receipts = this.speech.takeReceipts();
    return { ...(room ? { liveRoom: room } : {}), ...(receipts.length ? { speechReceipts: receipts } : {}) };
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
    // Task queue: an `act` carrying an envelope is an item (null: it carries one that is not well formed, so it is refused as a shape).
    const envelope = readEnvelope(command);
    const valid = command.schemaVersion === 1 && command.serverId === this.options.serverId && envelope !== null && !(cleanup && envelope)
      && command.connectionId === this.connectionId && context?.bodyId === this.observation.bodyId
      && ID.test(context.sessionId) && ID.test(context.taskId) && Number.isSafeInteger(context.generation)
      && context.generation >= 0 && Number.isSafeInteger(context.taskRevision) && context.taskRevision >= 0
      && command.lease && ID.test(command.lease.id) && typeof command.lease.holder === 'string'
      && Number.isSafeInteger(command.lease.generation) && Number.isFinite(Date.parse(command.deadlineAt))
      && (cleanup || Date.parse(command.deadlineAt) > now && Date.parse(command.deadlineAt) - now <= (envelope ? QUEUE_ACCEPT_WINDOW_MS : this.acceptWindow(command)));
    const key = valid ? identity(command) : '';
    const sessionKey = `${key}:${context?.sessionId}`;
    const historicalCleanup = cleanup && this.closedSessions.has(sessionKey);
    // r10: a read-only command (a probe) holds nothing of the body: it runs beside what its own owner has running, and with others like it
    // (the API may send several in one reply). Never beside another owner's, a held body or a cleanup.
    const readOnly = valid && command.kind === 'skill' && this.options.actuator.skills.find(skill => skill.name === command.skill)?.readOnly === true;
    const beside = readOnly && this.owner === key;
    // An item may come while its owner's item runs or waits (the queue judges that); anything else running (a probe is no part of it) refuses it.
    const otherActive = [...this.active.keys()].some(id => id !== this.queue.runningId && !this.beside.has(id));
    const busy = envelope ? otherActive : (this.active.size > 0 || this.queue.busy) && !beside;
    if (!valid || (!cleanup && (this.closedSessions.has(sessionKey) || this.held || busy || this.owner !== null && this.owner !== key
        || command.lease.generation < (this.leaseGenerations.get(command.lease.id) ?? -1)))
      || cleanup && this.owner !== null && this.owner !== key && !this.closedSessions.has(sessionKey)) {
      // A command refused for its own shape (stale connection, a deadline out of reach) never took the body: say so, so the
      // API can treat it as a known failure. One refused because the body is held or another owner has it says not released.
      const refused: Receipt = { id: command.id, connectionId: this.connectionId, outcome: 'failed',
        inputsReleased: !cleanup && !valid && !this.held && this.active.size === 0 && !this.queue.busy, observedAt: new Date(now).toISOString(), result: 'BODY_COMMAND_REFUSED' };
      this.receipts.set(command.id, refused);
      this.hurry(true);
      if (valid) this.watch(() => this.options.observer?.commandEnded?.(command, refused));
      return;
    }
    if (envelope) {
      const admission = this.queue.admit(envelope);
      if (typeof admission === 'object') {
        // No hand moved and the body is not held (checked above): a known refusal, the queue unchanged.
        this.closeUnstarted(command, 'failed', admission.failureType, admission.result);
        return;
      }
      this.owner = key; this.leaseGenerations.set(command.lease.id, command.lease.generation);
      if (admission === 'wait') {
        this.queue.waiting.push(command);
        this.hurry(false);
        this.watch(() => this.options.observer?.commandQueued?.(command));
        return;
      }
      this.begin(command, key);
      return;
    }
    // The fix run: the operator's cancel of a held task comes as a release naming the hold; the world moves again (the release goes on as ever).
    const cancelled = cleanup ? (context as { incident?: { cancel?: unknown } }).incident?.cancel : undefined;
    if (typeof cancelled === 'string' && cancelled) void this.options.actuator.cancelIncident?.(cancelled).catch(() => false);
    this.launch(command, key, cleanup, historicalCleanup);
  }
  /** An item about to start: its start-by time and its condition are checked once, now; if either fails it is not started and what waits is dropped. */
  private begin(command: Command, key: string): void {
    const envelope = readEnvelope(command) as QueueEnvelope;
    const verdict = notStarted(envelope, (this.options.now ?? Date.now)(), this.options.actuator.check?.bind(this.options.actuator));
    if (!verdict) { this.launch(command, key, false, false); return; }
    this.closeUnstarted(command, verdict.outcome, verdict.failureType, verdict.result);
    this.dropWaiting(droppedBecause(envelope.item, verdict.failureType));
    this.settleOwner(key);
  }
  /** A receipt for a command that never started: nothing moved, so the inputs are released unless the body is held. */
  private closeUnstarted(command: Command, outcome: Receipt['outcome'], failureType: string, result: string): void {
    const now = (this.options.now ?? Date.now)();
    const receipt: Receipt = { id: command.id, connectionId: this.connectionId, outcome, inputsReleased: !this.held, observedAt: new Date(now).toISOString(),
      failureType, recoverable: true, result };
    if (command.queue) this.queue.note(command.queue.item, false);
    this.receipts.set(command.id, receipt);
    this.hurry(true);
    this.watch(() => this.options.observer?.commandEnded?.(command, receipt));
  }
  /** Every waiting item is dropped, each with a receipt that says its hands did not move. */
  private dropWaiting(result: string): void {
    for (const command of this.queue.clear()) this.closeUnstarted(command, 'cancelled', 'queue_dropped', result);
  }
  /** An item still waiting past its start-by time is dropped now, with the ones behind it (the receipt need not wait for the item ahead to end). */
  private dropExpired(): void {
    const late = this.queue.firstExpired((this.options.now ?? Date.now)());
    if (!late) return;
    this.queue.removeFrom(late.id).forEach((command, index) => this.closeUnstarted(command, 'cancelled', index === 0 ? 'queue_expired' : 'queue_dropped',
      index === 0 ? EXPIRED_TEXT : droppedBecause(late.queue?.item ?? '-', 'queue_expired')));
  }
  /** The head cancelled this id: a running command is aborted; a waiting item goes, and so does every one behind it (they follow it). */
  private cancelOne(id: string): void {
    const running = this.active.get(id);
    if (running) { running.controller.abort('server_cancel'); return; }
    const gone = this.queue.removeFrom(id);
    gone.forEach((command, index) => this.closeUnstarted(command, 'cancelled', 'queue_dropped',
      index === 0 ? '捨てた: 取り消された。手は動いていない' : droppedBecause(gone[0]!.queue?.item ?? '-', '取り消された')));
  }
  /** The owner is given back when nothing runs and nothing waits (the loop is not held). */
  private settleOwner(key: string): void {
    if (!this.held && this.owner === key && this.active.size === 0 && !this.queue.busy) this.owner = null;
  }
  /** The running item's progress for the poll: its command id and how far it has got. */
  private queueFields(): { queue?: MinecraftQueueProgress } {
    const id = this.queue.runningId;
    const progress = id ? this.options.actuator.progress?.() : null;
    return id && progress ? { queue: { id, ...progress } } : {};
  }
  private launch(command: Command, key: string, cleanup: boolean, historicalCleanup: boolean): void {
    const now = (this.options.now ?? Date.now)();
    const context = command.context;
    const sessionKey = `${key}:${context?.sessionId}`;
    const envelope = readEnvelope(command) ?? null;
    this.hurry(false);
    if (!cleanup) { this.owner = key; this.leaseGenerations.set(command.lease.id, command.lease.generation); }
    else if (!this.closedSessions.has(sessionKey)) {
      this.dropWaiting('捨てた: 止める命令が来た。手は動いていない');
      for (const item of this.active.values()) item.controller.abort('owner_release');
    }
    const readOnly = command.kind === 'skill' && this.options.actuator.skills.find(skill => skill.name === command.skill)?.readOnly === true;
    if (readOnly && !envelope && this.owner === key) this.beside.add(command.id);
    if (envelope) this.queue.begin(command);
    const controller = new AbortController();
    this.watch(() => this.options.observer?.commandStarted?.(command));
    // An item's limit counts from its start (it may have waited); any other command's deadline is the one the API set.
    const timeout = setTimeout(() => controller.abort('deadline'), cleanup ? 3000 : envelope ? envelope.maxMs : Math.max(1, Date.parse(command.deadlineAt) - now));
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
      }
      if (envelope) this.queue.end(envelope.item, receipt.outcome === 'completed' && receipt.inputsReleased);
      this.receipts.set(command.id, receipt);
      this.hurry(true);
      this.watch(() => this.options.observer?.commandEnded?.(command, receipt));
      // An item that ended well lets the next one start now; any other end drops what waits (it was never started).
      if (envelope) {
        const next = receipt.outcome === 'completed' && receipt.inputsReleased && !this.held ? this.queue.next() : undefined;
        if (next) this.begin(next, key);
        else this.dropWaiting(droppedBecause(envelope.item, receipt.failureType ?? receipt.outcome));
      }
      // (Not while another command of this owner still runs or waits beside it: the last one to end gives the owner back.)
      if (!historicalCleanup && !this.held && receipt.inputsReleased && this.owner === key && ![...this.active.keys()].some(id => id !== command.id) && !this.queue.busy) this.owner = null;
    }).finally(() => {
      clearTimeout(timeout); this.active.delete(command.id); this.beside.delete(command.id);
      // Two commands of the owner that end together: the one that ends last gives the owner back (the other was still in `active` when the first ended).
      if (!cleanup && !historicalCleanup) this.settleOwner(key);
    });
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
    this.dropWaiting('捨てた: 操作者が止めた。手は動いていない');
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
    this.dropWaiting('捨てた: 体が切れた。手は動いていない');
    for (const value of this.active.values()) value.controller.abort('body_disconnected');
    const released = await this.options.actuator.release(AbortSignal.timeout(3000)).catch(() => false);
    this.held = !released;
    await this.options.actuator.dispose?.();
    return released;
  }
}
