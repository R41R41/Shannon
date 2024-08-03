from langchain.pydantic_v1 import BaseModel
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U


class GetInstantSkillsInput(BaseModel):
    pass


class GetInstantSkillsTool(BaseTool):
    # mineflayerのbotが覚えているスキルの名前と説明を取得するためのツール
    name = "get-instant-skills"
    description = "Tool to get the names and descriptions of the skills that the bot is learning in mineflayer."
    args_schema: Type[BaseModel] = GetInstantSkillsInput

    def _run(
        self, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        try:
            """Use the tool asynchronously."""
            data = {}
            response = await U.send_request(
                endpoint='get-instant-skills', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"get-instant-skills: {e}"
