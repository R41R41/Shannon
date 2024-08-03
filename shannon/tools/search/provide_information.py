from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
from prompts import load_prompt
from shannon_agent.llm import LLMAgent


class ProvideInformationInput(BaseModel):
    # ユーザーのメッセージを指定します。
    message: str = Field(description="The user's message.")
    # ユーザーのメッセージの文脈を要約して指定します。
    context: str = Field(description="The context of the user's message.")
    # ユーザーのメッセージに対しての感情を指定します。
    emotion: str = Field(description="The emotion of the user's message.")
    # ユーザーのメッセージに対しての反応方針を指定します。
    reaction_plan: str = Field(
        description="The reaction plan of the user's message.")
    # get-user-infoツールで取得したユーザー情報を指定します。
    user_info: str = Field(
        default=None, description="The user information obtained from the get-user-info tool.")


class ProvideInformationTool(BaseTool):
    # 信頼性の高い情報を提供するためのツール
    name = "provide-information"
    description = "Tool to provide information of high reliability."
    args_schema: Type[BaseModel] = ProvideInformationInput

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
            system_content = load_prompt("provide_information")
            human_content = f"\nMessage: {message}\nContext: {
                context}\nEmotion: {emotion}\nReaction Plan: {reaction_plan}\nUser Info: {user_info}"
            response = await llm.get_response(
                system_content=system_content, human_content=human_content)
            return "Information: " + response
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
