from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
import os
from dotenv import load_dotenv
from langchain_community.utilities.bing_search import BingSearchAPIWrapper
from shannon_agent.memory import Memory
load_dotenv()

BING_SUBSCRIPTION_KEY = os.getenv('BING_SUBSCRIPTION_KEY')
if BING_SUBSCRIPTION_KEY is not None:
    os.environ["BING_SUBSCRIPTION_KEY"] = BING_SUBSCRIPTION_KEY
else:
    raise ValueError("BING_SUBSCRIPTION_KEY 環境変数が設定されていません。")

os.environ["BING_SEARCH_URL"] = "https://api.bing.microsoft.com/v7.0/search"\



class BingSearchInput(BaseModel):
    query: str = Field(
        description="should be a query to search on bing search in japanese, e.g. 2024年2月1日 東京 天気")


class BingSearchTool(BaseTool):
    # 検索が必要な場合に使用するツール
    name = "bing_search"
    description = "Tool to search. Output in the specified format."
    args_schema: Type[BaseModel] = BingSearchInput

    def _run(
        self, query: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, query: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            bing_subscription_key = os.getenv('BING_SUBSCRIPTION_KEY')
            if bing_subscription_key is None:
                raise ValueError(
                    "BING_SUBSCRIPTION_KEY environment variable is not set.")
            bing_search_url = os.getenv('BING_SEARCH_URL')
            if bing_search_url is None:
                raise ValueError(
                    "BING_SEARCH_URL environment variable is not set.")

            bing = BingSearchAPIWrapper(
                bing_subscription_key=bing_subscription_key,
                bing_search_url=bing_search_url
            )
            response = bing.run(query)
            memory = Memory()
            memory.add_ai_action(
                skill="bing-search", action=f"search query: {query}")
            return str(response)
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
