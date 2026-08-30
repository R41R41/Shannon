import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { audienceKey, type RadarAudience } from '../../modules/radar/content.js';
import { snapshotSubscription, validFeedSubscription, type FeedRegistryPort, type FeedSubscription } from '../../modules/radar/sourceRegistry.js';

const MAX_BYTES = 64 * 1024;
/** Transitional read-only adapter. Explicit path, private regular file, no default path/env/startup effects. */
export class JsonFeedRegistry implements FeedRegistryPort {
  constructor(private readonly path: string, private readonly clock: () => number = Date.now) {}
  async get(id: string, audience: RadarAudience): Promise<FeedSubscription | null> {
    try { return await this.read(id, audience); }
    catch { throw new Error('RADAR_REGISTRY_UNAVAILABLE'); }
  }
  private async read(id: string, audience: RadarAudience): Promise<FeedSubscription | null> {
    // Re-open on each read so revocation and atomic file replacement are visible after collection.
    const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > MAX_BYTES) throw new Error('RADAR_REGISTRY_UNAVAILABLE');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_BYTES) throw new Error('RADAR_REGISTRY_UNAVAILABLE');
      const rows: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)));
      if (!Array.isArray(rows) || rows.length > 100) throw new Error('RADAR_REGISTRY_UNAVAILABLE');
      const key = audienceKey(audience);
      if (!key) return null;
      const found = rows.filter(row => row && typeof row === 'object' && row.id === id && audienceKey(row.audience) === key);
      if (found.length !== 1 || !validFeedSubscription(found[0], audience, this.clock())) return null;
      return snapshotSubscription(found[0]);
    } finally { await file.close(); }
  }
}
