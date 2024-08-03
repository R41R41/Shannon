from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
from prompts import load_prompt


class CreateDairyMessageInput(BaseModel):
    # 日付を指定します。
    date: str = Field(description="Date to specify. eg. 2024-05-01")


class CreateDiaryMessageTool(BaseTool):
    # 今日一日にあったことや感じたことの絵日記を出力します。
    name = "create-diary-message"
    description = "Create a diary message about what happened today."
    args_schema: Type[BaseModel] = CreateDairyMessageInput

    def _run(
        self, date: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, date: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            prompt = load_prompt("create_diary_message")
            return prompt
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
