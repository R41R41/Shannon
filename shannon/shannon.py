import asyncio
import os
import websockets
import json
import sys
from aiohttp import web
from apscheduler.triggers.cron import CronTrigger
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from shannon_agent import ChatAgent
from shannon_agent import Memory
from shannon_agent import PostWeatherAgent
from shannon_agent import PostFortuneAgent
from shannon_agent import PostAboutTodayAgent
import utils as U
import pytz
import wave
import tempfile
jst = pytz.timezone('Asia/Tokyo')


class Shannon():
    def __init__(self):
        self.initialization_status = {
            "success": True, "result": "shannon initialized successfully"}
        try:
            self.scheduler = AsyncIOScheduler(timezone=jst)
            self.chat_agent = ChatAgent()
            self.initialization_status = self.chat_agent.initialization_status
            self.weather_post_agent = PostWeatherAgent()
            self.fortune_post_agent = PostFortuneAgent()
            self.about_today_post_agent = PostAboutTodayAgent()
            self.memory = Memory()
        except Exception as e:
            self.initialization_status = {"success": False, "result": f"{e}"}

    async def start_server(self):
        app = web.Application()
        app.add_routes([
            web.post('/discord_chat', self.handle_request_discord_chat),
            web.post('/discord_voice_chat',
                     self.handle_request_discord_voice_chat),
            web.post('/minecraft/chat',
                     self.handle_request_minecraft_bot_chat),
            web.get('/post_weather_data',
                    self.handle_request_post_weather_data),
            web.get('/post_weather_comment',
                    self.handle_request_post_weather_comment),
            web.get('/post_fortune',
                    self.handle_request_post_fortune),
            web.get('/post_about_today',
                    self.handle_request_post_about_today),
            web.post('/import_tools', self.handle_request_import_tools),
            web.post('/get_variable', self.handle_request_get_variable),
            web.post('/response_to_voice',
                     self.handle_request_response_to_voice),
        ])

        websocket_server = websockets.serve(
            self.handle_websocket, 'localhost', int(U.destination_to_port("shannon_voice_client")))
        await websocket_server
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, 'localhost', PORT)
        await site.start()
        print(f"shannon_server started on port {PORT}")
        return site

    async def handle_websocket(self, websocket, path):
        pcm_data = b''  # バイナリデータを格納する変数
        try:
            async for message in websocket:
                if isinstance(message, bytes):
                    pcm_data += message
                else:
                    data = json.loads(message)
                    if data['type'] == 'end':
                        if len(pcm_data) < 800:  # 0.1秒未満のデータをチェック (16kHz * 0.1秒 * 1チャンネル * 2バイト)
                            await websocket.send(json.dumps({"error": "Audio file is too short. Minimum audio length is 0.1 seconds."}))
                            pcm_data = b''
                            continue

                        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp_wav:
                            with wave.open(temp_wav, 'wb') as wav_file:
                                wav_file.setnchannels(1)  # モノラル
                                wav_file.setsampwidth(2)  # 16ビット
                                wav_file.setframerate(8000)  # サンプルレート
                                wav_file.writeframes(pcm_data)
                            temp_wav_path = temp_wav.name

                        response = await self.chat_agent.response_to_voice(
                            voice_file_path=temp_wav_path,  # バイナリデータを渡す
                            user_name=data['nickname'],
                            time=data['jstTime']
                        )
                        pcm_data = b''
                        await websocket.send(json.dumps({"response": response}))
        except websockets.exceptions.ConnectionClosedError as e:
            print(f"WebSocket connection closed: {e}")
        except Exception as e:
            print(f"Error in handle_websocket: {e}")

    async def handle_request_response_to_voice(self, request):
        print("handle_request_response_to_voice")
        data = await request.json()
        voice_file_path = data["voice_file_path"]
        sender_id = data["sender_id"]
        guild_id = data["guild_id"]
        user_name = data["user_name"]
        time = data["time"]
        response = await self.chat_agent.response_to_voice(voice_file_path=voice_file_path, sender_id=sender_id, guild_id=guild_id, user_name=user_name, time=time)
        return web.json_response({"response": response})

    async def handle_request_get_variable(self, request):
        print("handle_get_variable_request")
        data = await request.json()
        variable_description = data["variable_description"]
        response = await self.chat_agent.get_variable(variable_description=variable_description)
        return web.json_response({"variable": response})

    async def start_scheduler(self):
        self.scheduler.add_job(
            self.ltm_delete_db, CronTrigger(hour="*", timezone=jst))
        self.scheduler.start()

    async def handle_request_minecraft_bot_chat(self, request):
        print("handle_minecraft_bot_chat_request")
        try:
            data = await request.json()
            sender_name = data["chat_sender_name"]
            message = data["chat_message"]
            bot_position = data["bot_position"]
            bot_health = data["bot_health"]
            bot_food_level = data["bot_food_level"]
            response = await self.chat_agent.minecraft_bot_chat(sender_name=sender_name, message=message, bot_position=bot_position, bot_health=bot_health, bot_food_level=bot_food_level)
            print("handle_minecraft_bot_chat_request", response)
            return web.json_response({"success": True, "result": response})
        except Exception as e:
            return web.json_response({"success": False, "result": f"{e}"})

    async def handle_request_discord_chat(self, request):
        print("handle_discord_chat_request")
        data = await request.json()
        message = data["message"]
        time = data["time"]
        sender_name = data["sender_name"]
        channel_id = data["channel_id"]
        check_needs = data["check_needs"]
        message_id = data["message_id"]
        response = await self.chat_agent.discord_chat(message=message, time=time, sender_name=sender_name, channel_id=channel_id, check_needs=check_needs, message_id=message_id)
        return web.json_response({"text": response})

    async def handle_request_discord_voice_chat(self, request):
        print("handle_discord_voice_chat_request")
        data = await request.json()
        message = data["message"]
        sender_name = data["sender_name"]
        actor = data["actor"]
        channel_id = data["channel_id"]
        check_needs = data["check_needs"]
        response = await self.chat_agent.discord_voice_chat(message=message, sender_name=sender_name, actor=actor, channel_id=channel_id, check_needs=check_needs)
        return web.json_response({"text": response})

    async def handle_request_post_weather_data(self, request):
        print("handle_weather_data_post_request")
        response = await self.weather_post_agent.post_data()
        return web.json_response({"text": response})

    async def handle_request_post_weather_comment(self, request):
        print("handle_weather_data_post_request")
        response = await self.weather_post_agent.post_comment()
        return web.json_response({"text": response})

    async def handle_request_post_fortune(self, request):
        print("handle_fortune_post_request")
        response = await self.fortune_post_agent.post()
        return web.json_response({"text": response})

    async def handle_request_post_about_today(self, request):
        print("handle_about_today_post_request")
        response = await self.about_today_post_agent.post()
        return web.json_response({"text": response})

    async def handle_request_create_voice_chat_message(self, request):
        print("handle_create_voice_chat_message_request")
        data = await request.json()
        message = data["message"]
        sender_name = data["sender_name"]
        channel_id = data["channel_id"]
        check_needs = data["check_needs"]
        response = await self.chat_agent.create_voice_chat_message(sender_name=sender_name, message=message, channel_id=channel_id, check_needs=check_needs)
        return web.json_response({"text": response})

    async def handle_request_import_tools(self, request):
        print("handle_request_import_tools")
        data = await request.json()
        tool_categories = data["tool_categories"]
        await self.chat_agent.llm.import_tools(tool_categories=tool_categories)
        return web.json_response({"text": "import_tools success"})

    async def ltm_delete_db(self):
        await self.memory.delete_db()


IS_TEST = os.getenv('IS_TEST') == 'True'

if IS_TEST:
    PORT = 3001
else:
    PORT = 3000

shannon = Shannon()


async def main():
    shannon = Shannon()
    if not shannon.initialization_status['success']:
        print(shannon.initialization_status['result'])
        return
    server_task = shannon.start_server()
    scheduler = shannon.start_scheduler()
    await asyncio.gather(server_task, scheduler)
    await asyncio.Event().wait()

if __name__ == "__main__":
    asyncio.run(main())
