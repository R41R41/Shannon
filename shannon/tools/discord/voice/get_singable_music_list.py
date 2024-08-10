from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    AsyncCallbackManagerForToolRun
)
import os


class GetSingableMusicListInput(BaseModel):
    pass


class GetSingableMusicListTool(BaseTool):
    # ボイスチャットを行うためのツール
    name = "get_singable_music_list"
    description = "Tool to get a list of singable music on Discord. Please use when there is a song request."
    args_schema: Type[BaseModel] = GetSingableMusicListInput

    def _run(
        self, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        # 現在のディレクトリからsaves/musicフォルダを探す
        current_dir = os.getcwd()
        music_dir = os.path.join(current_dir, 'saves', 'music')
        # wavファイルの一覧を取得
        wav_files = [f for f in os.listdir(music_dir) if f.endswith('.wav')]
        # レスポンスの作成
        # 曲名のセットを作成
        music_set = set()
        for file in wav_files:
            # ファイル名から拡張子を除去
            name_without_ext = os.path.splitext(file)[0]
            # _musicや_vocalを除去して曲名を取得
            song_name = name_without_ext.rsplit('_', 1)[0]
            music_set.add(song_name)

        # セットをリストに変換
        unique_songs = list(music_set)
        response = {
            'success': True,
            'result': unique_songs
        }
        if response is not None:
            if response['success']:
                return f"Success: {response['result']}"
            else:
                return f"Failed: {response['result']}"
        else:
            return 'An error occurred.'
