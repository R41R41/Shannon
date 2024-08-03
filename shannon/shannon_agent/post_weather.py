from prompts import load_prompt
import requests
from datetime import datetime, timedelta
import pytz
from typing import List
from .llm import LLMAgent

jst = pytz.timezone('Asia/Tokyo')


class PostWeatherAgent:
    def __init__(
        self,
        CITIES: List[str] = ["仙台", "東京", "名古屋", "大阪", "福岡"],
    ):
        self.llm = LLMAgent(model_name="gpt-4o-mini")
        self.cities = [["稚内", "011000"], ["根室", "014010"], ["札幌", "016010"], ["函館", "017010"], ["青森", "020010"], ["盛岡", "030010"], ["仙台", "040010"], ["秋田", "050010"], ["山形", "060010"], ["福島", "070010"], ["水戸", "080010"], ["宇都宮", "090010"], ["前橋", "100010"], ["熊谷", "110020"], ["銚子", "120020"], ["東京", "130010"], ["八丈島", "130030"], ["横浜", "140010"], ["新潟", "150010"], ["富山", "160010"], ["金沢", "170010"], ["福井", "180010"], ["甲府", "190010"], ["長野", "200010"], ["岐阜", "210010"], [
            "浜松", "220040"], ["名古屋", "230010"], ["津", "240010"], ["大津", "250010"], ["京都", "260010"], ["大阪", "270000"], ["神戸", "280010"], ["奈良", "290010"], ["和歌山", "300010"], ["鳥取", "310010"], ["松江", "320010"], ["岡山", "330010"], ["広島", "340010"], ["山口", "350020"], ["徳島", "360010"], ["高松", "370000"], ["松山", "380010"], ["高知", "390010"], ["福岡", "400010"], ["佐賀", "410010"], ["長崎", "420010"], ["熊本", "430010"], ["大分", "440010"], ["宮崎", "450010"], ["鹿児島", "460010"], ["那覇", "471010"]]
        self.display_cities = CITIES
        self.search_cities = [
            "函館", "仙台", "水戸", "熊谷", "東京", "名古屋", "金沢", "新潟", "浜松", "大阪", "広島", "高知", "福岡", "那覇"
        ]
        self.url = "https://weather.tsukumijima.net/api/forecast?city="

    @property
    def chat_observations(self):
        return [
            "city",
            "temperature",
            "weather",
            "chanceOfRain",
        ]

    def get_url(self, city):
        response = requests.get(self.url+city)
        return response

    async def get_telop(self, forecast_data):
        telop = forecast_data["telop"]
        return telop

    async def get_emoji(self, telop, chanceOfRain):
        system_content = load_prompt("emoji")
        human_content = "weather:"+telop+"\n,chanceOfRain:"+chanceOfRain
        response = await self.llm.get_response(system_content=system_content, human_content=human_content)
        return response

    def get_temperature(self, forecast_data):
        temperature_data = forecast_data["temperature"]
        min = temperature_data["min"]["celsius"]
        max = temperature_data["max"]["celsius"]
        temperature_text = min+"-"+max+"℃"
        return temperature_text

    def get_chanceOfRain(self, forecast_data):
        chanceOfRain_data = forecast_data["chanceOfRain"]
        t00_06 = chanceOfRain_data["T00_06"]
        t06_12 = chanceOfRain_data["T06_12"]
        t12_18 = chanceOfRain_data["T12_18"]
        t18_24 = chanceOfRain_data["T18_24"]
        chanceOfRain_text = t00_06+t06_12+t12_18+t18_24
        return chanceOfRain_text

    def get_weather(self, forecast_data):
        weather_data = forecast_data["detail"]["weather"]
        weather_txt = weather_data.replace("\u3000", "")
        return weather_txt

    async def get_forecasts(self):
        forecasts = []
        for city in self.cities:
            if city[0] in self.search_cities:
                print(f"searching weather at {city[0]}")
                response = self.get_url(city[1])
                data = response.json()
                forecast_data = data["forecasts"][1]
                city = city[0]
                telop = await self.get_telop(forecast_data)
                temperature = self.get_temperature(forecast_data)
                chanceOfRain = self.get_chanceOfRain(forecast_data)
                weather = self.get_weather(forecast_data)
                forecast = {"city": city, "telop": telop, "temperature": temperature,
                            "chanceOfRain": chanceOfRain, "weather": weather}
                forecasts.append(forecast)
        return forecasts

    async def get_comment(self, forecasts, date):
        system_content = load_prompt("forecast")
        human_content = "[\n"
        human_content += "date:" + date
        for forecast in forecasts:
            human_content += "  {\n"
            for key in self.chat_observations:
                human_content += "    "+key+":"+forecast[key]+"\n"
            human_content += "  },\n"
        human_content += "]\n"
        response = await self.llm.get_response(system_content=system_content, human_content=human_content)
        return response

    def get_tommorow_date(self):
        now = datetime.now(jst)
        tomorrow = now + timedelta(days=1)
        date = tomorrow.strftime("%m-%d")
        weekday_int = tomorrow.weekday()
        weekday_str = ["月", "火", "水", "木", "金", "土", "日"]
        return date+"("+weekday_str[weekday_int]+")"

    # "90%0%10%50%" というような文字列から最大の降水確率を取得するメソッド"
    async def get_maxChanceOfRain(self, chanceOfRain):
        chanceOfRain_list = chanceOfRain.split("%")
        chanceOfRain_list.pop()
        chanceOfRain_list = [int(i) for i in chanceOfRain_list]
        maxChanceOfRain = max(chanceOfRain_list)
        return str(maxChanceOfRain)+"%"

    async def post_data(self):
        forecasts = await self.get_forecasts()
        date = self.get_tommorow_date()
        data_sentence = f"明日{date}の天気\n"
        # data_sentence += "都市名：天気,気温,6時間毎の降水確率\n"
        for forecast in forecasts:
            city = forecast["city"]
            if city in self.display_cities:
                if len(city) <= 2:
                    padding = "　" * (3 - len(city))  # 全角スペースを追加
                    city += padding
                emoji = await self.get_emoji(forecast["telop"], forecast["chanceOfRain"])
                temperature = forecast["temperature"]
                chanceOfRain = await self.get_maxChanceOfRain(forecast["chanceOfRain"])
                text = f"{city}：{emoji}, {temperature}, {chanceOfRain}\n"
                data_sentence += text
        return data_sentence

    async def post_comment(self):
        forecasts = await self.get_forecasts()
        date = self.get_tommorow_date()
        comment_sentence = await self.get_comment(forecasts, date)
        return comment_sentence
