from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
import utils as U


class EatFoodInput(BaseModel):
    # 食べるアイテムの名前を指定します。
    itemName: str = Field(description="Specify the name of the item to eat.")


class EatFoodTool(BaseTool):
    # 指定したアイテムを食べるためのツール
    name = "eat-food"
    description = "Tool to eat the specified item."
    args_schema: Type[BaseModel] = EatFoodInput

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
                endpoint='eat-food', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"eat-food: {e}"
