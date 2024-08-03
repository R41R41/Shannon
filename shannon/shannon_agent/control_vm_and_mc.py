
import asyncio
import subprocess
import time
from datetime import datetime
import os
from dotenv import load_dotenv
import requests

load_dotenv()

TENANT_ID = os.getenv('TENANT_ID')
CLIENT_ID = os.getenv('CLIENT_ID')
CLIENT_SECRET = os.getenv('CLIENT_SECRET')
SUBSCRIPTION_ID = os.getenv('SUBSCRIPTION_ID')


class VMandMCAgent:
    def __init__(
        self,
        RESOURCE_GROUP,
        AZURE_USERNAME,
        MINECRAFT_VM_IP,
        VM_MINECRAFT_KEY_PATH,
        COST_CHANNEL_ID,
    ):
        self.VM_MINECRAFT_KEY_PATH = VM_MINECRAFT_KEY_PATH
        self.AZURE_USERNAME = AZURE_USERNAME
        self.TENANT_ID = TENANT_ID
        self.CLIENT_ID = CLIENT_ID
        self.CLIENT_SECRET = CLIENT_SECRET
        self.SUBSCRIPTION_ID = SUBSCRIPTION_ID
        self.MINECRAFT_VM_IP = MINECRAFT_VM_IP
        self.RESOURCE_GROUP = RESOURCE_GROUP
        self.COST_CHANNEL_ID = COST_CHANNEL_ID
        self.start_time = {"minecraft": None, "minebot": None}
        self.shutdown_task = {"minecraft": None, "minebot": None}

    async def async_run_command(self, command):
        process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await process.communicate()
        if process.returncode != 0:
            raise Exception(
                f"Command failed with error: {stderr.decode('utf-8')}")
        return stdout.decode('utf-8').strip()

    async def check_usage(self, channel):
        token_url = f"https://login.microsoftonline.com/{
            self.TENANT_ID}/oauth2/token"
        token_data = {
            "grant_type": "client_credentials",
            "client_id": self.CLIENT_ID,
            "client_secret": self.CLIENT_SECRET,
            "resource": "https://management.azure.com/"
        }

        token_r = requests.post(token_url, data=token_data)
        token = token_r.json().get("access_token")

        cost_url = f"https://management.azure.com/subscriptions/{
            self.SUBSCRIPTION_ID}/providers/Microsoft.CostManagement/query?api-version=2019-11-01"

        from_date = (datetime.now() +
                     datetime.timedelta(days=-1)).strftime('%Y-%m-%dT%H:%M:%SZ')
        to_date = datetime.now().strftime('%Y-%m-%dT%H:%M:%SZ')

        cost_data = {
            "type": "Usage",
            "timeframe": "Custom",
            "timePeriod": {"from": f"{from_date}", "to": f"{to_date}"},
            "dataset": {
                "granularity": "Daily",
                "aggregation": {"totalCost": {"name": "PreTaxCost", "function": "Sum"}}
            }
        }

        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }
        response = requests.post(cost_url, headers=headers, json=cost_data)
        cost_info = response.json()

        costs = cost_info["properties"]["rows"][0]

        if costs:
            formatted_date = datetime.datetime.strptime(
                str(costs[1]), '%Y%m%d').strftime('%m月%d日')
            await channel.send(f'{formatted_date}の使用料金は{int(float(costs[0]))}円です')
        else:
            await channel.send(f'使用料金情報を取得できませんでした')

    async def check_all_vm_usage_and_stop_vm_async(self, channel):
        await self.check_usage(channel=channel)

    async def statusMC(self, channel):
        servers = ['youtube', 'youtube2', 'test', 'play']
        for server in servers:
            stdout = await self.get_mc_status(server=server)
            if stdout:
                await channel.send(f"{server}用Minecraftサーバー:起動中")
            else:
                await channel.send(f"{server}用Minecraftサーバー:停止中")

    async def get_mc_status(self, server):
        command = f'pgrep -af "[{server[0]}]{server[1:]}-minecraft"'
        process = await asyncio.create_subprocess_shell(command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await process.communicate()
        if process.returncode == 0 and stdout:
            return True
        return False

    async def autoMC(self, server, channel):
        stdout = await self.get_mc_status(server=server)
        if stdout:
            command = f"bash /home/azureuser/stop_{server}_server.sh"
            subprocess.run(command, shell=True)
            running = True
            while running:
                running = await self.get_mc_status(server=server)
                time.sleep(2)
            await channel.send(f"{server}用Minecraftサーバーを停止しました")
        else:
            await channel.send(f"{server}用Minecraftサーバーを起動します")
            command = f"bash /home/azureuser/start_{server}_server.sh"
            subprocess.run(command, shell=True)
            running = False
            while not running:
                running = await self.get_mc_status(server=server)
                time.sleep(2)
            await channel.send(f"{server}用Minecraftサーバーを起動しました")

    async def startMC(self, server, channel):
        stdout = await self.get_mc_status(server=server)
        if stdout:
            await channel.send(f"{server}用Minecraftサーバーは既に起動しています")
        else:
            await channel.send(f"{server}用Minecraftサーバーを起動します")
            command = f"bash /home/azureuser/start_{server}_server.sh"
            subprocess.run(command, shell=True)
            running = False
            while not running:
                running = await self.get_mc_status(server=server)
                time.sleep(2)
            await channel.send(f"{server}用Minecraftサーバーを起動しました")

    async def stopMC(self, server, channel):
        stdout = await self.get_mc_status(server=server)
        if not stdout:
            await channel.send(f"{server}用Minecraftサーバーは既に停止しています")
        else:
            command = f"bash /home/azureuser/stop_{server}_server.sh"
            subprocess.run(command, shell=True)
            running = True
            while running:
                running = await self.get_mc_status(server=server)
                time.sleep(2)
            await channel.send(f"{server}用Minecraftサーバーを停止しました")
