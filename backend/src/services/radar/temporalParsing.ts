import { timestamp } from '../../modules/radar/content.js';
import { validTemporalSource, type TemporalSource } from '../../modules/radar/temporalSources.js';

export class TemporalReadError extends Error {
  constructor(readonly code: 'INVALID_SOURCE' | 'DENIED' | 'CANCELLED' | 'UNAVAILABLE') { super(code); }
}
export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function sourceSnapshot<T extends TemporalSource>(source: T, now: number): T {
  if (!validTemporalSource(source, now)) throw new TemporalReadError('INVALID_SOURCE');
  return Object.freeze(structuredClone(source));
}
export function active(source: TemporalSource, startedAt: number, now: number, signal: AbortSignal) {
  if (signal.aborted) throw new TemporalReadError('CANCELLED');
  if (!timestamp(now) || now < startedAt || !validTemporalSource(source, now)) throw new TemporalReadError('DENIED');
}
export function boundedJson(text: string): Record<string, unknown> {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 256 * 1024) throw new TemporalReadError('UNAVAILABLE');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new TemporalReadError('UNAVAILABLE'); }
  if (!record(value)) throw new TemporalReadError('UNAVAILABLE');
  return value;
}
export const calendarDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
export function dateAt(time: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(time);
  return ['year', 'month', 'day'].map(kind => parts.find(p => p.type === kind)!.value).join('-');
}
export const nextDate = (date: string, days: number) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);

/** Bounds provider/broker waits too. A late value has no parsing/return continuation. No DB writes here. */
export async function temporalRead<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (signal.aborted) throw new TemporalReadError('CANCELLED');
  const child = new AbortController(); let stop!: () => void;
  const cancelled = new Promise<never>((_, reject) => { stop = () => { child.abort(); reject(new TemporalReadError('CANCELLED')); }; });
  signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, 8000);
  try { return await Promise.race([cancelled, work(child.signal)]); }
  catch (error) { throw error instanceof TemporalReadError ? error : new TemporalReadError('UNAVAILABLE'); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', stop); child.abort(); }
}
