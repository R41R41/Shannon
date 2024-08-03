from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
import utils as U


class SearchBlockInput(BaseModel):
    # 探索するブロックの名前
    blockName: str = Field(description="The name of the block to search")


class SearchBlockTool(BaseTool):
    # 指定したブロックを探索するためのツール
    name = "search-block"
    description = "Tool to search for the specified block."
    args_schema: Type[BaseModel] = SearchBlockInput

    def _run(
        self, blockName: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, blockName: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            data = {
                "blockName": blockName
            }
            response = await U.send_request(
                endpoint='search-block', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"search-block: {e}"
