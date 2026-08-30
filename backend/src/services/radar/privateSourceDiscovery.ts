import type { RawRadarCandidate } from './radarDiscovery.js';

const OWNER=/^line:[a-f0-9]{64}$/;const HASH=/^[a-f0-9]{64}$/;
const clean=(v:unknown,max:number)=>typeof v==='string'&&v.trim()&&v.trim().length<=max&&!/[\u0000-\u001f\u007f]/.test(v)?v.trim():undefined;
export interface PrivateReadGrant {owner:string;bindingId:string;version:number;expiresAt:number;scope:string}
export interface SelectedNotionRow {pageId:string;title:string;summary:string;url:string;lastEditedAt:number}
export interface ImportantGmailRow {messageId:string;threadId:string;subject:string;sender:string;receivedAt:number;url:string}
export interface PrivateReadAuthority<T> {authorize(owner:string,signal:AbortSignal):Promise<PrivateReadGrant>;read(grant:PrivateReadGrant,limit:number,signal:AbortSignal):Promise<readonly T[]>}
const grant=(g:PrivateReadGrant,owner:string,scope:string,now:number,first?:PrivateReadGrant)=>g?.owner===owner&&HASH.test(g.bindingId)
  &&Number.isSafeInteger(g.version)&&g.version>0&&Number.isSafeInteger(g.expiresAt)&&g.expiresAt>now&&g.scope===scope
  &&(!first||(g.bindingId===first.bindingId&&g.version===first.version&&g.expiresAt===first.expiresAt));
async function bound<T>(owner:string,scope:string,limit:number,authority:PrivateReadAuthority<T>,now:()=>number,signal:AbortSignal){
  if(!OWNER.test(owner)||!Number.isSafeInteger(limit)||limit<1||limit>10)throw new Error('PRIVATE_DISCOVERY_POLICY_INVALID');
  const first=await authority.authorize(owner,signal);if(!grant(first,owner,scope,now()))throw new Error('PRIVATE_DISCOVERY_DENIED');
  const rows=await authority.read(first,limit,signal);signal.throwIfAborted();
  const current=await authority.authorize(owner,signal);if(!grant(current,owner,scope,now(),first))throw new Error('PRIVATE_DISCOVERY_DENIED');
  if(!Array.isArray(rows)||rows.length>limit)throw new Error('PRIVATE_DISCOVERY_RESPONSE_INVALID');return rows;
}
/** Only pages explicitly allowed by the injected authority. Workspace-wide search is outside this contract. */
export class SelectedNotionDiscovery{
  constructor(private readonly authority:PrivateReadAuthority<SelectedNotionRow>,private readonly now=Date.now){}
  async find(owner:string,limit:number,signal:AbortSignal):Promise<readonly RawRadarCandidate[]>{const rows=await bound(owner,'notion:selected:read',limit,this.authority,this.now,signal);const seen=new Set<string>();const result:RawRadarCandidate[]=[];
    for(const row of rows){const pageId=clean(row?.pageId,64),title=clean(row?.title,300),summary=clean(row?.summary,600);
      if(!pageId||!HASH.test(pageId)||seen.has(pageId)||!title||!summary||!/^https:\/\/(?:www\.)?notion\.so\/[A-Za-z0-9/?=&_-]+$/.test(row.url)
        ||!Number.isSafeInteger(row.lastEditedAt)||row.lastEditedAt>this.now()+300000)throw new Error('PRIVATE_DISCOVERY_RESPONSE_INVALID');
      seen.add(pageId);result.push(Object.freeze({source:'notion',externalId:`${pageId}:${row.lastEditedAt}`,title,fact:summary,url:row.url,publishedAt:row.lastEditedAt,metadata:Object.freeze(['明示選択Notion'])}));}
    return Object.freeze(result);}}
/** Header-only important+unread Gmail candidates. Body, attachments and state-changing operations are outside this contract. */
export class ImportantUnreadGmailDiscovery{
  constructor(private readonly authority:PrivateReadAuthority<ImportantGmailRow>,private readonly now=Date.now){}
  async find(owner:string,limit:number,signal:AbortSignal):Promise<readonly RawRadarCandidate[]>{const rows=await bound(owner,'https://www.googleapis.com/auth/gmail.metadata',limit,this.authority,this.now,signal);const seen=new Set<string>();const result:RawRadarCandidate[]=[];
    for(const row of rows){const id=clean(row?.messageId,128),thread=clean(row?.threadId,128),subject=clean(row?.subject,300),sender=clean(row?.sender,160);
      if(!id||!thread||seen.has(id)||!subject||!sender||!/^https:\/\/mail\.google\.com\/mail\/u\/0\/#inbox\/[A-Za-z0-9_-]{1,128}$/.test(row.url)
        ||!Number.isSafeInteger(row.receivedAt)||row.receivedAt>this.now()+300000)throw new Error('PRIVATE_DISCOVERY_RESPONSE_INVALID');
      seen.add(id);result.push(Object.freeze({source:'gmail',externalId:id,title:subject,fact:`差出人: ${sender}`,url:row.url,publishedAt:row.receivedAt,metadata:Object.freeze(['重要・未読','本文未取得'])}));}
    return Object.freeze(result);}}
