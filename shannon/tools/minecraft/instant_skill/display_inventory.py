from langchain.pydantic_v1 import BaseModel
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U


class DisplayInventoryInput(BaseModel):
    pass


class DisplayInventoryTool(BaseTool):
    # ボットのインベントリのアイテムを表示するためのツール
    name = "display-inventory"
    description = "Tool to display the items in the bot's inventory in the minecraft chat window."
    args_schema: Type[BaseModel] = DisplayInventoryInput

    def _run(
        self, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        try:
            """Use the tool asynchronously."""
            data = {}
            response = await U.send_request(
                endpoint='display-inventory', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"display-inventory: {e}"
