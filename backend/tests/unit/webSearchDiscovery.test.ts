import { describe, expect, it, vi } from 'vitest';
import { WebSearchDiscovery } from '../../src/services/radar/webSearchDiscovery.js';
const owner='line:'+'a'.repeat(64), NOW=1787932800000;
describe('Web Radar discovery',()=>{
  it('maps bounded public search results and labels unknown publication time',async()=>{
    const get=vi.fn(async()=>({ok:true,text:JSON.stringify({items:[{title:'New research',snippet:'A concise fact',link:'https://example.com/article'}]})}));
    const rows=await new WebSearchDiscovery({apiKey:'k'.repeat(10),engineId:'engine:1',get},()=>NOW).find(owner,'science',10,new AbortController().signal);
    expect(rows).toHaveLength(1);expect(rows[0]).toEqual(expect.objectContaining({source:'web',title:'New research',publishedAt:NOW,metadata:['公開日時不明','Web検索で取得']}));
    expect(rows[0].externalId).toMatch(/^[a-f0-9]{64}$/);expect(get).toHaveBeenCalledTimes(1);
  });
  it('rejects non-owner use before making a request',async()=>{const get=vi.fn();
    await expect(new WebSearchDiscovery({apiKey:'k'.repeat(10),engineId:'engine:1',get}).find('bad','science',5,new AbortController().signal)).rejects.toThrow('WEB_DISCOVERY_POLICY_INVALID');
    expect(get).not.toHaveBeenCalled();});
});
