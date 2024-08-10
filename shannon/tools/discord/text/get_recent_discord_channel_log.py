from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U
from shannon_agent.memory import Memory


class GetRecentDiscordChannelLogInput(BaseModel):
    # 取得したいDiscordチャンネルのチャンネルIDを指定します。
    channel_id: int = Field(
        description="Specify the channel ID of the Discord channel to retrieve.")
    # 取得したいメッセージの数を指定します。
    message_count: int = Field(
        description="Specify the number of messages to retrieve.")


class GetRecentDiscordChannelLogTool(BaseTool):
    # 指定されたDiscordチャンネルの最近のチャットログを取得するためのツール
    name = "get_recent_discord_channel_chat_log"
    description = "Tool to get the recent chat log of a specified Discord channel."
    args_schema: Type[BaseModel] = GetRecentDiscordChannelLogInput

    def _run(
        self, channel_id: int, message_count: int, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, channel_id: int, message_count: int, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        data = {
            "channel_id": channel_id,
            "message_count": message_count
        }
        response = await U.send_request(
            endpoint='get_recent_channel_log', data=data, destination="discord_bot", request_type="post")
        if response:
            if 'response' in response:
                return f"Recent chat log in this channel: {response['response']}"
            else:
                return 'Failed'
        else:
            return 'An error occurred.'
