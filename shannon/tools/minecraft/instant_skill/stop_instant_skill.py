from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U


class StopInstantSkillInput(BaseModel):
    # 停止させるスキルの名前を指定します。
    skill_name: str = Field(
        description="The name of the skill to stop.")


class StopInstantSkillTool(BaseTool):
    # 指定したインスタントスキルを停止するためのツール
    name = "stop-instant-skill"
    description = "Tool to stop the specified instant skill in Minecraft. This tool is used when the user says 'stop'."
    args_schema: Type[BaseModel] = StopInstantSkillInput

    def _run(
        self, skill_name: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, skill_name: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            data = {
                "skillName": skill_name,
            }
            response = await U.send_request(
                endpoint='stop-instant-skill', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"stop-instant-skill: {e}"
