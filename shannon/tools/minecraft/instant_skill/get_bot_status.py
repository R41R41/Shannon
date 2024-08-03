from langchain.pydantic_v1 import BaseModel
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U


class GetBotStatusInput(BaseModel):
    pass


class GetBotStatusTool(BaseTool):
    # ボットの体力と満腹度を取得するためのツール
    name = "get-bot-status"
    description = "Tool to get the bot's health and hunger status in Minecraft."
    args_schema: Type[BaseModel] = GetBotStatusInput

    def _run(
        self, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            data = {}
            response = await U.send_request(
                endpoint='get-bot-status', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                return f"Success: \n{response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"get-bot-status: {e}"
