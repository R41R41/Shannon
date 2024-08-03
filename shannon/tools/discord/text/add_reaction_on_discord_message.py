from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U
from shannon_agent.memory import Memory


class AddReactionOnDiscordMessageInput(BaseModel):
    # リアクションを追加したいDiscordのチャンネルIDを指定します。
    channel_id: str = Field(description="Discord channel ID to specify.")
    # リアクションを追加したいDiscordのメッセージIDを指定します。
    message_id: str = Field(description="Discord message ID to specify.")
    # リアクションとして追加したい絵文字を指定します。サーバー固有の絵文字を使用する場合は、その絵文字のnameであるべきです。
    emoji: str = Field(
        description="Emoji to add as a reaction. If using a server-specific emoji, the name of the emoji should be specified.")
    # サーバー固有の絵文字を使用する場合はTrueに設定します。
    is_server_emoji: bool = Field(
        default=False, description="Set to True if using a server-specific emoji.")


class AddReactionOnDiscordMessageTool(BaseTool):
    name = "add-reaction-on-discord-message"
    description = "Add a reaction to a Discord message. You must select a server-specific emoji and add it to the reaction. Do not react to your own message. You must first retrieve server-specific emoji using the get-discord-server-emoji tool and include it in the reaction."
    args_schema: Type[BaseModel] = AddReactionOnDiscordMessageInput

    def _run(
        self, channel_id: str, message_id: str, emoji: str, is_server_emoji: bool = False, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, channel_id: str, message_id: str, emoji: str, is_server_emoji: bool = False, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        data = {
            "channel_id": channel_id,
            "message_id": message_id,
            "emoji": emoji,
            "is_server_emoji": is_server_emoji
        }
        response = await U.send_request(
            endpoint='add_reaction', data=data, destination="discord_bot", request_type="post")
        if response:
            if 'response' in response:
                memory = Memory()
                memory.add_ai_action(
                    skill="add-reaction-on-discord-message", action=f"add reaction {emoji} on message_id: {message_id} in channel_id: {channel_id}")
                return f"add reaction {emoji} on message_id: {message_id} in channel_id: {channel_id}"
            else:
                return 'Failed'
        else:
            return 'An error occurred.'
