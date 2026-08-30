import { describe, expect, it, vi } from 'vitest';
import { YouTubeOfficialViewState, YouTubeSubscriptionReader, reserveUnseenYouTubeUploads,
  YOUTUBE_READONLY_SCOPE, type YouTubeDeliveryReceiptPort, type YouTubeReadGrant, type YouTubeViewState } from '../../src/services/radar/youtubeSubscriptionInbox.js';

const NOW=1787932800000, owner='line:'+'a'.repeat(64), binding='b'.repeat(64);
const channel=(n='a')=>'UC'+n.repeat(22), video=(n='v')=>n.repeat(11);
const grant=(patch:Partial<YouTubeReadGrant>={}):YouTubeReadGrant=>({owner,bindingId:binding,revision:1,scope:YOUTUBE_READONLY_SCOPE,expiresAt:NOW+60000,...patch});
const upload=(id=video(),patch={})=>({videoId:id,channelId:channel(),channelTitle:'登録ch',title:'新着',publishedAt:NOW-1000,...patch});
class Receipts implements YouTubeDeliveryReceiptPort { ids=new Set<string>(); async reserve(_o:string,id:string){if(this.ids.has(id))return false;this.ids.add(id);return true;} }

describe('YouTube subscription inbox',()=>{
  it('paginates authorized subscriptions, normalizes and deduplicates channel identity',async()=>{
    const listSubscriptions=vi.fn(async (_g:YouTubeReadGrant,token:string|undefined)=>token
      ? {items:[{channelId:channel('b'),title:' B '},{channelId:'bad',title:'bad'}]}
      : {items:[{channelId:channel('a'),title:' A '},{channelId:channel('a'),title:' A '}],nextPageToken:'next'});
    const reader=new YouTubeSubscriptionReader({listSubscriptions},()=>NOW);
    expect(await reader.list(owner,async()=>grant(),new AbortController().signal,{maxSubscriptions:10})).toEqual([
      {channelId:channel('a'),title:'A'},{channelId:channel('b'),title:'B'}]);
    expect(listSubscriptions).toHaveBeenCalledTimes(2);
  });
  it('rechecks binding revision around every page and refuses partial results after revocation',async()=>{
    let calls=0;const reader=new YouTubeSubscriptionReader({listSubscriptions:async()=>({items:[],nextPageToken:'next'})},()=>NOW);
    await expect(reader.list(owner,async()=>grant({revision:++calls<3?1:2}),new AbortController().signal,{maxSubscriptions:10})).rejects.toThrow('DENIED');
  });
  it('fails closed for unknown official watch state and only emits explicit unviewed evidence',async()=>{
    const receipts=new Receipts(), uploads=[upload(video('a')),upload(video('b'),{publishedAt:NOW-2000})];
    const official=new YouTubeOfficialViewState();
    expect(await reserveUnseenYouTubeUploads(owner,uploads,official,receipts,{baselineAt:NOW-5000,maxSubscriptions:10,maxCandidates:3,unknownViewState:'defer'},NOW,new AbortController().signal)).toEqual([]);
    const states=new Map<string,YouTubeViewState>([[video('a'),'viewed'],[video('b'),'unviewed']]);
    const selected=await reserveUnseenYouTubeUploads(owner,uploads,{states:async()=>states},receipts,{baselineAt:NOW-5000,maxSubscriptions:10,maxCandidates:3,unknownViewState:'defer'},NOW,new AbortController().signal);
    expect(selected.map(e=>e.videoId)).toEqual([video('b')]);
  });
  it('never reserves videos at/before enrollment baseline and does not backfill old subscriptions',async()=>{
    const receipts=new Receipts();const selected=await reserveUnseenYouTubeUploads(owner,[upload(video('a'),{publishedAt:NOW-5000}),upload(video('b'))],
      {states:async(_o,ids)=>new Map(ids.map(id=>[id,'unviewed' as const]))},receipts,{baselineAt:NOW-5000,maxSubscriptions:10,maxCandidates:3,unknownViewState:'defer'},NOW,new AbortController().signal);
    expect(selected.map(e=>e.videoId)).toEqual([video('b')]);
  });
  it('uses an insert-only receipt to suppress repeated and eight concurrent delivery attempts',async()=>{
    const receipts=new Receipts(), views={states:async(_o:string,ids:readonly string[])=>new Map(ids.map(id=>[id,'unviewed' as const]))};
    const policy={baselineAt:NOW-5000,maxSubscriptions:10,maxCandidates:3,unknownViewState:'defer' as const};
    const results=await Promise.all(Array.from({length:8},()=>reserveUnseenYouTubeUploads(owner,[upload()],views,receipts,policy,NOW,new AbortController().signal)));
    expect(results.flat()).toHaveLength(1);
    expect(await reserveUnseenYouTubeUploads(owner,[upload()],views,receipts,policy,NOW,new AbortController().signal)).toEqual([]);
  });
  it('allows an explicit approximation while preserving the unknown label as a product decision',async()=>{
    const selected=await reserveUnseenYouTubeUploads(owner,[upload()],new YouTubeOfficialViewState(),new Receipts(),
      {baselineAt:NOW-5000,maxSubscriptions:10,maxCandidates:3,unknownViewState:'assume-unviewed'},NOW,new AbortController().signal);
    expect(selected).toHaveLength(1);
  });
  it('rejects oversized pages, subscription overflow and conflicting duplicate video identities',async()=>{
    const tooMany=Array.from({length:51},(_,i)=>({channelId:channel(i%2?'a':'b'),title:'x'}));
    const reader=new YouTubeSubscriptionReader({listSubscriptions:async()=>({items:tooMany})},()=>NOW);
    await expect(reader.list(owner,async()=>grant(),new AbortController().signal,{maxSubscriptions:10})).rejects.toThrow('INVALID_RESPONSE');
    await expect(reserveUnseenYouTubeUploads(owner,[upload(),upload(video(),{title:'conflict'})],{states:async()=>new Map()},new Receipts(),
      {baselineAt:NOW-5000,maxSubscriptions:10,maxCandidates:3,unknownViewState:'defer'},NOW,new AbortController().signal)).rejects.toThrow('CONFLICT');
  });
});
