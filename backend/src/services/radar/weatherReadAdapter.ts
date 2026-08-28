import type { PersonalTemporalSnapshot, WeatherDay, WeatherSource } from '../../modules/radar/temporalSources.js';
import type { FeedHttpPort } from './safeFeedHttp.js';
import { active, boundedJson, calendarDate, dateAt, nextDate, record, sourceSnapshot, temporalRead, TemporalReadError } from './temporalParsing.js';

const codes = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];
export function weatherRequestUrl(source: WeatherSource, now: number): string {
  const s = sourceSnapshot(source, now); if (s.kind !== 'weather') throw new TemporalReadError('INVALID_SOURCE');
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({ latitude: String(s.latitudeTenth / 10), longitude: String(s.longitudeTenth / 10),
    daily: 'weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max',
    temperature_unit: 'celsius', timezone: s.timeZone, forecast_days: '3' }).toString();
  return url.href;
}
const value = (v: unknown, low: number, high: number): v is number | null => v === null
  || typeof v === 'number' && Number.isFinite(v) && v >= low && v <= high;
export function parseWeather(text: string, source: WeatherSource, now: number): readonly WeatherDay[] {
  const s = sourceSnapshot(source, now); if (s.kind !== 'weather') throw new TemporalReadError('INVALID_SOURCE'); const data = boundedJson(text);
  const daily = data.daily; const units = data.daily_units;
  if (data.error || !record(daily) || !record(units) || units.time !== 'iso8601'
    || units.weather_code !== 'wmo code' || units.temperature_2m_min !== '°C' || units.temperature_2m_max !== '°C'
    || units.precipitation_probability_max !== '%' || typeof data.latitude !== 'number' || typeof data.longitude !== 'number'
    || !Number.isFinite(data.latitude) || !Number.isFinite(data.longitude) || Math.abs(data.latitude) > 90 || Math.abs(data.longitude) > 180
    || Math.abs(data.latitude - s.latitudeTenth / 10) > 0.5
    || Math.min(Math.abs(data.longitude - s.longitudeTenth / 10), 360 - Math.abs(data.longitude - s.longitudeTenth / 10)) > 0.5)
    throw new TemporalReadError('UNAVAILABLE');
  try {
    if (new Intl.DateTimeFormat('en-US', { timeZone: String(data.timezone) }).resolvedOptions().timeZone
      !== new Intl.DateTimeFormat('en-US', { timeZone: s.timeZone }).resolvedOptions().timeZone) throw new Error();
  } catch { throw new TemporalReadError('UNAVAILABLE'); }
  const keys = ['time', 'weather_code', 'temperature_2m_min', 'temperature_2m_max', 'precipitation_probability_max'];
  if (keys.some(k => !Array.isArray(daily[k]) || (daily[k] as unknown[]).length !== 3)) throw new TemporalReadError('UNAVAILABLE');
  const array = (k: string) => daily[k] as unknown[];
  const today = dateAt(now, s.timeZone);
  return Object.freeze(array('time').map((date, i) => {
    const code = array('weather_code')[i]; const min = array('temperature_2m_min')[i];
    const max = array('temperature_2m_max')[i]; const rain = array('precipitation_probability_max')[i];
    if (!calendarDate(date) || date !== nextDate(today, i) || (code !== null && !codes.includes(code as number))
      || !value(min, -100, 70) || !value(max, -100, 70) || !value(rain, 0, 100)
      || (min !== null && max !== null && min > max)) throw new TemporalReadError('UNAVAILABLE');
    return Object.freeze({ date, weatherCode: code as number | null, minimumC: min, maximumC: max, precipitationPercent: rain });
  }));
}

/** Low-level connector only: caller must authenticate, reserve budget and recheck registry before use/commit.
 * No default transport, credentials, DB writes, retries, notifications or ambient location.
 */
export class WeatherReadAdapter {
  constructor(private readonly http: FeedHttpPort, private readonly clock: () => number = Date.now) {}
  async read(source: WeatherSource, signal: AbortSignal): Promise<PersonalTemporalSnapshot<WeatherDay>> {
    const startedAt = this.clock(); const s = sourceSnapshot(source, startedAt); if (s.kind !== 'weather') throw new TemporalReadError('INVALID_SOURCE'); active(s, startedAt, startedAt, signal);
    const text = await temporalRead(signal, child => this.http.get(weatherRequestUrl(s, startedAt), child));
    const now = this.clock(); active(s, startedAt, now, signal);
    const items = parseWeather(text, s, now);
    return Object.freeze({ kind: 'weather', owner: s.owner, sourceId: s.id, sourceRevision: s.revision,
      fetchedAt: now, validUntil: Math.min(now + 15 * 60000, s.consentExpiresAt), visibility: 'owner-only', notify: false,
      partial: items.some(i => Object.values(i).some(v => v === null)), attribution: 'Weather data by Open-Meteo.com (CC BY 4.0); selected daily fields, values unchanged',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      providerUrl: 'https://open-meteo.com/', items });
  }
}
