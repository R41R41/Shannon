from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
import os
from shannon_agent.memory import Memory


class CreateFileInput(BaseModel):
    # ファイルのパスを指定します。eg. /home/azureuser/shannon/shannon/tools/new_tool.py
    file_path: str = Field(
        description="Specify the file path. eg. /home/azureuser/shannon/shannon/tools/new_tool.py")
    # ファイルの内容を指定します。
    file_content: str = Field(
        description="Specify the content of the file.")


class CreateFileTool(BaseTool):
    # 新しいファイルを作成するためのツール
    name = "create-file"
    description = "Tool to create a new file."
    args_schema: Type[BaseModel] = CreateFileInput

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
            if os.path.exists(file_path):
                return f"File {file_path} already exists."
            with open(file_path, 'w') as file:
                file.write(file_content)
            memory = Memory()
            memory.add_ai_action(
                skill="create-file", action=f"create file {file_path}")
            return f"File {file_path} created."
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
