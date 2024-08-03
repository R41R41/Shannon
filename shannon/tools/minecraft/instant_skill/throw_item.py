from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
import utils as U


class ThrowItemInput(BaseModel):
    # 投げるアイテムの名前
    itemName: str = Field(description="The name of the item to throw")


class ThrowItemTool(BaseTool):
    # 指定したアイテムを投げるためのツール
    name = "throw-item"
    description = "Tool to throw the specified item."
    args_schema: Type[BaseModel] = ThrowItemInput

    def _run(
        self, itemName: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, itemName: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            data = {
                "itemName": itemName
            }
            response = await U.send_request(
                endpoint='throw-item', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"throw-item: {e}"
