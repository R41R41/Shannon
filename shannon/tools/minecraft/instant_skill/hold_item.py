from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
import utils as U


class HoldItemInput(BaseModel):
    # 手に持つアイテムの名前
    itemName: str = Field(description="The name of the item to hold")
    # 手の位置 ex)hand, offhand
    hand: str = Field(description="The position of the hand. ex)hand, offhand")


class HoldItemTool(BaseTool):
    name = "hold-item"
    description = "Tool to hold the specified item from the inventory."
    args_schema: Type[BaseModel] = HoldItemInput

    def _run(
        self, itemName: str, hand: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, itemName: str, hand: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            data = {
                "itemName": itemName,
                "hand": hand
            }
            response = await U.send_request(
                endpoint='hold-item', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"hold-item: {e}"
