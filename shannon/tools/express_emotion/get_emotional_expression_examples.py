from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
from prompts import load_prompt
from shannon_agent.memory import Memory


class GetEmotionalExpressionExamplesInput(BaseModel):
    # あなたの現在の感情を指定します。以下のいずれかの値を指定してください。disgust,anger,anticipation,joy,trust,fear,surprise,sadness
    emotion: str = Field(
        description="Specify your current emotional state. Choose one of the following values: disgust,anger,anticipation,joy,trust,fear,surprise,sadness")


class GetEmotionalExpressionExamplesTool(BaseTool):
    # 感情表現の例を取得するためのツール
    name = "get-emotional-expression-examples"
    description = "Tool to get examples of emotional expressions."
    args_schema: Type[BaseModel] = GetEmotionalExpressionExamplesInput

    def _run(
        self, emotion: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, emotion: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            system_content = load_prompt(f"emotional_expression_{emotion}")
            return str(system_content)
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
