from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
from prompts import load_prompt
from openai import OpenAI
from shannon_agent.memory import Memory

client = OpenAI()


class DescribeImageInput(BaseModel):
    # 画像のURLを指定します。
    image_url: str = Field(description="Specify the image URL.")


class DescribeImageTool(BaseTool):
    # 画像リンクから画像を読み込み、何が写っているか描写するためのツール
    name = "describe_image"
    description = "Tool to read an image from a link and describe what is written."
    args_schema: Type[BaseModel] = DescribeImageInput

    def _run(
        self, image_url: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, image_url: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            response = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text",
                                "text": "Please describe the image in detail."},
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": image_url
                                },
                            },
                        ],
                    }
                ],
                max_tokens=300,
            )
            memory = Memory()
            memory.add_ai_action(
                skill="describe-image", action=f"describe image {image_url}")
            return response.choices[0].message.content
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
