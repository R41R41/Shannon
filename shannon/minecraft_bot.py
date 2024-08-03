import asyncio
import os
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from minecraft_bot_agent import MinecraftBotAgent
import logging
import pytz
from dotenv import load_dotenv
from typing import List
from aiohttp import web
load_dotenv()

jst = pytz.timezone('Asia/Tokyo')


class MinecraftBot:
    def __init__(
        self,
        AZURE_USERNAME: str = None,
        RESOURCE_GROUP: str = None,
        server_ports: dict = None,
    ):
        self.RESOURCE_GROUP = RESOURCE_GROUP
        self.AZURE_USERNAME = AZURE_USERNAME
        self.scheduler = AsyncIOScheduler(timezone=jst)
        self.minecraft_bot_agent = MinecraftBotAgent(server_ports=server_ports)
        logging.basicConfig(filename='saves/error_log.txt',
                            level=logging.ERROR)

    async def start_scheduler(self):
        self.scheduler.start()

    async def start_server(self):
        app = web.Application()
        app.add_routes([
            web.get("/status", self.handle_request_status),
            web.get("/schedule_status", self.handle_request_scheduler_status),
            web.get("/schedule_start", self.handle_request_scheduler_start),
            web.get("/schedule_stop", self.handle_request_scheduler_stop),
            web.post("/login_minecraft_server",
                     self.handle_request_login_minecraft_server),
            web.post("/logout_minecraft_server",
                     self.handle_request_logout_minecraft_server),
            web.get("/status_minecraft_bot",
                    self.handle_request_status_minecraft_bot),
            web.post("/auto_minecraft_bot",
                     self.handle_request_auto_minecraft_bot),
            web.post("/learn_new_skill",
                     self.handle_request_learn_new_skill),
        ])
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, 'localhost', PORT)
        await site.start()
        print(f"minecraft_bot_server started on port {PORT}")
        return site

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

    async def handle_request_login_minecraft_server(self, request):
        print("handle_request_login_minecraft_server")
        data = await request.json()
        server_name = data['server_name']
        response = await self.minecraft_bot_agent.login_minecraft_server(
            server_name=server_name)
        return web.json_response({"response": response})

    async def handle_request_logout_minecraft_server(self, request):
        data = await request.json()
        server_name = data['server_name']
        response = await self.minecraft_bot_agent.logout_minecraft_server(
            server_name=server_name)
        return web.json_response({"response": response})

    async def handle_request_status_minecraft_bot(self, request):
        response = await self.minecraft_bot_agent.status_minecraft_bot()
        return web.json_response({"response": response})

    async def handle_request_auto_minecraft_bot(self, request):
        data = await request.json()
        server_name = data['server_name']
        response = await self.minecraft_bot_agent.auto_minecraft_bot(
            server_name=server_name)
        print(response)
        return web.json_response({"response": response})

    async def handle_request_learn_new_skill(self, request):
        data = await request.json()
        response = await self.minecraft_bot_agent.learn_new_skill(
            skill_name=data['skill_name'], skill_description=data['skill_description'], skill_params=data['skill_params'])
        return web.json_response({"success": response["success"], "result": response["result"]})


IS_TEST = os.getenv('IS_TEST') == 'True'

if IS_TEST:
    PORT = 3201
else:
    PORT = 3200

AZURE_USERNAME = os.getenv('AZURE_USERNAME')
RESOURCE_GROUP = os.getenv('RESOURCE_GROUP')

server_ports = {
    "1.19.0-youtube1": 25577,
    "1.19.0-youtube2": 25568,
    "1.19.0-youtube3": 25569,
    "1.20.4-test": 25566,
    "1.20.4-play": 25565,
    "1.21.0-play": 25564
}


async def main():
    minecraft_bot = MinecraftBot(
        AZURE_USERNAME=AZURE_USERNAME,
        RESOURCE_GROUP=RESOURCE_GROUP,
        server_ports=server_ports,
    )
    server_task = minecraft_bot.start_server()
    scheduler = minecraft_bot.start_scheduler()
    await asyncio.gather(server_task, scheduler)
    await asyncio.Event().wait()

if __name__ == "__main__":
    asyncio.run(main())
