import { RadarClientError, sourceIdValid } from './radarClient';
export type TemporalInput = { enabled: boolean; consentExpiresAt: number; timeZone: string } & (
  { kind: 'weather'; latitudeTenth: number; longitudeTenth: number } | { kind: 'calendar'; bindingId: string; days: number });
export interface TemporalEntry { id: string; source: (TemporalInput & { revision: number }) | null }
export interface CalendarChoice { id: string; label: string; timeZone: string; expiresAt: number }
export interface TemporalSources { sources: TemporalEntry[]; weatherAvailable: boolean; calendarAvailable: boolean; calendars: CalendarChoice[]; servedAt: number; validUntil: number }
export interface WeatherDay { date: string; weatherCode: number | null; minimumC: number | null; maximumC: number | null; precipitationPercent: number | null }
export type CalendarWhen = { kind: 'timed'; start: string; end: string } | { kind: 'all-day'; startDate: string; endDateExclusive: string; timeZone: string };
export interface CalendarEvent { id: string; version: string; title: string; status: 'confirmed' | 'tentative'; when: CalendarWhen }
export type TemporalContent = { sourceId: string; sourceRevision: number; fetchedAt: number; validUntil: number; visibility: 'owner-only'; notify: false; partial: boolean; attribution: string; providerUrl: string } & (
  { kind: 'weather'; licenseUrl: string; items: WeatherDay[] } | { kind: 'calendar'; items: CalendarEvent[] });
export interface TemporalPreview { sourceId: string; sourceRevision: number; timeZone: string; content: TemporalContent }
const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const fail = (): never => { throw new RadarClientError('invalid'); };
const plain = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !/[<>\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(v);
export const validZone = (v: unknown): v is string => { if (typeof v !== 'string' || v.length > 100) return false; try { new Intl.DateTimeFormat('en-US',{timeZone:v}); return true; } catch { return false; } };
const dateOnly = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v+'T00:00:00Z')) && new Date(v+'T00:00:00Z').toISOString().slice(0,10) === v;
const iso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export function temporalInput(v: unknown): TemporalInput {
  if (!obj(v) || typeof v.enabled !== 'boolean' || !integer(v.consentExpiresAt) || !validZone(v.timeZone)) return fail();
  const base = { enabled:v.enabled, consentExpiresAt:v.consentExpiresAt, timeZone:v.timeZone };
  if (v.kind === 'weather' && Number.isInteger(v.latitudeTenth) && Math.abs(v.latitudeTenth)<=900 && Number.isInteger(v.longitudeTenth) && Math.abs(v.longitudeTenth)<=1800)
    return {...base,kind:'weather',latitudeTenth:v.latitudeTenth,longitudeTenth:v.longitudeTenth};
  if (v.kind === 'calendar' && sourceIdValid(v.bindingId) && Number.isInteger(v.days) && v.days>=1 && v.days<=7)
    return {...base,kind:'calendar',bindingId:v.bindingId,days:v.days};
  return fail();
}
export function decodeTemporalSources(v: unknown): TemporalSources {
  if (!obj(v) || !Array.isArray(v.sources) || v.sources.length>32 || !Array.isArray(v.calendars) || v.calendars.length>32
    || typeof v.weatherAvailable !== 'boolean' || typeof v.calendarAvailable !== 'boolean'
    || !integer(v.servedAt) || !integer(v.validUntil) || v.validUntil<=v.servedAt || v.validUntil>v.servedAt+60000) return fail();
  const sources:TemporalEntry[] = v.sources.map((e:unknown)=>{
    if (!obj(e) || !sourceIdValid(e.id)) return fail();
    if(e.source===null)return {id:e.id,source:null};
    if(!obj(e.source)||e.source.id!==e.id||!integer(e.source.revision)||e.source.revision<1)return fail();
    return {id:e.id,source:{...temporalInput(e.source),revision:e.source.revision}};
  });
  const calendars:CalendarChoice[]=v.calendars.map((c:unknown)=>{
    if(!obj(c)||!sourceIdValid(c.id)||!plain(c.label,80)||!validZone(c.timeZone)||!integer(c.expiresAt)||c.expiresAt<v.validUntil)return fail();
    return {id:c.id,label:c.label,timeZone:c.timeZone,expiresAt:c.expiresAt};
  });
  if(new Set(sources.map(s=>s.id)).size!==sources.length || new Set(calendars.map(c=>c.id)).size!==calendars.length || (!v.calendarAvailable&&calendars.length))return fail();
  return {sources,calendars,weatherAvailable:v.weatherAvailable,calendarAvailable:v.calendarAvailable,servedAt:v.servedAt,validUntil:v.validUntil};
}
export function decodeTemporalPreview(v:unknown,servedAt:number,validUntil:number):TemporalPreview[] {
  if(!Array.isArray(v)||v.length>3)return fail();
  const entries:TemporalPreview[]=v.map((e:unknown)=>{
    if(!obj(e)||!sourceIdValid(e.sourceId)||!integer(e.sourceRevision)||e.sourceRevision<1||!validZone(e.timeZone)||!obj(e.content))return fail();
    const c=e.content;
    if(c.sourceId!==e.sourceId||c.sourceRevision!==e.sourceRevision||c.visibility!=='owner-only'||c.notify!==false||typeof c.partial!=='boolean'
      ||!integer(c.fetchedAt)||c.fetchedAt>servedAt||!integer(c.validUntil)||c.validUntil<validUntil||c.validUntil<=servedAt
      ||!Array.isArray(c.items)||!plain(c.attribution,256))return fail();
    const base={sourceId:e.sourceId,sourceRevision:e.sourceRevision,fetchedAt:c.fetchedAt,validUntil:c.validUntil,visibility:'owner-only' as const,notify:false as const,partial:c.partial,attribution:c.attribution,providerUrl:c.providerUrl};
    let content:TemporalContent;
    if(c.kind==='weather'){
      if(c.items.length!==3||c.validUntil>c.fetchedAt+900000||c.providerUrl!=='https://open-meteo.com/'||c.licenseUrl!=='https://creativecommons.org/licenses/by/4.0/')return fail();
      const numberOrNull=(n:unknown,min:number,max:number)=>n===null||typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max;
      const items:WeatherDay[]=c.items.map((d:unknown)=>{
        if(!obj(d)||!dateOnly(d.date)||!(d.weatherCode===null||[0,1,2,3,45,48,51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99].includes(d.weatherCode))
          ||!numberOrNull(d.minimumC,-100,70)||!numberOrNull(d.maximumC,-100,70)||!numberOrNull(d.precipitationPercent,0,100)
          ||d.minimumC!==null&&d.maximumC!==null&&d.minimumC>d.maximumC)return fail();
        return {date:d.date,weatherCode:d.weatherCode,minimumC:d.minimumC,maximumC:d.maximumC,precipitationPercent:d.precipitationPercent};
      });
      if(new Set(items.map(d=>d.date)).size!==3)return fail();
      content={...base,kind:'weather',licenseUrl:c.licenseUrl,items};
    }else if(c.kind==='calendar'){
      if(c.items.length>20||c.validUntil>c.fetchedAt+60000||c.providerUrl!=='https://calendar.google.com/')return fail();
      const items:CalendarEvent[]=c.items.map((x:unknown)=>{
        if(!obj(x)||typeof x.id!=='string'||!/^[a-f0-9]{64}$/.test(x.id)||typeof x.version!=='string'||!/^[a-f0-9]{64}$/.test(x.version)
          ||!plain(x.title,180)||!['confirmed','tentative'].includes(x.status)||!obj(x.when))return fail();
        const w=x.when;let when:CalendarWhen;
        if(w.kind==='timed'&&iso(w.start)&&iso(w.end)&&w.start<w.end)when={kind:'timed',start:w.start,end:w.end};
        else if(w.kind==='all-day'&&dateOnly(w.startDate)&&dateOnly(w.endDateExclusive)&&w.startDate<w.endDateExclusive&&w.timeZone===e.timeZone)
          when={kind:'all-day',startDate:w.startDate,endDateExclusive:w.endDateExclusive,timeZone:w.timeZone};
        else return fail();
        return {id:x.id,version:x.version,title:x.title,status:x.status as CalendarEvent['status'],when};
      });
      if(new Set(items.map(x=>x.id)).size!==items.length)return fail();
      content={...base,kind:'calendar',items};
    }else return fail();
    return {sourceId:e.sourceId,sourceRevision:e.sourceRevision,timeZone:e.timeZone,content};
  });
  if(new Set(entries.map(e=>e.sourceId)).size!==entries.length)return fail();return entries;
}
