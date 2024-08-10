from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
from prompts import load_prompt
from shannon.shannon_agent.llm_agent import LLMAgent
from shannon_agent.memory import Memory


class EmpathizeAndCommunicateInput(BaseModel):
    # ユーザーのメッセージを指定します。
    message: str = Field(description="User message to specify.")
    # ユーザーのメッセージの文脈を要約して指定します。
    context: str = Field(description="User message context to summarize.")
    # あなたの現在の感情パラメータを指定します。
    emotion: str = Field(
        description="Your current emotional parameters to specify. eg. 不安:3,驚き:5,関心:8")
    # ユーザーのメッセージに対しての反応方針を指定します。
    reaction_plan: str = Field(
        description="Reaction plan to specify for the user message.")
    # get-user-infoツールで取得したユーザー情報を指定します。
    user_info: str = Field(
        default=None, description="User information obtained from the get-user-info tool.")


class EmpathizeAndCommunicateTool(BaseTool):
    # 共感してコミュニケーションを取るためのツール
    name = "empathize-and-communicate"
    description = "Tool to empathize and communicate"
    args_schema: Type[BaseModel] = EmpathizeAndCommunicateInput

    def _run(
        self, message: str, context: str, emotion: str, reaction_plan: str, user_info: str = None, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, message: str, context: str, emotion: str, reaction_plan: str, user_info: str = None, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            llm = LLMAgent(model_name="gpt-4o-mini")
            system_content = load_prompt("empathize_and_communicate")
            human_content = f"\nMessage: {message}\nContext: {
                context}\nEmotion: {emotion}\nReaction Plan: {reaction_plan}\nUser Info: {user_info}"
            response = await llm.get_response(
                system_content=system_content, human_content=human_content)
            return "Response: " + response
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
