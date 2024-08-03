from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
from prompts import load_prompt
from shannon_agent.memory import Memory


class EditToolInput(BaseModel):
    # ツールの名前を指定します。
    tool_name: str = Field(
        description="The name of the tool. eg. get-current-time")
    # ツールの修正内容を指定します。
    edit_description: str = Field(
        description="The correction content of the tool. eg. Changes the tool to get the current time in Tokyo.")


class EditToolTool(BaseTool):
    # 既存ツールの内容を変更するためのツール
    name = "edit-tool"
    description = "Tool to change the existing tool. Changes the existing tool when necessary."
    args_schema: Type[BaseModel] = EditToolInput

    def _run(
        self, tool_name: str, edit_description: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, tool_name: str, edit_description: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            system_content = load_prompt("edit_tool")
            human_content = "tool_name:"+tool_name + \
                "\nedit_description:"+edit_description
            memory = Memory()
            memory.add_ai_action(
                skill="edit-tool", action=f"edit tool {tool_name} with description {edit_description}")
            return str(system_content) + "\n" + str(human_content)
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
