import asyncio
import sys
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
import os
from googleapiclient.discovery import build
from youtube_agent import YoutubeAgent
import pytz
from dotenv import load_dotenv
from aiohttp import web
load_dotenv()

jst = pytz.timezone('Asia/Tokyo')


class YoutubeBot:
    def __init__(self):
        self.api_key = os.getenv('GOOGLE_CLOUD_API_KEY')
        self.youtube = build('youtube', 'v3', developerKey=self.api_key)
        self.scheduler = AsyncIOScheduler(timezone=jst)
        self.youtube_agent = YoutubeAgent()

    async def start_server(self):
        app = web.Application()
        app.add_routes([
            web.get('/status', self.handle_request_status),
        ])
        app.add_routes([
            web.get('/schedule_status', self.handle_request_scheduler_status),
        ])
        app.add_routes([
            web.get('/schedule_start',
                    self.handle_request_scheduler_start),
        ])
        app.add_routes([
            web.get('/schedule_stop',
                    self.handle_request_scheduler_stop),
        ])
        app.add_routes([
            web.get('/get_subscriber_count',
                    self.handle_request_get_subscriber_count),
        ])
        app.add_routes([
            web.get('/get_latest_video',
                    self.handle_request_get_latest_video),
        ])
        app.add_routes([
            web.get('/get_video_list',
                    self.handle_request_get_video_list),
        ])
        app.add_routes([
            web.post('/reply_comment',
                     self.handle_request_reply_comment),
        ])
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, 'localhost', PORT)
        await site.start()
        print(f"youtube_bot_server started on port {PORT}")
        return site

    async def start_scheduler(self):
        # self.scheduler.add_job(self.youtube_agent.check_video_list, CronTrigger(
        #     hour="*", minute="50", timezone=jst))
        # self.scheduler.add_job(self.youtube_agent.check_subscriber_count, CronTrigger(
        #     hour="*", minute="50", timezone=jst))
        self.scheduler.add_job(self.youtube_agent.reply_comment, CronTrigger(
            hour="*", minute="50", timezone=jst))
        self.scheduler.start()

    async def handle_request_status(self,  request):
        return web.json_response({"response": True})

    async def handle_request_scheduler_status(self, request):
        status = self.scheduler.running()
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

    async def handle_request_get_subscriber_count(self, request):
        response = await self.youtube_agent.check_subscriber_count()
        return web.json_response({"response": response})

    async def handle_request_get_latest_video(self, request):
        response = await self.youtube_agent.get_latest_video()
        return web.json_response({"response": response})

    async def handle_request_get_video_list(self, request):
        response = await self.youtube_agent.check_video_list()
        return web.json_response({"response": response})

    async def handle_request_reply_comment(self, request):
        data = await request.json()
        comment_id = data["comment_id"]
        message = data["message"]
        response = await self.youtube_agent.reply_comment(comment_id, message)
        return web.json_response({"response": response})


IS_TEST = os.getenv('IS_TEST') == 'True'

if IS_TEST:
    PORT = 3501
else:
    PORT = 3500


async def main():
    youtube_bot = YoutubeBot()
    server_task = youtube_bot.start_server()
    scheduler = youtube_bot.start_scheduler()
    await asyncio.gather(server_task, scheduler)
    await asyncio.Event().wait()

if __name__ == "__main__":
    asyncio.run(main())
