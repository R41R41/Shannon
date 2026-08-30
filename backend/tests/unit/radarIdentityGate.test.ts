import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { AccessService } from '../../src/modules/access/index.js';
import { InMemoryIdentityProfileRepository } from '../../src/adapters/identity/MongoIdentityProfileRepository.js';
import { registerRadarRoutes } from '../../src/routes/radarRoutes.js';
import { PersonalRadarService } from '../../src/services/radar/personalRadar.js';
import { mergeProfileAfterAudience, emptyProfile } from '../../src/modules/identity/bindingWrite.js';
import type { RequestContext } from '../../src/modules/access/index.js';

const initialNow = 1_700_000_000_000;
const context = (): RequestContext => Object.freeze({
  requestId: 'req-1',
  principal: Object.freeze({ uid: 'alice', projectId: 'fixture', name: 'Alice', email: 'alice@example.test' }),
  capabilities: Object.freeze(['profile:read']),
  expiresAtMs: initialNow + 60_000,
});

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe('radar identity gate', () => {
  it('returns 403 when a stored profile disables radarPersonalFeed', async () => {
    const store = { read: vi.fn(async (owner: string) => ({ owner, revision: 0, sources: [], audit: [] })) } as any;
    const radar = new PersonalRadarService(store, () => initialNow);
    const profiles = new InMemoryIdentityProfileRepository();
    const ctx = context();
    await profiles.save(ctx, mergeProfileAfterAudience(emptyProfile(ctx), {
      confirm: true,
      memoryChannels: ['web'],
      lineDeliveryEnabled: false,
      radarPersonalFeed: false,
    }));
    const access = new AccessService({
      verify: async () => ({ projectId: 'fixture', uid: 'alice', email: 'alice@example.test', emailVerified: true, expiresAtMs: initialNow + 86400000 }),
    }, {
      findByIdentity: async () => ({ projectId: 'fixture', uid: 'alice', name: 'Alice', email: 'alice@example.test', isAuthorized: true, isAdmin: false }),
    }, () => 'request', () => initialNow);
    const app = express();
    registerRadarRoutes(app, access, radar, undefined, undefined, profiles);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const res = await fetch(`${url}/api/radar/sources`, { headers: { Authorization: 'Bearer alice' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'FORBIDDEN' });
  });
});
