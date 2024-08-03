from email.policy import default
from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U
from shannon_agent.memory import Memory


class ChatOnDiscordInput(BaseModel):
    # Discordに送信するテキストを指定します。
    text: str = Field(description="Text to send to Discord.")
    # Discordのチャットに添付するweb上の画像のurlを指定します。
    embed_image_url: str = Field(
        default=None, description="URL of the image to attach to the Discord chat.")
    # Discordのチャットに添付するローカルにある画像などのファイルのパスを指定します。
    file_path: str = Field(
        default=None, description="Path to a file attached to the Discord chat.")
    # DiscordのチャンネルIDを指定します。
    channel_id: str = Field(
        description="Specify the Discord channel ID to send the message.")


class ChatOnDiscordTool(BaseTool):
    # Discordのチャンネルにメッセージを送信するツール
    name = "chat-on-discord"
    description = "Send a message to a Discord channel."
    args_schema: Type[BaseModel] = ChatOnDiscordInput

    def _run(
        self, text: str,  channel_id: str, embed_image_url: str = None, file_path: str = None, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, text: str, channel_id: str, embed_image_url: str = None, file_path: str = None, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        data = {
            "text": text,
            "embed_image_url": embed_image_url,
            "file_path": file_path,
            "channel_id": channel_id
        }
        response = await U.send_request(
            endpoint='chat', data=data, destination="discord_bot", request_type="post")
        if response is not None:
            if 'response' in response:
                memory = Memory()
                memory.add_ai_action(
                    skill="chat-on-discord", action=f"send message {text} to channel_id: {channel_id}")
                return f"send message {text} to channel_id: {channel_id}"
            else:
                return 'error'
        else:
            return 'error'
