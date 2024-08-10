import sqlite3
from langchain.pydantic_v1 import BaseModel, Field
from langchain.tools import BaseTool
from typing import Optional, Type
from langchain.callbacks.manager import (
    CallbackManagerForToolRun,
    AsyncCallbackManagerForToolRun
)
from shannon_agent.memory import Memory
from datetime import datetime
import pytz


class SearchMyMemoryInput(BaseModel):
    # 検索するスキル名を指定します。
    skill: Optional[str] = Field(
        default=None,
        description="should be a skill name to search in the skill usage history database, e.g. llm-math")
    # 検索する期間の開始時間を指定します。
    start_timestamp: str = Field(
        default=None,
        description="should be the start timestamp for filtering by time in the skill usage history database, e.g. 2024-02-01 00:00:00")
    # 検索する期間の終了時間を指定します。
    end_timestamp: str = Field(
        default=None,
        description="should be the end timestamp for filtering by time in the skill usage history database, e.g. 2024-02-01 23:59:59")
    # 検索結果の上限数を指定します。
    limit: int = Field(
        default=None,
        description="should be the number of results to return from the skill usage history database, e.g. 16")
    # 検索するテキストを指定します。
    include_text: str = Field(
        default=None,
        description="should be a text to search in the skill usage history database, e.g. ライ あだ名")


class SearchMyMemoryTool(BaseTool):
    # スキル使用履歴DBから検索するためのツール
    name = "search_my_memory"
    description = "Tool to search in the skill usage history database. Output in the specified format."
    args_schema: Type[BaseModel] = SearchMyMemoryInput

    def _run(
        self, skill=None, start_timestamp=None, end_timestamp=None, limit=16, include_text=None, run_manager: Optional[CallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool."""
        raise NotImplementedError("This tool requires asynchronous operation.")

    async def _arun(
        self, skill=None, start_timestamp=None, end_timestamp=None, limit=16, include_text=None, run_manager: Optional[AsyncCallbackManagerForToolRun] = None
    ) -> str:
        """Use the tool asynchronously."""
        try:
            db_path = './saves/ltm.db'
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()
            query = "SELECT id, result FROM LTM"
            conditions = []
            params = []
            if skill:
                conditions.append("skill = ?")
                params.append(skill)
            if start_timestamp:
                conditions.append("timestamp >= ?")
                params.append(start_timestamp)
            if end_timestamp:
                conditions.append("timestamp <= ?")
                params.append(end_timestamp)
            if include_text:
                conditions.append("result LIKE ?")
                params.append(f"%{include_text}%")
            if conditions:
                query += " WHERE " + " AND ".join(conditions)
            query += " ORDER BY timestamp DESC"
            if limit:
                query += " LIMIT ?"
                params.append(limit)
            cursor.execute(query, tuple(params))
            results = cursor.fetchall()
            # Update reference count and last referenced timestamp
            jst = pytz.timezone('Asia/Tokyo')
            current_jst_timestamp = datetime.now(jst).isoformat()
            update_query = "UPDATE LTM SET reference_count = reference_count + 1, last_reference_timestamp = ? WHERE id = ?"
            for result in results:
                cursor.execute(
                    update_query, (current_jst_timestamp, result[0]))
            conn.commit()
            conn.close()
            memory = Memory()
            memory.add_ai_action(
                skill="search-my-memory", action=f"search my memory {skill} {start_timestamp} {end_timestamp} {limit} {include_text}")
            return str(results)
        except Exception as e:
            print(e)
            return f"An error occurred. {e}"
