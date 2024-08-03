import asyncio
import logging
import os
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from discord_agent import DiscordAgent
from discord_agent import VoiceAgent
import discord
import pytz
from discord import app_commands
from dotenv import load_dotenv
from aiohttp import web

load_dotenv()
jst = pytz.timezone('Asia/Tokyo')


class DiscordBot:
    def __init__(
        self,
        RESOURCE_GROUP: str,
        AZURE_USERNAME: str,
        MINECRAFT_VM_IP: str,
        VM_MINECRAFT_KEY_PATH: str,
        COST_CHANNEL_ID: int,
        GENERAL_CHANNEL_ID: int,
        TOYAMA_GUILD_ID: int,
        TOYAMA_CHANNEL_ID: int,
        IS_TEST: bool,
        TEST_GUILD_ID: int,
    ):
        self.subscriber_count = 0
        self.RESOURCE_GROUP = RESOURCE_GROUP
        self.AZURE_USERNAME = AZURE_USERNAME
        self.MINECRAFT_VM_IP = MINECRAFT_VM_IP
        self.VM_MINECRAFT_KEY_PATH = VM_MINECRAFT_KEY_PATH
        self.scheduler = AsyncIOScheduler(timezone=jst)
        self.discord_agent = DiscordAgent(
            client=client, COST_CHANNEL_ID=COST_CHANNEL_ID, GENERAL_CHANNEL_ID=GENERAL_CHANNEL_ID, TOYAMA_GUILD_ID=TOYAMA_GUILD_ID, TOYAMA_CHANNEL_ID=TOYAMA_CHANNEL_ID, IS_TEST=IS_TEST, TEST_GUILD_ID=TEST_GUILD_ID)
        self.voice_agent = VoiceAgent(client=client, is_test=IS_TEST)
        logging.basicConfig(filename='saves/error_log.txt',
                            level=logging.ERROR)

    async def start_server(self):
        app = web.Application()
        app.add_routes([
            web.get('/status', self.handle_request_status),
            web.post('/chat', self.handle_request_chat),
            web.post('/increase_youtube_subscriber_count',
                     self.handle_request_increase_youtube_subscriber_count),
            web.post('/voice_chat_in_or_out',
                     self.handle_request_voice_chat_in_or_out),
            web.post('/get_recent_channel_log',
                     self.handle_request_get_recent_channel_log),
            web.post('/add_reaction', self.handle_request_add_reaction),
            web.post("/get_server_emoji",
                     self.handle_request_get_server_emoji),
        ])
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, 'localhost', PORT)
        await site.start()
        print(f"discord_server started on port {PORT}")
        return site

    async def handle_request_status(self, request):
        return web.json_response({"response": True})

    async def handle_request_voice_chat_in_or_out(self, request):
        data = await request.json()
        option = data["option"]
        response = await self.voice_agent.voice_chat_in_or_out(option=option)
        return web.json_response({"response": response})

    async def handle_request_increase_youtube_subscriber_count(self, request):
        data = await request.json()
        subscriber_count = data["subscriber_count"]
        response = await self.discord_agent.increase_youtube_subscriber_count(subscriber_count=subscriber_count)
        return web.json_response({"response": response})

    async def handle_request_get_server_emoji(self, request):
        print("handle_get_emoji_request")
        data = await request.json()
        channel_id = int(data["channel_id"])
        message_id = int(data["message_id"])
        response = await self.discord_agent.get_emoji(channel_id=channel_id, message_id=message_id)
        return web.json_response({"response": response})

    async def handle_request_get_recent_channel_log(self, request):
        data = await request.json()
        channel_id = int(data["channel_id"])
        message_count = int(data["message_count"])
        response = await self.discord_agent.get_recent_channel_log(channel_id=channel_id, message_count=message_count)
        return web.json_response({"response": response})

    async def handle_request_add_reaction(self, request):
        print("handle_add_reaction_request")
        data = await request.json()
        channel_id = int(data["channel_id"])
        message_id = int(data["message_id"])
        emoji = data["emoji"]
        is_server_emoji = data["is_server_emoji"]
        response = await self.discord_agent.add_reaction(channel_id=channel_id, message_id=message_id, emoji=emoji, is_server_emoji=is_server_emoji)
        return web.json_response({"response": response})

    async def handle_request_chat(self, request):
        print("handle_chat_request")
        data = await request.json()
        text = data["text"]
        embed_image_url = data["embed_image_url"]
        file_path = data["file_path"]
        channel_id = int(data["channel_id"])
        response = await self.discord_agent.chat(text=text, embed_image_url=embed_image_url, file_path=file_path, channel_id=channel_id)
        print(response)
        return web.json_response({"response": response})


IS_TEST = os.getenv('IS_TEST') == 'True'
TEST_GUILD_ID = int(os.getenv('TEST_GUILD_ID'))

if IS_TEST:
    GUILD_ID = TEST_GUILD_ID
    X_CHANNEL_ID = int(os.getenv('TEST_X_CHANNEL_ID'))
    DEV_CHANNEL_ID = int(os.getenv('TEST_DEV_CHANNEL_ID'))
    GENERAL_CHANNEL_ID = int(os.getenv('TEST_GENERAL_CHANNEL_ID'))
    COST_CHANNEL_ID = int(os.getenv('TEST_COST_CHANNEL_ID'))
    VOICE_CHANNEL_ID = int(os.getenv("TEST_VOICE_CHANNEL_ID"))
    PORT = 3301
else:
    GUILD_ID = int(os.getenv('GUILD_ID'))
    X_CHANNEL_ID = int(os.getenv('X_CHANNEL_ID'))
    DEV_CHANNEL_ID = int(os.getenv('DEV_CHANNEL_ID'))
    GENERAL_CHANNEL_ID = int(os.getenv('GENERAL_CHANNEL_ID'))
    COST_CHANNEL_ID = int(os.getenv('COST_CHANNEL_ID'))
    VOICE_CHANNEL_ID = int(os.getenv("VOICE_CHANNEL_ID"))
    PORT = 3300
DISCORD_TOKEN = os.getenv('TOKEN')
RESOURCE_GROUP = os.getenv('RESOURCE_GROUP')
AZURE_USERNAME = os.getenv('AZURE_USERNAME')
MINECRAFT_VM_IP = os.getenv('MINECRAFT_VM_IP')
VM_MINECRAFT_KEY_PATH = os.getenv('VM_MINECRAFT_KEY_PATH')
TOYAMA_GUILD_ID = int(os.getenv('TOYAMA_GUILD_ID'))
TOYAMA_CHANNEL_ID = int(os.getenv('TOYAMA_CHANNEL_ID'))

intents = discord.Intents.default()
intents.messages = True
intents.presences = True
intents.members = True
intents.message_content = True
client = discord.Client(intents=intents)
tree = app_commands.CommandTree(client)

discord_bot = DiscordBot(
    RESOURCE_GROUP=RESOURCE_GROUP,
    AZURE_USERNAME=AZURE_USERNAME,
    MINECRAFT_VM_IP=MINECRAFT_VM_IP,
    VM_MINECRAFT_KEY_PATH=VM_MINECRAFT_KEY_PATH,
    COST_CHANNEL_ID=COST_CHANNEL_ID,
    GENERAL_CHANNEL_ID=GENERAL_CHANNEL_ID,
    TOYAMA_GUILD_ID=TOYAMA_GUILD_ID,
    TOYAMA_CHANNEL_ID=TOYAMA_CHANNEL_ID,
    IS_TEST=IS_TEST,
    TEST_GUILD_ID=TEST_GUILD_ID,
)

print(GUILD_ID, TOYAMA_GUILD_ID)


@client.event
async def on_ready():
    await tree.sync(guild=discord.Object(id=TOYAMA_GUILD_ID))


@tree.command(name="replay_voice_chat", description="送ったテキストに対してシャノンが音声チャットで返答します")
@discord.app_commands.guilds(TOYAMA_GUILD_ID, GUILD_ID)
@discord.app_commands.choices(
    actor=[
        app_commands.Choice(name="alloy", value="alloy"),
        app_commands.Choice(name="echo", value="echo"),
        app_commands.Choice(name="fable", value="fable"),
        app_commands.Choice(name="onyx", value="onyx"),
        app_commands.Choice(name="nova", value="nova"),
        app_commands.Choice(name="shimmer", value="shimmer"),
    ],
)
async def replay_voice_chat(interaction: discord.Interaction, actor: str, message: str):
    await discord_bot.voice_agent.voice_chat(interaction=interaction, actor=actor, message=message)


@tree.command(name="voice_chat", description="シャノンと音声チャットで会話します")
@discord.app_commands.guilds(TOYAMA_GUILD_ID, GUILD_ID)
@discord.app_commands.choices(
    option=[
        app_commands.Choice(name="login", value="login"),
        app_commands.Choice(name="logout", value="logout"),
    ],
    voice_mode=[
        app_commands.Choice(name="VoicePeak", value="VoicePeak"),
        app_commands.Choice(name="VoiceVox", value="VoiceVox"),
        app_commands.Choice(name="OpenAi", value="OpenAi"),
    ]
)
async def voice_chat(interaction: discord.Interaction, option: str = None, voice_mode: str = None):
    await discord_bot.voice_agent.voice_chat_in_or_out(interaction=interaction, option=option, voice_mode=voice_mode)


@tree.command(name="minecraft", description="Minecraftサーバーの操作を行います")
@discord.app_commands.guilds(TOYAMA_GUILD_ID, GUILD_ID)
@discord.app_commands.choices(
    option=[
        app_commands.Choice(name="start", value="start"),
        app_commands.Choice(name="stop", value="stop"),
        app_commands.Choice(name="status", value="status"),
    ],
    server=[
        app_commands.Choice(name="1.20.4-youtube1", value="1.20.4-youtube1"),
        app_commands.Choice(name="1.20.4-youtube2", value="1.20.4-youtube2"),
        app_commands.Choice(name="1.20.4-youtube3", value="1.20.4-youtube3"),
        app_commands.Choice(name="1.20.4-test", value="1.20.4-test"),
        app_commands.Choice(name="1.20.4-play", value="1.20.4-play"),
    ]
)
async def control_mc(interaction: discord.Interaction, option: str = "Auto", server: str = "Auto"):
    await discord_bot.discord_agent.control_mc(interaction=interaction, option=option, server=server)


@tree.command(name="minecraft_bot", description="minecraft_botの操作を行います")
@discord.app_commands.guilds(TOYAMA_GUILD_ID, GUILD_ID)
@discord.app_commands.choices(
    option=[
        app_commands.Choice(name="login", value="login"),
        app_commands.Choice(name="logout", value="logout"),
        app_commands.Choice(name="status", value="status"),
    ],
    server=[
        app_commands.Choice(name="1.19.0-youtube1", value="1.19.0-youtube1"),
        app_commands.Choice(name="1.19.0-youtube2", value="1.19.0-youtube2"),
        app_commands.Choice(name="1.19.0-youtube3", value="1.19.0-youtube3"),
        app_commands.Choice(name="1.20.4-test", value="1.20.4-test"),
        app_commands.Choice(name="1.20.4-play", value="1.20.4-play"),
    ]
)
async def control_bot(interaction: discord.Interaction, option: str = "Auto", server: str = "Auto"):
    await discord_bot.discord_agent.control_minecraft_bot(interaction=interaction, option=option, server=server)


@tree.command(name="post", description="x-botによるポストの操作を行います")
@discord.app_commands.guilds(GUILD_ID)
@discord.app_commands.choices(
    category=[
        app_commands.Choice(name="fortune", value="fortune"),
        app_commands.Choice(name="about_today", value="about_today"),
        app_commands.Choice(name="weather", value="weather"),
        app_commands.Choice(name="latest_video", value="latest_video"),
    ]
)
async def control_post(interaction: discord.Interaction, category: str,):
    await discord_bot.discord_agent.control_post(interaction=interaction, category=category)


@client.event
async def on_message(message):
    await discord_bot.discord_agent.on_message(message=message)


async def main():
    bot_task = client.start(DISCORD_TOKEN)
    server_task = discord_bot.start_server()
    await asyncio.gather(bot_task, server_task)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
