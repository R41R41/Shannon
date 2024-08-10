from langchain_openai import ChatOpenAI
from langgraph.prebuilt import ToolNode
from langchain_core.messages import HumanMessage
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages, AnyMessage
from typing import Literal, TypedDict, Annotated
import os
from dotenv import load_dotenv
from PIL import Image
import importlib.util
import json
import asyncio

class LangGraphApp:
    def __init__(self):
        self._load_env()
        self._load_bing_search_tool()
        self.model = self._initialize_model()
        self.workflow = self._initialize_workflow()

    def _load_env(self):
        load_dotenv()
        os.environ["OPENAI_API_KEY"] = os.getenv("OPENAI_API_KEY")

    def _load_bing_search_tool(self):
        spec = importlib.util.spec_from_file_location("bing_search", "./test/bing_search.py")
        bing_search = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bing_search)
        self.BingSearchTool = bing_search.BingSearchTool
        self.BingSearchInput = bing_search.BingSearchInput

    def _initialize_model(self):
        tools = [self.BingSearchTool()]
        model = ChatOpenAI(temperature=0, model="gpt-4o-mini")
        return model.bind_tools(tools)

    def _initialize_workflow(self):
        class MessagesState(TypedDict):
            messages: Annotated[list[AnyMessage], add_messages]

        async def call_model(state: MessagesState):
            messages = state['messages']
            response = await self.model.ainvoke(messages)
            return {"messages": [response]}

        def should_continue(state: MessagesState) -> Literal["tools", "__end__"]:
            messages = state['messages']
            last_message = messages[-1]
            if last_message.tool_calls:
                return "tools"
            return "__end__"

        workflow = StateGraph(MessagesState)
        tool_node = ToolNode([self.BingSearchTool()])

        workflow.add_node("agent", call_model)
        workflow.add_node("tools", tool_node)
        workflow.set_entry_point("agent")
        workflow.add_conditional_edges("agent", should_continue)
        workflow.add_edge("tools", 'agent')

        return workflow.compile()

    async def stream(self, inputs):
        async for output in self.workflow.astream(inputs, stream_mode="updates"):
            yield output

if __name__ == "__main__":
    app = LangGraphApp()
    inputs = {"messages": [HumanMessage(content="神戸の現在の天気・気温・湿度を教えて。")]}
    
    async def main():
        async for output in app.stream(inputs):
            for key, value in output.items():
                if key == 'agent':
                    for message in value['messages']:
                        if 'tool_calls' in message.additional_kwargs:
                            for tool_call in message.additional_kwargs['tool_calls']:
                                print(f"\033[34mtool_calls {tool_call['function']['name']} args: {tool_call['function']['arguments']}\033[0m")
                        else:
                            print(f"\033[32m{message.content}\033[0m")

    asyncio.run(main())