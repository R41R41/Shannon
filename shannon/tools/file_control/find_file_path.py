from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
import os
from shannon_agent.memory import Memory


class FindFilePathInput(BaseModel):
    # 探したいファイルの名前を指定します。
    filename: str = Field(
        description="Specify the name of the file to be searched.")


class FindFilePathTool(BaseTool):
    # 指定した名前のファイルを探してそのファイルへのパスを返すためのツール
    name = "find-file-path"
    description = "Tool to search for a file with the specified name and return the path to that file."
    args_schema: Type[BaseModel] = FindFilePathInput

    def _run(
        self, filename: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        directory = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        for root, dirs, files in os.walk(directory):
            if filename in files:
                return os.path.join(root, filename)
        return "File not found."

    async def _arun(
        self, filename: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            directory = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            for root, dirs, files in os.walk(directory):
                if filename in files:
                    return os.path.join(root, filename)
            memory = Memory()
            memory.add_ai_action(
                skill="find-file-path", action=f"find file path {filename}")
            return "File not found."
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
