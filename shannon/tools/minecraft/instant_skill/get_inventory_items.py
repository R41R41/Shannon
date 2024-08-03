from langchain.pydantic_v1 import BaseModel
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U


class GetInventoryItemsInput(BaseModel):
    pass


class GetInventoryItemsTool(BaseTool):
    # インベントリーのアイテムを取得するためのツール
    name = "get-inventory-items"
    description = "Tool to get the items in the inventory in Minecraft."
    args_schema: Type[BaseModel] = GetInventoryItemsInput

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
            file_path = os.path.join(current_dir, "..", "..", "..", "saves", "minecraft", "inventory.txt")
            response = await U.send_request(
                endpoint='get-inventory-items', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                with open(file_path, 'r') as file:
                    file_content = file.read()
                return f"Success: \n{file_content}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"get-inventory-items: {e}"
