from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
import utils as U


class CraftItemInput(BaseModel):
    # 作成するアイテムの名前を指定します。Minecraftのアイテム名を正確に指定して下さい。鉱石の種類や木の種類、石の種類が名前に入るアイテムがあることを忘れないでください。ex) diamond_sword, birch_planks, cobblestone_wall, etc...
    itemName: str = Field(
        description="Specify the name of the item to create. Please specify the exact item name in Minecraft. Remember that there are items that have names that include types of minerals or wood or stone. ex) diamond_sword, birch_planks, cobblestone_wall, etc...")
    # 作成するアイテムの数量を指定します。
    amount: int = Field(description="Specify the number of items to create.")


class CraftItemTool(BaseTool):
    # アイテムを作成するためのツール
    name = "craft-item"
    description = "Tool to create an item. Please check your inventory beforehand to determine what to create. Be sure to specify the exact item name and the number of items to create."
    args_schema: Type[BaseModel] = CraftItemInput

    def _run(
        self, itemName: str, amount: int, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, itemName: str, amount: int, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            data = {
                "itemName": itemName,
                "amount": amount
            }
            response = await U.send_request(
                endpoint='craft-item', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"craft-item: {e}"
