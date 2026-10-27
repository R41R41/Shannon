import { Vec3 } from 'vec3';
import { NativeGoalEvidence, GOAL_EVIDENCE_SKILL } from './goalEvidence.js';
import { primitiveState, primitiveCandidates, executePrimitive } from './primitives.js';
import { captureWorldObservation } from '../../cognition/worldFrame.js';
import { floorActive, floorSilenced, reflexHeld } from '../../utils/floorReflexes.js';
import { floorConfig } from '../../utils/floorConfig.js';
import { linkWatchOf } from '../../utils/linkWatch.js';
import type { ReflexLedger } from '../../utils/reflexLedger.js';
import { activeActionCapabilities, cancelIdleActions, currentAction, cancelNonSurvivalActions, createMotorPort, executeAction,
  hasActiveSafetyLease, physicalActionBusy, safetyLeaseCapabilities, withActionSignal } from '../../execution/ActionExecution.js';
import { bodySkillCatalog, isDragonGoal, type BodySkill } from './skillCatalog.js';
import type { BodyCandidateDraft, BodyObservation, BodyValue } from './bodyControlContract.js';
import type { MinecraftControlCommand as Command, MinecraftControlReceipt as Receipt, MinecraftQueueProgress } from './minecraftControlContract.js';
import { conditionHolds, conditionWords, type ActCondition } from '../../utils/actConditions.js';
import type { CommonFcaActuator } from './controlLoop.js';
import { BodyEventWatcher } from './bodyEvents.js';
import { closeInAdvised, combatOwnerOf } from '../../utils/combatOwner.js';
import { craftDoneDespiteCut, craftWitness, type CraftWitness } from '../../utils/cutCraftRecovery.js';
import { renderActReport, takeActReport } from '../../utils/actReport.js';
import { incidentsOf } from '../../utils/incidents.js';

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
/** The floor's action names, as the planner reads them in a receipt. */
const REFLEX_LABELS: Record<string, string> = { 'floor-eat': '食事', 'floor-armor': '防具の装着', 'floor-retreat': '退避', 'floor-flee': '低体力の逃走', 'floor-last-stand': '逃げ道が無い時の最後の手', 'floor-cover': '燃えて射手から見えている時に射線を切る', 'floor-melee': '近接の敵が近い時の最小の 1 手（打ち返す・間にブロック・2 段上がる・空所の縁から離れる）',
  'auto-swim': '泳ぎ（呼吸の確保）' };
/** A reflex's action name as the planner reads it: the table, else the name without its `floor-` / `constant:` / `auto-` prefix. */
function reflexLabel(by: string): string {
  const bare = by.replace(/^constant:/u, '');
  return REFLEX_LABELS[by] ?? REFLEX_LABELS[bare] ?? `反射（${bare.replace(/^(floor|auto)-/u, '')}）`;
}
export interface NativeBodyOptions {
  serverId: string; now?: () => number;
  /** The reflex note on receipts and the `interrupted_by_reflex` failure type (default: MINEBOT_FCA_REFLEX_OFF has no `ledger-tag`). */
  reflexTag?: boolean;
  capture(signal: AbortSignal): Promise<{ dataUrl: string; capturedAt: string }>;
  disposeCapture?(): Promise<void>;
  /** False when no first-person picture can come from this connection, so the API does not offer visual control. */
  rendererConfigured?(): boolean;
  /** Whether the body tells the API what changes while it works (bodyEvents; default: on unless MINEBOT_BODY_EVENTS=off). */
  events?: boolean;
}
/** One native bot, one ActionExecution resource arbiter, no game planner or model. */
/**
 * How long a release waits for a safety reflex that holds the body to end by itself: a meal takes about 1.6 s, a retreat at
 * most 1 s, armour under 0.5 s. With the 300 ms cleanup after it, the whole leaves room inside the 5 s an API stop or release
 * command allows (minecraftReflexAdapter, delivery included) and the 5 s of a lifecycle logout; a longer hold (a lava escape)
 * still ends held, as before.
 */
const SAFETY_RELEASE_WAIT_MS = 3000;
/**
 * How long the release after a command waits for auto-swim to have the body back at the air: a surfacing from a few blocks down takes
 * 2 to 5 s, under an ice sheet longer. Only after a command (an API stop or release keeps the 3 s above).
 */
const BREATH_RELEASE_WAIT_MS = 12_000;
/** The wait for auto-swim ends at least this long before the command's deadline: the cleanup (300 ms) and the receipt follow it. */
const RECEIPT_MARGIN_MS = 1500;
/** r10: a command waits for a reflex that holds the body, polling this often; the reflex must stay let go this long (the flee's next segment); a command with less than REFLEX_MIN_RUN_MS left is not started. */
const REFLEX_POLL_MS = 20;
const REFLEX_GRACE_MS = 80;
const REFLEX_MIN_RUN_MS = 1000;
/** No command for this long, the dragon's focus goes back to the ordinary one (decisions between commands take seconds). */
const DRAGON_CATALOG_IDLE_MS = 90_000;
/**
 * The skill's own failure kind for the API to sort retries by (agreed 2026-10-14: retry the same, change the situation,
 * get material first, or fix the input). move-to's old name for "no route" is said as the agreed no_path.
 */
function failureOf(result: { failureType?: string; recoverable?: boolean }): Pick<Receipt, 'failureType' | 'recoverable'> | undefined {
  const type = typeof result.failureType === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(result.failureType)
    ? (result.failureType === 'path_not_found' ? 'no_path' : result.failureType) : undefined;
  if (!type && typeof result.recoverable !== 'boolean') return undefined;
  return { ...(type ? { failureType: type } : {}), ...(typeof result.recoverable === 'boolean' ? { recoverable: result.recoverable } : {}) };
}
export class NativeCommonFcaBody implements CommonFcaActuator {
  private readonly catalog;
  /** What the planner is offered (the same for every task). */
  private readonly offered;
  private readonly runnable;
  private dragonTask = false;
  private running = 0;
  private idleSince = 0;
  /**
   * What the planner is offered. The body learns the task only from a command, so the dragon's focus of the remembered places with no
   * command for a while goes back to the ordinary one: the next request may be anything (fishing after the dragon).
   */
  get skills() {
    if (this.dragonTask && this.running === 0 && this.now() - this.idleSince > DRAGON_CATALOG_IDLE_MS) this.setDragonTask(false);
    return this.offered;
  }
  /** The task's kind also says which remembered places the observation puts first (the dragon's: base, portals, structures). */
  private setDragonTask(dragon: boolean) {
    this.dragonTask = dragon;
    if (this.bot.placeMemory) this.bot.placeMemory.focus = dragon ? 'dragon' : null;
  }
  private readonly goalEvidence: NativeGoalEvidence;
  readonly events?: BodyEventWatcher;
  private sequence = 0;
  private connected = true;
  private imageAvailable = false;
  private lastPosition: Vec3 | null = null;
  private movedAt = 0;
  private lastSafety: Record<string, BodyValue> | null = null;
  private readonly reflexTag: boolean;
  private readonly onEnd = () => { this.connected = false; };
  /** The running act's hand and pass, from its `minebotActStep` events (the task queue's progress in the poll); cleared when a command begins. */
  private stepProgress: Omit<MinecraftQueueProgress, 'id'> | null = null;
  private readonly onStep = (event: { index?: number; total?: number; iteration?: number; repeat?: number; status?: string }) => {
    if (event.status !== 'in_progress' || typeof event.index !== 'number' || typeof event.total !== 'number') return;
    this.stepProgress = { hand: event.index + 1, of: event.total, iteration: event.iteration ?? 1, repeat: event.repeat ?? 1 };
  };
  private readonly onProgress = (progress: any) => {
    if (progress.capability === 'auto-swim') this.lastSafety = { capability: 'auto-swim', status: String(progress.status),
      actionId: String(progress.actionId), observedAt: new Date(this.now()).toISOString() };
  };
  constructor(private readonly bot: any, private readonly options: NativeBodyOptions) {
    this.reflexTag = options.reflexTag ?? floorConfig().ledgerTag;
    // The planner is offered act, view, probe (r4) and the readers (design mb-llm-centric).
    this.catalog = bodySkillCatalog(bot.instantSkills.getSkills() as BodySkill[], bot);
    if (this.catalog.runnable.some(skill => skill.name === GOAL_EVIDENCE_SKILL.name)) throw Error('BODY_RESERVED_SKILL');
    this.offered = [...this.catalog.definitions, GOAL_EVIDENCE_SKILL];
    this.runnable = [...this.catalog.runnable, GOAL_EVIDENCE_SKILL];
    this.goalEvidence = new NativeGoalEvidence(bot, () => this.now());
    if (options.events ?? process.env.MINEBOT_BODY_EVENTS !== 'off') this.events = new BodyEventWatcher(bot, () => this.now());
    bot.on('end', this.onEnd); bot.on('minebotActionProgress', this.onProgress); bot.on('minebotActStep', this.onStep);
  }
  /** Task queue: whether an item's condition holds now, and in words what is lacking when it does not. */
  check(condition: ActCondition): { ok: boolean; words: string } {
    try { return conditionHolds(this.bot, condition) ? { ok: true, words: '' } : { ok: false, words: conditionWords(this.bot, condition) }; }
    catch { return { ok: false, words: '前提を確かめられなかった' }; }
  }
  /** The operator cancelled a held task (2026-10-28): its hold ends and the world moves again (`utils/incidents`). */
  async cancelIncident(id: string): Promise<boolean> { return (await incidentsOf(this.bot)?.cancel(id)) ?? false; }
  /** Task queue: how far the running act is, or null when none has begun a hand. */
  progress(): Omit<MinecraftQueueProgress, 'id'> | null { return this.running > 0 ? this.stepProgress : null; }
  private now() { return (this.options.now ?? Date.now)(); }
  observe(): BodyObservation {
    const world = captureWorldObservation(this.bot, { threatReach: true }), now = this.now();
    const position = this.bot.entity?.position;
    if (position && (!this.lastPosition || position.distanceTo(this.lastPosition) > 0.1)) {
      this.movedAt = now; this.lastPosition = position.clone();
    }
    const moving = ['forward', 'back', 'left', 'right', 'jump'].some(name => this.bot.controlState?.[name]);
    const facts: Record<string, null | string | number | boolean> = {
      // alive is false only for a body known to be dead (health 0): a body just back in after a drop has no health yet and is not dead
      // (run 24: a reconnect was taken for a respawn and a shelter was dug on magma); `connected` says whether it is there at all.
      connected: this.connected && !!this.bot.entity, alive: typeof this.bot.health === 'number' ? this.bot.health > 0 : true,
      onGround: this.bot.entity?.onGround === true, dimension: String(this.bot.game?.dimension ?? ''),
      // Seconds since the dimension last changed (a portal), null when it has not this connection.
      dimensionSinceSec: this.bot.dimensionChange ? Math.round((now - this.bot.dimensionChange.at) / 1000) : null,
      // Digs the server did not confirm (put back by utils/digConfirmation): in all, and in the last 30 s -- a streak is a server or a link that is behind.
      digRestored: Number(this.bot.ghostBlocksRestored ?? 0), digRestoredRecent: Number(this.bot.digUnconfirmedRecent?.() ?? 0),
      linkBehind: linkWatchOf(this.bot)?.behind() === true,
      yaw: Number(this.bot.entity?.yaw ?? 0), pitch: Number(this.bot.entity?.pitch ?? 0),
      equipped: this.bot.heldItem?.name ?? null, window: this.bot.currentWindow?.type ?? null,
      danger: (this.bot.health ?? 20) <= 8 || (this.bot.oxygenLevel ?? 20) <= 6 || (world.nearbyThreats ?? []).some(t => t.distance <= 5 && t.canReachMe !== false),
      floorActive: floorActive(this.bot),
      // r10: the reflex that holds the body now (`floor-flee`, `floor-last-stand`, `floor-cover` ...), also in the gap between two of its hands, or
      // null. An act that comes now waits for it (see `afterReflex`); the head need not send one until this is null.
      reflexHeld: reflexHeld(this.bot),
      // What the floor's budget is holding back right now (arrow, eat, armor, budget), or null: why no reflex came.
      floorSilenced: floorSilenced(this.bot),
      // Who holds the body in a fight: `head` (the planner's fight skill runs, or began within 20 s with its target near: the floor does
      // not run or wall in), `reflex` (a floor reflex is running the body away), or null. closeInAdvised: a lone skeleton, iron, a sword,
      // health 10 or more: close in and fight rather than run (run 21).
      combatOwner: combatOwnerOf(this.bot),
      closeInAdvised: closeInAdvised(this.bot),
      stuck: !!moving && now - this.movedAt > 1500, visualRequired: false, imageAvailable: this.imageAvailable,
      rendererConfigured: this.options.rendererConfigured?.() ?? null,
    };
    const primitives = primitiveState(this.bot); Object.assign(facts, primitives.facts);
    return { schemaVersion: 1, bodyId: `minecraft:${this.options.serverId}`, sequence: ++this.sequence,
      stateAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), connected: facts.connected === true,
      state: JSON.parse(JSON.stringify({ world, primitives: primitives.state, activeCapabilities: activeActionCapabilities(this.bot), localSafety: this.lastSafety })), facts };
  }
  candidates(observation: BodyObservation): BodyCandidateDraft[] {
    return primitiveCandidates(observation, this.now());
  }
  async execute(command: Command, signal: AbortSignal): Promise<Receipt> {
    // The task each command carries says which remembered places the observation puts first.
    if (typeof command.context?.goal === 'string') this.setDragonTask(isDragonGoal(command.context.goal));
    this.running++;
    if (command.kind === 'skill' && command.skill === 'act') this.stepProgress = null;
    try { return await this.executeCommand(command, signal); }
    finally { this.running--; this.idleSince = this.now(); }
  }
  private async executeCommand(command: Command, signal: AbortSignal): Promise<Receipt> {
    if (command.kind === 'capture') {
      // Capture never owns motor inputs. Missing exact assets or cancelled observation are a
      // known no-image result, not an uncertain physical effect. Existing cleanup holds remain held.
      try {
        signal.throwIfAborted();
        if (!this.connected || !this.bot.entity) throw Error('BODY_DISCONNECTED');
        const image = await this.options.capture(signal); signal.throwIfAborted();
        this.imageAvailable = true;
        return this.receipt(command, 'completed', true, undefined, image);
      } catch {
        this.imageAvailable = false;
        return this.receipt(command, signal.aborted ? 'cancelled' : 'failed', true, 'BODY_CAPTURE_UNAVAILABLE');
      }
    }
    signal.throwIfAborted();
    if (!this.connected || !this.bot.entity) throw Error('BODY_DISCONNECTED');
    // Each skill runs for its own time (build-around-self five minutes, mine-block three), never past the command's deadline
    // (the API sets that deadline from the catalog's maxDurationMs; until it does, its two minutes still bound every skill).
    const limit = command.kind === 'skill' ? this.runnable.find(skill => skill.name === command.skill)?.maxDurationMs ?? 120_000 : 120_000;
    // A queue item's time is its own, from its start (it may have waited); any other command's is the deadline the API set.
    const deadline = command.queue ? this.now() + Number(command.queue.maxMs) : Date.parse(command.deadlineAt);
    const milliseconds = Math.min(limit, deadline - this.now());
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw Error('BODY_DEADLINE');
    // r10: a read-only command that runs beside another (a probe beside an act) is no part of the goal's evidence: its start would stamp
    // the evidence with its id, and its cancel would clear the attacks the act made.
    const beside = this.running > 1 && command.kind === 'skill' && this.runnable.find(skill => skill.name === command.skill)?.readOnly === true;
    if (!beside) this.goalEvidence.begin(command);
    const cancelled = () => { if (!beside) this.goalEvidence.cancel(command.context); };
    signal.addEventListener('abort', cancelled, { once: true });
    try {
      if (command.kind === 'skill' && command.skill === GOAL_EVIDENCE_SKILL.name) {
        if (!command.arguments || typeof command.arguments !== 'object' || Array.isArray(command.arguments) || Object.keys(command.arguments).length) throw Error('BODY_EVIDENCE_ARGUMENTS');
        return this.receipt(command, 'completed', true, JSON.stringify(this.goalEvidence.snapshot()));
      }
      let capability: string, work: () => Promise<{ success: boolean; result: string; failureType?: string; recoverable?: boolean }>;
      let args: unknown[] = [];
      if (command.kind === 'skill') {
        const resolved = this.catalog.resolve(command.skill ?? '', command.arguments ?? {});
        capability = resolved.skill.skillName; args = resolved.args; work = () => resolved.skill.run(...resolved.args);
      } else if (command.kind === 'reflex' && command.operation) {
        const operation = command.operation, candidate = operation.candidate;
        if (JSON.stringify(operation.context) !== JSON.stringify(command.context) || candidate.sessionId !== command.context.sessionId
          || candidate.generation !== command.context.generation || candidate.taskRevision !== command.context.taskRevision
          || Date.parse(candidate.expiresAt) <= this.now() || Date.parse(operation.deadlineAt) <= this.now()) throw Error('BODY_STALE_CANDIDATE');
        const observation = this.observe();
        if (candidate.preconditions.some(item => observation.facts[item.key] !== item.value)) throw Error('BODY_PRECONDITION');
        // Only arguments generated by this adapter are admitted; no provider authored operation is executable.
        const current = this.candidates(observation).find(item => item.kind === candidate.kind && item.operation === candidate.operation
          && JSON.stringify(item.arguments) === JSON.stringify(candidate.arguments));
        if (!current || current.preconditions.some(required => !candidate.preconditions.some(p => p.key === required.key && p.value === required.value))
          || candidate.kind !== 'action' || candidate.maxDurationMs > 5000) throw Error('BODY_CANDIDATE_NOT_SUPPORTED');
        capability = 'common-fca-reflex';
        work = async () => {
          await executePrimitive(this.bot, createMotorPort(this.bot), candidate, signal);
          return { success: true, result: 'bounded primitive finished' };
        };
      } else throw Error('BODY_COMMAND_UNSUPPORTED');
      // A command is what idle work (a pickup walk) yields to, at once; then the ledger's position is taken, so only what the
      // reflexes do from here on is told with this command's result.
      // A read-only query (get-position and the like) does not need the body: it never cancels idle work.
      // The action's own id, so a reflex that cut off another action of the same name is not blamed for this one.
      let actionId: string | undefined;
      // A craft is remembered by what the pack held when it began: a reflex that cuts it off after the piece is made (the armour
      // reflex wears it at once) must not turn a made piece into a failure (run 21, below).
      const crafted: { witness: CraftWitness | null } = { witness: null };
      const started = work;
      work = () => { actionId = currentAction(this.bot)?.progress.actionId; crafted.witness = craftWitness(this.bot as never, capability, args); return started(); };
      const readOnly = command.kind === 'skill' && this.runnable.find(skill => skill.name === capability)?.readOnly === true;
      if (!readOnly) cancelIdleActions(this.bot, 'fca_command');
      if (command.kind === 'skill' && !readOnly) this.events?.begin(command);
      const ledger: ReflexLedger | undefined = this.reflexTag ? this.bot.reflexLedger : undefined;
      const mark = ledger?.mark() ?? 0;
      // r10 (run 34, +576: an urgent act met a flee that was digging down; it waited for the lock behind the reflex, was handed the lock in
      // the moment between two of the flee's segments and cut by the next, and its receipt came 4 s later, at its deadline, bare): a command
      // that moves the body and comes while a reflex holds it waits for the reflex to let go, and starts then (the time left of its deadline
      // is its time); the receipt says it did. If the reflex does not let go in time the command is not started, and that is said.
      let lead = '';
      let runMs = milliseconds;
      if (!readOnly && command.kind === 'skill') {
        const held = await this.afterReflex(signal, deadline);
        if (held) {
          const short = held.by.replace(/^constant:/u, '').replace(/^(floor|auto)-/u, '');
          const who = `反射 ${short}（${reflexLabel(held.by)}）`, waited = `${(held.ms / 1000).toFixed(1)}秒`;
          if (held.outcome === 'aborted') return this.receipt(command, 'cancelled', true, `${who}の最中に取り消された（始める前。${waited}待った。体は何も動かしていない）`);
          if (held.outcome === 'late') {
            return this.receipt(command, 'failed', true, `${who}の最中で、時間内に放されなかったため始められなかった（${waited}待った。体は何も動かしていない）。放された後に頼み直す`,
              undefined, { failureType: 'interrupted_by_reflex', recoverable: true });
          }
          lead = `${who}の最中のため、放された後に始めた（待ち ${waited}）`;
          runMs = Math.min(limit, deadline - this.now());
        }
      }
      // 2026-10-28: a task held on a heavy failure runs no act until the resume that names the hold (utils/incidents).
      const incidents = command.kind === 'skill' && capability === 'act' ? incidentsOf(this.bot) : null;
      const heldWords = incidents ? await incidents.beforeAct(command.context as never) : null;
      if (heldWords) return this.receipt(command, 'failed', true, heldWords, undefined, { failureType: 'held', recoverable: false });
      const actStartedAt = Date.now();
      const result = await withActionSignal(this.bot, signal, () => executeAction(this.bot, capability, runMs,
        work, { waitForQuiescence: true }));
      let outcome: Receipt['outcome'] = signal.aborted ? 'cancelled' : result.success ? 'completed' : 'failed';
      const released = readOnly || await this.release(AbortSignal.timeout(300), deadline - RECEIPT_MARGIN_MS);
      let failure = outcome === 'failed' ? failureOf(result) : undefined;
      let text = result.result;
      // A body reflex that took the body (a meal, a step back from a creeper) is not the model's failure: say so, and let it
      // look at the world again. Never for an API cancel, an operator stop or a deadline (those are `cancelled` / `timeout`).
      const cut = ledger && outcome === 'failed' && !signal.aborted && result.failureType === 'interrupted' ? ledger.cutOff(mark, capability, actionId) : undefined;
      // Run 21: the armour reflex wears a piece the moment the craft has put it in the pack and cancels the craft with it. The piece
      // exists (carried or worn): the command did what it was for, so it is a success, not an `interrupted_by_reflex` that makes the
      // planner drop the rest of its response. Judged after the release, so the pack is what the reflex left it.
      const made = cut && crafted.witness ? craftDoneDespiteCut(this.bot as never, crafted.witness) : null;
      if (cut && made) {
        outcome = 'completed'; failure = undefined;
        text = `${made.text}。体の反射「${reflexLabel(cut.by)}」が先に動いたため中断の形になりましたが、クラフトは完了しています`;
      } else if (cut) {
        failure = { failureType: 'interrupted_by_reflex', recoverable: true };
        text = `${text ?? capability}。体の反射「${reflexLabel(cut.by)}」が先に動いたため中断（反射が終わってから、観測を見て再開できる）`;
      }
      const note = ledger?.noteSince(mark);
      // An act says its own steps (utils/actReport): when a reflex or a cancel cut it, the action layer's answer is a bare
      // "interrupted", so the act's report is told instead, with the reflex's note and the map as it is after the reflex let go.
      const act = capability === 'act' ? takeActReport(this.bot, actStartedAt) : null;
      if (act) {
        text = renderActReport(this.bot, act, note, lead || undefined);
        // 2026-10-28: an act that did not succeed writes the black box (a heavy one also the scene, and holds a task that asked for it); the
        // receipt says which (`incident`), so that the head can hold the task and the operator can find the files.
        const incident = incidents ? await incidents.afterAct(command, act, Date.now() - actStartedAt).catch(() => null) : null;
        if (incident) {
          try { text = JSON.stringify({ ...JSON.parse(text), incident: { id: incident.id, heavy: incident.heavy, why: incident.why, held: incident.held,
            frozen: incident.frozen, ...(incident.freeze ? { freeze: incident.freeze } : {}), box: incident.box !== null, scene: incident.scene !== null,
            ...(incident.start ? { start: incident.start } : {}), ...(incident.end ? { end: incident.end } : {}) } }); }
          catch { /* the report as it was */ }
        }
        if (outcome === 'failed' && !failure) failure = { failureType: act.failureType ?? 'failed', recoverable: true };
        if (outcome === 'failed' && act.stoppedBy === 'reflex') failure = { failureType: 'interrupted_by_reflex', recoverable: true };
        return this.receipt(command, outcome, released, text, undefined, failure);
      }
      if (lead) text = text ? `${lead}。${text}` : lead;
      if (note) text = `${(text ?? '').slice(0, 16_000 - note.length - 1)}${text ? ' ' : ''}${note}`;
      return this.receipt(command, outcome, released, text, undefined, failure);
    } finally { signal.removeEventListener('abort', cancelled); this.events?.end(command.id); }
  }
  /**
   * r10: waits while a reflex holds the body (`reflexHeld`), until it lets go and stays let go for REFLEX_GRACE_MS (the flee's next segment
   * follows its last within a tick), the command's deadline is within REFLEX_MIN_RUN_MS (`late`), or the command is cancelled (`aborted`).
   * Null when no reflex held the body to begin with; `free` otherwise, with the reflex first met (or last seen) and how long it was waited for.
   */
  private async afterReflex(signal: AbortSignal, deadline: number): Promise<{ by: string; ms: number; outcome: 'free' | 'late' | 'aborted' } | null> {
    let by = reflexHeld(this.bot);
    if (!by) return null;
    const began = Date.now(), until = deadline - REFLEX_MIN_RUN_MS;
    for (;;) {
      if (signal.aborted) return { by, ms: Date.now() - began, outcome: 'aborted' };
      if (this.now() >= until) return { by, ms: Date.now() - began, outcome: 'late' };
      const held = reflexHeld(this.bot);
      if (held) by = held;
      else {
        await delay(REFLEX_GRACE_MS);
        if (!reflexHeld(this.bot)) return { by, ms: Date.now() - began, outcome: 'free' };
        continue;
      }
      await delay(REFLEX_POLL_MS);
    }
  }
  private receipt(command: Command, outcome: Receipt['outcome'], inputsReleased: boolean, result?: string, image?: Receipt['image'],
    failure?: Pick<Receipt, 'failureType' | 'recoverable'>): Receipt {
    const observedAt = new Date(this.now()).toISOString();
    return { id: command.id, connectionId: command.connectionId, outcome, inputsReleased, observedAt,
      ...(result ? { result: result.slice(0, 16_000) } : {}), ...(image ? { image } : {}), ...(failure ?? {}),
      ...(command.operation ? { action: { schemaVersion: 1, operationId: command.operation.operationId, bodyId: command.context.bodyId,
        sessionId: command.context.sessionId, generation: command.context.generation, outcome, inputsReleased, observedAt,
        evidenceId: command.id, observation: this.observe() } } : {}) };
  }
  async release(signal: AbortSignal, until = Infinity): Promise<boolean> {
    cancelNonSurvivalActions(this.bot, 'common_fca_release');
    // Critical air reflex owns the same arbiter; never acknowledge stopped while it is moving. A safety reflex (the floor's
    // eat/armour/retreat, lava, breath) ends by itself within seconds: wait for it, bounded, instead of reporting the body held
    // (2026-10-14 review: an interrupted action came back inputsReleased=false and every later command was refused).
    // Only a caller still waiting gets the extension; one that has already given up is answered at once, as before.
    // Surfacing for air takes longer than a meal: run 19 had two commands come back held (the API's FCA_BODY_OUTCOME_UNKNOWN and
    // a recovery of 17 s and 3 s) while auto-swim took 3.3 s and longer to reach the air. It is waited for up to
    // BREATH_RELEASE_WAIT_MS, not past `until` (the command's own deadline less the cleanup and receipt time) unless the 3 s every
    // safety reflex gets reach further. Only after a skill command (an `until` given): an API stop or release keeps the 3 s. Once
    // auto-swim has been seen holding the body, the longer bound stays (a meal that follows the surfacing does not cut it short).
    const extend = !signal.aborted, started = Date.now();
    let breathing = false;
    const bound = () => {
      breathing ||= Number.isFinite(until) && safetyLeaseCapabilities(this.bot).includes('auto-swim');
      return breathing ? Math.max(started + SAFETY_RELEASE_WAIT_MS, Math.min(until, started + BREATH_RELEASE_WAIT_MS)) : started + SAFETY_RELEASE_WAIT_MS;
    };
    let waited = false;
    while (physicalActionBusy(this.bot)) {
      if (signal.aborted) {
        if (!extend || !hasActiveSafetyLease(this.bot) || Date.now() >= bound()) return false;
        waited = true;
      }
      await delay(10);
    }
    // The caller's time was spent waiting for the safety reflex: the cleanup that follows gets its own short bound.
    if (waited) signal = AbortSignal.timeout(300);
    try {
      if (signal.aborted) return false;
      let removeAbort = () => {};
      const interrupted = new Promise<false>(resolve => { const abort = () => resolve(false);
        signal.addEventListener('abort', abort, { once: true }); removeAbort = () => signal.removeEventListener('abort', abort); });
      try {
        const stopped = await Promise.race([Promise.resolve(this.bot.collectBlock?.cancelTask?.()).then(() => true), interrupted]);
        if (!stopped || signal.aborted) return false;
      } finally { removeAbort(); }
      if (physicalActionBusy(this.bot)) return false; // A critical safety owner may start while plugin cleanup awaited.
      this.bot.pathfinder?.stop(); this.bot.pathfinder?.setGoal(null);
      this.bot.stopDigging?.(); this.bot.deactivateItem?.(); this.bot.clearControlStates();
      return !physicalActionBusy(this.bot) && !Object.values(this.bot.controlState ?? {}).some(Boolean);
    } catch { return false; }
  }
  closeEvidence(context: Command['context']): void { this.goalEvidence.cancel(context); }
  async dispose(): Promise<void> {
    this.goalEvidence.dispose();
    this.bot.removeListener('end', this.onEnd); this.bot.removeListener('minebotActionProgress', this.onProgress); this.bot.removeListener('minebotActStep', this.onStep);
    await this.options.disposeCapture?.();
  }
}
