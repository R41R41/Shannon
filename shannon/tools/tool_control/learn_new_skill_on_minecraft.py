from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
from prompts import load_prompt
from shannon_agent.memory import Memory


class LearnNewSkillOnMinecraftInput(BaseModel):
    # スキルの名前を指定します。
    skill_name: str = Field(
        description="The name of the skill. ex)attackEntity")
    # スキルの説明を指定します。
    skill_description: str = Field(
        description="The description of the skill. ex)Attacks the specified entity in the vicinity.")
    # スキルの引数を指定します。
    skill_params: str = Field(
        description="The parameters of the skill in the following format. ex) '[{name:entityCount, type:int, description:The number of entities to attack}, {name:entityName, type:string, description:The name of the entity to attack}]'")


class LearnNewSkillOnMinecraftTool(BaseTool):
    # mineflayerのbotに実行させるスキルを学習するためのツール
    name = "learn-new-skill-on-minecraft"
    description = "Tool to learn a skill for mineflayer bot. If the skill name, description, or parameters are not clear, please ask the user before running this tool."
    args_schema: Type[BaseModel] = LearnNewSkillOnMinecraftInput

    def _run(
        self, skill_name: str, skill_description: str, skill_params: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, skill_name: str, skill_description: str, skill_params: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            system_content = load_prompt("learn_new_skill_on_minecraft")
            human_content = "skill_name:"+skill_name+"\nskill_description:" + \
                skill_description+"\nskill_params:"+skill_params
            memory = Memory()
            memory.add_ai_action(
                skill="learn-new-skill", action=f"learn new skill {skill_name} with description {skill_description} and params {skill_params}")
            return str(system_content) + "\n" + str(human_content)
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
