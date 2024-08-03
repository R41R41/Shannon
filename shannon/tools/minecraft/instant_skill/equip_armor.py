from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
import utils as U


class EquipArmorInput(BaseModel):
    # 装備する防具の種類（例：helmet, chestplate, leggings, boots）, またはnullで全ての防具を脱ぎます。
    armorType: str = Field(
        description="Specify the type of armor to equip (e.g. helmet, chestplate, leggings, boots), or null to remove all armor.")


class EquipArmorTool(BaseTool):
    # 指定された防具を装備するか、全ての防具を脱ぎます。
    name = "equip-armor"
    description = "Tool to equip or remove the specified armor."
    args_schema: Type[BaseModel] = EquipArmorInput

    def _run(
        self, armorType: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, armorType: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            data = {
                "armorType": armorType
            }
            response = await U.send_request(
                endpoint='equip-armor', data=data, destination="mineflayer", request_type="post")
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        except Exception as e:
            return f"equip-armor: {e}"
