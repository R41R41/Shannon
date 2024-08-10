from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)


class CodeErrorAnalysisInput(BaseModel):
    # エラーがあったファイルの名前を指定します。
    file_name: str = Field(
        description="The name of the file where the error occurred. eg. main.py")
    # エラーメッセージを指定します。
    error_message: str = Field(
        description="The error message. eg. An error occurred.")


class CodeErrorAnalysisTool(BaseTool):
    # コードエラーを解析するためのツール
    name = "code_error_analysis"
    description = "Tool to analyze code errors."
    args_schema: Type[BaseModel] = CodeErrorAnalysisInput

    def _run(
        self, file_name: str, error_message: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, file_name: str, error_message: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            return "Analyze the error content and code to find the problem. If it cannot be identified immediately, search it on the web. If a hypothesis is formed, verify it. If it is incorrect, form a new hypothesis."
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
