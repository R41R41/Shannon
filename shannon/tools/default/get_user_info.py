from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)


class GetUserInfoInput(BaseModel):
    # ユーザー名を指定します。
    user_name: str = Field(description="User name to specify.")


class GetUserInfoTool(BaseTool):
    # ユーザーの情報(心理的距離、好感度、感情、付加情報)を取得するためのツール
    name = "get-user-info"
    description = "Tool to get user information (psychological distance, liking, emotion, additional information)"
    args_schema: Type[BaseModel] = GetUserInfoInput

    def _run(
        self, user_name: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, user_name: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            import os
            root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
            user_file_path = os.path.join(root_dir, "saves", "users", f"{user_name}.txt")
            init_content = "このユーザーへの私の心理的距離: 7/10\nこのユーザーへの私の好感度: 7/10\nこのユーザーへの私の感情: まだ特になし\nこのユーザーの付加情報: まだ特になし"
            
            os.makedirs(os.path.dirname(user_file_path), exist_ok=True)  # ディレクトリが存在しない場合は作成
            
            try:
                with open(user_file_path, 'r', encoding='utf-8') as file:
                    user_info = file.read()
            except FileNotFoundError:
                with open(user_file_path, 'w', encoding='utf-8') as file:
                    file.write(init_content)
                return f"New file created: {user_file_path}"
            except Exception as e:
                return f"An error occurred while reading the file: {e}"
            return "User Info: " + user_info
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
