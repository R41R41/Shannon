from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U


class StopMusicOnDiscordInput(BaseModel):
    pass


class StopMusicOnDiscordTool(BaseTool):
    # ボイスチャットを行うためのツール
    name = "stop_music_on_discord"
    description = "Tool to stop music on Discord."
    args_schema: Type[BaseModel] = StopMusicOnDiscordInput

    def _run(
        self, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        data = {}
        response = await U.send_request(
            endpoint='discord_stop_music', data=data, destination="voice_receiver", request_type="post")
        if response is not None:
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        else:
            return 'An error occurred.'
