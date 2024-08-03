from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U


class SingMusicOnDiscordInput(BaseModel):
    # 話す内容を指定します。口語的な表現を使うと、より自然な音声になります。
    music_name: str = Field(
        description="The name of the music to sing.")

class SingMusicOnDiscordTool(BaseTool):
    # ボイスチャットを行うためのツール
    name = "sing-music-on-discord"
    description = "Tool to sing music on Discord. Please use when there is a song request."
    args_schema: Type[BaseModel] = SingMusicOnDiscordInput

    def _run(
        self, music_name: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, music_name: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        data = {
            "music_name": music_name,
        }
        response = await U.send_request(
            endpoint='discord_play_music', data=data, destination="voice_receiver", request_type="post")
        if response is not None:
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        else:
            return 'An error occurred.'
