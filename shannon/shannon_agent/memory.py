import sqlite3
from langchain_core.messages import AIMessage, HumanMessage
from langchain_openai import ChatOpenAI
from prompts import load_prompt
from datetime import datetime, timezone, timedelta
import os
from langchain.schema import SystemMessage

class Memory:
    def __init__(
            self,
            db_path='saves/ltm.db',
            STM_size=16,
            model_name: str = "gpt-4o-mini",
            temperature: int = 0,
            request_timout: int = 120
    ):
        self.db_path = db_path
        self.is_test = os.getenv("IS_TEST") == 'True'
        self.init_db()
        self.STM_summary = ""
        self.STM = []
        self.STM_size = STM_size
        self.llm = ChatOpenAI(
            model_name=model_name,
            temperature=temperature,
            request_timeout=request_timout,
        )
        self.system_content = load_prompt("summarise_chat_log")


    @property
    def memory_observations(self):
        return [
            "old_summary",
            "recent_chat_log",
            "last_message"
        ]

    async def render_observation(self):
        observation = {
            "old_summary": f"Old Summary:\n {self.STM_summary}\n\n",
            "recent_chat_log": f"Recent Chat Log:\n {self.STM}\n\n",
            "last_message": f"Last Message: \n {self.STM[-1]}\n\n",
        }
        return observation

    def init_db(self):
        if self.is_test:
            return
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute(
            '''CREATE TABLE IF NOT EXISTS LTM (id INTEGER PRIMARY KEY AUTOINCREMENT, skill TEXT, result TEXT, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, reference_count INTEGER DEFAULT 0, last_reference_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
        conn.commit()
        conn.close()

    def get_STM(self):
        return self.STM

    async def delete_db(self):
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM LTM")
        count = cursor.fetchone()[0]
        if count >= 1024:
            cursor.execute("""
                DELETE FROM LTM
                WHERE id IN (
                    SELECT id FROM LTM
                    ORDER BY last_reference_timestamp ASC, reference_count ASC
                    LIMIT 64
                )
            """)
            conn.commit()
        conn.close()

    async def add_user_message(self, user_message):
        self.STM.append(HumanMessage(content=user_message))
        self.save_to_db(skill="input_message", result=user_message)
        if len(self.STM) > self.STM_size:
            await self.summarise_STM()
            while len(self.STM) > self.STM_size:
                self.STM.pop(0)

    async def add_ai_message(self, ai_message):
        self.STM.append(AIMessage(content=ai_message))
        self.save_to_db(skill="output_message", result=ai_message)
        if len(self.STM) > self.STM_size:
            await self.summarise_STM()
            while len(self.STM) > self.STM_size:
                self.STM.pop(0)

    def add_ai_action(self, skill, action):
        self.save_to_db(skill=skill, result=action)

    def render_system_message(self, content):
        system_message = SystemMessage(content=content)
        assert isinstance(system_message, SystemMessage)
        return system_message

    def render_human_message(self, *, content):
        return HumanMessage(content=content)

    async def summarise_STM(self):
        system_content = self.system_content
        observation = await self.render_observation()
        human_content = ""
        for key in self.memory_observations:
            human_content += observation[key]
        messages = [
            self.render_system_message(content=system_content),
            self.render_human_message(content=human_content)
        ]
        response = await self.llm.ainvoke(input=messages)
        self.STM_summary = response.content if isinstance(
            response, AIMessage) else response
        return

    def save_to_db(self, skill, result):
        if self.is_test:
            return
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        current_utc_time = datetime.utcnow()
        jst_time = current_utc_time + timedelta(hours=9)
        formatted_time = jst_time.strftime(
            '%Y-%m-%d %H:%M:%S')  # SQL用のフォーマットに変換
        cursor.execute("INSERT INTO LTM (skill, result, timestamp, last_reference_timestamp) VALUES (?, ?, ?, ?)",
                       (skill, result, formatted_time, formatted_time))
        conn.commit()
        conn.close()
