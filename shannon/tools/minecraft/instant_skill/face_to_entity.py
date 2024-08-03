from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
import utils as U


class FaceToEntityInput(BaseModel):
    # 視線を向けるエンティティの名前を指定します。
    entity_name: str = Field(
        description="Specify the name of the entity to look at.")


class FaceToEntityTool(BaseTool):
    # 視線を向けるエンティティを指定するためのツール
    name = "face-to-entity"
    description = "Tool to look at the specified entity."
    args_schema: Type[BaseModel] = FaceToEntityInput

    def _run(
        self, entity_name: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, entity_name: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            data = {
                "entityName": entity_name
            }
            response = await U.send_request(
                endpoint='face-to-entity', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"face-to-entity: {e}"
