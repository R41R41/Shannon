import { AccessError, type AccessService, type RequestContext } from '../../modules/access/index.js';
import { validId } from '../../modules/radar/content.js';
import { validFeedSubscription } from '../../modules/radar/sourceRegistry.js';
import type { FeedConnectorPort } from './feedConnector.js';
import { PersonalRadarError, PersonalRadarService, personalRadarOwner } from './personalRadar.js';

export const RADAR_SESSION_MAX_SOURCES = 3;
export const RADAR_SESSION_MAX_MS = 30000;

/** Explicit, foreground, one-owner pass. NOT a scheduler, delegated identity or persistent job.
 * The composition root must inject the real AccessService; no body-supplied RequestContext.
 * Tokens live only in this invocation and are never put in jobs, catalog, results or logs.
 */
export class RadarSessionRunner {
  constructor(private readonly access: Pick<AccessService, 'authenticate'>,
    private readonly radar: PersonalRadarService, private readonly connector: FeedConnectorPort,
    private readonly clock: () => number = Date.now) {}

  async run(idToken: unknown, body: unknown, outer: AbortSignal) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PersonalRadarError('INVALID_INPUT');
    const input = body as Record<string, unknown>;
    if (Object.keys(input).length !== 2 || !Object.prototype.hasOwnProperty.call(input, 'expectedRevision') || !Object.prototype.hasOwnProperty.call(input, 'sourceIds')
      || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0
      || Number(input.expectedRevision) >= Number.MAX_SAFE_INTEGER
      || !Array.isArray(input.sourceIds) || input.sourceIds.length < 1 || input.sourceIds.length > RADAR_SESSION_MAX_SOURCES
      || !input.sourceIds.every(validId) || new Set(input.sourceIds).size !== input.sourceIds.length)
      throw new PersonalRadarError('INVALID_INPUT');
    const selected = [...input.sourceIds] as string[];
    let expected = Number(input.expectedRevision);
    let owner: string | undefined;
    const startedAt = this.clock(); const deadline = startedAt + RADAR_SESSION_MAX_MS;
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new PersonalRadarError('UNAVAILABLE');
    let observedAt = startedAt;
    const controller = new AbortController();
    const guard = () => {
      if (controller.signal.aborted || outer.aborted) throw new PersonalRadarError('CANCELLED');
      const now = this.clock();
      if (!Number.isSafeInteger(now) || now < observedAt || now >= deadline) throw new PersonalRadarError('CANCELLED');
      observedAt = now;
    };
    const refresh = async (): Promise<RequestContext> => {
      guard();
      let verified: RequestContext;
      try { verified = await this.access.authenticate(idToken); }
      catch (error) { throw error instanceof AccessError ? error : new AccessError('AUTH_UNAVAILABLE'); }
      guard();
      const currentOwner = personalRadarOwner(verified, this.clock());
      if (owner !== undefined && currentOwner !== owner) throw new PersonalRadarError('CONFLICT');
      owner = currentOwner;
      // Renewal can shorten, never extend this pass's fixed deadline or grant extra capabilities.
      return Object.freeze({ ...verified, capabilities: Object.freeze(['profile:read'] as const),
        principal: Object.freeze({ ...verified.principal }), expiresAtMs: Math.min(verified.expiresAtMs, deadline) });
    };
    let stop: () => void = () => undefined;
    const cancelled = new Promise<never>((_, reject) => {
      stop = () => { controller.abort(); reject(new PersonalRadarError('CANCELLED')); };
    });
    outer.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, RADAR_SESSION_MAX_MS);
    const work = async () => {
      const context = await refresh(); guard();
      const snapshot = await this.radar.sources(context); guard();
      if (snapshot.revision !== expected) throw new PersonalRadarError('CONFLICT');
      // Validate the entire selection before spending any request budget. Never substitute a new source.
      for (const id of selected) {
        const source = snapshot.sources.find(s => s.id === id)?.source;
        if (!source || !validFeedSubscription(source, { kind: 'personal', subjectId: owner! }, this.clock()))
          throw new PersonalRadarError('NOT_FOUND');
      }
      const completedSourceIds: string[] = [];
      for (const id of selected) {
        guard();
        const current = await refresh(); guard();
        const result = await this.radar.collect(current, id, this.connector, controller.signal, refresh, expected);
        guard(); expected = result.revision; completedSourceIds.push(id);
      }
      const latest = await refresh(); guard();
      await this.radar.assertCurrent(latest, expected); guard();
      return { revision: expected, completedSourceIds };
    };
    try { return await Promise.race([cancelled, work()]); }
    catch (error) {
      // Acquisition failures are intentionally a fixed error here; callers reread, never retry blindly.
      if (error instanceof AccessError || error instanceof PersonalRadarError) throw error;
      throw new PersonalRadarError('UNAVAILABLE');
    } finally {
      clearTimeout(timer); outer.removeEventListener('abort', stop); controller.abort();
    }
  }
}
