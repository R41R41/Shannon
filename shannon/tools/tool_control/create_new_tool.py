from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
from prompts import load_prompt
from shannon_agent.memory import Memory


class CreateNewToolInput(BaseModel):
    # ツールの名前を指定します。
    tool_name: str = Field(
        description="The name of the tool. eg. get-current-time")
    # ツールの説明を指定します。
    tool_description: str = Field(
        description="The description of the tool. eg. Gets the current time in the specified timezone.")


class CreateNewToolTool(BaseTool):
    name = "create_new_tool"
    description = "Tool to create a new tool. Creates a new tool if no existing tool is available."
    args_schema: Type[BaseModel] = CreateNewToolInput

    def _run(
        self, tool_name: str, tool_description: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, tool_name: str, tool_description: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            system_content = load_prompt("create_new_tool")
            human_content = "tool_name:"+tool_name+"\ntool_description:"+tool_description
            memory = Memory()
            memory.add_ai_action(
                skill="create-new-tool", action=f"create new tool {tool_name} with description {tool_description}")
            return str(system_content) + "\n" + str(human_content)
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
