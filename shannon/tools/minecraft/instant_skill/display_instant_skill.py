from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U


class DisplayInstantSkillInput(BaseModel):
    # 表示するスキルの名前を指定します。
    skill_name: str = Field(
        description="Specify the name of the skill to display.")


class DisplayInstantSkillTool(BaseTool):
    # ボットのInstant Skillの設定を表示するためのツール
    name = "display-instant-skill"
    description = "Tool to display the settings of the bot's Instant Skill in the minecraft chat window."
    args_schema: Type[BaseModel] = DisplayInstantSkillInput

    def _run(
        self, skill_name: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, skill_name: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        try:
            """Use the tool asynchronously."""
            data = {
                "skillName": skill_name
            }
            response = await U.send_request(
                endpoint='display-instant-skill', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"display-instant-skill: {e}"
