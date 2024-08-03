from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
from prompts import load_prompt
from shannon_agent.memory import Memory


class CodingSkillOnMinecraftInput(BaseModel):
    # スキルの名前を指定します。
    skill_name: str = Field(
        description="The name of the skill. eg. attackEntity")
    # スキルの説明を指定します。
    skill_description: str = Field(
        description="The description of the skill. eg. Attacks the specified entity in the vicinity.")
    # スキルの引数を指定します。
    skill_params: str = Field(
        description="The parameters of the skill. eg. '[{name:entityCount, type:int, description:The number of entities to attack}, {name:entityName, type:string, description:The name of the entity to attack}]'")


class CodingSkillOnMinecraftTool(BaseTool):
    # mineflayerのbotに実行させる新しいスキルのjavascriptコードを生成するためのツール
    name = "coding-skill-on-minecraft"
    description = "Tool to generate new skill code for mineflayer bot. Use the learn-new-skill-on-minecraft tool to learn the new skill."
    args_schema: Type[BaseModel] = CodingSkillOnMinecraftInput

    def _run(
        self, skill_name: str, skill_description: str, skill_params: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, skill_name: str, skill_description: str, skill_params: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            system_content = load_prompt("coding_skill_on_minecraft")
            human_content = "skill_name:"+skill_name+"\nskill_description:" + \
                skill_description+"\nskill_params:"+skill_params
            memory = Memory()
            memory.add_ai_action(
                skill="coding-skill", action=f"create skill {skill_name}")
            return str(system_content) + "\n" + str(human_content)
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
