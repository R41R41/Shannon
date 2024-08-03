from langchain.pydantic_v1 import BaseModel
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U


class DisplayInstantSkillListInput(BaseModel):
    pass


class DisplayInstantSkillListTool(BaseTool):
    # ボットのInstant Skillのリストを表示するためのツール
    name = "display-instant-skill-list"
    description = "Tool to display the list of Instant Skill in the minecraft chat window."
    args_schema: Type[BaseModel] = DisplayInstantSkillListInput

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
                endpoint='display-instant-skill-list', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"display-instant-skill-list: {e}"
