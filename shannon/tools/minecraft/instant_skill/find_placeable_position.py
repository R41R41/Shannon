from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U


class FindPlaceablePositionInput(BaseModel):
    # 検索したい空間の始点座標を指定します。nullという文字列の場合は自分の現在地を中心に検索します。 ex) 0,0,0
    start_point: str = Field(
        description="Specify the start point of the space to search. If the string is null, search in the space centered around the bot's current location. ex) 0,0,0")
    # 検索したい空間の終点座標を指定します。nullという文字列の場合は自分の現在地を中心に検索します。 ex) 3,4,4
    end_point: str = Field(
        description="Specify the end point of the space to search. If the string is null, search in the space centered around the bot's current location. ex) 3,4,4")


class FindPlaceablePositionTool(BaseTool):
    # マイクラで指定した空間内でブロックを置ける座標を検索するためのツール
    name = "find-placeable-position"
    description = "Tool to search for coordinates where blocks can be placed in the specified space in Minecraft. For searches in the vicinity of the bot's current location, set start_point and end_point to null."
    args_schema: Type[BaseModel] = FindPlaceablePositionInput

    def _run(
        self, start_point: str, end_point: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, start_point: str, end_point: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            data = {
                "startPoint": start_point,
                "endPoint": end_point
            }
            response = await U.send_request(
                endpoint='find-placeable-position', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                return f"Success: \n{response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"find-placeable-position: {e}"
