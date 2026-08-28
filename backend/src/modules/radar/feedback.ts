import { audienceKey, timestamp, validId, type RadarAudience } from './content.js';

export interface ReactionObservation {
  readonly id: string;
  readonly subjectId: string;
  readonly audience: RadarAudience;
  readonly sourceMessageId: string;
  readonly topicId: string;
  readonly reaction: string | null;
  readonly action: 'add' | 'remove';
  readonly observedAt: number;
}
export interface InterestEvidence {
  readonly evidenceId: string;
  readonly subjectId: string;
  readonly audienceKey: string;
  readonly sourceMessageId: string;
  readonly topicId: string;
  readonly signal: 'interested' | 'wants_to_play' | 'saved' | 'less_of_topic';
  readonly operation: 'record' | 'retract';
  readonly observedAt: number;
}
/** A reaction is an observed action, not a trait or a claim of true preference. No observation => no evidence. */
export function reactionEvidence(input: ReactionObservation, consent: { subjectId: string; audience: RadarAudience; enabled: boolean }): InterestEvidence | null {
  const key = audienceKey(input.audience);
  if (!key || consent.enabled !== true || consent.subjectId !== input.subjectId || audienceKey(consent.audience) !== key
    || (input.audience.kind === 'personal' && input.audience.subjectId !== input.subjectId)
    || !validId(input.id) || !validId(input.subjectId) || !validId(input.topicId)
    || !/^\d{1,25}$/.test(input.sourceMessageId) || !timestamp(input.observedAt)
    || !['add', 'remove'].includes(input.action)) return null;
  const signals: Readonly<Record<string, InterestEvidence['signal']>> = {
    '👀': 'interested', '🎮': 'wants_to_play', '📌': 'saved', '🙅': 'less_of_topic',
  };
  const signal = input.reaction && Object.hasOwn(signals, input.reaction) ? signals[input.reaction] : undefined;
  if (!signal) return null;
  return Object.freeze({ evidenceId: input.id, subjectId: input.subjectId, audienceKey: key,
    sourceMessageId: input.sourceMessageId, topicId: input.topicId, signal,
    operation: input.action === 'add' ? 'record' : 'retract', observedAt: input.observedAt });
}
