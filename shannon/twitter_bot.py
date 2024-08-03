import asyncio
import os
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from twitter_agent import TwitterAgent
import logging
import pytz
from dotenv import load_dotenv
from typing import List
from aiohttp import web
import sys
load_dotenv()

jst = pytz.timezone('Asia/Tokyo')


class TwitterBot:
    def __init__(
        self,
        CONSUMER_KEY: str = None,
        CONSUMER_SECRET: str = None,
        ACCESS_TOKEN: str = None,
        ACCESS_SECRET: str = None,
        VM_MINECRAFT_KEY_PATH: str = None,
        MINECRAFT_VM_IP: str = None,
        AZURE_USERNAME: str = None,
        RESOURCE_GROUP: str = None,
        COST_CHANNEL_ID: int = None,
        CITIES: List[str] = ["東京", "名古屋", "大阪", "福岡"],
        X_CHANNEL_ID: int = None,
        TOYAMA_CHANNEL_ID: int = None,
    ):
        self.twitter_agent = TwitterAgent(
            CONSUMER_KEY=CONSUMER_KEY, CONSUMER_SECRET=CONSUMER_SECRET, ACCESS_TOKEN=ACCESS_TOKEN, ACCESS_SECRET=ACCESS_SECRET, X_CHANNEL_ID=X_CHANNEL_ID, TOYAMA_CHANNEL_ID=TOYAMA_CHANNEL_ID)
        self.RESOURCE_GROUP = RESOURCE_GROUP
        self.AZURE_USERNAME = AZURE_USERNAME
        self.COST_CHANNEL_ID = COST_CHANNEL_ID
        self.scheduler = AsyncIOScheduler(timezone=jst)
        self.subscriber_count = 0
        self.video_count = 0
        logging.basicConfig(filename='saves/error_log.txt',
                            level=logging.ERROR)

    async def start_scheduler(self):
        self.scheduler.add_job(
            self.twitter_agent.post_fortune, CronTrigger(hour="8", timezone=jst))
        self.scheduler.add_job(
            self.twitter_agent.post_aboutToday, CronTrigger(hour="12", timezone=jst))
        self.scheduler.add_job(
            self.twitter_agent.post_weather, CronTrigger(hour="18", timezone=jst))
        self.scheduler.start()

    async def start_server(self):
        app = web.Application()
        app.add_routes([
            web.get("/status", self.handle_request_status),
            web.get("/schedule_status", self.handle_request_scheduler_status),
            web.get("/schedule_start", self.handle_request_scheduler_start),
            web.get("/schedule_stop", self.handle_request_scheduler_stop),
            web.get("/post_fortune", self.handle_request_post_fortune),
            web.get("/post_about_today", self.handle_request_post_aboutToday),
            web.get("/post_weather", self.handle_request_post_weather),
            web.get("/get_latest_video", self.handle_request_get_latest_video),
            web.get("/post_latest_video",
                    self.handle_request_post_latest_video)
        ])
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, 'localhost', PORT)
        await site.start()
        print(f"twitter_server started on port {PORT}")
        return site

    async def handle_request_post_fortune(self, request):
        response = await self.twitter_agent.post_fortune()
        return web.json_response({"response": response})

    async def handle_request_post_aboutToday(self, request):
        response = await self.twitter_agent.post_aboutToday()
        return web.json_response({"response": response})

    async def handle_request_post_weather(self, request):
        print("handle_request_post_weather")
        response = await self.twitter_agent.post_weather()
        return web.json_response({"response": response})

    async def handle_request_get_latest_video(self, request):
        await self.twitter_agent.get_latest_video()
        return web.json_response()

    async def handle_request_post_latest_video(self, request):
        response = await self.twitter_agent.post_latest_video()
        return web.json_response({"response": response})

    async def handle_request_status(self, request):
        return web.json_response({"response": True})

    async def handle_request_scheduler_status(self, request):
        print("handle_status_scheduler_request")
        status = self.scheduler.running
        return web.json_response({"response": status})

    async def handle_request_scheduler_start(self, request):
        status = self.scheduler.running
        if not status:
            await self.start_scheduler()
            return web.json_response({"response": "started"})
        else:
            return web.json_response({"response": "already started"})

    async def handle_request_scheduler_stop(self, request):
        status = self.scheduler.running
        if status:
            await self.scheduler.shutdown()
            return web.json_response({"response": "stopped"})
        else:
            return web.json_response({"response": "already stopped"})


IS_TEST = os.getenv('IS_TEST') == 'True'

if IS_TEST:
    CONSUMER_KEY = os.getenv('TWITTER_API_KEY_TEST')
    CONSUMER_SECRET = os.getenv('TWITTER_API_KEY_SECRET_TEST')
    ACCESS_TOKEN = os.getenv('TWITTER_ACCESS_TOKEN_TEST')
    ACCESS_SECRET = os.getenv('TWITTER_ACCESS_TOKEN_SECRET_TEST')
    X_CHANNEL_ID = int(os.getenv('TEST_X_CHANNEL_ID'))
    TOYAMA_CHANNEL_ID = int(os.getenv('TEST_TOYAMA_CHANNEL_ID'))
    PORT = 3401
else:
    CONSUMER_KEY = os.getenv('TWITTER_API_KEY')
    CONSUMER_SECRET = os.getenv('TWITTER_API_KEY_SECRET')
    ACCESS_TOKEN = os.getenv('TWITTER_ACCESS_TOKEN')
    ACCESS_SECRET = os.getenv('TWITTER_ACCESS_TOKEN_SECRET')
    X_CHANNEL_ID = int(os.getenv('X_CHANNEL_ID'))
    TOYAMA_CHANNEL_ID = int(os.getenv('TOYAMA_CHANNEL_ID'))
    PORT = 3400

CITIES = ["仙台", "東京", "名古屋", "大阪", "福岡"]

VM_MINECRAFT_KEY_PATH = os.getenv('VM_MINECRAFT_KEY_PATH')
MINECRAFT_VM_IP = os.getenv('MINECRAFT_VM_IP')
AZURE_USERNAME = os.getenv('AZURE_USERNAME')
RESOURCE_GROUP = os.getenv('RESOURCE_GROUP')
COST_CHANNEL_ID = int(os.getenv('COST_CHANNEL_ID'))


async def main():
    twitter_bot = TwitterBot(
        CONSUMER_KEY=CONSUMER_KEY,
        CONSUMER_SECRET=CONSUMER_SECRET,
        ACCESS_TOKEN=ACCESS_TOKEN,
        ACCESS_SECRET=ACCESS_SECRET,
        CITIES=CITIES,
        VM_MINECRAFT_KEY_PATH=VM_MINECRAFT_KEY_PATH,
        MINECRAFT_VM_IP=MINECRAFT_VM_IP,
        AZURE_USERNAME=AZURE_USERNAME,
        RESOURCE_GROUP=RESOURCE_GROUP,
        COST_CHANNEL_ID=COST_CHANNEL_ID,
        X_CHANNEL_ID=X_CHANNEL_ID,
        TOYAMA_CHANNEL_ID=TOYAMA_CHANNEL_ID,
    )
    server_task = twitter_bot.start_server()
    if IS_TEST:
        await server_task
    else:
        scheduler = twitter_bot.start_scheduler()
        await asyncio.gather(server_task, scheduler)
    await asyncio.Event().wait()

if __name__ == "__main__":
    asyncio.run(main())
