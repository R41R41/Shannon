import {describe,it,expect,vi} from 'vitest';
vi.mock('../../src/utils/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),success:vi.fn()}}));
vi.mock('../../src/services/llm/graph/nodes/execution/TaskTreePublisher.js',()=>({TaskTreePublisher:class{}}));
import {ToolExecutor} from '../../src/services/llm/graph/nodes/execution/ToolExecutor.js';
import {selectAllowedTools} from '../../src/modules/access/toolSelection.js';
it('actual executor cannot invoke a tool omitted from the allowlist even when the model asks for it',async()=>{
 const invoke=vi.fn();const tools=selectAllowedTools([{name:'send',invoke}],[]);const executor=new ToolExecutor({publishTaskTree:vi.fn()} as any);
 const messages:any[]=[];const result=await executor.executeToolCalls([{id:'call-1',name:'send',args:{}}],new Map(tools.map(t=>[t.name,t])) as any,messages,{goal:'test',platform:'web',channelId:null,taskId:'request',context:null,steps:[],stepCounter:0,lastThinkingContent:null});
 expect(invoke).not.toHaveBeenCalled();expect(result.results).toHaveLength(1);expect(messages).toHaveLength(1);
});

it('passes cancellation into a tool and stops the remaining calls after abort', async () => {
 const controller=new AbortController();const next=vi.fn();
 const invoke=vi.fn(async (_args,options)=>{expect(options.signal).toBe(controller.signal);controller.abort();return 'late result';});
 const executor=new ToolExecutor({publishTaskTree:vi.fn()} as any);
 await expect(executor.executeToolCalls([{name:'first',args:{}},{name:'next',args:{}}],new Map([['first',{invoke}],['next',{invoke:next}]]) as any,[],{goal:'test',platform:'web',channelId:null,taskId:'request',context:null,steps:[],stepCounter:0,lastThinkingContent:null},controller.signal)).rejects.toMatchObject({name:'AbortError'});
 expect(next).not.toHaveBeenCalled();
});

it('does not start a tool for an already cancelled request',async()=>{
 const controller=new AbortController();controller.abort();const invoke=vi.fn();
 const executor=new ToolExecutor({publishTaskTree:vi.fn()} as any);
 await expect(executor.executeToolCalls([{name:'send',args:{}}],new Map([['send',{invoke}]]) as any,[],{goal:'test',platform:'web',channelId:null,taskId:'request',context:null,steps:[],stepCounter:0,lastThinkingContent:null},controller.signal)).rejects.toThrow();
 expect(invoke).not.toHaveBeenCalled();
});
