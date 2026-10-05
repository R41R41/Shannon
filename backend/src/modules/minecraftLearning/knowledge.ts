import type { SituationFeatures, TimeBand, DepthBand } from './situation.js';

/**
 * A dev-only memory scope for general Minecraft knowledge learned across
 * isolated worlds. It holds lessons and procedures, never world facts
 * (coordinates, structures, people), so it is independent of the RF-03
 * server/world/dimension scopes and is not readable from other channels.
 */
export interface MinecraftKnowledgeScope {
  readonly version: 1;
  readonly kind: 'minecraft-general';
  readonly namespace: string;
}

export function minecraftKnowledgeScope(namespace: string): MinecraftKnowledgeScope {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(namespace)) throw new Error('MINECRAFT_KNOWLEDGE_NAMESPACE_INVALID');
  return Object.freeze({ version: 1, kind: 'minecraft-general', namespace });
}

/** When a lesson applies. Every given field must hold; omitted fields match anything. */
export interface KnowledgeConditions {
  dimensions?: string[];
  timeBands?: TimeBand[];
  depthBands?: DepthBand[];
  inWater?: boolean;
  emergency?: boolean;
  minHealth?: number; maxHealth?: number;
  minFood?: number; maxFood?: number;
  /** Any of these hostile kinds within 16m. */
  threatsAny?: string[];
  /** Any hostile at all within 16m. */
  threatsPresent?: boolean;
  /** Any of these non-hostile kinds (animals, villagers) within 24m. */
  othersAny?: string[];
  /** Any of these kinds of notable place in view (e.g. village). */
  landmarksAny?: string[];
  /** Any of these items carried. An entry `*_bed` stands for every item whose name ends so (sixteen colours of bed). */
  carryingAny?: string[];
  /** None of these items carried (same patterns): what the body has yet to make. */
  carryingNone?: string[];
  /** Relevant when the planner considers or just used one of these tools. */
  tools?: string[];
}

export type KnowledgeKind = 'avoid' | 'prefer' | 'procedure' | 'fact';
export type KnowledgeSource = 'human-seed' | 'reflection';

export interface KnowledgeItem {
  id: string;
  kind: KnowledgeKind;
  /** Situation in words, e.g. "夜の地上で敵が複数いる". */
  situation: string;
  /** What to do or avoid, with the reason. */
  advice: string;
  conditions: KnowledgeConditions;
  source: KnowledgeSource;
  /** Run/event references that produced or tested this item. */
  provenance: string[];
  support: number;
  contradict: number;
  uses: number;
  createdAt: string;
  updatedAt: string;
  retired?: boolean;
  /** Set when consolidation folded this item into a more general one. */
  mergedInto?: string;
  /** A merge product retired when its sources were restored (see restoreMergedLessons). */
  unmerged?: boolean;
  /**
   * The verdict each run gave this item. A run is one unit of evidence: it
   * reflects several times (each advancement, a stall, its end), and counting
   * every reflection let an item that was merely displayed all run collect
   * dozens of confirmations from a single run.
   */
  evidence?: Record<string, EvidenceVerdict>;
}

export type EvidenceVerdict = 'supported' | 'contradicted';
const EVIDENCE_RUNS_KEPT = 64;

/** The run a provenance entry (`${runId}:${trigger}:${time}`) belongs to. */
export function provenanceRun(provenance: string): string { return provenance.split(':')[0]; }

/**
 * Record one run's verdict on an item; returns whether the counts changed.
 * A run counts once. A failure later in the same run (a death after a
 * milestone) overrides an earlier confirmation, never the reverse.
 */
export function creditEvidence(item: KnowledgeItem, run: string, verdict: EvidenceVerdict): boolean {
  const evidence = item.evidence ??= {};
  const previous = evidence[run];
  if (previous === verdict || (previous === 'contradicted' && verdict === 'supported')) return false;
  if (previous === 'supported') item.support = Math.max(0, item.support - 1);
  if (verdict === 'supported') item.support++; else item.contradict++;
  delete evidence[run];
  evidence[run] = verdict;
  const runs = Object.keys(evidence);
  for (const old of runs.slice(0, Math.max(0, runs.length - EVIDENCE_RUNS_KEPT))) delete evidence[old];
  return true;
}

/**
 * Re-base counts recorded before evidence was kept per run: no item can have
 * more confirmations or contradictions than the distinct runs that touched it.
 * Returns the ids it lowered.
 */
export function recountLegacyEvidence(state: KnowledgeStoreState): string[] {
  const lowered: string[] = [];
  for (const item of state.items) {
    if (item.evidence) continue;
    const runs = new Set(item.provenance.filter(entry => entry.includes(':') && !entry.includes(':consolidation:')).map(provenanceRun));
    const support = Math.min(item.support, Math.max(item.source === 'human-seed' ? 0 : 1, runs.size));
    const contradict = Math.min(item.contradict, runs.size);
    if (support !== item.support || contradict !== item.contradict) lowered.push(item.id);
    item.support = support; item.contradict = contradict; item.evidence = {};
  }
  return lowered;
}

export interface KnowledgeStoreState {
  scope: MinecraftKnowledgeScope;
  items: KnowledgeItem[];
  /** When near-duplicate lessons were last merged. */
  consolidatedAt?: string;
}

export const MAX_ACTIVE_ITEMS = 200;
/** A coordinate triple or an X/Z position is a world fact; a Y level alone is general (generation depth). */
const COORDINATE = /-?\d{1,6}\s*[,，]\s*-?\d{1,4}\s*[,，]\s*-?\d{1,6}|\b[xz]\s*[=:]\s*-?\d/i;

/** Laplace-smoothed share of confirming observations; seeds start at 0.5. */
export function confidence(item: Pick<KnowledgeItem, 'support' | 'contradict'>): number {
  return (item.support + 1) / (item.support + item.contradict + 2);
}

/** General knowledge only: no coordinates, no URLs, bounded length. */
export function assertGeneralKnowledgeText(text: string): void {
  if (typeof text !== 'string' || !text.trim() || text.length > 400) throw new Error('MINECRAFT_KNOWLEDGE_TEXT_INVALID');
  if (COORDINATE.test(text)) throw new Error('MINECRAFT_KNOWLEDGE_HAS_COORDINATES');
  if (/https?:\/\//i.test(text)) throw new Error('MINECRAFT_KNOWLEDGE_HAS_URL');
}

const ARRAY_FIELDS = ['dimensions', 'timeBands', 'depthBands', 'threatsAny', 'othersAny', 'landmarksAny', 'carryingAny', 'carryingNone', 'tools'] as const;
const NUMBER_FIELDS = ['minHealth', 'maxHealth', 'minFood', 'maxFood'] as const;
const BOOLEAN_FIELDS = ['inWater', 'emergency', 'threatsPresent'] as const;

export function sanitizeConditions(value: unknown): KnowledgeConditions {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const conditions: KnowledgeConditions = {};
  for (const field of ARRAY_FIELDS) {
    const list = input[field];
    if (Array.isArray(list)) {
      const clean = list.filter((entry): entry is string => typeof entry === 'string' && /^[a-z0-9_:-]{1,40}$/.test(entry)).slice(0, 12);
      if (clean.length) (conditions as Record<string, unknown>)[field] = clean;
    }
  }
  for (const field of NUMBER_FIELDS) {
    const number = input[field];
    if (typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 20) conditions[field] = number;
  }
  for (const field of BOOLEAN_FIELDS) if (typeof input[field] === 'boolean') conditions[field] = input[field] as boolean;
  return conditions;
}

export function conditionsMatch(conditions: KnowledgeConditions, features: SituationFeatures, tools: string[] = []): boolean {
  const near = features.threats.filter(threat => threat.distance <= 16);
  if (conditions.dimensions && !conditions.dimensions.some(d => features.dimension?.includes(d))) return false;
  if (conditions.timeBands && !conditions.timeBands.includes(features.timeBand)) return false;
  if (conditions.depthBands && !conditions.depthBands.includes(features.depthBand)) return false;
  if (conditions.inWater !== undefined && conditions.inWater !== features.inWater) return false;
  if (conditions.emergency !== undefined && conditions.emergency !== features.emergency) return false;
  if (conditions.minHealth !== undefined && !(features.health !== null && features.health >= conditions.minHealth)) return false;
  if (conditions.maxHealth !== undefined && !(features.health !== null && features.health <= conditions.maxHealth)) return false;
  if (conditions.minFood !== undefined && !(features.food !== null && features.food >= conditions.minFood)) return false;
  if (conditions.maxFood !== undefined && !(features.food !== null && features.food <= conditions.maxFood)) return false;
  if (conditions.threatsPresent !== undefined && conditions.threatsPresent !== (near.length > 0)) return false;
  if (conditions.threatsAny && !near.some(threat => conditions.threatsAny!.includes(threat.name))) return false;
  if (conditions.othersAny && !conditions.othersAny.some(kind => features.others.includes(kind))) return false;
  if (conditions.landmarksAny && !conditions.landmarksAny.some(kind => features.landmarks?.includes(kind))) return false;
  const carries = (item: string) => item.startsWith('*')
    ? Object.entries(features.inventory).some(([name, count]) => name.endsWith(item.slice(1)) && count > 0)
    : (features.inventory[item] ?? 0) > 0;
  if (conditions.carryingAny && !conditions.carryingAny.some(carries)) return false;
  if (conditions.carryingNone && conditions.carryingNone.some(carries)) return false;
  if (conditions.tools && !conditions.tools.some(tool => tools.includes(tool))) return false;
  return true;
}

/** Number of constrained fields: a lesson that names its situation precisely outranks a vague one. */
function specificity(conditions: KnowledgeConditions): number {
  return Object.keys(conditions).length;
}

export interface RetrievedKnowledge { item: KnowledgeItem; score: number; confidence: number }

/** Places kept for matching knowledge that has had the least chance to be tried. */
const UNTRIED_SLOTS = 2;
/**
 * Places kept for what a person taught that matches the situation. Ranked by score alone, taught advice with two
 * conditions sat under self-taught lessons with five or six: "at night go on mining underground" ranked 18th of 25 at
 * night on the surface, never reached the planner, and the lesson ranked first said to build a shelter and wait for
 * morning (reinforced each night survived), so nights were sat out (paid runs L101-L103).
 */
const TAUGHT_SLOTS = 3;
/** How many of the lessons that match almost everywhere are shown at once. */
const MAX_ALWAYS_ON = 3;

/**
 * The best-scoring knowledge for the situation, with a few places kept for
 * what has been tested least. Ranked by score alone, anything new sat below
 * a dozen established lessons and was never shown, so it could never gather
 * the evidence to rise or be retired: advice a human had just taught ranked
 * 11th of 12 and would not have reached the planner at all.
 */
export function retrieveKnowledge(items: KnowledgeItem[], features: SituationFeatures,
  options: { tools?: string[]; limit?: number; alwaysOn?: ReadonlySet<string>; maxAlwaysOn?: number } = {}): RetrievedKnowledge[] {
  let general = 0;
  const ranked = items
    .filter(item => !item.retired && conditionsMatch(item.conditions, features, options.tools))
    .map(item => {
      const c = confidence(item);
      return { item, confidence: c, score: c * (1 + 0.25 * specificity(item.conditions)) + Math.min(item.support, 10) * 0.02 };
    })
    .sort((a, b) => b.score - a.score)
    // What matches nearly every situation is a general principle, not a
    // recollection of this one: a few of the best are enough, the rest of
    // the places go to what this situation in particular calls up.
    .filter(entry => !options.alwaysOn?.has(entry.item.id) || ++general <= (options.maxAlwaysOn ?? MAX_ALWAYS_ON));
  const limit = options.limit ?? 8;
  if (ranked.length <= limit || limit <= UNTRIED_SLOTS) return ranked.slice(0, limit);
  // Only taught advice experience has not turned against: one contradicted more often than confirmed competes on its
  // score like any lesson.
  const taught = ranked.filter(entry => entry.item.source === 'human-seed' && entry.confidence >= 0.5).slice(0, Math.min(TAUGHT_SLOTS, limit - UNTRIED_SLOTS));
  if (taught.length) {
    const rest = ranked.filter(entry => !taught.includes(entry));
    const others = retrieveFrom(rest, limit - taught.length);
    return [...taught, ...others];
  }
  return retrieveFrom(ranked, limit);
}

/** The best of `ranked` up to `limit`, with places kept for what has been tried least. */
function retrieveFrom(ranked: RetrievedKnowledge[], limit: number): RetrievedKnowledge[] {
  if (ranked.length <= limit || limit <= UNTRIED_SLOTS) return ranked.slice(0, limit);
  const tested = (entry: RetrievedKnowledge) => entry.item.support + entry.item.contradict;
  const untried = ranked.slice(limit - UNTRIED_SLOTS)
    .sort((a, b) => tested(a) - tested(b) || a.item.uses - b.item.uses || b.score - a.score)
    .slice(0, UNTRIED_SLOTS);
  return [...ranked.slice(0, limit - UNTRIED_SLOTS), ...untried];
}

export function renderKnowledge(retrieved: RetrievedKnowledge[]): string {
  return retrieved.map(({ item, confidence: c }) =>
    `- [${item.id}] (${item.kind}, 確信度${Math.round(c * 100)}%, 確認${item.support}/反例${item.contradict}, 出典${item.source === 'human-seed' ? '人間の初期知識' : '自分の経験'}) ${item.situation} → ${item.advice}`,
  ).join('\n');
}

export interface ReflectionLesson {
  kind: KnowledgeKind;
  situation: string;
  advice: string;
  conditions: KnowledgeConditions;
}
export interface ReflectionAssessment { id: string; verdict: 'supported' | 'contradicted' | 'irrelevant'; reason?: string }
export interface ReflectionResult { lessons: ReflectionLesson[]; assessments: ReflectionAssessment[] }

function normalized(text: string): string {
  return text.replace(/[\s、。,.!！?？「」『』（）()]/g, '').toLowerCase();
}

/**
 * Fold one reflection into the store. Assessments move existing confidence;
 * a new lesson whose advice duplicates an active one reinforces it instead of
 * adding a copy. Items contradicted more than confirmed (with enough
 * evidence) retire; the store keeps the best MAX_ACTIVE_ITEMS active.
 */
export function applyReflection(state: KnowledgeStoreState, result: ReflectionResult, provenance: string,
  now: string, newId: () => string): { added: string[]; reinforced: string[]; contradicted: string[]; retired: string[] } {
  const summary = { added: [] as string[], reinforced: [] as string[], contradicted: [] as string[], retired: [] as string[] };
  const byId = new Map(state.items.map(item => [item.id, item]));
  const run = provenanceRun(provenance);
  for (const assessment of result.assessments) {
    const item = byId.get(assessment.id);
    if (!item || item.retired || assessment.verdict === 'irrelevant') continue;
    if (!creditEvidence(item, run, assessment.verdict)) continue;
    (assessment.verdict === 'supported' ? summary.reinforced : summary.contradicted).push(item.id);
    item.provenance = [...item.provenance, provenance].slice(-20);
    item.updatedAt = now;
  }
  for (const lesson of result.lessons) {
    assertGeneralKnowledgeText(lesson.situation);
    assertGeneralKnowledgeText(lesson.advice);
    const key = normalized(lesson.advice);
    const duplicate = state.items.find(item => !item.retired && normalized(item.advice) === key);
    if (duplicate) {
      if (creditEvidence(duplicate, run, 'supported')) summary.reinforced.push(duplicate.id);
      duplicate.updatedAt = now;
      continue;
    }
    const item: KnowledgeItem = { id: newId(), kind: lesson.kind, situation: lesson.situation.trim(), advice: lesson.advice.trim(),
      conditions: sanitizeConditions(lesson.conditions), source: 'reflection', provenance: [provenance],
      support: 1, contradict: 0, uses: 0, createdAt: now, updatedAt: now, evidence: { [run]: 'supported' } };
    state.items.push(item);
    summary.added.push(item.id);
  }
  for (const item of state.items) {
    if (!item.retired && item.contradict >= 3 && confidence(item) < 0.35) { item.retired = true; item.updatedAt = now; summary.retired.push(item.id); }
  }
  // What a human taught leaves only on evidence against it, never for lack of room:
  // an untested prior scores below every lesson with one confirmation.
  const active = state.items.filter(item => !item.retired)
    .sort((a, b) => Number(b.source === 'human-seed') - Number(a.source === 'human-seed')
      || confidence(b) - confidence(a) || b.updatedAt.localeCompare(a.updatedAt));
  for (const item of active.slice(MAX_ACTIVE_ITEMS)) { item.retired = true; item.updatedAt = now; summary.retired.push(item.id); }
  return summary;
}
