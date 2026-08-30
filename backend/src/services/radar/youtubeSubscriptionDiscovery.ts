import type { RawRadarCandidate } from './radarDiscovery.js';
import type { YouTubeDataApiUploadReader } from './youtubeDataApi.js';
import { YOUTUBE_READONLY_SCOPE,type YouTubeReadGrant,type YouTubeSubscriptionReader } from './youtubeSubscriptionInbox.js';

const OWNER=/^line:[a-f0-9]{64}$/;
const validGrant=(grant:YouTubeReadGrant,owner:string,now:number,binding?:YouTubeReadGrant)=>grant.owner===owner&&/^[a-f0-9]{64}$/.test(grant.bindingId)
  &&Number.isSafeInteger(grant.revision)&&grant.revision>0&&grant.scope===YOUTUBE_READONLY_SCOPE&&Number.isSafeInteger(grant.expiresAt)&&grant.expiresAt>now
  &&(!binding||(grant.bindingId===binding.bindingId&&grant.revision===binding.revision));
/** Read-only implementation behind get_unshared_youtube_videos. Receipt filtering is performed by the run-scoped skill set. */
export class YouTubeSubscriptionDiscovery {
  constructor(private readonly subscriptions:Pick<YouTubeSubscriptionReader,'list'>,private readonly uploads:Pick<YouTubeDataApiUploadReader,'list'>,
    private readonly owner:string,private readonly authorize:()=>Promise<YouTubeReadGrant>,private readonly baselineAt:number,
    private readonly maxSubscriptions=500,private readonly now=Date.now){if(!OWNER.test(owner)||!Number.isSafeInteger(baselineAt)||!Number.isSafeInteger(maxSubscriptions)||maxSubscriptions<1||maxSubscriptions>500)throw new Error('YOUTUBE_SKILL_CONFIG_INVALID');}
  async find(limit:number,signal:AbortSignal):Promise<readonly RawRadarCandidate[]>{
    const now=this.now();if(!Number.isSafeInteger(limit)||limit<1||limit>20||this.baselineAt>now)throw new Error('YOUTUBE_SKILL_POLICY_INVALID');
    const binding=await this.authorize();if(!validGrant(binding,this.owner,now))throw new Error('YOUTUBE_SKILL_DENIED');
    const bound=async()=>{const grant=await this.authorize();if(!validGrant(grant,this.owner,this.now(),binding))throw new Error('YOUTUBE_SKILL_DENIED');return grant;};
    const channels=await this.subscriptions.list(this.owner,bound,signal,{maxSubscriptions:this.maxSubscriptions});if(!channels.length)return Object.freeze([]);
    const publishedAfter=Math.max(this.baselineAt,now-72*60*60*1000);
    const videos=await this.uploads.list(await bound(),channels,{publishedAfter,maxPerChannel:3,maxTotal:limit},signal);await bound();
    return Object.freeze(videos.slice(0,limit).map(video=>Object.freeze({source:'youtube' as const,externalId:video.videoId,title:video.title,
      fact:`${video.channelTitle} · ${new Date(video.publishedAt).toISOString()}`,url:`https://www.youtube.com/watch?v=${video.videoId}`,
      publishedAt:video.publishedAt,metadata:Object.freeze([video.channelTitle])})));
  }
}
