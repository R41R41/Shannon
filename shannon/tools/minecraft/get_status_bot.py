from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U


class GetStatusBotInput(BaseModel):
    # ステータスを確認するminecraftサーバーの名前を以下の候補から指定します。1.20.4-test:テスト用, 1.20.4-youtube1:youtubeメイン撮影用, 1.20.4-youtube2:youtube撮影用サブ1, 1.20.4-youtube3:youtube撮影用サブ2, 1.20.4-play:遊び用, Auto:特に指定がない場合
    server_name: str = Field(
        description="The name of the Minecraft server to check the status from. Choose from the following candidates. 1.20.4-test:test, 1.20.4-youtube1:youtube main, 1.20.4-youtube2:youtube sub1, 1.20.4-youtube3:youtube sub2, 1.20.4-play:play, Auto:no specific server")


class GetStatusBotTool(BaseTool):
    # マインボットのステータスを確認するためのツール
    name = "get-status-bot"
    description = "Tool to check the status of the Minecraft bot."
    args_schema: Type[BaseModel] = GetStatusBotInput

    def _run(
        self, server_name: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, server_name: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            response = await U.send_request(
                endpoint='status_minecraft_bot', data={}, destination="minecraft_bot", request_type="get")
            if response:
                if 'response' in response:
                    return f"{response['response']}"
                else:
                    return 'Failed'
            else:
                return 'Error'
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
