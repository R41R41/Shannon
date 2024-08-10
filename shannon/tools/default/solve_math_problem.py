import nest_asyncio
from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
from langchain_community.utilities.wolfram_alpha import WolframAlphaAPIWrapper
import os
from dotenv import load_dotenv

load_dotenv()
nest_asyncio.apply()

WOLFRAM_ALPHA_APPID = os.getenv('WOLFRAM_ALPHA_APPID')
if WOLFRAM_ALPHA_APPID is not None:
    os.environ["WOLFRAM_ALPHA_APPID"] = WOLFRAM_ALPHA_APPID
else:
    raise ValueError("WOLFRAM_ALPHA_APPID 環境変数が設定されていません。")
wolfram = WolframAlphaAPIWrapper(wolfram_client=WOLFRAM_ALPHA_APPID)


class SolveMathProblemInput(BaseModel):
    math_problem: str = Field(description="should be a math problem to solve")


class SolveMathProblemTool(BaseTool):
    name = "solve_math_problem"
    description = "solve the given math problem like equation, inequality, etc."
    args_schema: Type[BaseModel] = SolveMathProblemInput

    def _run(
        self, math_problem: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, math_problem: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
    ) -> str:
        """Use the tool asynchronously."""
        try:
            answer = wolfram.run(math_problem)
            return answer
        except Exception as e:
            print(e)
            return f"Error: {e}"
