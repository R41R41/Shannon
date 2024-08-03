from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
import utils as U


class PlaceBlockInput(BaseModel):
    # 置くブロックの名前
    block_name: str = Field(description="The name of the block to place")
    # ブロックを置く座標。空気ブロックがある座標でないとならない。例: 0,0,0
    place_position: str = Field(
        description="The coordinates to place the block. The coordinates must be air blocks. Example: 0,0,0")
    # ブロックを面で接するように置く先の既に置いてあるブロックの座標。ブロックを置く座標との差は単位ベクトルでなければならない。例: 0,1,0
    placed_block_position: str = Field(
        description="The coordinates of the block to place next to the block to be placed. The difference between the coordinates of the block to be placed and the coordinates of the block to place is a unit vector. Example: 0,1,0")


class PlaceBlockTool(BaseTool):
    # 指定したブロックを指定した座標に置きます。find-placeable-positionツールで適切なplace_positionとplaced_block_positionを確認してから使用してください。
    name = "place-block"
    description = "Tool to place the specified block at the specified coordinates. Check the appropriate place_position and placed_block_position using the find-placeable-position tool before using this tool."
    args_schema: Type[BaseModel] = PlaceBlockInput

    def _run(
        self, block_name: str, place_position: str, placed_block_position: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, block_name: str, place_position: str, placed_block_position: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            data = {
                "blockName": block_name,
                "placePosition": place_position,
                "placedBlockPosition": placed_block_position
            }
            response = await U.send_request(
                endpoint='place-block', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"place-block: {e}"
