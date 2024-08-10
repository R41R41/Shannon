from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U


class LoadSkillsOnMinecraftInput(BaseModel):
    pass


class LoadSkillsOnMinecraftTool(BaseTool):
    # mineflayerのbotにスキルを読み込ませるためのツール
    name = "load_skills_on_minecraft"
    description = "Tool to load skills for mineflayer bot."
    args_schema: Type[BaseModel] = LoadSkillsOnMinecraftInput

    def _run(
        self, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            response = await U.send_request(
                endpoint='load-skills', data={}, destination="mineflayer", request_type="post")
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"Error: {e}"
