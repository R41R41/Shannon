from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U


class RestartSingingMusicOnDiscordInput(BaseModel):
    pass


class RestartSingingMusicOnDiscordTool(BaseTool):
    # ボイスチャットを行うためのツール
    name = "restart_singing_music_on_discord"
    description = "Tool to restart singing music on Discord. Please use when there is a song request."
    args_schema: Type[BaseModel] = RestartSingingMusicOnDiscordInput

    def _run(
        self, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        response = await U.send_request(
            endpoint='discord_replay_music', data={}, destination="voice_receiver", request_type="post")
        if response is not None:
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        else:
            return 'An error occurred.'
