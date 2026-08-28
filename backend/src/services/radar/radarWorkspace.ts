import type { RadarContext } from './radarAccess.js';
import { validId, timestamp } from '../../modules/radar/content.js';
import { validTimeZone } from '../../modules/radar/temporalSources.js';
import { PersonalRadarService, PersonalRadarError, personalRadarOwner, type ReauthorizeRadar } from './personalRadar.js';
import { PersonalTemporalRadar } from './personalTemporalRadar.js';
import { temporalRead } from './temporalParsing.js';

/** Server-owned list of already linked calendars. Never accepts account IDs, scopes or credentials from a browser. */
export interface CalendarChoice { readonly id: string; readonly label: string; readonly timeZone: string; readonly expiresAt: number }
export interface RadarWorkspaceOptions {
  readonly weatherAvailable: boolean;
  readonly calendars?: { list(owner: string, signal: AbortSignal): Promise<readonly CalendarChoice[]> };
}
/** One screen, one owner revision. Public feed cards and private temporal content remain different DTOs. */
export class RadarWorkspace {
  constructor(private readonly feed: PersonalRadarService, readonly temporal: PersonalTemporalRadar,
    private readonly options: RadarWorkspaceOptions, private readonly clock: () => number = Date.now) {}
  private async choices(context: RadarContext, signal: AbortSignal) {
    const owner = personalRadarOwner(context, this.clock());
    const rows = this.options.calendars ? await temporalRead(signal, child => this.options.calendars!.list(owner, child)) : [];
    if (!Array.isArray(rows) || rows.length > 32 || new Set(rows.map(r => r.id)).size !== rows.length
      || rows.some(r => !r || !validId(r.id) || typeof r.label !== 'string' || !r.label.trim() || r.label.length > 80
        || /[<>\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(r.label) || !validTimeZone(r.timeZone)
        || !timestamp(r.expiresAt))) throw new PersonalRadarError('UNAVAILABLE');
    return rows.filter(r => r.expiresAt > this.clock()).map(({ id, label, timeZone, expiresAt }) => ({ id, label, timeZone, expiresAt }));
  }
  private async current(context: RadarContext, revision: number, reauthorize: ReauthorizeRadar, signal: AbortSignal) {
    const latest = await reauthorize();
    if (signal.aborted) throw new PersonalRadarError('CANCELLED');
    if (personalRadarOwner(latest, this.clock()) !== personalRadarOwner(context, this.clock())) throw new PersonalRadarError('CONFLICT');
    await this.feed.assertCurrent(latest, revision); return latest;
  }
  async sources(context: RadarContext, reauthorize: ReauthorizeRadar, signal: AbortSignal) {
    const publicSources = await this.feed.sources(context);
    const privateSources = await this.temporal.sources(context, reauthorize);
    const calendars = await this.choices(context, signal);
    if (publicSources.revision !== privateSources.revision) throw new PersonalRadarError('CONFLICT');
    const latest = await this.current(context, publicSources.revision, reauthorize, signal);
    const servedAt = this.clock();
    const validUntil = Math.min(servedAt + 60000, context.expiresAtMs, latest.expiresAtMs, ...calendars.map(c => c.expiresAt));
    if (validUntil <= servedAt) throw new PersonalRadarError('CONFLICT');
    return { ...publicSources, temporal: { sources: privateSources.sources, weatherAvailable: this.options.weatherAvailable,
      calendars, calendarAvailable: !!this.options.calendars, servedAt, validUntil } };
  }
  async preview(context: RadarContext, reauthorize: ReauthorizeRadar, signal: AbortSignal) {
    const publicView = await this.feed.preview(context);
    const latest = await this.current(context, publicView.revision, reauthorize, signal);
    // This is last: Calendar grants are checked after the outer request's final reauthentication.
    const privateView = await this.temporal.preview(latest, reauthorize, signal);
    if (privateView.revision !== publicView.revision) throw new PersonalRadarError('CONFLICT');
    await this.feed.assertCurrent(context, privateView.revision);
    const servedAt = this.clock(), validUntil = Math.min(publicView.validUntil, privateView.validUntil);
    if (signal.aborted || validUntil <= servedAt) throw new PersonalRadarError('CONFLICT');
    return { ...publicView, temporal: privateView.entries, servedAt, validUntil };
  }
  async configure(context: RadarContext, id: string, body: unknown, reauthorize: ReauthorizeRadar, signal: AbortSignal) {
    // Service owns exact body validation; these checks only restrict exposed provider capabilities.
    const input = (body as { source?: { kind?: unknown; enabled?: unknown; bindingId?: unknown; timeZone?: unknown } } | null)?.source;
    const refresh = async () => {
      const latest = await reauthorize();
      if (personalRadarOwner(latest, this.clock()) !== personalRadarOwner(context, this.clock())) throw new PersonalRadarError('CONFLICT');
      if (input?.enabled === true) {
        if (input.kind === 'weather' && !this.options.weatherAvailable) throw new PersonalRadarError('UNAVAILABLE');
        if (input.kind === 'calendar' && !(await this.choices(latest, signal)).some(c => c.id === input.bindingId && c.timeZone === input.timeZone))
          throw new PersonalRadarError('CONFLICT');
      }
      return latest;
    };
    return this.temporal.configure(context, id, body, refresh, signal);
  }
}
