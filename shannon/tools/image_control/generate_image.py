from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
from openai import OpenAI
from dotenv import load_dotenv
from shannon_agent.memory import Memory
load_dotenv()

client = OpenAI()


class GenerateImageInput(BaseModel):
    # 画像を生成するためのプロンプトを指定します。
    prompt: str = Field(description="should be a generate_image prompt")
    # 画像のサイズを指定します。
    size: str = Field(
        description="should be the size of the image to generate, e.g. 1024x1024")


class GenerateImageTool(BaseTool):
    name = "generate_image"
    description = "generate an image for the given prompt"
    args_schema: Type[BaseModel] = GenerateImageInput

    def _run(
        self, prompt: str, size: str = "1024x1024", run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self,
        prompt: str, size: str = "1024x1024",
        run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
    ) -> str:
        """Use the tool asynchronously."""
        try:
            response = client.images.generate(
                model="dall-e-3",
                prompt=prompt,
                size="1024x1024",
                quality="standard",
                n=1,
            )
            image_url = response.data[0].url
            memory = Memory()
            memory.add_ai_action(
                skill="generate-image", action=f"generate image {prompt} with size {size}")
            return str(image_url)
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
