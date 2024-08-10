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


class UpdateUserInfoInput(BaseModel):
    # ユーザー名を指定します。
    user_name: str = Field(description="User name to specify.")
    # 現在のユーザーの情報を指定します。
    current_user_info: str = Field(
        description="Current user information to specify.")
    # 更新する内容を指定します。
    update_content: str = Field(description="Update content to specify.")


class UpdateUserInfoTool(BaseTool):
    # ユーザーの情報を更新するためのツール
    name = "update_user_info"
    description = "Tool to update user information"
    args_schema: Type[BaseModel] = UpdateUserInfoInput

    def _run(
        self, user_name: str, current_user_info: str, update_content: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, user_name: str, current_user_info: str, update_content: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            llm = LLMAgent()
            system_content = load_prompt("update_user_info")
            human_content = f"\nCurrent User Info: {
                current_user_info}\nUpdate Content: {update_content}"
            response = await llm.get_response(
                system_content=system_content, human_content=human_content)
            import os
            current_dir = os.path.dirname(os.path.abspath(__file__))
            user_file_path = os.path.join(
                current_dir, "..", "..", "saves", "users", f"{user_name}.txt")
            try:
                with open(user_file_path, 'w') as file:
                    file.write(response)
            except FileNotFoundError:
                return f"File not found: {user_file_path}"
            except Exception as e:
                return f"An error occurred while writing the file: {e}"
            memory = Memory()
            memory.add_ai_action(
                skill="update-user-info", action=f"update {user_name} user info:{update_content}")
            return "Updated User Info: " + response
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
