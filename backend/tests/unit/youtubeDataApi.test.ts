import {describe,expect,it,vi} from 'vitest';
import {YouTubeDataApiSubscriptionTransport,YouTubeDataApiUploadReader} from '../../src/services/radar/youtubeDataApi.js';
import {YOUTUBE_READONLY_SCOPE,type YouTubeReadGrant} from '../../src/services/radar/youtubeSubscriptionInbox.js';
const NOW=1787932800000,owner='line:'+'a'.repeat(64),channel='UC'+'c'.repeat(22),grant:YouTubeReadGrant={owner,bindingId:'b'.repeat(64),revision:1,scope:YOUTUBE_READONLY_SCOPE,expiresAt:NOW+60000};
describe('YouTube Data API read adapters',()=>{
 it('uses mine=true, readonly broker and a field-limited 50 item subscription page',async()=>{
  const get=vi.fn(async()=>({nextPageToken:'next',items:[{snippet:{title:' 登録 ',resourceId:{channelId:channel}}}]}));
  const result=await new YouTubeDataApiSubscriptionTransport({get}).listSubscriptions(grant,undefined,new AbortController().signal);
  const path=get.mock.calls[0][1];expect(path).toContain('/youtube/v3/subscriptions?');expect(path).toContain('mine=true');expect(path).toContain('maxResults=50');
  expect(path).not.toContain('access_token');expect(result).toEqual({items:[{channelId:channel,title:'登録'}],nextPageToken:'next'});
 });
 it('discovers uploads without search.list and filters at the enrollment baseline',async()=>{
  const get=vi.fn(async(_g:YouTubeReadGrant,path:string)=>path.includes('/channels?')
   ? {items:[{id:channel,snippet:{title:'Channel'},contentDetails:{relatedPlaylists:{uploads:'UUplaylist'}}}]}
   : {items:[{contentDetails:{videoId:'v'.repeat(11),videoPublishedAt:new Date(NOW-1000).toISOString()},snippet:{title:'New',channelId:channel}},
     {contentDetails:{videoId:'o'.repeat(11),videoPublishedAt:new Date(NOW-90000).toISOString()},snippet:{title:'Old',channelId:channel}}]});
  const result=await new YouTubeDataApiUploadReader({get}).list(grant,[{channelId:channel}],{publishedAfter:NOW-5000,maxPerChannel:5,maxTotal:10},new AbortController().signal);
  expect(result.map(e=>e.videoId)).toEqual(['v'.repeat(11)]);expect(get.mock.calls.every(([,p])=>!p.includes('/search'))).toBe(true);
  expect(get.mock.calls.every(([,p])=>!p.includes('access_token'))).toBe(true);
 });
 it('discovers uploads across several channels with bounded playlist concurrency',async()=>{
  const channels=Array.from({length:8},(_,i)=>({channelId:'UC'+String(i).padStart(22,'d'),uploads:'UU'+String(i),title:'Ch'+i}));
  const get=vi.fn(async(_g:YouTubeReadGrant,path:string)=>{
   if(path.includes('/channels?'))return {items:channels.map(c=>({id:c.channelId,snippet:{title:c.title},contentDetails:{relatedPlaylists:{uploads:c.uploads}}}))};
   const playlist=new URLSearchParams(path.split('?')[1]??'').get('playlistId');
   const ch=channels.find(c=>c.uploads===playlist)!;
   return {items:[{contentDetails:{videoId:('v'+ch.channelId.replace(/\D/g,'')).padEnd(11,'x').slice(0,11),videoPublishedAt:new Date(NOW-1000).toISOString()},snippet:{title:'New',channelId:ch.channelId}}]};
  });
  const result=await new YouTubeDataApiUploadReader({get}).list(grant,channels.map(c=>({channelId:c.channelId})),{publishedAfter:NOW-5000,maxPerChannel:3,maxTotal:5},new AbortController().signal);
  expect(result).toHaveLength(5);expect(get.mock.calls.filter(([,p])=>String(p).includes('/playlistItems?')).length).toBe(8);
  expect(get.mock.calls.every(([,p])=>!String(p).includes('/search'))).toBe(true);
 });
 it('omits one failing playlist and still returns other channels',async()=>{
  const a='UC'+'a'.repeat(22),b='UC'+'b'.repeat(22);
  const get=vi.fn(async(_g:YouTubeReadGrant,path:string)=>{
   if(path.includes('/channels?'))return {items:[
    {id:a,snippet:{title:'A'},contentDetails:{relatedPlaylists:{uploads:'UUa'}}},
    {id:b,snippet:{title:'B'},contentDetails:{relatedPlaylists:{uploads:'UUb'}}}]};
   if(String(path).includes('playlistId=UUa'))throw new Error('GOOGLE_RADAR_UNAVAILABLE');
   return {items:[{contentDetails:{videoId:'b'.repeat(11),videoPublishedAt:new Date(NOW-1000).toISOString()},snippet:{title:'Kept',channelId:b}}]};
  });
  const result=await new YouTubeDataApiUploadReader({get}).list(grant,[{channelId:a},{channelId:b}],{publishedAfter:NOW-5000,maxPerChannel:3,maxTotal:10},new AbortController().signal);
  expect(result.map(e=>e.videoId)).toEqual(['b'.repeat(11)]);
 });
 it('aborts playlist discovery without issuing search.list',async()=>{
  const channels=Array.from({length:8},(_,i)=>({channelId:'UC'+String(i).padStart(22,'e')}));
  const c=new AbortController();let playlists=0;
  const get=vi.fn(async(_g:YouTubeReadGrant,path:string)=>{
   if(path.includes('/channels?'))return {items:channels.map((ch,i)=>({id:ch.channelId,snippet:{title:'Ch'+i},contentDetails:{relatedPlaylists:{uploads:'UU'+i}}}))};
   playlists++;if(playlists===1)c.abort();
   return {items:[]};
  });
  await expect(new YouTubeDataApiUploadReader({get}).list(grant,channels,{publishedAfter:NOW-5000,maxPerChannel:3,maxTotal:5},c.signal)).rejects.toThrow();
  expect(get.mock.calls.every(([,p])=>!String(p).includes('/search'))).toBe(true);
 });
 it('rejects duplicate subscriptions and malformed provider pages',async()=>{
  const reader=new YouTubeDataApiUploadReader({get:async()=>({items:'bad'})});
  await expect(reader.list(grant,[{channelId:channel},{channelId:channel}],{publishedAfter:NOW-5000,maxPerChannel:5,maxTotal:10},new AbortController().signal)).rejects.toThrow('INVALID_POLICY');
  await expect(reader.list(grant,[{channelId:channel}],{publishedAfter:NOW-5000,maxPerChannel:5,maxTotal:10},new AbortController().signal)).rejects.toThrow('INVALID_RESPONSE');
 });
});
