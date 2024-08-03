import json
import matplotlib.pyplot as plt
import pandas as pd
from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
import subprocess
import sys
import imgkit


class CreateComparisonTableImageInput(BaseModel):
    # 比較する名前のリスト。
    names: list = Field(
        description="List of names to compare. Example: ['さくら みこ', '星街 すいせい']")
    # json形式の比較表のデータ。
    data: str = Field(
        description="Comparison table data in JSON format. Example: {'誕生日': ['3月5日', '3月22日'], '趣味': ['ゲーム', '歌'], ...}")


class CreateComparisonTableImageTool(BaseTool):
    name = "create-comparison-table-image"
    # 比較表を画像に変換します。
    description = "Create an image of a comparison table."
    args_schema: Type[BaseModel] = CreateComparisonTableImageInput

    def _run(
        self, names: list, data: str, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool synchronously."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, names: list, data: str, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            data = json.loads(data)
            df = pd.DataFrame(data)
            # DataFrameを転置
            df_transposed = df.transpose()
            df_transposed.columns = names

            # スタイリングの適用
            styled_html = df_transposed.style.set_properties(**{
                'background-color': '#f0f0f0',
                'color': 'black',
                'font-size': '12pt'
            }).to_html()

            # HTMLファイルとして保存（余分な空間を削除し、テキストを中央揃えにするCSSを追加）
            html_output = f'''
            <html>
            <head>
            <meta charset="UTF-8">
            <style>
                body, html {{
                    margin: 0;
                    padding: 0;
                    height: 100%;
                    width: 100%;
                }}
                table {{
                    width: 500px;
                    margin: 20px auto;
                }}
                th, td {{
                    text-align: center;
                }}
            </style>
            </head>
            <body>{styled_html}</body>
            </html>
            '''
            current_dir = os.path.dirname(os.path.abspath(__file__))
            project_root = os.path.abspath(os.path.join(current_dir, '..', '..', '..'))
            image_path = os.path.join(project_root, 'saves', 'images', 'comparison_table.png')
            html_path = os.path.join(project_root, 'saves', 'html', 'comparison_table.html')
            with open(html_path, "w") as file:
                file.write(html_output)
            # HTMLを画像に変換
            imgkit.from_file(html_path,
                             image_path, options={'width': 1})
            return image_path
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
