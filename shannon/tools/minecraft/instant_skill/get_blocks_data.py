from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U


class GetBlocksDataInput(BaseModel):
    # ブロックの情報を取得したい空間の始点座標を指定します。 ex) 0,0,0
    start_point: str = Field(
        description="Specify the start point of the space to get block information. ex) 0,0,0")
    # ブロックの情報を取得したい空間の終点座標を指定します。 ex) 3,4,4
    end_point: str = Field(
        description="Specify the end point of the space to get block information. ex) 3,4,4")


class GetBlocksDataTool(BaseTool):
    # 指定した空間にあるブロックの情報を取得するためのツール
    name = "get-blocks-data"
    description = "Tool to get information about blocks in the specified space in Minecraft. The space volume must be less than or equal to 64. Use the bot's current location coordinates as a reference."
    args_schema: Type[BaseModel] = GetBlocksDataInput

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
            import os
            current_dir = os.path.dirname(os.path.abspath(__file__))
            file_path = os.path.join(current_dir, "..", "..", "..", "saves", "minecraft", "blocks.txt")
            response = await U.send_request(
                endpoint='get-blocks-data', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                with open(file_path, 'r') as file:
                    file_content = file.read()
                return f"Success: \n{file_content}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"get-blocks-data: {e}"
