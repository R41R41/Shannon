import type { LineRadarPolicy,LineYouTubeSubscriptionsSetting } from './radarPolicy.js';
import { lineKey } from './ledger.js';
import { RadarDiscoverySkills,type RadarCandidate,type RadarDeliveryReceiptPort,type RadarDigestSelection,type RawRadarCandidate } from '../radar/radarDiscovery.js';
import type { RadarFca } from '../radar/radarFca.js';

export interface LineRadarFcaPorts {
  fca: RadarFca;
  receipts: RadarDeliveryReceiptPort;
  youtube(owner:string,setting:LineYouTubeSubscriptionsSetting,limit:number,signal:AbortSignal):Promise<readonly RawRadarCandidate[]>;
  youtubeRecommendations?(owner:string,query:string,limit:number,signal:AbortSignal):Promise<readonly RawRadarCandidate[]>;
  twitter?(owner:string,query:string,limit:number,signal:AbortSignal):Promise<readonly RawRadarCandidate[]>;
  webSearch?(owner:string,query:string,limit:number,signal:AbortSignal):Promise<readonly RawRadarCandidate[]>;
}
interface NewsPreview { items:readonly {contentId:string;sourceId:string;card:{title:string;fact:string;metadata:readonly string[];sourceUrl:string}}[]; }
interface TemporalPreview { entries:readonly {sourceId:string;content:any;timeZone:string}[]; }

const safeTime=(value:unknown,fallback:number)=>typeof value==='string'&&Number.isSafeInteger(Date.parse(value))?Date.parse(value):fallback;
const webCandidates=(news:NewsPreview,policy:LineRadarPolicy,now:number,kind:'web'|'youtube')=>news.items.flatMap(item=>{
  const setting=policy.feeds.find(source=>source.id===item.sourceId&&source.kind===kind);if(!setting)return[];
  return[{source:kind,externalId:kind==='youtube'&&/^https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})$/.test(item.card.sourceUrl)
    ?item.card.sourceUrl.slice(-11):lineKey(item.card.sourceUrl),title:item.card.title,fact:item.card.fact,url:item.card.sourceUrl,
    publishedAt:safeTime(item.card.metadata[0],now),metadata:item.card.metadata} satisfies RawRadarCandidate];
});
const temporalCandidates=(temporal:TemporalPreview,kind:'weather'|'calendar')=>temporal.entries.flatMap(entry=>{
  const content=entry.content;if(content?.kind!==kind||!Array.isArray(content.items))return[];
  if(kind==='weather'){
    const day=content.items[0];if(!day)return[];
    return[{source:'weather' as const,externalId:`${entry.sourceId}:${day.date}`,title:`天気 ${day.date}`,
      fact:`最低 ${day.minimumC??'不明'}°C / 最高 ${day.maximumC??'不明'}°C / 降水確率 ${day.precipitationPercent??'不明'}%`,
      url:content.providerUrl,publishedAt:content.fetchedAt,metadata:[content.attribution]}];
  }
  return content.items.map((event:any)=>({source:'calendar' as const,externalId:event.id,title:event.title,
    fact:event.when.kind==='timed'?`${event.when.start} – ${event.when.end}`:`${event.when.startDate} – ${event.when.endDateExclusive}（終日）`,
    url:content.providerUrl,publishedAt:content.fetchedAt,metadata:[entry.timeZone,event.status]}));
});
const block=(item:{candidate:RadarCandidate;reason:string})=>[
  item.candidate.title.slice(0,180),item.candidate.fact.slice(0,320),
  item.candidate.metadata?.slice(0,2).join(' · ').slice(0,160),item.candidate.url,`選定理由: ${item.reason.slice(0,100)}`
].filter(Boolean).join('\n');

export async function selectLineRadarDigest(input:{owner:string;policy:LineRadarPolicy;news:NewsPreview;temporal:TemporalPreview;
  ports:LineRadarFcaPorts;signal:AbortSignal;now:number}):Promise<{selection:RadarDigestSelection;blocks:readonly string[]}>{
  const web=webCandidates(input.news,input.policy,input.now,'web'),feedYoutube=webCandidates(input.news,input.policy,input.now,'youtube');
  const weather=temporalCandidates(input.temporal,'weather'),calendar=temporalCandidates(input.temporal,'calendar');
  const setting=input.policy.youtubeSubscriptions;
  const skills=new RadarDiscoverySkills(input.owner,{
    youtube:async(limit,signal)=>Object.freeze([...(setting?await input.ports.youtube(input.owner,setting,limit,signal):[]),...feedYoutube].slice(0,limit)),
    ...(input.ports.youtubeRecommendations?{youtubeRecommendations:(query:string,limit:number,signal:AbortSignal)=>input.ports.youtubeRecommendations!(input.owner,query,limit,signal)}:{}),
    twitter:async(query,limit,signal)=>input.ports.twitter?input.ports.twitter(input.owner,query,limit,signal):Object.freeze([]),
    web:async(query,limit,signal)=>Object.freeze([...(input.ports.webSearch?await input.ports.webSearch(input.owner,query,limit,signal):[]),...web].slice(0,limit)),
    ...(input.policy.weather?{weather:async()=>Object.freeze(weather.slice(0,3))}:{}),
    ...(input.policy.calendar?{calendar:async(limit:number)=>Object.freeze(calendar.slice(0,limit))}:{})
  },input.ports.receipts,()=>input.now,{lane:'personal'});
  const result=await input.ports.fca.run(skills,input.policy.topics??[...new Set(input.policy.feeds.flatMap(feed=>feed.topicIds))],input.signal);
  const fitting:{candidate:RadarCandidate;reason:string}[]=[];const blocks:string[]=[];let bytes=Buffer.byteLength('Shannon Radar\n\n\n配信停止:「配信停止」');
  for(const item of result.selection.items){const rendered=block(item);const size=Buffer.byteLength(rendered)+2;if(bytes+size>4200)continue;bytes+=size;fitting.push(item);blocks.push(rendered);}
  const reserved=await skills.reserve({items:fitting,...(!fitting.length&&result.selection.silenceReason?{silenceReason:result.selection.silenceReason}:{})},input.signal);
  const accepted=new Set(reserved.items.map(item=>item.candidate.candidateId));
  return Object.freeze({selection:reserved,blocks:Object.freeze(blocks.filter((_value,index)=>accepted.has(fitting[index].candidate.candidateId)))});
}
