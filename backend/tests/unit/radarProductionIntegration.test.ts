import { describe,expect,it,vi } from 'vitest';
import { CalendarReadAdapter,CALENDAR_READ_SCOPE } from '../../src/services/radar/calendarReadAdapter.js';
import { GoogleRadarOAuthBroker,googleRadarBindingId } from '../../src/services/radar/googleRadarOAuth.js';
import { YOUTUBE_READONLY_SCOPE } from '../../src/services/radar/youtubeSubscriptionInbox.js';
import { RadarFca } from '../../src/services/radar/radarFca.js';
import { selectLineRadarDigest } from '../../src/services/line/lineRadarFcaSelection.js';
import { parseLineRadarPolicy } from '../../src/services/line/radarPolicy.js';
const owner='line:'+'a'.repeat(64),now=Date.parse('2026-08-29T03:00:00Z');
const config={clientId:'client-id-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com',clientSecret:'secret_abcdefghijk',refreshToken:'refresh_abcdefghijklmnopqrstuvwxyz'};
const tokenBody={access_token:'access_abcdefghijklmnopqrstuvwxyz',expires_in:3600,scope:[YOUTUBE_READONLY_SCOPE,CALENDAR_READ_SCOPE].join(' ')};
describe('Google Radar OAuth broker',()=>{
  it('keeps the bearer out of URLs and enforces the exact read-only scope set',async()=>{
    const http=vi.fn(async(url:any,init:any)=>{
      if(String(url).includes('oauth2'))return new Response(JSON.stringify(tokenBody),{status:200});
      expect(String(url)).toContain('/youtube/v3/subscriptions?');expect(String(url)).not.toContain('access_');
      expect(init.headers.authorization).toContain('access_');return new Response(JSON.stringify({items:[]}),{status:200});
    });
    const broker=new GoogleRadarOAuthBroker(config,owner,()=>now,http as any);
    const grant=await broker.authorizeYouTube(new AbortController().signal);
    expect(grant).toMatchObject({owner,scope:YOUTUBE_READONLY_SCOPE,bindingId:googleRadarBindingId(config,owner)});
    expect(await broker.get(grant,'/youtube/v3/subscriptions?part=snippet&mine=true',new AbortController().signal)).toEqual({items:[]});
    await expect(broker.get(grant,'/youtube/v3/search?part=snippet',new AbortController().signal)).rejects.toThrow('GOOGLE_RADAR_DENIED');
  });
  it('bridges the same bounded grant into the existing sanitized Calendar adapter',async()=>{
    const http=vi.fn(async(url:any)=>{
      if(String(url).includes('oauth2'))return new Response(JSON.stringify(tokenBody),{status:200});
      return new Response(JSON.stringify({kind:'calendar#events',timeZone:'Asia/Tokyo',accessRole:'reader',items:[]}),{status:200});
    });
    const broker=new GoogleRadarOAuthBroker(config,owner,()=>now,http as any);
    const source={id:'calendar',kind:'calendar' as const,revision:1,owner,enabled:true,consentExpiresAt:now+86400000,timeZone:'Asia/Tokyo',
      bindingId:broker.bindingId,days:7};
    const snapshot=await new CalendarReadAdapter(broker,()=>now).read(source,new AbortController().signal);
    expect(snapshot).toMatchObject({kind:'calendar',owner,visibility:'owner-only',items:[]});
    expect(String(http.mock.calls.at(-1)?.[0])).toContain('/calendar/v3/calendars/primary/events?');
  });
});
describe('LINE Radar FCA production selection',()=>{
  it('accepts the expanded protected policy and permanently reserves only the submitted candidate',async()=>{
    const policy=parseLineRadarPolicy({version:1,enabled:true,hourJst:12,minuteJst:0,consentExpiresAt:now+86400000,feeds:[],weather:null,
      topics:['science'],youtubeSubscriptions:{baselineAt:now-1000,maxSubscriptions:500,maxCandidates:20},calendar:null},now);
    const stored=new Set<string>();
    const receipts={existing:async(_o:string,keys:readonly string[])=>new Set(keys.filter(k=>stored.has(k))),
      reserve:async(_o:string,key:string)=>{if(stored.has(key))return false;stored.add(key);return true;}};
    let turn=0;const fca=new RadarFca({next:async(input)=>{
      turn++;if(turn===1)return{content:'',toolCalls:[{id:'call_y',name:'get_unshared_youtube_videos',arguments:{limit:20}}]};
      const payload=JSON.parse(input.messages.at(-1)!.content);const id=payload.untrustedCandidates[0].candidateId;
      return{content:'',toolCalls:[{id:'call_s',name:'submit_personal_digest',arguments:{items:[{candidateId:id,reason:'新着で関心テーマに近い'}]}}]};
    }});
    const result=await selectLineRadarDigest({owner,policy,news:{items:[]},temporal:{entries:[]},ports:{fca,receipts,
      youtube:async()=>[{source:'youtube',externalId:'abcdefghijk',title:'新着動画',fact:'架空チャンネル · 2026-08-29',url:'https://www.youtube.com/watch?v=abcdefghijk',publishedAt:now}]},
      signal:new AbortController().signal,now});
    expect(result.selection.items).toHaveLength(1);expect(result.blocks[0]).toContain('選定理由');expect(stored.size).toBe(1);
  });
});
