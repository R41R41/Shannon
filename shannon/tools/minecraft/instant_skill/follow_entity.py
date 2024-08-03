from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import utils as U
from shannon_agent.memory import Memory


class FollowEntityInput(BaseModel):
    # フォローするエンティティの名前を指定します。zombieなどのentity_typeか、player名を指定します。
    entity_name: str = Field(
        description="Specify the name of the entity to follow. Use the entity type or player name.")


class FollowEntityTool(BaseTool):
    # 指定したエンティティを追尾するためのツール
    name = "follow-entity"
    description = "Tool to follow the specified entity in Minecraft."
    args_schema: Type[BaseModel] = FollowEntityInput

    def _run(
        self, entity_name: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, entity_name: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            data = {
                "entityName": entity_name,
            }
            response = await U.send_request(
                endpoint='follow-entity', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"follow-entity: {e}"
