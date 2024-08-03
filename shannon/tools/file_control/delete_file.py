from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
import os
from shannon_agent.memory import Memory


class DeleteFileInput(BaseModel):
    # ファイルのパスを指定します。eg. /home/azureuser/shannon/shannon/tools/new_tool.py
    file_path: str = Field(
        description="Specify the file path. eg. /home/azureuser/shannon/shannon/tools/new_tool.py")


class DeleteFileTool(BaseTool):
    # ファイルを削除するためのツール
    name = "delete-file"
    description = "Tool to delete a file."
    args_schema: Type[BaseModel] = DeleteFileInput

    def _run(
        self, file_path: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, file_path: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            if os.path.exists(file_path):
                os.remove(file_path)
                return f"File {file_path} deleted."
            else:
                return f"File {file_path} does not exist."
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
