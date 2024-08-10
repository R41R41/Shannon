from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)


class MemoriseMessageInfoInput(BaseModel):
    # ユーザーのメッセージのIDを指定します。
    message_id: str = Field(description="User message ID to specify.")
    # チャンネルIDを指定します。
    channel_id: str = Field(description="Channel ID to specify.")
    # メッセージの内容を指定します。
    message_content: str = Field(description="Message content to specify.")
    # メッセージの画像URLを指定します。
    message_image_url: str = Field(
        default=None, description="Message image URL to specify.")


class MemoriseMessageInfoTool(BaseTool):
    # メッセージの情報をメモするツール
    name = "memorise-message-info"
    description = "Tool to memorise message information"
    args_schema: Type[BaseModel] = MemoriseMessageInfoInput

    def _run(
        self, message_id: str, channel_id: str, message_content: str, message_image_url: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, message_id: str, channel_id: str, message_content: str, message_image_url: str = None, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            memo = f"message_id: {message_id}\nchannel_id: {channel_id}\nmessage_content: {
                message_content}\nmessage_image_url: {message_image_url}"
            return "The following information will be useful to remember.\n" + memo
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
