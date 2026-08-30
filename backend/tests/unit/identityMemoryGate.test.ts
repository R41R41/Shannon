import { describe, expect, it } from 'vitest';
import { InMemoryIdentityProfileRepository } from '../../src/adapters/identity/MongoIdentityProfileRepository.js';
import { applyDiscordIdentityMemoryGate } from '../../src/services/identity/identityMemoryGate.js';
import type { RequestEnvelope } from '@shannon/common';
import { mergeProfileAfterAudience, mergeProfileAfterLink, emptyProfile } from '../../src/modules/identity/bindingWrite.js';
import type { RequestContext } from '../../src/modules/access/index.js';

const context: RequestContext = Object.freeze({
  requestId: 'req-1',
  principal: Object.freeze({ uid: 'firebase-user', projectId: 'dev-project', name: 'Test', email: 'test@example.test' }),
  capabilities: Object.freeze(['profile:read']),
  expiresAtMs: Date.now() + 60_000,
});

const envelope = Object.freeze({
  requestId: 'req-1',
  channel: 'discord',
  sourceUserId: '123456789012345678',
  conversationId: 'discord:123456789012345678',
  threadId: 'thread-1',
  text: 'hello',
  timestampIso: new Date().toISOString(),
  discord: Object.freeze({ channelId: '987654321098765432', guildId: '111111111111111111', isDM: false }),
}) as RequestEnvelope;

describe('identity memory gate', () => {
  it('disables memory for linked discord users when audience excludes discord_text', async () => {
    const profiles = new InMemoryIdentityProfileRepository();
    let stored = emptyProfile(context);
    stored = mergeProfileAfterLink(stored, 'discord', {
      externalId: '123456789012345678',
      label: 'Discord',
      linkedAtIso: '2026-01-01T00:00:00.000Z',
    });
    stored = mergeProfileAfterAudience(stored, {
      confirm: true,
      memoryChannels: ['web'],
      lineDeliveryEnabled: false,
      radarPersonalFeed: false,
    });
    await profiles.save(context, stored);

    const gated = await applyDiscordIdentityMemoryGate(envelope, 'dev-project', profiles);
    expect(gated.metadata?.memoryDisabled).toBe(true);
  });

  it('leaves memory enabled when no profile exists for the discord author', async () => {
    const profiles = new InMemoryIdentityProfileRepository();
    const gated = await applyDiscordIdentityMemoryGate(envelope, 'dev-project', profiles);
    expect(gated.metadata?.memoryDisabled).toBeUndefined();
  });
});
