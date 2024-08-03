from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U


class StopServerInput(BaseModel):
    # 停止させるminecraftサーバーの名前を以下の候補から指定します。1.20.4-test:テスト用, 1.20.4-youtube1:youtubeメイン撮影用, 1.20.4-youtube2:youtube撮影用サブ1, 1.20.4-youtube3:youtube撮影用サブ2, 1.20.4-play:遊び用, Auto:特に指定がない場合
    server_name: str = Field(
        description="The name of the Minecraft server to stop. Choose from the following candidates. 1.20.4-test:test, 1.20.4-youtube1:youtube main, 1.20.4-youtube2:youtube sub1, 1.20.4-youtube3:youtube sub2, 1.20.4-play:play, Auto:no specific server")


class StopServerTool(BaseTool):
    # マイクラサーバーを停止するためのツール
    name = "stop-server"
    description = "Tool to stop the Minecraft server."
    args_schema: Type[BaseModel] = StopServerInput

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
            data = {
                "server_name": server_name
            }
            response = await U.send_request(
                endpoint='stop_minecraft_server', data=data, destination="minecraft_server", request_type="post")
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
