from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
from pytz import timezone
from datetime import datetime
from shannon_agent.memory import Memory


class GetCurrentTimeInput(BaseModel):
    # タイムゾーンを指定します。デフォルトは東京です。
    zone: str = Field(default="Asia/Tokyo",
                      description="Timezone to specify. Default is Tokyo.")


class GetCurrentTimeTool(BaseTool):
    # 指定されたタイムゾーンの現在時刻を取得します。
    name = "get_current_time"
    description = "Get the current time in the specified timezone."
    args_schema: Type[BaseModel] = GetCurrentTimeInput

    def _run(
        self, zone: str = "Asia/Tokyo", run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, zone: str = "Asia/Tokyo", run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            tokyo_zone = timezone(zone)
            tokyo_time = datetime.now(tokyo_zone)
            return tokyo_time.strftime('%Y-%m-%d %H:%M:%S')
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
