from langchain.pydantic_v1 import BaseModel
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U


class DisplayConstantSkillListInput(BaseModel):
    pass


class DisplayConstantSkillListTool(BaseTool):
    # ボットのConstant Skillのリストを表示するためのツール
    name = "display-constant-skill-list"
    description = "Tool to display the list of Constant Skill in the minecraft chat window."
    args_schema: Type[BaseModel] = DisplayConstantSkillListInput

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
                endpoint='display-constant-skill-list', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                return f"成功: {response['result']}"
            else:
                return f"失敗: {response['result']}"
        except Exception as e:
            return f"display-constant-skill-list: {e}"
