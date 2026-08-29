import { describe, expect, it } from 'vitest';
import { AccessError, type RequestContext } from '../../src/modules/access/index.js';
import { InMemoryIdentityProfileRepository, ProfileIdentityStatusRepository } from '../../src/adapters/identity/MongoIdentityProfileRepository.js';
import {
  IdentityBindingWriteService,
  IdentityInputError,
  IdentityStatusService,
  parseAudienceUpdateInput,
  parseLinkBindingInput,
} from '../../src/modules/identity/index.js';

const context: RequestContext = Object.freeze({
  requestId: 'req-1',
  principal: Object.freeze({ uid: 'firebase-user', projectId: 'dev-project', name: 'Test', email: 'test@example.test' }),
  capabilities: Object.freeze(['profile:read']),
  expiresAtMs: Date.now() + 60_000,
});

describe('identity binding write', () => {
  it('requires explicit confirm for link/unlink/audience', () => {
    expect(() => parseLinkBindingInput('discord', { confirm: false, discordUserId: '123456789012345678' })).toThrow(IdentityInputError);
    expect(() => parseAudienceUpdateInput({ confirm: false, memoryChannels: [], lineDeliveryEnabled: false, radarPersonalFeed: false })).toThrow(IdentityInputError);
  });

  it('validates channel-specific identifiers', () => {
    expect(() => parseLinkBindingInput('discord', { confirm: true, discordUserId: 'abc' })).toThrow('INVALID_DISCORD_USER_ID');
    expect(() => parseLinkBindingInput('line', { confirm: true, lineUserId: 'bad' })).toThrow('INVALID_LINE_USER_ID');
    expect(() => parseLinkBindingInput('minecraft', { confirm: true, serverId: 'default', worldId: 'world-a' })).toThrow('INVALID_MINECRAFT_BINDING');
    expect(parseLinkBindingInput('discord', { confirm: true, discordUserId: '123456789012345678' }).discordUserId).toBe('123456789012345678');
  });

  it('links, updates audience, and unlinks for the authenticated identity only', async () => {
    const profiles = new InMemoryIdentityProfileRepository();
    const write = new IdentityBindingWriteService(profiles);
    const read = new IdentityStatusService(new ProfileIdentityStatusRepository(profiles));

    const linked = await write.link(context, 'discord', { confirm: true, discordUserId: '123456789012345678' });
    expect(linked.bindings.find((row) => row.channel === 'discord')?.status).toBe('linked');

    const audienceUpdated = await write.updateAudience(context, {
      confirm: true,
      memoryChannels: ['web'],
      lineDeliveryEnabled: true,
      radarPersonalFeed: true,
    });
    expect(audienceUpdated.audience.memoryChannels).toEqual(['web']);
    expect(audienceUpdated.audience.lineDeliveryEnabled).toBe(true);

    const unlinked = await write.unlink(context, 'discord', { confirm: true });
    expect(unlinked.bindings.find((row) => row.channel === 'discord')?.status).toBe('unlinked');

    const status = await read.read(context);
    expect(status.identity.uid).toBe('firebase-user');
    expect(JSON.stringify(status)).not.toMatch(/token|secret|refresh/i);
  });

  it('links radar owner to the current firebase identity', async () => {
    const profiles = new InMemoryIdentityProfileRepository();
    const write = new IdentityBindingWriteService(profiles);
    const linked = await write.link(context, 'radar', { confirm: true });
    expect(linked.bindings.find((row) => row.channel === 'radar')?.status).toBe('linked');
    expect(linked.bindings.find((row) => row.channel === 'radar')?.label).toContain('Radar owner');
  });

  it('rejects unauthenticated writes', async () => {
    const write = new IdentityBindingWriteService(new InMemoryIdentityProfileRepository());
    await expect(write.link(null, 'discord', { confirm: true, discordUserId: '123456789012345678' })).rejects.toThrow(AccessError);
  });
});
