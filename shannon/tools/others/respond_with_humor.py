from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
from prompts import load_prompt
from shannon_agent.memory import Memory


class RespondWithHumorInput(BaseModel):
    # 求められている面白さの種類を指定します。
    humor_type: str = Field(
        description="Type of humor to request. eg. Sarcastic humor")


class RespondWithHumorTool(BaseTool):
    # ユーザーからのメッセージにユーモアたっぷりに応えるためのツール
    name = "respond-with-humor"
    description = "Tool to respond to user messages with sarcastic humor."
    args_schema: Type[BaseModel] = RespondWithHumorInput

    def _run(
        self, humor_type: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, humor_type: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            system_content = load_prompt("sense_of_humor")
            human_content = "\nhumor_type:"+humor_type
            return str(system_content) + "\n" + str(human_content)
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
