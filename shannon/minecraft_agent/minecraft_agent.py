import os
import re
import pytz
import utils as U
import subprocess
import socket
import time


class MinecraftAgent:
    def __init__(self, server_ports: dict):
        self.is_test = os.getenv('IS_TEST') == 'True'
        self.server_ports = server_ports

    def server_name_to_port(self, server_name: str) -> int:
        return self.server_ports.get(server_name, 0)  # デフォルトポートは25565

    async def start_minecraft_server(self, server_name: str):
        if server_name == "Auto":
            if self.is_test:
                server_name = "1.20.4-test"
            else:
                server_name = "1.20.4-play"
        port = int(self.server_name_to_port(server_name))
        minecraft_version = server_name.split("-")[0]
        if port == 0:
            return "サーバー名が不正です。"
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        result = sock.connect_ex(('localhost', port))
        if result == 0:
            return "マインクラフトサーバーが既に起動しています。"
        sock.close()
        os.chdir(f"/home/azureuser/minecraft/minecraft-{server_name}")
        process = subprocess.run(["screen", "-S", f"{server_name}", "-d", "-m", "java",
                                  "-Xmx2G", "-Xms1G", "-jar", f"minecraft-server-{minecraft_version}.jar", "nogui"],
                                 capture_output=True, text=True)
        if process.returncode == 0:
            return "マインクラフトサーバーの起動に成功しました。"
        else:
            return f"マインクラフトサーバーの起動に失敗しました。エラー: {process.stderr}"

    async def stop_minecraft_server(self, server_name: str):
        print("stop_minecraft_server")
        if server_name == "Auto":
            response = ""
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            server_ports = self.server_name_to_port.items()
            for name, port in server_ports:
                result = sock.connect_ex(('localhost', port))
                if result == 0:
                    response += await self.stop_minecraft_server(server_name=name)
                    response += "\n"
            sock.close()
            print(response)
            return response
        port = int(self.server_name_to_port(server_name))
        if port == 0:
            return "サーバー名が不正です。"
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        result = sock.connect_ex(('localhost', port))
        if result != 0:
            return "マインクラフトサーバーが既に停止しています。"
        sock.close()
        os.chdir(f"/home/azureuser/minecraft/minecraft-{server_name}")
        subprocess.run(
            ["screen", "-S", f"{server_name}", "-X", "stuff", "stop$(printf \\r)"])
        time.sleep(10)
        process = subprocess.run(["screen", "-S", f"{server_name}", "-X", "quit"],
                                 capture_output=True, text=True)
        if process.returncode == 0:
            return "マインクラフトサーバーの停止に成功しました。"
        else:
            return f"マインクラフトサーバーの停止に失敗しました。エラー: {process.stderr}"

    async def status_minecraft_server(self, server_name: str):
        port = self.server_name_to_port(server_name)
        if port == 0:
            return "サーバー名が不正です。"
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        result = sock.connect_ex(('localhost', port))
        if result == 0:
            return "マインクラフトサーバーは起動中です。"
        else:
            return "マインクラフトサーバーは停止中です。"

    async def auto_minecraft_server(self, server_name: str):
        print("auto_minecraft_server")
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server_ports = self.server_ports.items()
        print(server_ports)
        running_servers = []
        for name, port in server_ports:
            result = sock.connect_ex(('localhost', port))
            if result == 0:
                running_servers.append(name)
        sock.close()
        print(running_servers)
        response = ""
        if running_servers:
            for running_server_name in running_servers:
                response += await self.stop_minecraft_server(server_name=running_server_name)
                response += "\n"
        else:
            response = await self.start_minecraft_server(server_name=server_name)
        return response
