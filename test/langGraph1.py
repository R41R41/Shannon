from langchain_openai import ChatOpenAI
from langchain_core.tools import tool
from langgraph.prebuilt import ToolNode
from langchain_core.messages import HumanMessage
from langgraph.graph import END, MessageGraph
from langchain_core.messages import BaseMessage
from typing import Literal
import os
from dotenv import load_dotenv
from PIL import Image


load_dotenv()
os.environ["OPENAI_API_KEY"] = os.getenv("OPENAI_API_KEY")


# ツールの定義
@tool
def multiply(first_number: int, second_number: int):
    """2つの数値で掛け算を行う。"""
    return first_number * second_number



# 分岐処理を行う関数
def router(state: list[BaseMessage]) -> Literal["multiply", "__end__"]:
    tool_calls = state[-1].additional_kwargs.get("tool_calls", [])
    if len(tool_calls):
        return "multiply"
    else:
        return END


# モデルの定義
model = ChatOpenAI(temperature=0, model="gpt-4o-mini")
# グラフを初期化
graph = MessageGraph()

# モデルを呼び出すノード、"first_node"をグラフに追加
graph.add_node("first_node", model)
# ツールを実行するノードにツールを紐づけ
tool_node = ToolNode([multiply])
# ツール実行ノード、"multiply"をグラフに追加
graph.add_node("multiply", tool_node)
# "multiply"ノードと"END"ノード（終了ノード）をエッジでつなげる
graph.add_edge("multiply", END)
# グラフのエントリーポイント（開始点）を"first_node"に設定
graph.set_entry_point("first_node")
# 分岐を行うエッジを"first_node"、分岐用関数に紐づけ
graph.add_conditional_edges("first_node", router)

# グラフをコンパイルして実行可能にする
runnable = graph.compile()


response = runnable.invoke(HumanMessage("明日の天気は？"))
# グラフを実行
for r in response:
    print("{}: {}".format(r.type, r.content))
    
# グラフの画像を保存
graph_image = runnable.get_graph(xray=True).draw_mermaid_png()
with open("test/graph.png", "wb") as f:
    f.write(graph_image)
