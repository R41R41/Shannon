from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
import utils as U


class AttackEntityInput(BaseModel):
    # 倒したいエンティティの数を指定します。nullで全てのエンティティを倒します。
    num: int = Field(
        description="Specify the number of entities to attack. Null to attack all entities.")
    entity_name: str = Field(
        description="Specify the name of the entity to attack. You can specify the entity_type or player name.")
    tool_name: str = Field(
        description="Specify the name of the tool to use for attack. Null to automatically select a tool.")


class AttackEntityTool(BaseTool):
    name = "attack-entity"
    description = "Tool to attack the specified entity."
    args_schema: Type[BaseModel] = AttackEntityInput

    def _run(
        self, num: int, entity_name: str, tool_name: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, num: int, entity_name: str, tool_name: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            data = {
                "num": num,
                "entityName": entity_name,
                "toolName": tool_name
            }
            response = await U.send_request(
                endpoint='attack-entity', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"attack-entity: {e}"
