from langchain.pydantic_v1 import BaseModel
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U


class GetEntitiesInfoInput(BaseModel):
    pass


class GetEntitiesInfoTool(BaseTool):
    # 自分を含めた周囲のmob, player, hostileの位置情報を取得するためのツール
    name = "get-entities-info"
    description = "Tool to get the location information of mobs, players, and hostiles around the bot in Minecraft."
    args_schema: Type[BaseModel] = GetEntitiesInfoInput

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
            file_path = os.path.join(current_dir, "..", "..", "..", "saves", "minecraft", "surrounding_entities.txt")
            response = await U.send_request(
                endpoint='get-entities-info', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                with open(file_path, 'r') as file:
                    file_content = file.read()
                return f"Success: \n{file_content}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"get-entities-info: {e}"
