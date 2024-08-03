from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
import os
from shannon_agent.memory import Memory


class WriteFileInput(BaseModel):
    # ファイルのパスを指定します。eg. /Users/shannon/test.py
    file_path: str = Field(
        description="Specify the file path. eg. /Users/shannon/test.py")
    # ファイルの書き換える内容を指定します。
    file_content: str = Field(
        description="Specify the content to be written to the file.")


class WriteFileTool(BaseTool):
    # ファイルを書き換えるためのツール
    name = "write-file"
    description = "Tool to write to a file."
    args_schema: Type[BaseModel] = WriteFileInput

    def _run(
        self, file_path: str, file_content: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, file_path: str, file_content: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            if not os.path.exists(file_path):
                return f"File {file_path} does not exist."
            with open(file_path, 'w') as file:
                file.write(file_content)
            memory = Memory()
            memory.add_ai_action(
                skill="write-file", action=f"write file {file_path} {file_content}")
            return f"File {file_path} written."
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
