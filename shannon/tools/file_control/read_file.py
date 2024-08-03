from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
import os
from shannon_agent.memory import Memory


class ReadFileInput(BaseModel):
    # ファイルのパスを指定します。eg. /Users/shannon/test.py
    file_path: str = Field(
        description="Specify the file path. eg. /Users/shannon/test.py")


class ReadFileTool(BaseTool):
    # ファイルを読み込むためのツール
    name = "read-file"
    description = "Tool to read a file."
    args_schema: Type[BaseModel] = ReadFileInput

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
            if not os.path.exists(file_path):
                return f"File {file_path} does not exist."
            with open(file_path, 'r') as file:
                file_content = file.read()
            memory = Memory()
            memory.add_ai_action(
                skill="read-file", action=f"read file {file_path}")
            return file_content
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
