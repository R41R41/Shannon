from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U
from shannon_agent.memory import Memory


class GetDiscordServerEmojiInput(BaseModel):
    # メッセージを受け取ったDiscordサーバーのチャンネルIDを指定します。
    channel_id: int = Field(
        description="Specify the Discord channel ID where the message was received.")
    # メッセージIDを指定します。
    message_id: int = Field(description="Specify the message ID.")


class GetDiscordServerEmojiTool(BaseTool):
    # discordサーバー固有の絵文字を取得するためのツール
    name = "get_discord_server_emoji"
    description = "Tool to get server-specific emoji."
    args_schema: Type[BaseModel] = GetDiscordServerEmojiInput

    def _run(
        self, channel_id: int, message_id: int, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, channel_id: int, message_id: int, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            data = {
                "channel_id": channel_id,
                "message_id": message_id
            }
            response = await U.send_request(
                endpoint='get_server_emoji', data=data, destination="discord_bot", request_type="post")
            if response:
                if 'response' in response:
                    return f"this server's emoji: {response['response']}"
                else:
                    return 'Failed'
            else:
                return 'An error occurred.'
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
