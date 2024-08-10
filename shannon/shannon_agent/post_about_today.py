from datetime import datetime
import requests
from prompts import load_prompt
import pytz
from .llm_agent import LLMSkillAgent

jst = pytz.timezone('Asia/Tokyo')


class PostAboutTodayAgent:
    def __init__(
        self,
    ):
        self.llm = LLMSkillAgent(
            model_name="gpt-4o-mini", tool_categories=["search"])

    def get_today_date(self):
        now = datetime.now(jst)
        mmdd = now.strftime('%m%d')
        return mmdd

    def get_aboutToday_keyword(self, mmdd):
        url = "https://wazka.jp/v2/anniv/" + mmdd
        r = requests.get(url).json()
        item = r['_items'][0]
        anniv_list = []
        for i in range(1, 6):  # 1から5まで
            key = f"anniv{i}"
            if key in item:
                anniv_list.append(item[key])
        return anniv_list

    async def post(self):
        system_content = load_prompt("aboutToday")
        today = self.get_today_date()
        # anniv_list = self.get_aboutToday_keyword(today)
        # print(anniv_list)
        # human_content = f"date:{today}\nanniversaries:{anniv_list}"
        human_content = f"date:{today}"
        response = await self.llm.get_response(system_content=system_content, human_content=human_content)
        return response
