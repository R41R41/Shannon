from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
import utils as U
from shannon_agent.memory import Memory


class ImportToolInput(BaseModel):
    # toolのファイル名を指定します。
    tool_filename: str = Field(
        description="The name of the tool file. eg. get-current-time.py")


class ImportToolTool(BaseTool):
    # pythonで書かれたopenai toolをimportするためのツール
    name = "import-tool"
    description = "Tool to import an openai tool written in python."
    args_schema: Type[BaseModel] = ImportToolInput

    def _run(
        self, tool_filename: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, tool_filename: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        data = {
            "import_filename": tool_filename,
        }
        try:
            response = await U.send_request(
                endpoint='import_tool', data=data, destination="shannon", request_type="post")
            if response:
                if 'text' in response:
                    memory = Memory()
                    memory.add_ai_action(
                        skill="import-tool", action=f"import tool {tool_filename}")
                    return response['text']
                else:
                    return 'Failed'
            else:
                return 'Error'
        except Exception as e:
            return f"import failed: {e}"
