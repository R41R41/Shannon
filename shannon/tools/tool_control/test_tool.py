from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
from shannon.shannon_agent.llm_agent import LLMSkillAgent
from prompts import load_prompt
from shannon_agent.memory import Memory


class TestToolInput(BaseModel):
    # toolをテストするためのプロンプトを指定します。
    test_prompt: str = Field(
        description="The prompt to test the tool. Always specify the arguments of the tool to be tested.")
    # toolをテストするための環境を指定します。
    test_env: str = Field(
        description="The environment to test the tool. eg) discord, minecraft")


class TestToolTool(BaseTool):
    # toolをテストするためのツール
    name = "test-tool"
    description = "Tool to test the tool."
    args_schema: Type[BaseModel] = TestToolInput

    async def _arun(
        self, test_prompt: str, test_env: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            test_llm = LLMSkillAgent(model_name="gpt-4o-mini")
            status = test_llm.initialization_status
            if not status['success']:
                return status['result']
            system_content = load_prompt(f"text_chat_on_{test_env}")
            human_content = f"{test_prompt}"
            response = await test_llm.get_response(
                system_content=system_content, human_content=human_content)
            memory = Memory()
            memory.add_ai_action(
                skill="test-tool", action=f"test tool {test_prompt}")
            return response
        except Exception as e:
            error_message = f"An error occurred. {e}"
            return error_message

    def _run(
        self, test_prompt: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")
