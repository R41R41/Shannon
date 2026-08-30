import { createHash } from 'node:crypto';
import type { TemporalSource } from '../../modules/radar/temporalSources.js';
import type { TemporalSnapshot } from '../../modules/radar/catalogVersion.js';
import type { TemporalCatalogReader } from './personalTemporalRadar.js';
import type { WeatherReadAdapter } from './weatherReadAdapter.js';
import type { CalendarReadAdapter } from './calendarReadAdapter.js';
import { PersonalRadarError } from './radarAccess.js';
/** Explicit adapters only, no transport defaults or ambient credentials. */
export class PersonalTemporalReaders implements TemporalCatalogReader {
  constructor(private readonly weather?: WeatherReadAdapter, private readonly calendar?: CalendarReadAdapter) {}
  async authorize(source: TemporalSource, signal: AbortSignal) {
    if (signal.aborted) throw new PersonalRadarError('CANCELLED');
    if (source.kind === 'calendar' && this.calendar) return this.calendar.authorize(source, signal);
    if (source.kind === 'weather' && this.weather) return { stamp: createHash('sha256').update(JSON.stringify(source)).digest('hex'), expiresAt: source.consentExpiresAt };
    throw new PersonalRadarError('UNAVAILABLE');
  }
  async read(source: TemporalSource, signal: AbortSignal): Promise<TemporalSnapshot> {
    if (source.kind === 'weather' && this.weather) return { ...await this.weather.read(source,signal), kind: 'weather' };
    if (source.kind === 'calendar' && this.calendar) return { ...await this.calendar.read(source,signal), kind: 'calendar' };
    throw new PersonalRadarError('UNAVAILABLE');
  }
}
