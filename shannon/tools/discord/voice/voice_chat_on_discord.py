from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U
from shannon_agent.memory import Memory


class VoiceChatOnDiscordInput(BaseModel):
    # 感情を指定します。候補は以下の通りです。
    # 嫌悪, 期待, 羞恥, 怒り, 悲観, 楽観, 冷静, 幸せ
    emotion: str = Field(
        description="Specify the emotion. The following are candidates: 嫌悪, 期待, 羞恥, 怒り, 悲観, 楽観, 冷静, 幸せ")
    # 話す内容を指定します。口語的な表現を使うと、より自然な音声になります。
    message: str = Field(
        description="Speak the content. Using colloquial expressions will result in more natural sounding voices.")


class VoiceChatOnDiscordTool(BaseTool):
    # ボイスチャットを行うためのツール
    name = "voice-chat-on-discord"
    description = "Tool to send a voice chat on Discord."
    args_schema: Type[BaseModel] = VoiceChatOnDiscordInput

    def _run(
        self, emotion: str, message: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, emotion: str, message: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        data = {
            "emotion": emotion,
            "message": message,
        }
        response = await U.send_request(
            endpoint='discord_voice_chat_send', data=data, destination="voice_receiver", request_type="post")
        if response is not None:
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        else:
            return 'An error occurred.'
