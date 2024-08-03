import asyncio
from datetime import datetime
import logging
import subprocess
import time
import aiohttp
from .control_vm_and_mc import VMandMCAgent


class BotAgent:
    def __init__(
        self,
        RESOURCE_GROUP,
        AZURE_USERNAME,
        MINECRAFT_VM_IP,
        VM_MINECRAFT_KEY_PATH,
        COST_CHANNEL_ID,
    ):
        self.vm_agent = VMandMCAgent(
            RESOURCE_GROUP=RESOURCE_GROUP,
            AZURE_USERNAME=AZURE_USERNAME,
            MINECRAFT_VM_IP=MINECRAFT_VM_IP,
            VM_MINECRAFT_KEY_PATH=VM_MINECRAFT_KEY_PATH,
            COST_CHANNEL_ID=COST_CHANNEL_ID,
        )

    async def request_get_twitter_bot(self, request_url):
        async with aiohttp.ClientSession() as session:
            try:
                async with session.get(request_url) as response:
                    if response.status == 200:
                        return await response.text()
            except Exception as e:
                logging.error(f"{datetime.now()} - 未知のエラー: {e}")

    async def statusMineBot(self):
        command = "screen -list | grep minebot"
        process = await asyncio.create_subprocess_shell(command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await process.communicate()
        if "minebot" in stdout.decode():
            return True
        else:
            return False

    async def statusBot(self, channel):
        bot_status = self.statusMineBot()
        if bot_status:
            await channel.send(f'minecraft_bot: 起動中')
        else:
            await channel.send(f'minecraft_bot: 停止中')
        await channel.send(f'discord_bot: 起動中')
        bot_status = await self.request_get_twitter_bot(request_url="http://localhost:3000/status")
        if bot_status == "True":
            await channel.send(f'twitter_bot: 起動中')
        else:
            await channel.send(f'twitter_bot: 停止中')

    async def autoBot(self, channel, bot, server):
        bot_status = self.statusMineBot()
        if bot_status:
            self.stopBot(channel, bot)
        else:
            self.startBot(channel, bot, server)

    async def startBot(self, channel, bot, server):
        if bot == "minecraft_bot":
            await channel.send(f"{bot}を起動します")
            command = f"bash /home/azureuser/start_minebot.sh {server}"
            subprocess.run(command, shell=True)
        if bot == "twitter_bot":
            bot_status = await self.request_get_twitter_bot(request_url="http://localhost:3000/status")
            if bot_status == "True":
                await channel.send(f'twitter_botは既に起動しています')
            else:
                await channel.send(f'twitter_botを起動します')
                responce = await self.request_get_twitter_bot(request_url="http://localhost:3000/start")
                if responce == "True":
                    await channel.send('twitter_botの起動に成功しました')
                else:
                    await channel.send('twitter_botの起動に失敗しました')

    async def schedule_minebot_shutdown(self, channel):
        vm = "minebot"
        await asyncio.sleep(3*3600)
        await self.vm_agent.check_and_stop_vm_async(channel=channel, vm=vm)

    async def stopBot(self, channel, bot):
        if bot == "minecraft_bot":
            await channel.send(f"{bot}を停止します")
            command = f"bash /home/azureuser/stop_minebot.sh"
            subprocess.run(command, shell=True)
        if bot == "twitter_bot":
            bot_status = await self.request_get_twitter_bot(request_url="http://localhost:3000/status")
            if not bot_status == "True":
                await channel.send(f'twitter_botは既に停止しています')
            else:
                await channel.send(f'twitter_botを停止します')
                responce = await self.request_get_twitter_bot(request_url="http://localhost:3000/stop")
                if responce == "True":
                    await channel.send('twitter_botの停止に成功しました')
                else:
                    await channel.send('twitter_botの停止に失敗しました')
