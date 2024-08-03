import asyncio
import os
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from minecraft_agent import MinecraftAgent
import logging
import pytz
from dotenv import load_dotenv
from typing import List
from aiohttp import web
load_dotenv()

jst = pytz.timezone('Asia/Tokyo')


class MinecraftServer:
    def __init__(
        self,
        AZURE_USERNAME: str = None,
        RESOURCE_GROUP: str = None,
        server_ports: dict = None,
    ):
        self.RESOURCE_GROUP = RESOURCE_GROUP
        self.AZURE_USERNAME = AZURE_USERNAME
        self.scheduler = AsyncIOScheduler(timezone=jst)
        self.minecraft_agent = MinecraftAgent(server_ports=server_ports)
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
            web.post("/start_minecraft_server",
                     self.handle_request_start_minecraft_server),
            web.post("/stop_minecraft_server",
                     self.handle_request_stop_minecraft_server),
            web.post("/status_minecraft_server",
                     self.handle_request_status_minecraft_server),
            web.post("/auto_minecraft_server",
                     self.handle_request_auto_minecraft_server),
        ])
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, 'localhost', PORT)
        await site.start()
        print(f"minecraft_server started on port {PORT}")
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

    async def handle_request_start_minecraft_server(self, request):
        print("handle_request_start_minecraft_server")
        data = await request.json()
        server_name = data['server_name']
        response = await self.minecraft_agent.start_minecraft_server(
            server_name=server_name)
        print(f"response: {response}")
        return web.json_response({"response": response})

    async def handle_request_stop_minecraft_server(self, request):
        data = await request.json()
        server_name = data['server_name']
        response = await self.minecraft_agent.stop_minecraft_server(
            server_name=server_name)
        print(f"response: {response}")
        return web.json_response({"response": response})

    async def handle_request_status_minecraft_server(self, request):
        data = await request.json()
        server_name = data['server_name']
        response = await self.minecraft_agent.status_minecraft_server(
            server_name=server_name)
        return web.json_response({"response": response})

    async def handle_request_auto_minecraft_server(self, request):
        data = await request.json()
        server_name = data['server_name']
        response = await self.minecraft_agent.auto_minecraft_server(
            server_name=server_name)
        return web.json_response({"response": response})


IS_TEST = os.getenv('IS_TEST') == 'True'

if IS_TEST:
    PORT = 3101
else:
    PORT = 3100

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
    minecraft_server = MinecraftServer(
        AZURE_USERNAME=AZURE_USERNAME,
        RESOURCE_GROUP=RESOURCE_GROUP,
        server_ports=server_ports,
    )
    server_task = minecraft_server.start_server()
    scheduler = minecraft_server.start_scheduler()
    await asyncio.gather(server_task, scheduler)
    await asyncio.Event().wait()

if __name__ == "__main__":
    asyncio.run(main())
