import { createHash } from 'node:crypto';
import type { CalendarSource } from '../../modules/radar/temporalSources.js';
import { CALENDAR_READ_SCOPE,type BoundCalendarReader,type CalendarListRequest,type CalendarReadAuthority } from './calendarReadAdapter.js';
import type { AuthorizedYouTubeGet } from './youtubeDataApi.js';
import { YOUTUBE_READONLY_SCOPE,type YouTubeReadGrant } from './youtubeSubscriptionInbox.js';

const OWNER=/^line:[a-f0-9]{64}$/;
const REQUIRED=Object.freeze([YOUTUBE_READONLY_SCOPE,CALENDAR_READ_SCOPE]);
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
type Token={accessToken:string;expiresAt:number;revision:number};
export interface GoogleRadarOAuthConfig { clientId:string;clientSecret:string;refreshToken:string; }
const configured=(c:GoogleRadarOAuthConfig)=>typeof c.clientId==='string'&&/^[A-Za-z0-9._-]{20,256}$/.test(c.clientId)
  &&typeof c.clientSecret==='string'&&/^[A-Za-z0-9._-]{8,256}$/.test(c.clientSecret)
  &&typeof c.refreshToken==='string'&&/^[A-Za-z0-9_./-]{20,1024}$/.test(c.refreshToken);
export const googleRadarBindingId=(config:GoogleRadarOAuthConfig,owner:string)=>{
  if(!configured(config)||!OWNER.test(owner))throw new Error('GOOGLE_RADAR_OAUTH_CONFIG');
  return digest(JSON.stringify([owner,config.clientId,config.refreshToken]));
};

/** Dedicated in-memory refresh broker. Tokens never enter URLs, Mongo, logs, tool results or the LINE ledger. */
export class GoogleRadarOAuthBroker implements AuthorizedYouTubeGet,CalendarReadAuthority{
  readonly bindingId:string;private cached?:Token;private refreshTask?:Promise<Token>;
  constructor(private readonly config:GoogleRadarOAuthConfig,private readonly owner:string,private readonly now=Date.now,
    private readonly http:typeof fetch=fetch){this.bindingId=googleRadarBindingId(config,owner);}
  private async body(response:Response,max=1024*1024){const declared=Number(response.headers.get('content-length')??0);if(declared>max)throw new Error('GOOGLE_RADAR_RESPONSE');
    const text=await response.text();if(Buffer.byteLength(text)>max)throw new Error('GOOGLE_RADAR_RESPONSE');return text;}
  private token(signal:AbortSignal):Promise<Token>{
    if(this.cached&&this.cached.expiresAt>this.now()+120000)return Promise.resolve(this.cached);
    if(this.refreshTask)return this.refreshTask;
    const task=(async()=>{signal.throwIfAborted();const response=await this.http('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',
      headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.config.clientId,client_secret:this.config.clientSecret,
        refresh_token:this.config.refreshToken,grant_type:'refresh_token'}),signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
      const text=await this.body(response,65536);let value:any;try{value=JSON.parse(text);}catch{throw new Error('GOOGLE_RADAR_OAUTH');}
      const scopes=typeof value.scope==='string'?value.scope.split(/\s+/).filter(Boolean).sort():[];
      if(!response.ok||typeof value.access_token!=='string'||value.access_token.length<20||value.access_token.length>4096
        ||!Number.isSafeInteger(value.expires_in)||value.expires_in<300||value.expires_in>86400
        ||JSON.stringify(scopes)!==JSON.stringify([...REQUIRED].sort()))throw new Error('GOOGLE_RADAR_OAUTH');
      const token=Object.freeze({accessToken:value.access_token,expiresAt:this.now()+value.expires_in*1000,revision:(this.cached?.revision??0)+1});this.cached=token;return token;
    })();this.refreshTask=task;void task.finally(()=>{if(this.refreshTask===task)this.refreshTask=undefined;}).catch(()=>undefined);return task;
  }
  async authorizeYouTube(signal:AbortSignal):Promise<YouTubeReadGrant>{const token=await this.token(signal);return Object.freeze({owner:this.owner,bindingId:this.bindingId,
    revision:token.revision,scope:YOUTUBE_READONLY_SCOPE,expiresAt:token.expiresAt});}
  async get(grant:YouTubeReadGrant,pathAndQuery:string,signal:AbortSignal):Promise<unknown>{
    if(grant.owner!==this.owner||grant.bindingId!==this.bindingId||grant.scope!==YOUTUBE_READONLY_SCOPE
      ||!/^\/youtube\/v3\/(?:subscriptions|channels|playlistItems)\?[A-Za-z0-9%&=,._-]+$/.test(pathAndQuery))throw new Error('GOOGLE_RADAR_DENIED');
    const token=await this.token(signal);if(grant.revision!==token.revision||grant.expiresAt!==token.expiresAt)throw new Error('GOOGLE_RADAR_DENIED');
    const response=await this.http(`https://www.googleapis.com${pathAndQuery}`,{method:'GET',redirect:'error',headers:{authorization:`Bearer ${token.accessToken}`},
      signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});const text=await this.body(response);if(!response.ok)throw new Error('GOOGLE_RADAR_UNAVAILABLE');
    try{return JSON.parse(text);}catch{throw new Error('GOOGLE_RADAR_RESPONSE');}
  }
  async authorize(source:CalendarSource,signal:AbortSignal):Promise<BoundCalendarReader>{
    if(source.owner!==this.owner||source.bindingId!==this.bindingId||source.kind!=='calendar')throw new Error('GOOGLE_RADAR_DENIED');
    const token=await this.token(signal);const binding=Object.freeze({id:this.bindingId,owner:this.owner,sourceId:source.id,sourceRevision:source.revision,
      version:token.revision,calendarId:'primary',timeZone:source.timeZone,expiresAt:token.expiresAt,scopes:Object.freeze([CALENDAR_READ_SCOPE])});
    return Object.freeze({binding,read:async(request:CalendarListRequest,child:AbortSignal)=>{
      if(request.calendarId!=='primary'||request.timeZone!==source.timeZone||request.maxResults!==20||request.singleEvents!==true||request.orderBy!=='startTime'
        ||request.showDeleted!==false||request.fields!=='kind,timeZone,accessRole,nextPageToken,items(id,status,eventType,summary,start,end,updated)')throw new Error('GOOGLE_RADAR_DENIED');
      const current=await this.token(child);if(current.revision!==token.revision||current.expiresAt!==token.expiresAt)throw new Error('GOOGLE_RADAR_DENIED');
      const query=new URLSearchParams({timeMin:request.timeMin,timeMax:request.timeMax,timeZone:request.timeZone,singleEvents:'true',orderBy:'startTime',
        showDeleted:'false',maxResults:'20',eventTypes:'default',fields:request.fields});
      const response=await this.http(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${query}`,{method:'GET',redirect:'error',
        headers:{authorization:`Bearer ${current.accessToken}`},signal:AbortSignal.any([child,AbortSignal.timeout(10000)])});
      const text=await this.body(response);if(!response.ok)throw new Error('GOOGLE_RADAR_UNAVAILABLE');return text;
    }});
  }
}
