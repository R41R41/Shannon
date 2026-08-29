import { ChatOpenAI } from '@langchain/openai';
import { AIMessage,HumanMessage,SystemMessage,ToolMessage,type BaseMessage } from '@langchain/core/messages';
import type { RadarFcaMessage,RadarFcaModel } from './radarFca.js';

const toMessages=(system:string,history:readonly RadarFcaMessage[]):BaseMessage[]=>[
  new SystemMessage(system),
  ...history.map(message=>{
    if(message.role==='user')return new HumanMessage(message.content);
    if(message.role==='tool')return new ToolMessage({content:message.content,tool_call_id:message.toolCallId!});
    return new AIMessage({content:message.content,tool_calls:(message.toolCalls??[]).map(call=>({id:call.id,name:call.name,
      args:call.arguments&&typeof call.arguments==='object'&&!Array.isArray(call.arguments)?call.arguments as Record<string,unknown>:{},type:'tool_call' as const}))});
  }),
];
/** Explicit stateless provider adapter for the dedicated Radar FCA. No tools exist beyond the per-run catalog. */
export function createRadarFcaModel(input:{apiKey:string;model:string}):RadarFcaModel{
  if(!input.apiKey||!/^[A-Za-z0-9._:-]{1,100}$/.test(input.model))throw new Error('RADAR_FCA_MODEL_CONFIG_INVALID');
  const model=new ChatOpenAI({apiKey:input.apiKey,model:input.model,maxTokens:1200,maxRetries:0,timeout:30000,temperature:0.4});
  return{async next(request,signal){signal.throwIfAborted();
    const tools=request.tools.map(tool=>({type:'function' as const,function:{name:tool.name,description:tool.description,parameters:tool.parameters}}));
    const bound=model.bindTools(tools,{parallel_tool_calls:false});
    const result=await bound.invoke(toMessages(request.system,request.messages),{signal});signal.throwIfAborted();
    const calls=(result.tool_calls??[]).map(call=>({id:call.id??'',name:call.name,arguments:call.args}));
    const content=typeof result.content==='string'?result.content:'';
    return{content,toolCalls:Object.freeze(calls)};
  }};
}
