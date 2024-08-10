from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)


class SearchWeatherInput(BaseModel):
    # 天気を検索する日付を指定します。
    day: str = Field(
        description="should get by get_current_time tool, e.g. 2024年2月1日")
    # 天気を検索する場所を指定します。
    location: str = Field(
        description="should be a location to search on bing search about weather, e.g. 東京")


class SearchWeatherTool(BaseTool):
    # 天気を検索するためのツール
    name = "search-weather"
    description = "Tool to search weather forecast."
    args_schema: Type[BaseModel] = SearchWeatherInput

    def _run(
        self, day: str, location: str = "東京", run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, day: str, location: str = "東京", run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        return f"If necessary, calculate the date to be searched, and then search it in the format of '{day} {location} weather' with the 'weather' word using the bing-search tool. Search in the language of the location. Output must include specific date, maximum temperature, minimum temperature, precipitation, and wind speed. The unit of temperature is℃, the unit of precipitation is mm, and the unit of wind speed is m/s."
