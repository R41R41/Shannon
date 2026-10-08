import type {
  CriticAssessment,
  CriticInput,
  ExecutionCritic,
  FailureCause,
  NextControl,
  ProgressState,
} from './types.js';
import {
  OpenAIStructuredDecisionGateway,
  openAIReasoningEffort,
} from './OpenAIStructuredDecisionGateway.js';
import { parseChoiceAnswer, receiptOutcome, supportsControl } from './decisionEvidence.js';
import { budgetedMinecraftFetch } from './MinecraftModelBudget.js';
import { AnthropicStructuredDecisionGateway, type AnthropicStructuredDecisionGatewayOptions } from './AnthropicStructuredDecisionGateway.js';

const PROGRESS_STATES = ['ON_TRACK', 'UNCERTAIN', 'STALLED', 'REGRESSING', 'COMPLETED_UNVERIFIED'] as const;
const FAILURE_CAUSES = [
  'NONE', 'BLOCKED_PATH', 'MISSING_RESOURCE', 'WRONG_ASSUMPTION', 'REPEATED_FAILURE',
  'WORLD_CHANGED', 'CAPABILITY_GAP', 'UNSAFE', 'UNKNOWN',
] as const;
const NEXT_CONTROLS = ['CONTINUE', 'OBSERVE', 'RETRY_ONCE', 'SWITCH_SUBTASK', 'REPLAN', 'ABORT_UNSAFE'] as const;
const CONFIDENCE_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;

export interface JevExecutionCriticOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  timeoutMilliseconds?: number;
  fetcher?: typeof fetch;
  nowMilliseconds?: () => number;
  idFactory?: () => string;
}

export interface OpenAIExecutionCriticOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  reasoningEffort?: 'none' | 'low' | 'medium';
  timeoutMilliseconds?: number;
  fetcher?: typeof fetch;
  nowMilliseconds?: () => number;
  idFactory?: () => string;
}

export class JevExecutionCritic implements ExecutionCritic {
  readonly source = 'jev' as const;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMilliseconds: number;
  private readonly fetcher: typeof fetch;
  private readonly nowMilliseconds: () => number;
  private readonly idFactory: () => string;

  constructor(private readonly options: JevExecutionCriticOptions) {
    if (!options.apiKey.trim()) throw new Error('TYPESAFE_API_KEY is required');
    this.endpoint = options.endpoint ?? 'https://api.typesafe.ai/v1/systemone';
    this.model = options.model ?? 'jev-latest';
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 900;
    this.fetcher = options.fetcher ?? budgetedMinecraftFetch;
    this.nowMilliseconds = options.nowMilliseconds ?? Date.now;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  async assess(input: CriticInput): Promise<CriticAssessment> {
    const startedAt = this.nowMilliseconds();
    try {
      const response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          state: compactCriticState(input),
          questions: criticQuestions,
        }),
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      });
      const value = await response.json() as unknown;
      if (!response.ok) throw new Error(`JEV_RESPONSE_${response.status}`);
      return parseAssessment(value, input, this.nowMilliseconds() - startedAt, this.idFactory);
    } catch {
      return fallbackAssessment(input, this.nowMilliseconds() - startedAt, this.idFactory);
    }
  }
}

export class OpenAIExecutionCritic implements ExecutionCritic {
  readonly source = 'openai' as const;
  private readonly gateway: OpenAIStructuredDecisionGateway;
  private readonly nowMilliseconds: () => number;
  private readonly idFactory: () => string;

  constructor(options: OpenAIExecutionCriticOptions) {
    this.gateway = new OpenAIStructuredDecisionGateway(options);
    this.nowMilliseconds = options.nowMilliseconds ?? Date.now;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  async assess(input: CriticInput): Promise<CriticAssessment> {
    const startedAt = this.nowMilliseconds();
    try {
      const value = await this.gateway.decide<OpenAICriticOutput>({
        instructions: criticInstructions,
        state: compactCriticState(input),
        schemaName: 'minecraft_execution_critic',
        schema: openAICriticSchema,
      });
      return parseOpenAIAssessment(value, input, this.nowMilliseconds() - startedAt, this.idFactory);
    } catch {
      return fallbackAssessment(input, this.nowMilliseconds() - startedAt, this.idFactory);
    }
  }
}

export interface AnthropicExecutionCriticOptions extends AnthropicStructuredDecisionGatewayOptions {
  nowMilliseconds?: () => number;
  idFactory?: () => string;
}
export class AnthropicExecutionCritic implements ExecutionCritic {
  readonly source = 'anthropic' as const;
  private readonly gateway: AnthropicStructuredDecisionGateway;
  private readonly nowMilliseconds: () => number;
  private readonly idFactory: () => string;
  constructor(options: AnthropicExecutionCriticOptions) {
    this.gateway = new AnthropicStructuredDecisionGateway(options);
    this.nowMilliseconds = options.nowMilliseconds ?? Date.now;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }
  async assess(input: CriticInput): Promise<CriticAssessment> {
    const startedAt = this.nowMilliseconds();
    try {
      const value = await this.gateway.decide<OpenAICriticOutput>({
        instructions: criticInstructions, state: compactCriticState(input),
        schemaName: 'minecraft_execution_critic', schema: openAICriticSchema,
      });
      return parseOpenAIAssessment(value, input, this.nowMilliseconds() - startedAt, this.idFactory, 'anthropic');
    } catch {
      return fallbackAssessment(input, this.nowMilliseconds() - startedAt, this.idFactory);
    }
  }
}

export class LocalExecutionCritic implements ExecutionCritic {
  readonly source = 'fallback' as const;
  constructor(
    private readonly nowMilliseconds: () => number = Date.now,
    private readonly idFactory: () => string = () => crypto.randomUUID(),
  ) {}

  async assess(input: CriticInput): Promise<CriticAssessment> {
    const startedAt = this.nowMilliseconds();
    return fallbackAssessment(input, this.nowMilliseconds() - startedAt, this.idFactory);
  }
}

export function createConfiguredExecutionCritic(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  anthropic?: AnthropicExecutionCriticOptions,
): ExecutionCritic {
  const provider = configuredProvider(environment);
  const jevApiKey = environment.TYPESAFE_API_KEY?.trim();
  const openAIApiKey = environment.OPENAI_API_KEY?.trim();
  if ((provider === 'auto' || provider === 'jev') && jevApiKey) {
    return new JevExecutionCritic({
      apiKey: jevApiKey,
      endpoint: environment.SHANNON_JEV_ENDPOINT?.trim() || undefined,
      model: environment.SHANNON_JEV_MODEL?.trim() || 'jev-latest',
      timeoutMilliseconds: positiveInteger(environment.SHANNON_JEV_TIMEOUT_MS) ?? 900,
    });
  }
  if (provider === 'auto' && anthropic?.model === 'claude-haiku-5-5') {
    return anthropic.apiKey.trim() ? new AnthropicExecutionCritic(anthropic) : new LocalExecutionCritic();
  }
  if ((provider === 'auto' || provider === 'openai') && openAIApiKey) {
    return new OpenAIExecutionCritic({
      apiKey: openAIApiKey,
      endpoint: environment.MINECRAFT_OPENAI_ENDPOINT?.trim() || undefined,
      model: environment.MINECRAFT_OPENAI_MODEL?.trim() || 'gpt-5.6-luna',
      reasoningEffort: openAIReasoningEffort(environment.MINECRAFT_OPENAI_REASONING_EFFORT),
      timeoutMilliseconds: positiveInteger(environment.MINECRAFT_OPENAI_TIMEOUT_MS) ?? 2_500,
    });
  }
  return new LocalExecutionCritic();
}

export function formatCriticFeedback(assessment: CriticAssessment): string | null {
  if (assessment.source === 'fallback' || assessment.stale || !Number.isFinite(assessment.confidence) || assessment.confidence < 0.66 || !supportsControl(assessment.decisionEvidence)) return null;
  if (assessment.nextControl === 'CONTINUE') return null;
  return [
    `【Fast Execution Critic (${assessment.source}) / 独立実行評価】`,
    `進捗=${assessment.progressState}`,
    `原因=${assessment.failureCause}`,
    `推奨制御=${assessment.nextControl}`,
    `再観測=${assessment.needsObservationProbability.toFixed(2)}`,
    `再計画=${assessment.needsReplanProbability.toFixed(2)}`,
    'この評価を観測として扱い、現在の世界状態を確認してから次の行動を選んでください。',
  ].join(' ');
}

const criticQuestions = {
  progress_state: {
    type: 'choice',
    instructions: 'Judge real progress from live activeAction evidence, receipts and world deltas. Normal smelting or confirmed game-mechanic waiting is not a stall; phase timers alone are not proof of failure.',
    criteria: {
      ON_TRACK: 'Recent actions produced evidence consistent with the goal.',
      UNCERTAIN: 'There is not enough observation to verify progress.',
      STALLED: 'Actions are not advancing the goal.',
      REGRESSING: 'The world state is moving away from the goal or becoming less safe.',
      COMPLETED_UNVERIFIED: 'The agent claims or appears to be done, but success has not been independently verified.',
    },
  },
  continue_now: {
    type: 'noul',
    instructions: 'Should the current action continue without intervention? Judge active_action and observed receipts. A running furnace legitimately holds resources not yet in inventory; normal verified smelting is not a missing prerequisite.',
    criteria: { true: 'The current plan remains appropriate.', false: 'Continuing unchanged risks waste or failure.' },
  },
  needs_observation: {
    type: 'noul',
    instructions: 'Is a fresh Minecraft observation needed before another consequential action?',
    criteria: { true: 'The evidence is stale, incomplete, or contradictory.', false: 'The evidence is sufficient.' },
  },
  needs_replan: {
    type: 'noul',
    instructions: 'Does the goal/subtask plan need to change rather than merely retrying the same action? Missing final products while their verified prerequisite is still running do not alone require replanning.',
    criteria: { true: 'A different route, prerequisite, or subtask is needed.', false: 'The current plan is still viable.' },
  },
  failure_cause: {
    type: 'choice',
    instructions: 'Select the dominant CURRENT cause supported by evidence. If current health/oxygen plus threats make continuing immediately unsafe, choose UNSAFE even when an earlier receipt has no_path. NONE means no current blocker. MISSING_RESOURCE means a prerequisite actually blocks the current action, not input items already observed inside a working furnace or final products that are still being made. Use UNKNOWN for insufficient evidence.',
    criteria: Object.fromEntries(FAILURE_CAUSES.map(value => [value, value.replaceAll('_', ' ').toLowerCase()])),
  },
  next_control: {
    type: 'choice',
    instructions: 'Choose from the live evidence only. Healthy verified external work (including burning fuel already consumed by a furnace) and pending_external receipts are not failures. CONTINUE while progress is supported. OBSERVE for missing/contradictory evidence. REPLAN or SWITCH_SUBTASK only for a demonstrated blocked prerequisite or repeated failure; not merely unfinished products. ABORT_UNSAFE takes priority when the current live health/oxygen/threat evidence shows immediate danger. Other questions are independent: do not assume their answers.',
    criteria: {
      CONTINUE: 'Current action is safe and has verified progress or a legitimate active external wait; no demonstrated blocker.',
      OBSERVE: 'Important current facts are missing or inconsistent. Not merely a demonstrated repeated route failure.',
      RETRY_ONCE: 'One recoverable failure, and concrete corrected timing/arguments are already supported. Not repeated unchanged failures.',
      SWITCH_SUBTASK: 'The supplied plan identifies a specific unblocked ready sibling/prerequisite to switch to. Do not invent a sibling when the plan is empty.',
      REPLAN: 'A demonstrated blocker or repeated failure needs a new route, and no specific ready alternative is supported by the supplied plan.',
      ABORT_UNSAFE: 'Stop because continuing presents an immediate safety risk.',
    },
  },
  confidence: {
    type: 'choice',
    instructions: 'How confident is this assessment given the supplied world frames and receipts?',
    criteria: { LOW: 'Weak or missing evidence.', MEDIUM: 'Useful but incomplete evidence.', HIGH: 'Direct and consistent evidence.' },
  },
} as const;

const criticInstructions = [
  'You are the fast System 1 execution critic for a Minecraft agent.',
  'Judge only from the supplied task, world frames, plan, and action receipts.',
  'Choose a bounded control; do not write prose, Minecraft commands, or new goals.',
  'Treat claimed completion without world evidence as COMPLETED_UNVERIFIED.',
  'Use activeAction evidence while a skill is still running. Normal external work such as smelting is not a stall. Do not infer failure from elapsed time alone.',
].join(' ');

const openAICriticSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    progress_state: { type: 'string', enum: PROGRESS_STATES },
    continue_probability: { type: 'number', minimum: 0, maximum: 1 },
    needs_observation_probability: { type: 'number', minimum: 0, maximum: 1 },
    needs_replan_probability: { type: 'number', minimum: 0, maximum: 1 },
    failure_cause: { type: 'string', enum: FAILURE_CAUSES },
    next_control: { type: 'string', enum: NEXT_CONTROLS },
    confidence: { type: 'string', enum: CONFIDENCE_LEVELS },
  },
  required: [
    'progress_state', 'continue_probability', 'needs_observation_probability',
    'needs_replan_probability', 'failure_cause', 'next_control', 'confidence',
  ],
} as const;

interface OpenAICriticOutput {
  progress_state: string;
  continue_probability: number;
  needs_observation_probability: number;
  needs_replan_probability: number;
  failure_cause: string;
  next_control: string;
  confidence: string;
}

function compactCriticState(input: CriticInput): Record<string, unknown> {
  return {
    run_id: input.runId,
    goal: input.goal.slice(0, 2_000),
    evaluated_world_revision: input.evaluatedRevision,
    plan: input.plan,
    previous_world: input.previousWorld,
    current_world: input.currentWorld,
    // Phase summaries are useful; raw per-tick traces are not model context.
    recent_action_receipts: input.recentReceipts.map(({ execution, ...receipt }) => ({ ...receipt, outcome: receiptOutcome(receipt),
      ...(receiptOutcome(receipt) === 'pending_external' ? { success: null, failureType: null } : {}),
      execution: execution ? { actionId: execution.actionId, queueMs: execution.queueMs,
        phaseMs: execution.phaseMs, quiescent: execution.quiescent } : undefined })),
    active_action: input.activeAction ?? null,
    previous_assessment: input.previousAssessment,
  };
}

function parseAssessment(
  value: unknown,
  input: CriticInput,
  elapsedMilliseconds: number,
  idFactory: () => string,
): CriticAssessment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JEV_RESPONSE_INVALID');
  const answers = (value as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('JEV_RESPONSE_INVALID');
  const answerMap = answers as Record<string, unknown>;
  choiceValue(answerMap.confidence, CONFIDENCE_LEVELS); // diagnostic only; never a control probability
  const control = parseChoiceAnswer(answerMap.next_control, NEXT_CONTROLS);
  return {
    id: idFactory(),
    runId: input.runId,
    evaluatedRevision: input.evaluatedRevision,
    receivedAt: new Date().toISOString(),
    elapsedMilliseconds: Math.max(0, Math.round(elapsedMilliseconds)),
    source: 'jev',
    stale: false,
    progressState: choiceValue(answerMap.progress_state, PROGRESS_STATES),
    continueProbability: noulValue(answerMap.continue_now),
    needsObservationProbability: noulValue(answerMap.needs_observation),
    needsReplanProbability: noulValue(answerMap.needs_replan),
    failureCause: choiceValue(answerMap.failure_cause, FAILURE_CAUSES),
    nextControl: control.choice,
    confidence: control.providerConfidence,
    confidenceKind: 'provider_distribution',
    decisionEvidence: control,
  };
}

function parseOpenAIAssessment(
  value: OpenAICriticOutput,
  input: CriticInput,
  elapsedMilliseconds: number,
  idFactory: () => string,
  source: 'openai' | 'anthropic' = 'openai',
): CriticAssessment {
  const confidenceLevel = directChoiceValue(value.confidence, CONFIDENCE_LEVELS);
  return {
    id: idFactory(),
    runId: input.runId,
    evaluatedRevision: input.evaluatedRevision,
    receivedAt: new Date().toISOString(),
    elapsedMilliseconds: Math.max(0, Math.round(elapsedMilliseconds)),
    source,
    confidenceKind: 'self_reported',
    stale: false,
    progressState: directChoiceValue(value.progress_state, PROGRESS_STATES),
    continueProbability: directProbability(value.continue_probability),
    needsObservationProbability: directProbability(value.needs_observation_probability),
    needsReplanProbability: directProbability(value.needs_replan_probability),
    failureCause: directChoiceValue(value.failure_cause, FAILURE_CAUSES),
    nextControl: directChoiceValue(value.next_control, NEXT_CONTROLS),
    confidence: confidenceLevel === 'HIGH' ? 0.9 : confidenceLevel === 'MEDIUM' ? 0.66 : 0.33,
  };
}

function fallbackAssessment(
  input: CriticInput,
  elapsedMilliseconds: number,
  idFactory: () => string,
): CriticAssessment {
  const recent = input.recentReceipts.filter(receipt => receipt.meaningfulWorldAction).slice(-3);
  const failures = recent.filter(receipt => receiptOutcome(receipt) === 'failed');
  const repeatedCapability = failures.length >= 2
    && new Set(failures.map(receipt => receipt.capability)).size === 1;
  const progressState: ProgressState = failures.length >= 2 ? 'STALLED' : 'UNCERTAIN';
  const failureCause: FailureCause = repeatedCapability ? 'REPEATED_FAILURE' : failures.length > 0 ? 'UNKNOWN' : 'NONE';
  const nextControl: NextControl = repeatedCapability ? 'OBSERVE' : 'CONTINUE';
  return {
    id: idFactory(),
    runId: input.runId,
    evaluatedRevision: input.evaluatedRevision,
    receivedAt: new Date().toISOString(),
    elapsedMilliseconds: Math.max(0, Math.round(elapsedMilliseconds)),
    source: 'fallback',
    confidenceKind: 'fallback',
    stale: false,
    progressState,
    continueProbability: repeatedCapability ? 0.2 : 0.7,
    needsObservationProbability: repeatedCapability ? 0.9 : 0.3,
    needsReplanProbability: repeatedCapability ? 0.6 : 0.2,
    failureCause,
    nextControl,
    confidence: failures.length > 0 ? 0.5 : 0.25,
  };
}

function noulValue(value: unknown): number {
  if (!value || typeof value !== 'object') throw new Error('JEV_RESPONSE_INVALID');
  const probability = (value as { noul?: unknown }).noul;
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error('JEV_RESPONSE_INVALID');
  }
  return probability;
}

function choiceValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (!value || typeof value !== 'object') throw new Error('JEV_RESPONSE_INVALID');
  const choice = (value as { choice?: unknown }).choice;
  if (typeof choice !== 'string' || !allowed.includes(choice)) throw new Error('JEV_RESPONSE_INVALID');
  return choice as T[number];
}

function directProbability(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('OPENAI_RESPONSE_INVALID');
  }
  return value;
}

function directChoiceValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error('OPENAI_RESPONSE_INVALID');
  return value as T[number];
}

function configuredProvider(environment: Readonly<Record<string, string | undefined>>): 'auto' | 'jev' | 'openai' | 'local' {
  const value = environment.MINECRAFT_COGNITION_PROVIDER?.trim().toLowerCase();
  return value === 'jev' || value === 'openai' || value === 'local' ? value : 'auto';
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
