import os
import utils as U
import subprocess
import socket
import json


class MinecraftBotAgent:
    def __init__(self, server_ports: dict):
        self.server_ports = server_ports
        self.is_test = os.getenv('IS_TEST') == 'True'
        if self.is_test:
            self.minecraft_bot_port = 3251
        else:
            self.minecraft_bot_port = 3250

    async def run_minecraft_bot(self, port: int):
        print("run_minecraft_bot")
        current_dir = os.path.dirname(os.path.abspath(__file__))
        minecraft_bot_directory = os.path.join(current_dir, "..", "minecraft_bot_agent")
        os.chdir(minecraft_bot_directory)
        process = subprocess.run(
            ["screen", "-S", f"minecraft-bot", "-d",
                "-m", "node", "runMinebot", str(port)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE)
        print("process", process)
        return process

    async def quit_minecraft_bot(self):
        process = subprocess.run(
            ["screen", "-S", f"minecraft_bot", "-X", "quit"])
        return process

    def server_name_to_port(self, server_name: str) -> int:
        return self.server_ports.get(server_name, 25565)  # デフォルトポートは25565

    async def login_minecraft_server(self, server_name: str):
        if server_name == "Auto":
            if self.is_test:
                server_name = "1.20.4-test"
            else:
                server_name = "1.20.4-play"
        port = int(self.server_name_to_port(server_name))
        if port == 0:
            return "サーバー名が不正です。"
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        result = sock.connect_ex(('localhost', port))
        if result != 0:
            return "マインクラフトサーバーが起動していません。"
        result = sock.connect_ex(('localhost', self.minecraft_bot_port))
        if result == 0:
            return "minecraft_botが既に起動しています。"
        sock.close()
        process = await self.run_minecraft_bot(port=port)
        if process.returncode == 0:
            return "minecraft_botの起動に成功しました。"
        else:
            return f"minecraft_botの起動に失敗しました。エラー: {process.stderr}"

    async def logout_minecraft_server(self, server_name: str):
        if server_name == "Auto":
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            for server, port in self.server_ports.items():
                result = sock.connect_ex(('localhost', port))
                if result == 0:
                    sock.close()
                    server_name = server
                    break
            sock.close()
            if server_name == "Auto":
                return "稼働しているサーバーはありません。"
        port = int(self.server_name_to_port(server_name))
        if port == 0:
            return "サーバー名が不正です。"
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        result = sock.connect_ex(('localhost', port))
        if result != 0:
            return "マインクラフトサーバーが起動していません。"
        result = sock.connect_ex(('localhost', self.minecraft_bot_port))
        if result == 0:
            return "minecraft_botが既に起動しています。"
        sock.close()
        process = await self.quit_minecraft_bot()
        if process.returncode == 0:
            return "minecraft_botの終了に成功しました。"
        else:
            return f"minecraft_botの終了に失敗しました。エラー: {process.stderr}"

    async def status_minecraft_bot(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        result = sock.connect_ex(('localhost', self.minecraft_bot_port))
        sock.close()
        if result == 0:
            return "minecraft_botは起動しています。"
        else:
            return "minecraft_botは起動していません。"

    async def auto_minecraft_bot(self, server_name: str):
        print("auto_minecraft_bot")
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        result = sock.connect_ex(('localhost', self.minecraft_bot_port))
        sock.close()
        if result == 0:
            response = await self.logout_minecraft_server(server_name=server_name)
        else:
            response = await self.login_minecraft_server(server_name=server_name)
        return response

    async def learn_new_skill(self, skill_name: str, skill_description: str, skill_params: str):
        try:
            skill_params_list = json.loads(skill_params)
            parsed_params = []
            for param in skill_params_list:
                parsed_params.append({
                    "name": param['name'],
                    "type": param['type'],
                    "description": param['description']
                })
            print("learn_skill", parsed_params)
            return {"success": True, "result": "スキルの学習の開始に成功しました。"}
        except Exception as e:
            return {"success": False, "result": f"スキルの学習の開始に失敗しました。エラー: {e}"}
