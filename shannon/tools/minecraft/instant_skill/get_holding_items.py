from langchain.pydantic_v1 import BaseModel
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U


class GetHoldingItemsInput(BaseModel):
    pass


class GetHoldingItemsTool(BaseTool):
    # 手持ちのアイテムを取得するためのツール
    name = "get-holding-items"
    description = "Tool to get the items held by the bot in Minecraft."
    args_schema: Type[BaseModel] = GetHoldingItemsInput

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
            import os
            current_dir = os.path.dirname(os.path.abspath(__file__))
            file_path = os.path.join(current_dir, "..", "..", "..", "saves", "minecraft", "holding_items.txt")
            response = await U.send_request(
                endpoint='get-holding-items', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                with open(file_path, 'r') as file:
                    file_content = file.read()
                return f"Success: \n{file_content}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"get-holding-items: {e}"
