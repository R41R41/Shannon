import { describe, expect, it } from 'vitest';
import { InMemoryIdentityProfileRepository } from '../../src/adapters/identity/MongoIdentityProfileRepository.js';
import { IdentityBindingWriteService } from '../../src/modules/identity/index.js';
import { assertLinePersonalAccess, isLineDeliveryAllowed } from '../../src/modules/identity/lineIdentityGate.js';
import { IdentityGateError } from '../../src/modules/identity/resolveBinding.js';
import { authorizeLinePersonal, authorizeLineRadarPersonal, InMemoryLineIdentityPort } from '../../src/services/line/lineIdentityPort.js';
import { lineRadarPolicyForIdentity } from '../../src/services/line/runtime.js';
import { firebasePersonalRadarOwner } from '../../src/services/radar/radarAccess.js';
import type { RequestContext } from '../../src/modules/access/index.js';

const lineUserId = 'U' + 'a'.repeat(32);
const context: RequestContext = Object.freeze({
  requestId: 'req-line',
  principal: Object.freeze({ uid: 'firebase-user', projectId: 'dev-project', name: 'Test', email: 'test@example.test' }),
  capabilities: Object.freeze(['profile:read']),
  expiresAtMs: Date.now() + 60_000,
});

describe('LINE identity gate', () => {
  it('allows personal traffic when no profile is stored yet', () => {
    expect(isLineDeliveryAllowed(null, lineUserId)).toBe(true);
    expect(() => assertLinePersonalAccess(null, lineUserId)).not.toThrow();
  });

  it('requires linked LINE binding and lineDeliveryEnabled once a profile exists', async () => {
    const profiles = new InMemoryIdentityProfileRepository();
    const write = new IdentityBindingWriteService(profiles);
    await write.link(context, 'line', { confirm: true, lineUserId });
    const profile = await profiles.find(context);
    expect(isLineDeliveryAllowed(profile, lineUserId)).toBe(false);

    await write.updateAudience(context, {
      confirm: true,
      memoryChannels: ['web'],
      lineDeliveryEnabled: true,
      radarPersonalFeed: true,
    });
    const allowed = await profiles.find(context);
    expect(isLineDeliveryAllowed(allowed, lineUserId)).toBe(true);
    expect(isLineDeliveryAllowed(allowed, 'U' + 'b'.repeat(32))).toBe(false);
  });

  it('finds profiles by LINE user id and authorizes through the LINE port', async () => {
    const profiles = new InMemoryIdentityProfileRepository();
    const write = new IdentityBindingWriteService(profiles);
    await write.link(context, 'line', { confirm: true, lineUserId });
    await write.updateAudience(context, {
      confirm: true,
      memoryChannels: ['web'],
      lineDeliveryEnabled: true,
      radarPersonalFeed: false,
    });
    const stored = await profiles.findByLineUserId('dev-project', lineUserId);
    expect(stored?.bindings.line?.externalId).toBe(lineUserId);

    const port = new InMemoryLineIdentityPort();
    if (stored) port.seed(stored);
    await expect(authorizeLinePersonal(port, 'dev-project', lineUserId)).resolves.toBeUndefined();
    await expect(authorizeLineRadarPersonal(port, 'dev-project', lineUserId)).rejects.toBeInstanceOf(IdentityGateError);

    const blocked = new InMemoryLineIdentityPort();
    if (stored) {
      blocked.seed({
        ...stored,
        audience: { ...stored.audience, lineDeliveryEnabled: false },
      });
    }
    await expect(authorizeLinePersonal(blocked, 'dev-project', lineUserId)).rejects.toBeInstanceOf(IdentityGateError);
  });

  it('syncs only active Web Radar sources and clamps the LINE policy authority', async () => {
    const now = Date.now();
    const profiles = new InMemoryIdentityProfileRepository();
    const write = new IdentityBindingWriteService(profiles, () => now);
    await write.link(context, 'line', { confirm: true, lineUserId });
    await write.updateAudience(context, { confirm: true, memoryChannels: ['web'], lineDeliveryEnabled: true, radarPersonalFeed: true });
    const profile = await profiles.find(context);
    expect(profile).not.toBeNull();
    const owner = firebasePersonalRadarOwner('dev-project', 'firebase-user');
    const source = (id: string, consentExpiresAt: number, enabled = true) => ({ id, revision: 1, enabled, consentExpiresAt,
      audience: { kind: 'personal' as const, subjectId: owner }, kind: 'youtube' as const,
      locator: `UC${id.padEnd(22, 'a').slice(0, 22)}`, articleHosts: ['www.youtube.com'], topicIds: [`topic-${id}`],
      maxItems: 5, retentionMs: 86400000 });
    const port = new InMemoryLineIdentityPort();
    port.seed(profile!);
    port.seedRadarCatalog(profile!, { owner, revision: 1, sources: [
      { id: 'one', source: source('one', now + 9_000_000), records: [] },
      { id: 'two', source: source('two', now + 8_000_000), records: [] },
      { id: 'three', source: source('three', now + 7_000_000), records: [] },
      { id: 'four', source: source('four', now + 6_000_000), records: [] },
      { id: 'off', source: source('off', now + 9_000_000, false), records: [] },
    ], audit: [] });
    const sync = await port.readWebRadarSync('dev-project', lineUserId, now);
    expect(sync.state).toBe('linked');
    expect(sync.feeds.map(feed => feed.id)).toEqual(['one', 'two', 'three']);
    expect(sync.validUntil).toBe(now + 7_000_000);
    const policy = lineRadarPolicyForIdentity({ version: 1, enabled: true, hourJst: 8, minuteJst: 0,
      consentExpiresAt: now + 10_000_000, feeds: [{ id: 'operator-fallback', kind: 'youtube', locator: `UC${'z'.repeat(22)}`,
        articleHosts: ['www.youtube.com'], topicIds: [], maxItems: 5, retentionMs: 86400000 }],
      weather: null, topics: [], youtubeSubscriptions: null, calendar: null }, sync, now);
    expect(policy.feeds.map(feed => feed.id)).toEqual(['one', 'two', 'three']);
    expect(policy.topics).toEqual(['topic-one', 'topic-two', 'topic-three']);
    expect(policy.consentExpiresAt).toBe(now + 7_000_000);
    await expect(authorizeLineRadarPersonal(port, 'dev-project', lineUserId, now)).resolves.toBeUndefined();
  });

  it('stops scheduled Radar without disabling a separately authorized LINE chat path', async () => {
    const profiles = new InMemoryIdentityProfileRepository();
    const write = new IdentityBindingWriteService(profiles);
    await write.link(context, 'line', { confirm: true, lineUserId });
    await write.updateAudience(context, { confirm: true, memoryChannels: ['web'], lineDeliveryEnabled: true, radarPersonalFeed: false });
    const profile = await profiles.find(context);
    const port = new InMemoryLineIdentityPort();
    port.seed(profile!);
    await expect(authorizeLinePersonal(port, 'dev-project', lineUserId)).resolves.toBeUndefined();
    await expect(authorizeLineRadarPersonal(port, 'dev-project', lineUserId)).rejects.toBeInstanceOf(IdentityGateError);
    const sync = await port.readWebRadarSync('dev-project', lineUserId);
    const policy = lineRadarPolicyForIdentity({ version: 1, enabled: true, hourJst: 8, minuteJst: 0,
      consentExpiresAt: Date.now() + 60_000, feeds: [{ id: 'legacy', kind: 'youtube', locator: `UC${'a'.repeat(22)}`,
        articleHosts: ['www.youtube.com'], topicIds: [], maxItems: 5, retentionMs: 86400000 }], weather: null }, sync);
    expect(policy.enabled).toBe(false);
    expect(policy.feeds).toEqual([]);
  });
});
