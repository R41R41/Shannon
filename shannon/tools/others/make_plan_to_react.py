from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
from prompts import load_prompt
from shannon.shannon_agent.llm_agent import LLMSkillAgent
from shannon_agent.memory import Memory


class MakePlanToReactInput(BaseModel):
    # ユーザーのメッセージを指定します。
    message: str = Field(description="User message to specify.")
    # ユーザーのメッセージのIDを指定します。
    message_id: str = Field(description="User message ID to specify.")
    # チャンネルIDを指定します。
    channel_id: str = Field(description="Channel ID to specify.")
    # ユーザーのメッセージの文脈を要約して指定します。
    context: str = Field(description="User message context to summarize.")
    # あなたの現在の感情パラメータを指定します。
    emotion: str = Field(
        description="Your current emotional parameters to specify. eg. 不安:3,驚き:5,関心:8")
    # get-user-infoツールで取得したユーザー情報を指定します。
    user_info: str = Field(
        default=None, description="User information obtained from the get-user-info tool.")


class MakePlanToReactTool(BaseTool):
    # 反応方針を決定するためのツール
    name = "make-plan-to-react"
    description = "Tool to decide reaction plan"
    args_schema: Type[BaseModel] = MakePlanToReactInput

    def _run(
        self, message: str, message_id: str, channel_id: str, context: str, emotion: str, user_info: str = None, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, message: str, message_id: str, channel_id: str, context: str, emotion: str, user_info: str = None, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            # llm = LLMSkillAgent(model_name="gpt-4o-mini")
            # status = llm.initialization_status
            # if not status['success']:
            #     return status['result']
            system_content = load_prompt("make_plan_to_react")
            # human_content = f"\nMessage: {message}\nMessage ID: {message_id}\nChannel ID: {
            #     channel_id}\nContext: {context}\nEmotion: {emotion}\nUser Info: {user_info}"
            # response = await llm.get_response(
            #     system_content=system_content, human_content=human_content)
            # memory = Memory()
            # memory.add_ai_action(
            #     skill="make-plan-to-react", action=f"make reaction plan {response}")
            return system_content
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
