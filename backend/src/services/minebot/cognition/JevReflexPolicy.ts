import type {
  ReflexAction,
  ReflexDecision,
  ReflexDecisionInput,
  ReflexPolicy,
} from './types.js';
import {
  OpenAIStructuredDecisionGateway,
  openAIReasoningEffort,
} from './OpenAIStructuredDecisionGateway.js';
import { parseChoiceAnswer, supportsControl } from './decisionEvidence.js';
import { budgetedMinecraftFetch } from './MinecraftModelBudget.js';
import { AnthropicStructuredDecisionGateway, type AnthropicStructuredDecisionGatewayOptions } from './AnthropicStructuredDecisionGateway.js';

const REFLEX_ACTIONS = [
  'FLEE', 'EAT', 'SURFACE', 'STOP_MOVEMENT', 'SEEK_SHELTER', 'OBSERVE', 'DELEGATE_SYSTEM2',
] as const;
const URGENCY_LEVELS = ['LOW', 'MEDIUM', 'CRITICAL'] as const;
const CONFIDENCE_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;

export const capabilityForAction: Readonly<Record<ReflexAction, string | null>> = {
  FLEE: 'flee-from',
  EAT: 'auto-eat',
  STOP_MOVEMENT: 'stop-movement',
  SURFACE: 'auto-swim',
  SEEK_SHELTER: 'seek-shelter',
  OBSERVE: null,
  DELEGATE_SYSTEM2: null,
};

export interface JevReflexPolicyOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  timeoutMilliseconds?: number;
  fetcher?: typeof fetch;
  nowMilliseconds?: () => number;
  idFactory?: () => string;
}

export interface OpenAIReflexPolicyOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  reasoningEffort?: 'none' | 'low' | 'medium';
  timeoutMilliseconds?: number;
  fetcher?: typeof fetch;
  nowMilliseconds?: () => number;
  idFactory?: () => string;
}

export class JevReflexPolicy implements ReflexPolicy {
  readonly source = 'jev' as const;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMilliseconds: number;
  private readonly fetcher: typeof fetch;
  private readonly nowMilliseconds: () => number;
  private readonly idFactory: () => string;

  constructor(private readonly options: JevReflexPolicyOptions) {
    if (!options.apiKey.trim()) throw new Error('TYPESAFE_API_KEY is required');
    this.endpoint = options.endpoint ?? 'https://api.typesafe.ai/v1/systemone';
    this.model = options.model ?? 'jev-latest';
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 900;
    this.fetcher = options.fetcher ?? budgetedMinecraftFetch;
    this.nowMilliseconds = options.nowMilliseconds ?? Date.now;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  async decide(input: ReflexDecisionInput): Promise<ReflexDecision> {
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
          state: input,
          questions: reflexQuestions,
        }),
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      });
      const value = await response.json() as unknown;
      if (!response.ok) throw new Error(`JEV_RESPONSE_${response.status}`);
      return parseDecision(value, input, this.nowMilliseconds() - startedAt, this.idFactory);
    } catch {
      return fallbackDecision(input, this.nowMilliseconds() - startedAt, this.idFactory);
    }
  }
}

export class OpenAIReflexPolicy implements ReflexPolicy {
  readonly source = 'openai' as const;
  private readonly gateway: OpenAIStructuredDecisionGateway;
  private readonly nowMilliseconds: () => number;
  private readonly idFactory: () => string;

  constructor(options: OpenAIReflexPolicyOptions) {
    this.gateway = new OpenAIStructuredDecisionGateway(options);
    this.nowMilliseconds = options.nowMilliseconds ?? Date.now;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  async decide(input: ReflexDecisionInput): Promise<ReflexDecision> {
    const startedAt = this.nowMilliseconds();
    try {
      const value = await this.gateway.decide<OpenAIReflexOutput>({
        instructions: reflexInstructions,
        state: input as unknown as Record<string, unknown>,
        schemaName: 'minecraft_reflex_policy',
        schema: openAIReflexSchema,
        maxOutputTokens: 140,
      });
      return parseOpenAIDecision(value, input, this.nowMilliseconds() - startedAt, this.idFactory);
    } catch {
      return fallbackDecision(input, this.nowMilliseconds() - startedAt, this.idFactory);
    }
  }
}

export interface AnthropicReflexPolicyOptions extends AnthropicStructuredDecisionGatewayOptions {
  nowMilliseconds?: () => number;
  idFactory?: () => string;
}
export class AnthropicReflexPolicy implements ReflexPolicy {
  readonly source = 'anthropic' as const;
  private readonly gateway: AnthropicStructuredDecisionGateway;
  private readonly nowMilliseconds: () => number;
  private readonly idFactory: () => string;
  constructor(options: AnthropicReflexPolicyOptions) {
    this.gateway = new AnthropicStructuredDecisionGateway(options);
    this.nowMilliseconds = options.nowMilliseconds ?? Date.now;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }
  async decide(input: ReflexDecisionInput): Promise<ReflexDecision> {
    const startedAt = this.nowMilliseconds();
    try {
      const value = await this.gateway.decide<OpenAIReflexOutput>({
        instructions: reflexInstructions, state: input as unknown as Record<string, unknown>,
        schemaName: 'minecraft_reflex_policy', schema: openAIReflexSchema, maxOutputTokens: 140,
      });
      return parseOpenAIDecision(value, input, this.nowMilliseconds() - startedAt, this.idFactory, 'anthropic');
    } catch {
      return fallbackDecision(input, this.nowMilliseconds() - startedAt, this.idFactory);
    }
  }
}

export class LocalReflexPolicy implements ReflexPolicy {
  readonly source = 'fallback' as const;
  constructor(
    private readonly nowMilliseconds: () => number = Date.now,
    private readonly idFactory: () => string = () => crypto.randomUUID(),
  ) {}

  async decide(input: ReflexDecisionInput): Promise<ReflexDecision> {
    const startedAt = this.nowMilliseconds();
    return fallbackDecision(input, this.nowMilliseconds() - startedAt, this.idFactory);
  }
}

export function createConfiguredReflexPolicy(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  anthropic?: AnthropicReflexPolicyOptions,
): ReflexPolicy {
  const provider = configuredProvider(environment);
  const jevApiKey = environment.TYPESAFE_API_KEY?.trim();
  const openAIApiKey = environment.OPENAI_API_KEY?.trim();
  if ((provider === 'auto' || provider === 'jev') && jevApiKey) {
    return new JevReflexPolicy({
      apiKey: jevApiKey,
      endpoint: environment.SHANNON_JEV_ENDPOINT?.trim() || undefined,
      model: environment.SHANNON_JEV_MODEL?.trim() || 'jev-latest',
      timeoutMilliseconds: positiveInteger(environment.SHANNON_JEV_TIMEOUT_MS) ?? 900,
    });
  }
  if (provider === 'auto' && anthropic?.model === 'claude-haiku-5-5') {
    return anthropic.apiKey.trim() ? new AnthropicReflexPolicy(anthropic) : new LocalReflexPolicy();
  }
  if ((provider === 'auto' || provider === 'openai') && openAIApiKey) {
    return new OpenAIReflexPolicy({
      apiKey: openAIApiKey,
      endpoint: environment.MINECRAFT_OPENAI_ENDPOINT?.trim() || undefined,
      model: environment.MINECRAFT_OPENAI_MODEL?.trim() || 'gpt-5.6-luna',
      reasoningEffort: openAIReasoningEffort(environment.MINECRAFT_OPENAI_REASONING_EFFORT),
      timeoutMilliseconds: positiveInteger(environment.MINECRAFT_OPENAI_TIMEOUT_MS) ?? 2_500,
    });
  }
  return new LocalReflexPolicy();
}

export function formatReflexRecommendation(decision: ReflexDecision): string | null {
  if (decision.source === 'fallback' || decision.stale || !Number.isFinite(decision.confidence) || decision.confidence < 0.66 || !supportsControl(decision.decisionEvidence)) return null;
  return `高速反射判断(${decision.source}): urgency=${decision.urgency}, immediate_action=${decision.immediateAction}, preempt=${decision.shouldPreemptProbability.toFixed(2)}, capability_available=${decision.capabilityAvailable}`;
}

const reflexQuestions = {
  should_preempt: {
    type: 'noul',
    instructions: 'Should this event preempt the active Minecraft task immediately?',
    criteria: {
      true: 'Waiting for the current task risks death, severe damage, or irreversible loss.',
      false: 'The event can be observed or queued without interrupting the active task.',
    },
  },
  immediate_action: {
    type: 'choice',
    instructions: 'Choose the best immediate response from the supplied capabilities and world state. Prefer a directly available capability; delegate when more planning is needed.',
    criteria: {
      FLEE: 'Increase distance from one or more immediate threats.',
      EAT: 'Restore hunger/health when safe enough to consume food.',
      SURFACE: 'Move toward breathable space during drowning or suffocation.',
      STOP_MOVEMENT: 'Stop a dangerous current movement or path.',
      SEEK_SHELTER: 'Move to nearby cover from environmental or ranged danger.',
      OBSERVE: 'Refresh state because the hazard source is unclear.',
      DELEGATE_SYSTEM2: 'No single reflex is sufficient; hand the constrained problem to the planner.',
    },
  },
  urgency: {
    type: 'choice',
    instructions: 'Classify how quickly the bot must act.',
    criteria: { LOW: 'Can wait for normal planning.', MEDIUM: 'Act soon but not within a reflex tick.', CRITICAL: 'Act immediately.' },
  },
  confidence: {
    type: 'choice',
    instructions: 'How confident is this decision from the supplied event and world observation?',
    criteria: { LOW: 'Insufficient or conflicting evidence.', MEDIUM: 'Useful but incomplete evidence.', HIGH: 'Direct and consistent evidence.' },
  },
} as const;

const reflexInstructions = [
  'You are the fast System 1 reflex classifier for a Minecraft agent.',
  'Choose only from the bounded response fields using the supplied event, world state, and capability names.',
  'Do not write prose or commands. Delegate to System 2 when one reflex cannot safely resolve the event.',
].join(' ');

const openAIReflexSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    should_preempt_probability: { type: 'number', minimum: 0, maximum: 1 },
    immediate_action: { type: 'string', enum: REFLEX_ACTIONS },
    urgency: { type: 'string', enum: URGENCY_LEVELS },
    confidence: { type: 'string', enum: CONFIDENCE_LEVELS },
  },
  required: ['should_preempt_probability', 'immediate_action', 'urgency', 'confidence'],
} as const;

interface OpenAIReflexOutput {
  should_preempt_probability: number;
  immediate_action: string;
  urgency: string;
  confidence: string;
}

function parseDecision(
  value: unknown,
  input: ReflexDecisionInput,
  elapsedMilliseconds: number,
  idFactory: () => string,
): ReflexDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JEV_RESPONSE_INVALID');
  const answers = (value as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('JEV_RESPONSE_INVALID');
  const map = answers as Record<string, unknown>;
  const evidence = parseChoiceAnswer(map.immediate_action, REFLEX_ACTIONS);
  const requestedAction = evidence.choice;
  const requiredCapability = capabilityForAction[requestedAction];
  const capabilityAvailable = requiredCapability === null || input.availableCapabilities.includes(requiredCapability);
  choiceValue(map.confidence, CONFIDENCE_LEVELS); // diagnostic only
  return {
    id: idFactory(),
    eventType: stringEventType(input.event),
    evaluatedAt: new Date().toISOString(),
    elapsedMilliseconds: Math.max(0, Math.round(elapsedMilliseconds)),
    source: 'jev',
    shouldPreemptProbability: noulValue(map.should_preempt),
    immediateAction: capabilityAvailable ? requestedAction : 'DELEGATE_SYSTEM2',
    urgency: choiceValue(map.urgency, URGENCY_LEVELS),
    confidence: evidence.providerConfidence,
    confidenceKind: 'provider_distribution',
    decisionEvidence: evidence,
    capabilityAvailable,
  };
}

function parseOpenAIDecision(
  value: OpenAIReflexOutput,
  input: ReflexDecisionInput,
  elapsedMilliseconds: number,
  idFactory: () => string,
  source: 'openai' | 'anthropic' = 'openai',
): ReflexDecision {
  const requestedAction = directChoiceValue(value.immediate_action, REFLEX_ACTIONS);
  const requiredCapability = capabilityForAction[requestedAction];
  const capabilityAvailable = requiredCapability === null || input.availableCapabilities.includes(requiredCapability);
  const confidenceLevel = directChoiceValue(value.confidence, CONFIDENCE_LEVELS);
  return {
    id: idFactory(),
    eventType: stringEventType(input.event),
    evaluatedAt: new Date().toISOString(),
    elapsedMilliseconds: Math.max(0, Math.round(elapsedMilliseconds)),
    source,
    confidenceKind: 'self_reported',
    shouldPreemptProbability: directProbability(value.should_preempt_probability),
    immediateAction: capabilityAvailable ? requestedAction : 'DELEGATE_SYSTEM2',
    urgency: directChoiceValue(value.urgency, URGENCY_LEVELS),
    confidence: confidenceLevel === 'HIGH' ? 0.9 : confidenceLevel === 'MEDIUM' ? 0.66 : 0.33,
    capabilityAvailable,
  };
}

function fallbackDecision(
  input: ReflexDecisionInput,
  elapsedMilliseconds: number,
  idFactory: () => string,
): ReflexDecision {
  return {
    id: idFactory(),
    eventType: stringEventType(input.event),
    evaluatedAt: new Date().toISOString(),
    elapsedMilliseconds: Math.max(0, Math.round(elapsedMilliseconds)),
    source: 'fallback',
    shouldPreemptProbability: 1,
    immediateAction: 'DELEGATE_SYSTEM2',
    urgency: 'CRITICAL',
    confidence: 0,
    capabilityAvailable: true,
  };
}

function stringEventType(event: Record<string, unknown>): string {
  return typeof event.eventType === 'string' ? event.eventType : 'unknown';
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
