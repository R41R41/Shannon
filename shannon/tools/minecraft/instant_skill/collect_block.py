from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
import utils as U


class CollectBlockInput(BaseModel):
    # 集めるブロックの名前を指定します。
    block_name: str = Field(
        description="Specify the name of the block to collect.")
    # 集めるブロックの個数を指定します。
    count: int = Field(description="Specify the number of blocks to collect.")


class CollectBlockTool(BaseTool):
    # ブロックを集めるためのツール
    name = "collect-block"
    description = "Tool to collect the specified block."
    args_schema: Type[BaseModel] = CollectBlockInput

    def _run(
        self, block_name: str, count: int, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, block_name: str, count: int, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            data = {
                "blockName": block_name,
                "count": count
            }
            response = await U.send_request(
                endpoint='collect-block', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"collect-block: {e}"
