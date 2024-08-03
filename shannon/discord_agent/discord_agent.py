

import asyncio
import os
import re
import discord
import pytz
import utils as U
import random


class DiscordAgent:
    def __init__(self, client, COST_CHANNEL_ID: int, GENERAL_CHANNEL_ID: int, TOYAMA_GUILD_ID: int, TOYAMA_CHANNEL_ID: int, IS_TEST: bool, TEST_GUILD_ID: int):
        self.COST_CHANNEL_ID = COST_CHANNEL_ID
        self.GENERAL_CHANNEL_ID = GENERAL_CHANNEL_ID
        self.TOYAMA_GUILD_ID = TOYAMA_GUILD_ID
        self.TOYAMA_CHANNEL_ID = TOYAMA_CHANNEL_ID
        self.TEST_GUILD_ID = TEST_GUILD_ID
        self.IS_TEST = IS_TEST
        self.client = client

    async def increase_youtube_subscriber_count(self, number):
        channel = self.client.get_channel(self.GENERAL_CHANNEL_ID)
        await channel.send(f"現在のチャンネル登録者数は{number}人です")
        return

    def get_clean_content(self, message_content):
        cleaned_text = re.sub(r'@\w+\s', '', message_content)
        return re.sub(r'\n', '', cleaned_text)

    async def get_emoji(self, channel_id, message_id):
        print("get_emoji")
        channel = self.client.get_channel(int(channel_id))
        message = await channel.fetch_message(int(message_id))
        guild_emojis = message.guild.emojis
        if not guild_emojis:
            return "there is no emoji in this server"
        return str(guild_emojis)

    async def get_recent_channel_log(self, channel_id, message_count):
        channel = self.client.get_channel(channel_id)
        channel_log = []
        if channel is None:
            return None
        async for message in channel.history(limit=message_count):
            jst_time = message.created_at.astimezone(
                pytz.timezone('Asia/Tokyo'))
            time_stamp = jst_time.strftime('%Y-%m-%d %H:%M:%S')
            clean_content = self.get_clean_content(message.clean_content)
            if message.attachments:
                clean_content += "\nimage_url:" + message.attachments[0].url
            author_name = self.get_nickname(message.author)
            formatted_log_entry = f"{time_stamp},{author_name},{clean_content}"
            channel_log.append(formatted_log_entry)
        return channel_log

    async def control_mc(self, interaction: discord.Interaction, option: str, server: str):
        channel = interaction.channel
        data = {
            "server_name": server
        }
        if option == "Auto":
            await interaction.response.send_message(f"Minecraftサーバーを起動または停止します", ephemeral=True)
            response = await U.send_request(
                destination="minecraft_server", endpoint="auto_minecraft_server", data=data, request_type="post")
        if option == "status":
            await interaction.response.send_message(f"minecraftサーバーの状態を取得します", ephemeral=True)
            response = await U.send_request(
                destination="minecraft_server", endpoint="status_minecraft_server", data=data, request_type="post")
        if option == "start":
            await interaction.response.send_message(f"{server}用minecraftサーバーを起動します", ephemeral=True)
            response = await U.send_request(
                destination="minecraft_server", endpoint="start_minecraft_server", data=data, request_type="post")
        if option == "stop":
            await interaction.response.send_message(f"{server}用minecraftサーバーを停止します", ephemeral=True)
            response = await U.send_request(
                destination="minecraft_server", endpoint="stop_minecraft_server", data=data, request_type="post")
        if response:
            if response["response"]:
                await channel.send(f"{response['response']}")
        else:
            await channel.send(f"Failed to {option} {server} server")
        return

    async def control_minecraft_bot(self, interaction: discord.Interaction, option: str, server: str):
        channel = interaction.channel
        data = {
            "server_name": server
        }
        if option == "Auto":
            await interaction.response.send_message(f"Minecraft Botを起動または停止します", ephemeral=True)
            response = await U.send_request(
                destination="minecraft_bot", endpoint="auto_minecraft_bot", data=data, request_type="post")
        if option == "status":
            await interaction.response.send_message(f"Minecraft Botの状態を取得します", ephemeral=True)
            response = await U.send_request(
                destination="minecraft_bot", endpoint="status_minecraft_bot", data=data, request_type="post")
        if option == "login":
            await interaction.response.send_message(f"Minecraft Botを起動します", ephemeral=True)
            response = await U.send_request(
                destination="minecraft_bot", endpoint="login_minecraft_server", data=data, request_type="post")
        if option == "logout":
            await interaction.response.send_message(f"Minecraft Botを停止します", ephemeral=True)
            response = await U.send_request(
                destination="minecraft_bot", endpoint="logout_minecraft_server", data=data, request_type="post")
        if response:
            if response["response"]:
                await channel.send(f"{response['response']}")
        else:
            await channel.send(f"Failed to {option} Minecraft Bot")
        return

    async def control_post(self, interaction: discord.Interaction, category: str):
        print("control_post")
        channel = interaction.channel
        await interaction.response.send_message(f"{category}のポストをします", ephemeral=True)
        if category == "fortune":
            response = await U.send_request(endpoint='post_fortune', data={},
                                            destination="twitter_bot", request_type="get")
        elif category == "about_today":
            response = await U.send_request(endpoint='post_about_today', data={},
                                            destination="twitter_bot", request_type="get")
        elif category == "weather":
            response = await U.send_request(endpoint='post_weather', data={},
                                            destination="twitter_bot", request_type="get")
        elif category == "latest_video":
            response = await U.send_request(endpoint='post_latest_video', data={},
                                            destination="twitter_bot", request_type="get")
        else:
            return
        response_text = response["response"]
        if response_text:
            await channel.send(response_text)

    def get_nickname(self, author):
        if author.nick is None:
            return author.name
        return author.nick

    async def on_message(self, message):
        print("on_message")
        channel = message.channel
        guild = message.guild
        message_content = message.clean_content
        message_id = message.id
        time = message.created_at.astimezone(
            pytz.timezone('Asia/Tokyo')).strftime('%Y-%m-%d %H:%M:%S')
        if self.IS_TEST:
            if guild.id != self.TEST_GUILD_ID:
                return
        else:
            if guild.id == self.TEST_GUILD_ID:
                return
        if guild.id == self.TOYAMA_GUILD_ID:
            if channel.id != self.TOYAMA_CHANNEL_ID:
                if self.client.user not in message.mentions:
                    return
        author = message.author
        sender_name = self.get_nickname(author)
        if sender_name == "Sh4nnon":
            return
        if re.search(r'{[^{}]*}', message_content):
            new_message_content = await self.replace_braces_inner(message_content)
            sent_message = await channel.send(new_message_content)
            message_content = new_message_content
            message_id = sent_message.id
        if message.attachments:
            image_urls = [attachment.url for attachment in message.attachments]
            if image_urls:
                for url in image_urls:
                    message_content += "\nimage_url:" + url
        data = {
            'message': message_content,
            'time': time,
            'sender_name': sender_name,
            'check_needs': True,
            'channel_id': channel.id,
            'message_id': message_id
        }
        if self.client.user in message.mentions:
            data['check_needs'] = False
        response = await U.send_request(endpoint='discord_chat', data=data, destination="shannon", request_type="post")
        return response

    async def replace_braces_inner(self, message_content):
        print("replace_braces_inner", message_content)
        if re.search(r'{[^{}]*}', message_content):
            new_message_content = await self.async_replace_braces(message_content)
            return await self.replace_braces_inner(new_message_content)
        else:
            return message_content

    async def async_replace_braces(self, message_content):
        matches = re.finditer(r'{[^{}]*}', message_content)
        new_message_content = message_content
        for match in matches:
            replacement = await self.replace_braces(match)
            new_message_content = new_message_content.replace(
                match.group(0), replacement, 1)
        return new_message_content

    async def replace_braces(self, match):
        inner_text = match.group(0)
        print("replace_braces", inner_text)
        inner_text = inner_text.replace("{", "").replace("}", "")
        if inner_text.startswith("#1"):
            text_for_anagram = inner_text[2:].strip()
            new_message_content = self.create_anagram(text_for_anagram)
        elif inner_text.startswith("#2"):
            new_message_content = self.create_anagram(inner_text)
        elif re.search(r'\d+d\d+', inner_text):
            def replace_dice(dice_match):
                n, m = map(int, dice_match.group(0).split('d'))
                return self.get_dice_result(n, m)
            new_message_content = re.sub(
                r'\d+d\d+', replace_dice, inner_text)
        else:
            data = {
                "variable_description": inner_text
            }
            response = await U.send_request(endpoint='get_variable', data=data, destination="shannon", request_type="post")
            new_message_content = response["variable"]
        return new_message_content

    async def chat(self, text, embed_image_url, file_path, channel_id):
        print("chat")
        try:
            channel = self.client.get_channel(int(channel_id))
            print(type(channel))
            embed = discord.Embed()
            if embed_image_url and file_path:
                embed.set_image(url=embed_image_url)
                file = discord.File(file_path, filename="image.png")
                await channel.send(content=text, embed=embed, file=file)
            elif embed_image_url:
                embed.set_image(url=embed_image_url)
                await channel.send(content=text, embed=embed)
            elif file_path:
                file = discord.File(file_path, filename="image.png")
                await channel.send(content=text, file=file)
            else:
                await channel.send(content=text)
            return "Success"
        except Exception as e:
            return "Failed:" + str(e)

    def get_dice_result(self, n, m):
        value = []
        for _ in range(n):
            value.append(random.randint(1, m))
        total = sum(value)
        if n == 1:
            result_str = f"{total}"
        else:
            value_str = ' + '.join(map(str, value))
            result_str = f"{value_str} = {total}"
        return result_str

    async def add_reaction(self, channel_id, message_id, emoji, is_server_emoji=False):
        print("add_reaction")
        channel = self.client.get_channel(int(channel_id))
        message = await channel.fetch_message(int(message_id))
        if is_server_emoji:
            emoji = discord.utils.get(message.guild.emojis, name=emoji)
        await message.add_reaction(emoji)
        return "reaction added"

    async def check_all_vm_usage_and_stop_vm_async(self):
        channel = self.client.get_channel(self.COST_CHANNEL_ID)
        await self.vm_and_mc_agent.check_all_vm_usage_and_stop_vm_async(channel=channel)

    def create_anagram(self, text):
        chars = list(text)
        random.shuffle(chars)
        return ''.join(chars)