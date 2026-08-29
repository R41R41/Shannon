import { describe,expect,it,vi } from 'vitest';
import { YouTubeSubscriptionDiscovery } from '../../src/services/radar/youtubeSubscriptionDiscovery.js';
import { YOUTUBE_READONLY_SCOPE,type YouTubeReadGrant } from '../../src/services/radar/youtubeSubscriptionInbox.js';
const NOW=1787932800000,owner='line:'+'a'.repeat(64),bindingId='b'.repeat(64),channel='UC'+'c'.repeat(22);
const grant=(patch:Partial<YouTubeReadGrant>={}):YouTubeReadGrant=>({owner,bindingId,revision:1,scope:YOUTUBE_READONLY_SCOPE,expiresAt:NOW+60000,...patch});
describe('registered YouTube discovery skill backend',()=>{
  it('returns at most twenty recent subscription uploads as minimal read-only candidates',async()=>{const subscriptions={list:vi.fn(async()=>[{channelId:channel,title:'Channel'}])};
    const uploads={list:vi.fn(async()=>Array.from({length:20},(_,i)=>({videoId:String(i).padStart(11,'0'),channelId:channel,channelTitle:'Channel',title:`Video ${i}`,publishedAt:NOW-i*1000})))};
    const service=new YouTubeSubscriptionDiscovery(subscriptions as any,uploads as any,owner,async()=>grant(),NOW-86400000,500,()=>NOW);
    const result=await service.find(20,new AbortController().signal);expect(result).toHaveLength(20);expect(result[0]).toEqual(expect.objectContaining({source:'youtube',url:'https://www.youtube.com/watch?v=00000000000'}));
    expect(uploads.list).toHaveBeenCalledWith(expect.objectContaining({scope:YOUTUBE_READONLY_SCOPE}),[{channelId:channel,title:'Channel'}],{publishedAfter:NOW-86400000,maxPerChannel:3,maxTotal:20},expect.any(AbortSignal));});
  it('rechecks the same binding and revision after discovery',async()=>{const subscriptions={list:async()=>[{channelId:channel,title:'Channel'}]},uploads={list:async()=>[]};let calls=0;
    const service=new YouTubeSubscriptionDiscovery(subscriptions as any,uploads as any,owner,async()=>grant({revision:++calls<3?1:2}),NOW-86400000,500,()=>NOW);
    await expect(service.find(20,new AbortController().signal)).rejects.toThrow('YOUTUBE_SKILL_DENIED');});
});
