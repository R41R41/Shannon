import os
import subprocess
import discord
import utils as U
import platform
import psutil
import datetime

class VoiceAgent:
    def __init__(self, client, is_test=False):
        self.client = client
        self.is_test = is_test
        current_dir = os.path.dirname(os.path.abspath(__file__))
        self.voice_receiver_directory = os.path.join(current_dir, "..", "discord_agent")
        self.voice_receiver_file = f"voice_receiver"
        self.speech_file_path = "saves/speech.mp3"
        self.os_type = platform.system()  # OSの種類を取得
        self.log_directory = os.path.join(current_dir, "..", "..", "saves", "receive_voice_message")
        os.makedirs(self.log_directory, exist_ok=True)  # ログディレクトリが存在しない場合は作成

    def run_command(self, guild_id, channel_id, voice_mode=None):
        print("run_command")
        if self.is_test:
            test = "test"
        else:
            test = ""
        try:
            os.chdir(self.voice_receiver_directory)
            if self.os_type == "Windows":
                self._run_command_windows(guild_id, channel_id, test, voice_mode)
            else:  # Unix系（Linux, macOS）
                self._run_command_unix(guild_id, channel_id, test, voice_mode)
        except Exception as e:
            print("run_command", e)

    def _get_log_file_path(self, guild_id, channel_id):
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"voice_receiver_{guild_id}_{channel_id}_{timestamp}.log"
        return os.path.join(self.log_directory, filename)

    def _run_command_windows(self, guild_id, channel_id, test, voice_mode=None):
        log_file = self._get_log_file_path(guild_id, channel_id)
        command = f"node {self.voice_receiver_file} {guild_id} {channel_id} {voice_mode} {test}"
        print(f"Running command: {command}")
        with open(log_file, 'a', encoding='utf-8') as f:
            subprocess.Popen(command, shell=True, stdout=f, stderr=subprocess.STDOUT)

    def _run_command_unix(self, guild_id, channel_id, test, voice_mode=None):
        # Unix系OSの場合は従来通りscreenを使用
        command = f"screen -S voice-receiver-{guild_id}-{channel_id} -d -m node {self.voice_receiver_file} {guild_id} {channel_id} {voice_mode} {test}"
        print(f"Running command: {command}")
        subprocess.run(command, shell=True)

    def check_voice_receiver_screen(self):
        if self.os_type == "Windows":
            return self._check_voice_receiver_windows()
        else:  # Unix系（Linux, macOS）
            return self._check_voice_receiver_unix()

    async def stop_voice_receiver_screen(self):
        await U.send_request(endpoint="discord_voice_chat_logout", data={}, destination="voice_receiver", request_type="post")
        if self.os_type == "Windows":
            self._stop_voice_receiver_windows()
        else:  # Unix系（Linux, macOS）
            self._stop_voice_receiver_unix()

    def _check_voice_receiver_windows(self):
        try:
            for proc in psutil.process_iter(['name', 'cmdline']):
                if proc.info['name'] == 'node.exe' and any('voice_receiver' in arg for arg in proc.info['cmdline']):
                    return True
            return False
        except Exception as e:
            print("check_voice_receiver_windows", e)
            return False

    def _check_voice_receiver_unix(self):
        try:
            screen_list = subprocess.run(
                ["screen", "-ls"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            return "voice_receiver" in screen_list.stdout.decode()
        except Exception as e:
            print("check_voice_receiver_unix", e)
            return False

    def _stop_voice_receiver_windows(self):
        try:
            for proc in psutil.process_iter(['name', 'cmdline']):
                if proc.info['name'] == 'node.exe' and any('voice_receiver' in arg for arg in proc.info['cmdline']):
                    proc.terminate()
                    proc.wait(timeout=5)
        except Exception as e:
            print("stop_voice_receiver_windows", e)

    def _stop_voice_receiver_unix(self):
        try:
            subprocess.run(["screen", "-S", "voice_receiver", "-X", "quit"])
        except Exception as e:
            print("stop_voice_receiver_unix", e)

    async def voice_chat_login(self, author=None, guild: discord.Guild = None, voice_mode: str = None):
        print("voice_chat_login")
        if self.check_voice_receiver_screen():
            print("voice_receiver is running")
            await self.stop_voice_receiver_screen()
        if author is None:
            channel = guild.voice_channels[0]
        else:
            if author.voice is None:
                channel = guild.voice_channels[0]
            else:
                channel: discord.VoiceChannel = author.voice.channel
        print(channel)
        try:
            guild_id = guild.id
            channel_id = channel.id
            print(guild_id, channel_id)
            self.run_command(guild_id, channel_id, voice_mode)
        except discord.errors.ClientException as e:
            print("Already connected to a voice channel.")
        except discord.errors.OpusNotLoaded as e:
            print("Opus library not loaded.")
        except Exception as e:
            print("voice_client", e)

    async def voice_chat_logout(self):
        if self.check_voice_receiver_screen():
            await self.stop_voice_receiver_screen()

    async def voice_chat(self, interaction: discord.Interaction, actor: str, message: str):
        await self.voice_chat_login(author=interaction.user, guild=interaction.guild)
        await self.voice_chat_send_message(message=message, actor=actor, channel_id=interaction.channel.id, message_id=interaction.message.id)

    async def voice_chat_in_or_out(self, interaction: discord.Interaction, option: str, voice_mode: str):
        if option is None:
            if self.check_voice_receiver_screen():
                option = "logout"
            else:
                option = "login"
        author = interaction.user
        guild = interaction.guild
        if option == "login":
            try:
                await interaction.response.send_message("ボイスチャットにログインします", ephemeral=True)
                await self.voice_chat_login(author=author, guild=guild, voice_mode=voice_mode)
            except Exception as e:
                print("voice_chat_in_or_out", e)
        if option == "logout":
            try:
                await interaction.response.send_message("ボイスチャットからログアウトします", ephemeral=True)
                await self.voice_chat_logout()
            except Exception as e:
                print("voice_chat_in_or_out", e)
