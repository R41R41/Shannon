import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../../../utils/logger.js';
import { describePace, type PaceEntry,
  applyConsolidation, applyReflection, buildConsolidationMessage, buildReflectionMessage, CONSOLIDATION_SYSTEM_PROMPT, describeSituation, mergeCombatStats, parseReflection, REFLECTION_SYSTEM_PROMPT,
  addMissingSeeds, recountLegacyEvidence, renderKnowledge, renderTrajectory, retrieveKnowledge, seedCombatStats, seedItems, situationSummary,
  type CombatStatsState, type KnowledgeStoreState, type MinecraftKnowledgeScope, type ReflectionTrigger, type SituationFeatures,
  type TrajectoryPoint,
} from '../../../modules/minecraftLearning/index.js';
import { EncounterMemory } from './EncounterMemory.js';
import { captureWorldObservation } from '../cognition/worldFrame.js';
import { acquireExclusiveFileLock, writeFileAtomically } from '../utils/exclusiveFileLock.js';
import { describeRecentMotion, recentMotion } from '../utils/motionRecorder.js';

const log = createLogger('Minebot:Learning');

/** off: nothing. shadow: record and reflect, but keep learned knowledge out of the prompt. feedback: also inject it. */
export type MinecraftLearningMode = 'off' | 'shadow' | 'feedback';

export interface MinecraftLearningOptions {
  mode: MinecraftLearningMode;
  scope: MinecraftKnowledgeScope;
  /** Directory for this scope: knowledge.json plus experience/<runId>.jsonl. */
  directory: string;
  runId: string;
  /** Budgeted planner transport; reflection is skipped without it. */
  modelClient?: Pick<Anthropic, 'messages'>;
  model?: string;
}

export interface LearningActionRecord {
  tool: string;
  args: Record<string, unknown>;
  success: boolean | null;
  failureType: string | null;
  result: string;
  durationMs: number;
  emergency: boolean;
}

const EVENT_WINDOW = 60;
/** The run's course is sampled at least this often, and on any marked change of vitals or surroundings. */
const TRAJECTORY_SAMPLE_MS = 60_000;
const TRAJECTORY_KEEP = 240;
const STALL_FAILURES = 6;
const STALL_COOLDOWN_MS = 5 * 60_000;
/** No new kind of item and no advancement for this long counts as a stall, whatever the cause. */
const NO_PROGRESS_MS = 8 * 60_000;
/** A lesson that matched this share of the run's situations (after enough calls to tell) is general, not situational. */
const ALWAYS_ON_MATCH_RATE = 0.8;
const ALWAYS_ON_MIN_CALLS = 20;
/** Merge near-duplicates once this many new lessons accumulated since the last consolidation. */
const CONSOLIDATE_AFTER_NEW_LESSONS = 6;
const QUERY_PREFIXES = ['get-', 'list-', 'find-', 'check-', 'manage-', 'set-goal', 'task-complete', 'inspect', 'investigate'];

/**
 * Closes the experience -> lesson -> behaviour loop for Minebot. Every action
 * and survival event is recorded with world-independent situation features;
 * a death, a stall or the end of a run triggers a model reflection that adds,
 * confirms or contradicts general lessons in a store shared across isolated
 * worlds; and the planner sees only the lessons whose conditions match the
 * current situation. Nothing here hardcodes what to do in a situation.
 */
/** The planner transport caps a response at 4096 tokens; only what is used is billed. */
const REFLECTION_MAX_TOKENS = 4000;

export class MinecraftLearningService {
  readonly mode: MinecraftLearningMode;
  private readonly storeFile: string;
  private readonly combatFile: string;
  private readonly experienceFile: string;
  private encounters: EncounterMemory | null = null;
  private readonly startedAt = Date.now();
  private events: string[] = [];
  private consecutiveFailures = 0;
  private lastStallReflectionAt = 0;
  private lastProgressAt = Date.now();
  /** The actions of the last stretch with what they took, and the last advancement: see paceSection. */
  private pace: PaceEntry[] = [];
  private lastMilestone: { name: string; at: number } | null = null;
  private readonly heldKinds = new Set<string>();
  private pending = new Set<Promise<void>>();
  private shown = new Map<string, number>();
  /** Every item shown during this run, so a late outcome can be traced to early advice. */
  private readonly shownThisRun = new Map<string, { count: number; firstSec: number; lastSec: number }>();
  private readonly trajectory: TrajectoryPoint[] = [];
  private lastFeatures: SituationFeatures | null = null;
  private lastHealth: number | null = null;
  private damageSince: number | null = null;
  private damageTotal = 0;
  readonly stats = { reflections: 0, reflectionErrors: 0, added: 0, reinforced: 0, contradicted: 0, retired: 0,
    rejected: 0, injections: 0, actions: 0, consolidations: 0, merged: 0 };
  private consolidating = false;
  private promptCalls = 0;
  private readonly matched = new Map<string, number>();

  constructor(private readonly options: MinecraftLearningOptions) {
    this.mode = options.mode;
    this.storeFile = path.join(options.directory, 'knowledge.json');
    this.combatFile = path.join(options.directory, 'combat-stats.json');
    this.experienceFile = path.join(options.directory, 'experience', `${options.runId}.jsonl`);
    if (this.mode === 'off') return;
    fs.mkdirSync(path.dirname(this.experienceFile), { recursive: true, mode: 0o700 });
    this.update(state => state); // creates and seeds the store once
  }

  private readStore(): KnowledgeStoreState {
    if (!fs.existsSync(this.storeFile)) return { scope: this.options.scope, items: seedItems(new Date().toISOString()) };
    const state = JSON.parse(fs.readFileSync(this.storeFile, 'utf8')) as KnowledgeStoreState;
    if (state.scope?.kind !== 'minecraft-general' || state.scope.namespace !== this.options.scope.namespace
      || !Array.isArray(state.items)) throw new Error('MINECRAFT_KNOWLEDGE_STORE_SCOPE_MISMATCH');
    recountLegacyEvidence(state);
    addMissingSeeds(state.items, new Date().toISOString());
    return state;
  }

  /** Read-modify-write under an exclusive lock: parallel isolated runs share one store. */
  private update<T>(change: (state: KnowledgeStoreState) => T): T {
    const lock = acquireExclusiveFileLock(`${this.storeFile}.lock`);
    try {
      const state = this.readStore();
      const result = change(state);
      for (const [id, count] of this.shown) {
        const item = state.items.find(entry => entry.id === id);
        if (item) item.uses += count;
      }
      this.shown.clear();
      writeFileAtomically(this.storeFile, JSON.stringify(state, null, 1));
      return result;
    } finally { fs.closeSync(lock); fs.unlinkSync(`${this.storeFile}.lock`); }
  }

  private append(record: Record<string, unknown>, line: string): void {
    const atSec = Math.round((Date.now() - this.startedAt) / 1000);
    this.events.push(`[+${atSec}s] ${line}`);
    if (this.events.length > EVENT_WINDOW) this.events.splice(0, this.events.length - EVENT_WINDOW);
    try { fs.appendFileSync(this.experienceFile, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 }); }
    catch (error) { log.warn(`経験の記録に失敗: ${String(error)}`); }
  }

  private features(bot: unknown, emergency = false): SituationFeatures {
    const features = describeSituation(captureWorldObservation(bot), emergency);
    this.lastFeatures = features;
    this.sampleTrajectory(features);
    return features;
  }

  private sampleTrajectory(features: SituationFeatures): void {
    const sec = Math.round((Date.now() - this.startedAt) / 1000);
    const last = this.trajectory[this.trajectory.length - 1];
    const changed = !last || Math.abs((last.features.health ?? 0) - (features.health ?? 0)) >= 4
      || Math.abs((last.features.food ?? 0) - (features.food ?? 0)) >= 3
      || last.features.timeBand !== features.timeBand || last.features.depthBand !== features.depthBand
      || last.features.dimension !== features.dimension;
    if (!changed && sec - last.sec < TRAJECTORY_SAMPLE_MS / 1000) return;
    this.trajectory.push({ sec, features });
    if (this.trajectory.length > TRAJECTORY_KEEP) this.trajectory.splice(1, 1); // keep the start for reference
  }

  /** Lessons matching the current situation, as a prompt section (feedback) or only logged (shadow). */
  promptSection(bot: unknown, context: { emergency: boolean; recentTools: string[] }): string | null {
    if (this.mode === 'off') return null;
    let state: KnowledgeStoreState;
    try { state = this.readStore(); } catch (error) { log.warn(`知識ストアを読めません: ${String(error)}`); return null; }
    const features = this.features(bot, context.emergency);
    // Which lessons match almost whatever the situation is, measured on this run's own calls.
    this.promptCalls++;
    for (const { item } of retrieveKnowledge(state.items, features, { tools: context.recentTools, limit: Infinity }))
      this.matched.set(item.id, (this.matched.get(item.id) ?? 0) + 1);
    const alwaysOn = new Set(this.promptCalls < ALWAYS_ON_MIN_CALLS ? [] : [...this.matched.entries()]
      .filter(([, count]) => count / this.promptCalls >= ALWAYS_ON_MATCH_RATE).map(([id]) => id));
    const retrieved = retrieveKnowledge(state.items, features, { tools: context.recentTools, alwaysOn });
    if (!retrieved.length) return null;
    const sec = Math.round((Date.now() - this.startedAt) / 1000);
    for (const { item } of retrieved) {
      this.shown.set(item.id, (this.shown.get(item.id) ?? 0) + 1);
      const seen = this.shownThisRun.get(item.id);
      if (seen) { seen.count++; seen.lastSec = sec; } else this.shownThisRun.set(item.id, { count: 1, firstSec: sec, lastSec: sec });
    }
    const ids = retrieved.map(entry => entry.item.id);
    this.append({ kind: 'knowledge_shown', mode: this.mode, ids }, `knowledge ${this.mode === 'feedback' ? 'shown' : 'matched(shadow)'}: ${ids.join(',')}`);
    if (this.mode !== 'feedback') return null;
    this.stats.injections++;
    return `## 経験から学んだ知識（いまの状況に合うものだけ。出典と確信度つき）\n`
      + `最新のnative観測と矛盾する時は観測を優先する。従って結果が悪ければ、後の振り返りで反証される。\n${renderKnowledge(retrieved)}`;
  }

  /** How the run's time has gone, for the planner's per-call note (null in the first minutes, or when off). */
  paceSection(now = Date.now()): string | null {
    if (this.mode === 'off') return null;
    return describePace(this.pace, { now, startedAt: this.startedAt, lastMilestone: this.lastMilestone });
  }

  recordAction(bot: unknown, action: LearningActionRecord): void {
    if (this.mode === 'off') return;
    const now = Date.now();
    this.pace.push({ at: now, tool: action.tool, ms: Math.max(0, action.durationMs), emergency: action.emergency });
    if (this.pace.length > 600 || now - this.pace[0].at > 30 * 60_000) this.pace = this.pace.filter(entry => now - entry.at <= 30 * 60_000).slice(-600);
    this.stats.actions++;
    const physical = !QUERY_PREFIXES.some(prefix => action.tool.startsWith(prefix));
    const features = this.features(bot, action.emergency);
    const outcome = action.success === true ? '成功' : action.success === false ? `失敗(${action.failureType ?? '?'})` : '不明';
    const args = JSON.stringify(action.args).slice(0, 160);
    const showSituation = action.success !== true || action.emergency;
    this.append({ kind: 'action', tool: action.tool, args: action.args, success: action.success, failureType: action.failureType,
      result: action.result.slice(0, 400), durationMs: action.durationMs, situation: features },
    `${action.emergency ? '[緊急] ' : ''}${action.tool}(${args}) → ${outcome} ${action.result.replace(/\s+/g, ' ').slice(0, 220)}`
      + (showSituation ? ` | ${situationSummary(features)}` : ''));
    const newKinds = Object.keys(features.inventory).filter(name => !this.heldKinds.has(name));
    for (const name of newKinds) this.heldKinds.add(name);
    if (newKinds.length) this.lastProgressAt = Date.now();
    if (Date.now() - this.lastProgressAt >= NO_PROGRESS_MS && Date.now() - this.lastStallReflectionAt >= STALL_COOLDOWN_MS) {
      this.lastStallReflectionAt = Date.now();
      this.lastProgressAt = Date.now();
      this.reflectInBackground(bot, 'stall', `${Math.round(NO_PROGRESS_MS / 60000)}分以上、新しい種類のアイテムも実績も得られていない`);
      return;
    }
    if (!physical) return;
    if (action.success === false) this.consecutiveFailures++;
    else if (action.success === true) this.consecutiveFailures = 0;
    if (this.consecutiveFailures >= STALL_FAILURES && Date.now() - this.lastStallReflectionAt >= STALL_COOLDOWN_MS) {
      this.lastStallReflectionAt = Date.now();
      this.consecutiveFailures = 0;
      this.reflectInBackground(bot, 'stall', `身体を使う行動が${STALL_FAILURES}回続けて失敗した（最後: ${action.tool} ${outcome}）`);
    }
  }

  /**
   * Measured combat statistics shared by every run in this scope. With learning
   * off, the fight-or-flee estimate falls back to the human priors in memory.
   */
  encounterMemory(): EncounterMemory {
    if (this.mode === 'off') return this.encounters ??= new EncounterMemory();
    return this.encounters ??= new EncounterMemory({
      load: () => fs.existsSync(this.combatFile) ? JSON.parse(fs.readFileSync(this.combatFile, 'utf8')) as CombatStatsState : seedCombatStats(),
      save: delta => {
        const lock = acquireExclusiveFileLock(`${this.combatFile}.lock`);
        try {
          const base = fs.existsSync(this.combatFile) ? JSON.parse(fs.readFileSync(this.combatFile, 'utf8')) as CombatStatsState : seedCombatStats();
          writeFileAtomically(this.combatFile, JSON.stringify(mergeCombatStats(base, delta), null, 1));
        } finally { fs.closeSync(lock); fs.unlinkSync(`${this.combatFile}.lock`); }
      },
    });
  }

  /**
   * The run is going round in a way the action counts above do not see (the task stopped again and again for
   * the same thing): thought over like any other stall, and no more often.
   */
  stalled(bot: unknown, detail: string): void {
    if (this.mode === 'off' || Date.now() - this.lastStallReflectionAt < STALL_COOLDOWN_MS) return;
    this.lastStallReflectionAt = Date.now();
    this.reflectInBackground(bot, 'stall', detail);
  }

  /** Native decisions worth reflecting on (e.g. a fight-or-flee estimate) join the experience log. */
  note(kind: string, record: Record<string, unknown>, line: string): void {
    if (this.mode === 'off') return;
    this.append({ kind, ...record }, line);
  }

  /** Survival signals straight from the bot: damage bursts, death and its server message. */
  attach(bot: { on(event: string, listener: (...args: any[]) => void): unknown; health?: number; username?: string }): void {
    if (this.mode === 'off') return;
    bot.on('health', () => {
      const health = bot.health ?? null;
      if (health !== null && this.lastHealth !== null && health < this.lastHealth) {
        this.damageSince ??= Date.now();
        this.damageTotal += this.lastHealth - health;
        if (Date.now() - this.damageSince >= 2000) this.flushDamage(bot);
      }
      this.lastHealth = health;
    });
    bot.on('minebotToolBroke', (entry: { name: string }) => {
      const features = this.features(bot);
      this.append({ kind: 'tool_broke', name: entry.name, situation: features }, `道具が壊れた: ${entry.name} | ${situationSummary(features)}`);
    });
    bot.on('messagestr', (message: string) => {
      if (!bot.username || !message.startsWith(`${bot.username} `)) return;
      const advancement = /has (?:made the advancement|completed the challenge|reached the goal) \[(.+)\]/.exec(message);
      if (advancement) {
        this.lastProgressAt = Date.now();
        this.lastMilestone = { name: advancement[1], at: this.lastProgressAt };
        const situation = this.lastFeatures ? situationSummary(this.lastFeatures) : '不明';
        this.append({ kind: 'milestone', advancement: advancement[1], situation: this.lastFeatures }, `実績: ${advancement[1]} | ${situation}`);
        this.reflectInBackground(bot, 'milestone', `実績「${advancement[1]}」を得た。ここに至った手順から、次の試行で再現・短縮できる手順（procedure）や判断を導く`, situation);
        return;
      }
      if (!/(was |died|drowned|burned|fell|blew up|suffocated|starved|froze|withered|hit the ground|went up in flames|tried to swim)/.test(message)) return;
      this.flushDamage(bot);
      const situation = this.lastFeatures ? situationSummary(this.lastFeatures) : '不明';
      const motion = describeRecentMotion(recentMotion(bot));
      this.append({ kind: 'death', message, motion, situation: this.lastFeatures }, `死亡: ${message} | ${situation}`);
      this.reflectInBackground(bot, 'death', `死亡メッセージ: ${message}${motion ? `。直前の動き: ${motion}` : ''}`, situation);
    });
  }

  private flushDamage(bot: unknown): void {
    if (!this.damageTotal) return;
    const features = this.features(bot);
    this.append({ kind: 'damage', amount: this.damageTotal, situation: features },
      `被ダメージ -${this.damageTotal.toFixed(1)} | ${situationSummary(features)}`);
    this.damageTotal = 0; this.damageSince = null;
  }

  private reflectInBackground(bot: unknown, trigger: ReflectionTrigger, detail: string, situation?: string): void {
    const work = this.reflect(bot, trigger, detail, situation).catch(error => {
      this.stats.reflectionErrors++;
      log.warn(`振り返りに失敗 (${trigger}): ${String(error)}`);
    }).finally(() => { this.pending.delete(work); });
    this.pending.add(work);
  }

  async reflect(bot: unknown, trigger: ReflectionTrigger, detail: string, situation?: string): Promise<void> {
    if (this.mode === 'off' || !this.options.modelClient) return;
    const features = this.lastFeatures ?? this.features(bot);
    const state = this.readStore();
    const shownIds = new Set(this.events.join('\n').match(/seed-[a-z-]+|k-[0-9a-f-]{8,}/g) ?? []);
    const related = retrieveKnowledge(state.items, features, { limit: 12 }).map(entry => entry.item);
    // A death, a stall or the end of a run may stem from advice followed long
    // before the recent events: offer every item shown this run, and the run's course.
    const longHorizon = trigger !== 'milestone';
    const nowSec = Math.round((Date.now() - this.startedAt) / 1000);
    if (longHorizon && this.trajectory[this.trajectory.length - 1]?.features !== features) this.trajectory.push({ sec: nowSec, features });
    const runShown = longHorizon ? [...this.shownThisRun.entries()].sort((a, b) => b[1].count - a[1].count).map(([id]) => id) : [];
    const byId = new Map(state.items.filter(item => !item.retired).map(item => [item.id, item]));
    const knowledge = [...state.items.filter(item => shownIds.has(item.id) && !item.retired),
      ...runShown.map(id => byId.get(id)).filter((item): item is NonNullable<typeof item> => Boolean(item)), ...related]
      .filter((item, index, list) => list.findIndex(other => other.id === item.id) === index).slice(0, 20);
    const knowledgeNotes = Object.fromEntries([...this.shownThisRun.entries()].map(([id, seen]) =>
      [id, `この試行で${seen.count}回表示（+${Math.round(seen.firstSec / 60)}分〜+${Math.round(seen.lastSec / 60)}分）`]));
    const message = buildReflectionMessage({ trigger, detail, situation: situation ?? situationSummary(features),
      events: this.events.slice(-40), knowledge, knowledgeNotes,
      trajectory: longHorizon ? renderTrajectory(this.trajectory) : undefined });
    const response = await this.options.modelClient.messages.create({
      // Verdicts on up to twenty items plus new lessons do not fit 1500 tokens:
      // one reflection in four came back cut off and was lost, a death's among them (paid run L18).
      model: this.options.model ?? 'gpt-5.6-luna', max_tokens: REFLECTION_MAX_TOKENS,
      system: REFLECTION_SYSTEM_PROMPT, messages: [{ role: 'user', content: message }],
    } as any);
    const text = (response as any).content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('');
    const parsed = parseReflection(text, new Set(knowledge.map(item => item.id)));
    const provenance = `${this.options.runId}:${trigger}:${new Date().toISOString()}`;
    const summary = this.update(current => applyReflection(current, parsed, provenance, new Date().toISOString(), () => `k-${randomUUID()}`));
    this.stats.reflections++;
    this.stats.added += summary.added.length; this.stats.reinforced += summary.reinforced.length;
    this.stats.contradicted += summary.contradicted.length; this.stats.retired += summary.retired.length;
    this.stats.rejected += parsed.rejected.length;
    this.append({ kind: 'reflection', trigger, detail, lessons: parsed.lessons, assessments: parsed.assessments, rejected: parsed.rejected, summary },
      `振り返り(${trigger}): 追加${summary.added.length} 裏付け${summary.reinforced.length} 反証${summary.contradicted.length} 廃止${summary.retired.length} 却下${parsed.rejected.length}`);
    log.info(`🧠 振り返り(${trigger}): 新しい教訓${summary.added.length}件、裏付け${summary.reinforced.length}件、反証${summary.contradicted.length}件`
      + (parsed.lessons.length ? ` — ${parsed.lessons.map(lesson => lesson.advice).join(' / ').slice(0, 300)}` : ''));
    await this.consolidateIfDue();
  }

  /** Merge near-duplicate learned lessons; the model call happens outside the store lock. */
  async consolidateIfDue(): Promise<void> {
    if (this.mode === 'off' || !this.options.modelClient || this.consolidating) return;
    const state = this.readStore();
    const since = state.consolidatedAt ?? '';
    const active = state.items.filter(item => !item.retired && item.source === 'reflection');
    if (active.filter(item => item.createdAt > since).length < CONSOLIDATE_AFTER_NEW_LESSONS) return;
    this.consolidating = true;
    try {
      const response = await this.options.modelClient.messages.create({
        model: this.options.model ?? 'gpt-5.6-luna', max_tokens: REFLECTION_MAX_TOKENS,
        system: CONSOLIDATION_SYSTEM_PROMPT, messages: [{ role: 'user', content: buildConsolidationMessage(active) }],
      } as any);
      const text = (response as any).content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('');
      const start = text.indexOf('{'); const end = text.lastIndexOf('}');
      const merges = start >= 0 && end > start ? (JSON.parse(text.slice(start, end + 1)).merges ?? []) : [];
      const provenance = `${this.options.runId}:consolidation:${new Date().toISOString()}`;
      const result = this.update(current => {
        const applied = applyConsolidation(current, Array.isArray(merges) ? merges : [], provenance, new Date().toISOString(), () => `k-${randomUUID()}`);
        current.consolidatedAt = new Date().toISOString();
        return applied;
      });
      this.stats.consolidations++;
      this.stats.merged += result.merged.reduce((sum, entry) => sum + entry.from.length, 0);
      this.append({ kind: 'consolidation', merged: result.merged, rejected: result.rejected },
        `記憶の統合: ${result.merged.length}グループ（元${result.merged.reduce((sum, entry) => sum + entry.from.length, 0)}件）、却下${result.rejected.length}`);
      log.info(`🧠 記憶の統合: ${result.merged.length}グループをまとめた（元${result.merged.reduce((sum, entry) => sum + entry.from.length, 0)}件）`);
    } finally { this.consolidating = false; }
  }

  /** Wait for in-flight reflections, bounded, before the process exits. */
  async flush(timeoutMs = 60_000): Promise<void> {
    try { this.encounters?.flush(); } catch (error) { log.warn(`戦闘統計の保存に失敗: ${String(error)}`); }
    if (!this.pending.size) { if (this.mode !== 'off' && this.shown.size) this.update(state => state); return; }
    await Promise.race([Promise.allSettled([...this.pending]), new Promise(resolve => setTimeout(resolve, timeoutMs))]);
    if (this.mode !== 'off') this.update(state => state);
  }

  summary(): Record<string, unknown> {
    if (this.mode === 'off') return { mode: 'off' };
    const state = this.readStore();
    const active = state.items.filter(item => !item.retired);
    return { mode: this.mode, scope: this.options.scope, ...this.stats,
      activeItems: active.length, learnedItems: active.filter(item => item.source === 'reflection').length,
      retiredItems: state.items.length - active.length };
  }
}
