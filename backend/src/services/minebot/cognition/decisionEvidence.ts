import type { DecisionEvidence } from './types.js';

/** A classifier distribution is evidence, not a calibrated probability of correctness. */
export function parseChoiceAnswer<const T extends readonly string[]>(value: unknown, allowed: T): DecisionEvidence<T[number]> {
  if (!value || typeof value !== 'object') throw new Error('CHOICE_INVALID');
  const answer = value as { choice?: unknown; confidence?: unknown; probabilities?: unknown };
  if (typeof answer.choice !== 'string' || !allowed.includes(answer.choice)
    || typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)
    || answer.confidence < 0 || answer.confidence > 1
    || !answer.probabilities || typeof answer.probabilities !== 'object') throw new Error('CHOICE_INVALID');
  const probabilities = answer.probabilities as Record<string, unknown>;
  if (Object.keys(probabilities).length !== allowed.length) throw new Error('CHOICE_INCOMPLETE');
  let sum = 0;
  for (const option of allowed) {
    const probability = probabilities[option];
    if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('CHOICE_INVALID');
    sum += probability;
  }
  if (Math.abs(sum - 1) > 0.01) throw new Error('CHOICE_DISTRIBUTION_INVALID');
  const selected = probabilities[answer.choice] as number;
  if (allowed.some(option => (probabilities[option] as number) > selected + 0.000001)) throw new Error('CHOICE_NOT_MAXIMUM');
  return { choice: answer.choice as T[number], probabilities: probabilities as Record<T[number], number>, providerConfidence: answer.confidence };
}

export function receiptOutcome(receipt: { outcome?: string; success: boolean | null; failureType: string | null }): string {
  return receipt.outcome ?? (receipt.failureType === 'waiting_external' ? 'pending_external'
    : receipt.success === true ? 'succeeded' : receipt.success === false ? 'failed' : 'unknown');
}

export function supportsControl(evidence: DecisionEvidence<string> | undefined, minimum = 0.66): boolean {
  return !evidence || (evidence.providerConfidence >= minimum && evidence.probabilities[evidence.choice] >= minimum);
}
