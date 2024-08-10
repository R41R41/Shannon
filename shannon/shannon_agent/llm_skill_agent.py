from langchain_openai import ChatOpenAI
from langchain.schema import SystemMessage
from langchain_core.messages import HumanMessage
from langgraph.prebuilt import ToolNode
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages, AnyMessage
from langgraph.checkpoint.memory import MemorySaver
from typing import Literal, TypedDict, Annotated
from datetime import datetime
import importlib
import os
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo
import glob
from aiohttp import web
import asyncio
import websockets
import utils as U

sys.path.append(os.path.join(os.path.dirname(
    os.path.abspath(__file__)), "..", "tools"))


class LLMSkillAgent:
    def __init__(self, model_name: str = "gpt-4o-mini", temperature: int = 0, init_tool_categories: list[str] = ["default", "discord", "search"]):
        self.model_name = model_name
        self.temperature = temperature
        self.init_tool_categories = init_tool_categories
        self.tools = []
        self._init_load_tools()
        self.model = self._initialize_model()
        self.workflow = self._initialize_workflow()
        self.config = {"configurable": {"thread_id": "1"}}

    def render_system_message(self, content):
        system_message = SystemMessage(content=content)
        assert isinstance(system_message, SystemMessage)
        return system_message

    def render_human_message(self, *, content):
        return HumanMessage(content=content)

    async def start_server(self):
        app = web.Application()
        app.add_routes([
            web.post('/response_to_message',
                     self.handle_request_response_to_message),
        ])
        websocket_server = websockets.serve(
            self.handle_websocket, 'localhost', int(U.destination_to_port("llm_skill_agent")))
        await websocket_server
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, 'localhost', PORT)
        await site.start()
        print(f"shannon_server started on port {PORT}")
        return site

    async def handle_request_response_to_message(self, system_content, human_content, data=None, need_memorise=False):
        messages = [
            self.render_system_message(content=system_content),
            self.render_human_message(content=human_content)
        ]
        await self.stream(messages, self.config)
        return

    def _init_load_tools(self):
        for category in self.init_tool_categories:
            tool_files = glob.glob(
                f"./shannon/tools/{category}/**/*.py", recursive=True)
            for tool_file in tool_files:
                spec = importlib.util.spec_from_file_location(
                    os.path.basename(tool_file)[:-3], tool_file)
                tool_module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(tool_module)
                class_name = ''.join(word.capitalize() for word in os.path.basename(
                    tool_file)[:-3].split('_')) + "Tool"
                tool_class = getattr(tool_module, class_name)
                self.tools.append(tool_class())

    def load_tool(self, file_name: str):
        for root, dirs, files in os.walk("./shannon/tools"):
            for file in files:
                if file == f"{file_name}.py":
                    tool_file = os.path.join(root, file)
                    spec = importlib.util.spec_from_file_location(
                        file_name, tool_file)
                    tool_module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(tool_module)
                    class_name = ''.join(word.capitalize()
                                         for word in file_name.split('_')) + "Tool"
                    tool_class = getattr(tool_module, class_name)
                    self.tools.append(tool_class())
                    self.model = self._initialize_model()
                    self.workflow = self._initialize_workflow()
                    print(f"ツール '{file_name}' を読み込みました。")
                    return
        print(f"ツール '{file_name}' が見つかりませんでした。")

    def unload_tool(self, tool_name: str):
        for tool in self.tools:
            if tool.name == tool_name:
                self.tools.remove(tool)
                self.model = self._initialize_model()
                self.workflow = self._initialize_workflow()
                print(f"ツール '{tool_name}' を削除しました。")
                return
        print(f"ツール '{tool_name}' が見つかりませんでした。")

    def _initialize_model(self):
        model = ChatOpenAI(
            temperature=self.temperature,
            model=self.model_name,
            timeout=None
        )
        return model.bind_tools(self.tools)

    def _initialize_workflow(self):
        class MessagesState(TypedDict):
            messages: Annotated[list[AnyMessage], add_messages]

        async def chatbot(state: MessagesState):
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
        tool_node = ToolNode(self.tools)

        workflow.add_node("agent", chatbot)
        workflow.add_node("tools", tool_node)
        workflow.set_entry_point("agent")
        workflow.add_conditional_edges("agent", should_continue)
        workflow.add_edge("tools", 'agent')

        memory = MemorySaver()

        return workflow.compile(checkpointer=memory)

    async def stream(self, inputs, config):
        async for output in self.workflow.astream(inputs, config, stream_mode="updates"):
            current_time = datetime.fromtimestamp(
                time.time(), ZoneInfo("Asia/Tokyo"))
            print(f"\033[90m{current_time.strftime(
                '%Y-%m-%d %H:%M:%S')}\033[0m")
            for key, value in output.items():
                if key == 'agent':
                    for message in value['messages']:
                        if 'tool_calls' in message.additional_kwargs:
                            for tool_call in message.additional_kwargs['tool_calls']:
                                print(f"\033[34mtool_calls {tool_call['function']['name']} args: {
                                      tool_call['function']['arguments']}\033[0m")
                        else:
                            print(f"\033[32m{message.content}\033[0m")
                elif key == 'tools':
                    for message in value['messages']:
                        if message.content.startswith("Error"):
                            print(f"\033[31m{message.content}\033[0m")
                        else:
                            print(f"\033[36m{message.content}\033[0m")
            print("\n")

    async def user_input(self, system_content, human_content, data=None, need_memorise=False):
        messages = [
            self.render_system_message(content=system_content),
            self.render_human_message(content=human_content)
        ]

        return


IS_TEST = os.getenv('IS_TEST') == 'True'

if IS_TEST:
    PORT = 3001
else:
    PORT = 3000


async def main():
    agent = LLMSkillAgent()
    server_task = agent.start_server()
    await asyncio.gather(server_task)
    await asyncio.Event().wait()

if __name__ == "__main__":
    asyncio.run(main())
