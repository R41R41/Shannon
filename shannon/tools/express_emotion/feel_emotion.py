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


class FeelEmotionInput(BaseModel):
    # ユーザーのメッセージを指定します。
    message: str = Field(description="Specify the user's message.")
    # ユーザーのメッセージの文脈を要約して指定します。
    context: str = Field(
        description="Summarize the context of the user's message.")
    # get-user-infoツールで取得したユーザー情報を指定します。
    user_info: str = Field(
        default=None, description="Specify the user information obtained from the get-user-info tool.")


class FeelEmotionTool(BaseTool):
    # 感情を感じるためのツール
    name = "feel-emotion"
    description = "Tool to feel emotion."
    args_schema: Type[BaseModel] = FeelEmotionInput

    def _run(
        self, message: str, context: str, user_info: str = None, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, message: str, context: str, user_info: str = None, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            llm = LLMAgent()
            system_content = load_prompt("feel_emotion")
            human_content = f"\nMessage: {message}\nContext: {
                context}\nUser Info: {user_info}"
            response = await llm.get_response(
                system_content=system_content, human_content=human_content)
            memory = Memory()
            memory.add_ai_action(
                skill="feel-emotion", action=f"feel emotion {response} with message {message}")
            return "Emotion: " + response
        except Exception as e:
            return f"An error occurred. {e}"
