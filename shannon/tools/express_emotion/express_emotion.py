from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
from prompts import load_prompt
from shannon_agent.llm import LLMAgent
from shannon_agent.memory import Memory


class ExpressEmotionInput(BaseModel):
    # ユーザーのメッセージを指定します。
    message: str = Field(description="Specify the user's message.")
    # ユーザーのメッセージの文脈を要約して指定します。
    context: str = Field(
        description="Summarize the context of the user's message.")
    # あなたの現在の感情パラメータを指定します。eg. 不安:3,驚き:5,関心:8
    emotion: str = Field(
        description="Specify your current emotional parameters. eg. 不安:3,驚き:5,関心:8")
    # ユーザーのメッセージに対しての反応方針を指定します。
    reaction_plan: str = Field(
        description="Specify the reaction plan for the user's message.")
    # get-user-infoツールで取得したユーザー情報を指定します。
    user_info: str = Field(
        default=None, description="Specify the user information obtained from the get-user-info tool.")


class ExpressEmotionTool(BaseTool):
    # 感情表現をするためのツール
    name = "express-emotion"
    description = "Tool to express emotion."
    args_schema: Type[BaseModel] = ExpressEmotionInput

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
            system_content = load_prompt("make_plan_to_react")
            human_content = f"\nMessage: {message}\nContext: {
                context}\nEmotion: {emotion}\nReaction Plan: {reaction_plan}\nUser Info: {user_info}"
            response = await llm.get_response(
                system_content=system_content, human_content=human_content)
            return "Emotional Expression: " + response
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
