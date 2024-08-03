import subprocess
import signal
import os
from dotenv import load_dotenv
import sys
import threading

import psutil
import os
import time


load_dotenv()

OPENAI_API_KEY = os.getenv('OPENAI_API_KEY')
os.environ["OPENAI_API_KEY"] = OPENAI_API_KEY

if len(sys.argv) > 1 and sys.argv[1] == 'test':
    os.environ["IS_TEST"] = "True"
else:
    os.environ["IS_TEST"] = "False"

# 使用されるポートのリスト
PORTS = [3000, 3001, 3050, 3051, 3100, 3101, 3200, 3201, 3250, 3251, 3300, 3301, 3340, 3341, 3350, 3351, 3400, 3401, 3500, 3501]

def kill_process_on_ports(ports):
    for conn in psutil.net_connections():
        if conn.laddr.port in ports:
            try:
                proc = psutil.Process(conn.pid)
                print(f"Killing process {proc.name()} (PID: {proc.pid}) on port {conn.laddr.port}")
                proc.terminate()
            except psutil.NoSuchProcess:
                print(f"Process with PID {conn.pid} no longer exists")

kill_process_on_ports(PORTS)

def set_priority_on_ports(ports, duration=10, interval=1):
    end_time = time.time() + duration
    processed_pids = set()  # 優先度を上げたプロセスのPIDを記録するセット
    while time.time() < end_time:
        for conn in psutil.net_connections():
            if conn.laddr.port in ports and conn.pid not in processed_pids:
                try:
                    proc = psutil.Process(conn.pid)
                    print(f"Setting priority for process {proc.name()} (PID: {proc.pid}) on port {conn.laddr.port}")
                    # プロセスの優先度を設定
                    subprocess.run(
                        ["wmic", "process", "where", f"processid={proc.pid}", "CALL", "setpriority", "high priority"],
                        check=True,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE
                    )
                    processed_pids.add(conn.pid)  # 優先度を上げたプロセスのPIDを記録
                except psutil.NoSuchProcess:
                    print(f"Process with PID {conn.pid} no longer exists")
                except Exception as e:
                    print(f"Failed to set priority for process {proc.pid}: {e}")
        time.sleep(interval)

# set_priority_on_ports関数を別スレッドで実行
priority_thread = threading.Thread(target=set_priority_on_ports, args=(PORTS,))
priority_thread.start()

def run_shannon():
    subprocess.run(["python3", "shannon/shannon.py"])


def run_discord_bot():
    subprocess.run(["python3", "shannon/discord_bot.py"])


def run_twitter_bot():
    subprocess.run(["python3", "shannon/twitter_bot.py"])


def run_youtube_bot():
    subprocess.run(["python3", "shannon/youtube_bot.py"])


def run_minecraft_bot():
    subprocess.run(["python3", "shannon/minecraft_bot.py"])


def run_minecraft():
    subprocess.run(["python3", "shannon/minecraft_server.py"])


# ボットのプロセスを開始
if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == 'test':
        print("テストモードでshannonと各連携サーバーを起動します")
    else:
        print("通常モードでshannonと各連携サーバーを起動します")
    shannon_thread = threading.Thread(target=run_shannon)
    youtube_thread = threading.Thread(target=run_youtube_bot)
    discord_thread = threading.Thread(target=run_discord_bot)
    twitter_thread = threading.Thread(target=run_twitter_bot)
    minecraft_thread = threading.Thread(target=run_minecraft)
    minecraft_bot_thread = threading.Thread(target=run_minecraft_bot)

    shannon_thread.start()
    youtube_thread.start()
    discord_thread.start()
    twitter_thread.start()
    minecraft_thread.start()
    minecraft_bot_thread.start()

    shannon_thread.join()
    youtube_thread.join()
    discord_thread.join()
    twitter_thread.join()
    minecraft_thread.join()
    minecraft_bot_thread.join()
