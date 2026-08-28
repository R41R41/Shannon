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
