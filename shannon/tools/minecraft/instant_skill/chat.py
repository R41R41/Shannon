from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U


class ChatInput(BaseModel):
    # Minecraftに送信するテキストを指定します。
    text: str = Field(description="Specify the text to send to Minecraft.")


class ChatTool(BaseTool):
    # Minecraftにメッセージを送信するためのツール
    name = "chat-on-minecraft"
    description = "Tool to send a message to Minecraft."
    args_schema: Type[BaseModel] = ChatInput

    def _run(
        self, text: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, text: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            data = {
                "text": text,
            }
            response = await U.send_request(
                endpoint='chat', data=data, destination="mineflayer", request_type="post")
            print(response)
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"chat: {e}"
