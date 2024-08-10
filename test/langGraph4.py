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
import asyncio
import time
from datetime import datetime
from zoneinfo import ZoneInfo
import glob
from langgraph.checkpoint.memory import MemorySaver


class LangGraphApp:
    def __init__(self):
        self.tools = []
        self._load_env()
        self._load_tools()
        self.model = self._initialize_model()
        self.workflow = self._initialize_workflow()

    def _load_env(self):
        load_dotenv()
        os.environ["OPENAI_API_KEY"] = os.getenv("OPENAI_API_KEY")

    def _load_tools(self):
        tool_files = glob.glob("./test/tools/*.py")
        for tool_file in tool_files:
            spec = importlib.util.spec_from_file_location(
                os.path.basename(tool_file)[:-3], tool_file)
            tool_module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(tool_module)
            class_name = ''.join(word.capitalize() for word in os.path.basename(
                tool_file)[:-3].split('_')) + "Tool"
            tool_class = getattr(tool_module, class_name)
            self.tools.append(tool_class())

    def _initialize_model(self):
        model = ChatOpenAI(temperature=0, model="gpt-4o-mini")
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
            yield output


if __name__ == "__main__":
    app = LangGraphApp()

    async def main():
        config = {"configurable": {"thread_id": "1"}}
        while True:
            user_input = await asyncio.get_event_loop().run_in_executor(None, input, "質問を入力してください: ")
            inputs = {"messages": [HumanMessage(content=user_input)]}
            if user_input.lower() in ["quit", "exit", "q"]:
                print("Goodbye!")
                break
            async for output in app.stream(inputs, config):
                current_time = datetime.fromtimestamp(
                    time.time(), ZoneInfo("Asia/Tokyo"))
                print(f"\033[33m{current_time.strftime(
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
            print("\n")

    asyncio.run(main())
