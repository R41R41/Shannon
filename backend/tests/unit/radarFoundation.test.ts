import { describe, expect, it } from 'vitest';
import { audienceKey, rankCandidates, type ContentItem, type RadarAudience, type RankedCandidate } from '../../src/modules/radar/content.js';
import { decideDelivery, type DeliveryContext, type DeliveryPolicy } from '../../src/modules/radar/deliveryPolicy.js';
import { createDiscordDraft, createPersonalDigest, createQuietCard, matchesApproval, reviewSnapshot, type PublicationApproval } from '../../src/modules/radar/drafts.js';
import { reactionEvidence, type ReactionObservation } from '../../src/modules/radar/feedback.js';

const now = 1800000000000;
const community: RadarAudience = { kind: 'community', guildId: '100', channelId: '200' };
const personal: RadarAudience = { kind: 'personal', subjectId: 'discord:300' };
const item = (patch: Partial<ContentItem> = {}): ContentItem => ({ id: 'item-1', revision: 1, clusterId: 'cluster-1',
  sourceId: 'official-nintendo', sourceKind: 'web', sourceUrl: 'https://example.org/news/1', fetchedAt: now,
  publishedAt: now - 3600000, expiresAt: now + 86400000, visibility: 'public', verification: 'source_checked',
  title: '新作の発売日', fact: '発売日は9月12日と発表された。', metadata: ['Nintendo Switch'], topicIds: ['nintendo'],
  novelty: 0.9, quality: 1, ...patch });
const candidate = (patch: Partial<ContentItem> = {}, audience = community): RankedCandidate => rankCandidates([item(patch)],
  { audience, now, preferences: [{ topicId: 'nintendo', weight: 1 }] })[0];
const policy = (audience = community, patch: Partial<DeliveryPolicy> = {}): DeliveryPolicy => ({ audience, revision: 1,
  enabled: true, allowedSourceIds: ['official-nintendo'], minimumScore: 0.7, maxPerHour: 1, maxPerDay: 2,
  minimumGapMs: 3600000, maxDigestItems: 3, ...patch });
const context = (patch: Partial<DeliveryContext> = {}): DeliveryContext => ({ now, focusMode: false, quietUntil: 0,
  usedThisHour: 0, usedToday: 0, lastDeliveryAt: null, deliveredOrReservedClusterIds: [], ...patch });
const draft = () => createDiscordDraft(candidate(), policy(), context(), 'delivery-1')!;

describe('Radar ranking and scope', () => {
  it('ranks explicit preferences separately from delivery policy and deduplicates after scoring', () => {
    const ranked = rankCandidates([item({ id: 'other', topicIds: ['trpg'], clusterId: 'other' }), item(), item({ id: 'duplicate' })],
      { audience: community, now, preferences: [{ topicId: 'nintendo', weight: 1 }] });
    expect(ranked).toHaveLength(2); expect(ranked[0].matchedTopicIds).toEqual(['nintendo']);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(decideDelivery(ranked[0], undefined, context()).kind).toBe('silence');
  });
  it.each([
    { visibility: personal }, { verification: 'unverified' }, { expiresAt: now }, { fetchedAt: now + 1 },
    { publishedAt: now + 1 }, { sourceKind: 'calendar' }, { sourceKind: 'x' }, { sourceUrl: 'file:///etc/passwd' },
    { sourceUrl: 'http://example.org/' }, { sourceUrl: 'https://user:secret@example.org/' },
    { novelty: NaN }, { quality: Infinity }, { topicIds: [''] }, { revision: 0 }, { fact: '' },
  ])('excludes unsafe or invalid input before ranking: %j', patch => {
    expect(rankCandidates([item(patch as Partial<ContentItem>)], { audience: community, now, preferences: [] })).toEqual([]);
  });
  it('keeps private calendars and preferences in the exact personal audience', () => {
    const calendar = item({ sourceKind: 'calendar', visibility: personal });
    expect(rankCandidates([calendar], { audience: personal, now, preferences: [] })).toHaveLength(1);
    expect(rankCandidates([calendar], { audience: { kind: 'personal', subjectId: 'discord:301' }, now, preferences: [] })).toEqual([]);
    expect(rankCandidates([item({ sourceKind: 'calendar', visibility: 'public' })], { audience: personal, now, preferences: [] })).toEqual([]);
    expect(audienceKey({ kind: 'community', guildId: '100', channelId: '201' })).not.toBe(audienceKey(community));
    expect(audienceKey({ kind: 'community', guildId: 100 as unknown as string, channelId: '201' })).toBeNull();
  });
  it('snapshots arrays and audience instead of retaining mutable input', () => {
    const source = item(); const mutableAudience = { kind: 'community' as const, guildId: '100', channelId: '200' };
    const [ranked] = rankCandidates([source], { audience: mutableAudience, now, preferences: [] });
    (source.topicIds as string[]).push('private'); mutableAudience.channelId = '201';
    expect(ranked.item.topicIds).toEqual(['nintendo']); expect(ranked.audience).toEqual(community);
    expect(Object.isFrozen(ranked.item)).toBe(true);
  });
});

describe('Radar attention policy', () => {
  it('never produces a send authorization even with a perfect score', () => {
    expect(decideDelivery(candidate(), policy(), context())).toMatchObject({ kind: 'approval_required', reason: 'manual_review' });
  });
  it.each([
    [undefined, 'disabled'], [policy(community, { enabled: false }), 'disabled'],
    [policy(personal), 'scope'], [policy(community, { allowedSourceIds: [] }), 'source'],
    [policy(community, { maxPerDay: 0 }), 'budget'], [policy(community, { maxPerHour: 0 }), 'budget'],
    [policy(community, { minimumScore: 1 }), 'low_score'], [policy(community, { minimumScore: NaN }), 'invalid_context'],
    [policy(community, { maxPerDay: -1 }), 'invalid_context'], [policy(community, { revision: 0 }), 'invalid_context'],
  ] as const)('fails closed for absent, mismatched or malformed policy %#', (p, reason) => {
    expect(decideDelivery(candidate(), p, context())).toMatchObject({ kind: 'silence', reason });
  });
  it.each([
    [{ focusMode: true }, 'quiet'], [{ quietUntil: now + 1 }, 'quiet'],
    [{ usedThisHour: 1, usedToday: 1 }, 'budget'], [{ usedToday: 2 }, 'budget'],
    [{ lastDeliveryAt: now - 1 }, 'budget'], [{ deliveredOrReservedClusterIds: ['cluster-1'] }, 'duplicate'],
    [{ usedToday: NaN }, 'invalid_context'], [{ lastDeliveryAt: now + 1 }, 'invalid_context'],
    [{ usedThisHour: 1, usedToday: 0 }, 'invalid_context'], [{ now: now + 86400000 }, 'ineligible'],
  ] as const)('suppresses interruptions and duplicate reservations %#', (patch, reason) => {
    expect(decideDelivery(candidate(), policy(), context(patch))).toMatchObject({ kind: 'silence', reason });
  });
  it('rechecks content scope and score at delivery, not only at ranking', () => {
    const c = candidate();
    expect(decideDelivery({ ...c, item: item({ visibility: personal }) }, policy(), context()).kind).toBe('silence');
    expect(decideDelivery({ ...c, score: Infinity }, policy(), context()).kind).toBe('silence');
  });
  it('only assembles a private digest preview while focus/notification budget prevents interruptions', () => {
    const ranked = Array.from({ length: 6 }, (_, i) => candidate({ id: `item-${i}`, clusterId: `cluster-${i}` }, personal));
    const cards = createPersonalDigest([...ranked, ranked[0]], policy(personal), context({ focusMode: true, usedToday: 2 }));
    expect(cards).toHaveLength(3); expect(cards.every(c => c.notify === false)).toBe(true);
    expect(createPersonalDigest(ranked, policy(personal, { maxDigestItems: 0 }), context())).toEqual([]);
    expect(createPersonalDigest(ranked, policy(), context())).toEqual([]);
  });
});

describe('Radar quiet drafts and approval consistency', () => {
  it('produces a mechanical source card without ranking reasons or user targeting', () => {
    const card = createQuietCard(candidate({ title: '@everyone 新作', fact: '公式の[発表](リンク)。' }), now)!;
    expect(card).toMatchObject({ mentions: 'none', notify: false, thread: 'none', sourceUrl: 'https://example.org/news/1' });
    expect(card.title).toContain('＠everyone'); expect(card.fact).toContain('\\[');
    expect(Object.keys(card)).not.toContain('matchedTopicIds'); expect(Object.keys(card)).not.toContain('subjectId');
  });
  it.each([{ title: '一緒に遊ぶ？' }, { fact: 'どう思いますか?' }, { metadata: ['遊ぶ？'] }, { visibility: community }])('refuses questions/private observations in cards %j', patch => {
    expect(createQuietCard(candidate(patch), now)).toBeNull();
  });
  it('does not create Discord drafts for private digests, missing source grants or quiet hours', () => {
    expect(createDiscordDraft(candidate({}, personal), policy(personal), context(), 'job')).toBeNull();
    expect(createDiscordDraft(candidate(), policy(community, { allowedSourceIds: [] }), context(), 'job')).toBeNull();
    expect(createDiscordDraft(candidate(), policy(), context({ quietUntil: now + 1 }), 'job')).toBeNull();
  });
  const approval = (d = draft(), patch: Partial<PublicationApproval> = {}): PublicationApproval => ({ approverId: 'owner',
    reviewedSnapshot: reviewSnapshot(d), approvedAt: now, expiresAt: now + 1000, revoked: false, ...patch });
  it('requires trusted approver, exact reviewed snapshot and current approval', () => {
    const d = draft(); const a = approval(d);
    expect(matchesApproval(d, a, ['owner'], now)).toBe(true);
    expect(matchesApproval(d, undefined, ['owner'], now)).toBe(false);
    expect(matchesApproval(d, a, [], now)).toBe(false);
    expect(matchesApproval(d, { ...a, revoked: true }, ['owner'], now)).toBe(false);
    expect(matchesApproval(d, { ...a, approvedAt: now + 1 }, ['owner'], now)).toBe(false);
    expect(matchesApproval(d, a, ['owner'], now + 1000)).toBe(false);
  });
  it.each(['destination', 'policy', 'body', 'source', 'delivery', 'candidate', 'expiry'])('invalidates approval when %s changes', change => {
    const d = draft(); const a = approval(d);
    const changed = { ...d, ...(change === 'destination' ? { audienceKey: 'other' } : change === 'policy' ? { policyRevision: 2 }
      : change === 'body' ? { card: { ...d.card, fact: 'Changed.' } } : change === 'source' ? { sourceId: 'other' }
      : change === 'delivery' ? { deliveryId: 'other' } : change === 'candidate' ? { candidateRevision: 2 } : { expiresAt: now + 900 }) };
    expect(matchesApproval(changed, a, ['owner'], now)).toBe(false);
  });
});

describe('Radar reaction observations', () => {
  const observation = (patch: Partial<ReactionObservation> = {}): ReactionObservation => ({ id: 'reaction-1', subjectId: 'discord:300',
    audience: community, sourceMessageId: '400', topicId: 'nintendo', reaction: '👀', action: 'add', observedAt: now, ...patch });
  const consent = { subjectId: 'discord:300', audience: community, enabled: true };
  it.each([['👀', 'interested'], ['🎮', 'wants_to_play'], ['📌', 'saved'], ['🙅', 'less_of_topic']])('maps %s to an observation, not a personality', (reaction, signal) => {
    expect(reactionEvidence(observation({ reaction }), consent)).toMatchObject({ signal, operation: 'record', topicId: 'nintendo' });
  });
  it.each([null, '', '💤', 'constructor', '__proto__'])('does not turn absent/unknown reactions into dislike: %s', reaction => {
    expect(reactionEvidence(observation({ reaction }), consent)).toBeNull();
  });
  it('represents removal as retraction and requires consent in the same audience for that subject', () => {
    expect(reactionEvidence(observation({ action: 'remove' }), consent)?.operation).toBe('retract');
    expect(reactionEvidence(observation(), { ...consent, enabled: false })).toBeNull();
    expect(reactionEvidence(observation(), { ...consent, subjectId: 'discord:301' })).toBeNull();
    expect(reactionEvidence(observation(), { ...consent, audience: personal })).toBeNull();
    const other: RadarAudience = { kind: 'personal', subjectId: 'discord:301' };
    expect(reactionEvidence(observation({ audience: other }), { ...consent, audience: other })).toBeNull();
  });
});
