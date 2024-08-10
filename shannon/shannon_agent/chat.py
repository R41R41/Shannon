from datetime import datetime
import json
import random
import re

import pytz
from prompts import load_prompt
from .llm_agent import LLMSkillAgent
from .llm_agent import LLMAgent
from openai import OpenAI
from .transcription_agent import TranscriptionAgent
import utils as U


class ChatAgent:
    def __init__(
        self,
    ):
        self.initialization_status = {
            "success": True, "result": "agent initialized successfully"}
        try:
            self.transcription_agent = TranscriptionAgent()
            self.llm = LLMAgent()
            self.hot_llm = LLMAgent(temperature=0.4)
            self.discord_skill_llm = LLMSkillAgent(
                model_name="gpt-4o-mini", tool_categories=["default", "discord"])
            self.minecraft_skill_llm = LLMSkillAgent(
                model_name="gpt-4o-mini", tool_categories=["default", "minecraft"])
            self.initialization_status = self.discord_skill_llm.initialization_status
            self.client = OpenAI()
            self.speech_file_path = "saves/speech.mp3"
            self.voice_chat_log = {}
            self.prompt_cache = {}
        except Exception as e:
            self.initialization_status = {"success": False, "result": f"{e}"}

    @property
    def chat_observations(self):
        return [
            "message",
            "sender_name",
            "env_info"
        ]

    @property
    def conversation_history_observations(self):
        return [
            "message",
            "sender_name",
            "conversation_history"
        ]

    def get_clean_content(self, message_content):
        cleaned_text = re.sub(r'@\w+\s', '', message_content)
        return re.sub(r'\n', '', cleaned_text)

    async def render_observation(self, *, message, sender_name, env_info=None, conversation_history=None):
        observation = {
            "message": f"Message:\n {self.get_clean_content(message)}\n\n",
            "sender_name": f"Sender Name:\n {sender_name}\n\n",
            "env_info": f"Env Info: \n {env_info}\n\n",
            "conversation_history": f"Conversation History: \n {conversation_history}\n\n",
        }
        return observation

    def load_system_content(self, mode):
        if mode in self.prompt_cache:
            return self.prompt_cache[mode]

        switcher = {
            "discord_voice_chat": "voice_chat_on_discord",
            "discord_text_chat": "text_chat_on_discord",
            "minecraft_bot_chat": "text_chat_on_minecraft",
            "console_text_chat": "text_chat_on_console",
            "check_need_to_response_on_minecraft": "check_need_to_response_on_minecraft",
            "check_need_to_response_on_discord_text": "check_need_to_response_on_discord_text",
            "check_need_to_response_on_discord_voice": "check_need_to_response_on_discord_voice",
            "check_necessary_tool": "check_necessary_tool",
            "get_variable": "get_variable",
        }
        prompt_file = switcher.get(mode, "text_chat_on_console")
        prompt_content = load_prompt(prompt_file)
        self.prompt_cache[mode] = prompt_content
        return prompt_content

    def format_conversation_history(self, conversation_history):
        return "\n".join([message.content for message in conversation_history])

    async def check_needs(self, message, sender_name, mode):
        conversation_history = []
        if "シャノン" in message:
            return "need_response_text"
        elif mode == "minecraft_bot_chat":
            system_content = self.load_system_content(
                "check_need_to_response_on_minecraft")
        elif mode == "discord_text_chat":
            system_content = self.load_system_content(
                "check_need_to_response_on_discord_text")
        elif mode == "discord_voice_chat":
            if not any(ord(char) > 127 for char in message):
                return "no_need_response"
            system_content = self.load_system_content(
                "check_need_to_response_on_discord_voice")
        else:
            return "no_need_response"
        human_content = ""
        if mode == "discord_text_chat":
            conversation_history = self.discord_skill_llm.memory.STM
        elif mode == "minecraft_bot_chat":
            conversation_history = self.minecraft_skill_llm.memory.STM
        formatted_history = self.format_conversation_history(
            conversation_history)
        observation = await self.render_observation(message=message, sender_name=sender_name, conversation_history=formatted_history)
        for key in self.conversation_history_observations:
            human_content += observation[key]
        response = await self.llm.get_response(system_content=system_content, human_content=human_content)
        return response

    async def chat(self, message, sender_name=None, time=None, mode=None, check_needs=False, env_info=None):
        print("chat", check_needs, message)
        is_needed = "need_response_text"
        if check_needs:
            is_needed = await self.check_needs(message=message, sender_name=sender_name, mode=mode)
            if is_needed != "need_response_text":
                print("chat", is_needed)
        if is_needed == "need_response_text" or is_needed == "need_reaction_emoji":
            if is_needed == "need_reaction_emoji":
                env_info += ", Only a reaction emoji is needed."
            system_content = self.load_system_content(mode)
            human_content = ""
            observation = await self.render_observation(message=message, sender_name=sender_name, env_info=env_info)
            for key in self.chat_observations:
                human_content += observation[key]
            data = {"message": message,
                    "sender_name": sender_name, "time": time}
            if mode == "discord_text_chat":
                response = await self.discord_skill_llm.get_response(system_content=system_content, human_content=human_content, data=data, need_memorise=True)
            elif mode == "minecraft_bot_chat":
                response = await self.minecraft_skill_llm.get_response(system_content=system_content, human_content=human_content, data=data, need_memorise=True)
            return response
        else:
            return None

    async def minecraft_bot_chat(self, sender_name, message, bot_position, bot_health, bot_food_level):
        env_info = f"chat in minecraft, sendername :{sender_name}, your_position :{
            bot_position}, your_health :{bot_health}, your_food_level :{bot_food_level}"
        print("minecraft_bot_chat", env_info)
        time = datetime.now(pytz.timezone('Asia/Tokyo')
                            ).strftime('%Y-%m-%d %H:%M:%S')
        response = await self.chat(sender_name=sender_name, message=message, time=time, mode="minecraft_bot_chat", check_needs=True, env_info=env_info)
        return response

    async def discord_chat(self, sender_name, message, time, channel_id, message_id, check_needs=False):
        print("discord_chat")
        env_info = f"chat in discord, channel_id is {
            channel_id}, message_id is {message_id}"
        response = await self.chat(sender_name=sender_name, message=message, time=time, mode="discord_text_chat", check_needs=check_needs, env_info=env_info)
        return response

    async def discord_voice_chat(self, sender_name, message, actor, channel_id, check_needs=False):
        print("discord_voice_chat")
        response = await self.create_voice_chat_message(sender_name=sender_name, message=message, channel_id=channel_id, check_needs=check_needs)
        await self.create_voice_message(message=response, actor=actor)
        return response

    async def create_voice_chat_message(self, sender_name, message, channel_id, check_needs=False):
        env_info = f"voice chat in discord, channel_id is {channel_id}"
        response = await self.chat(sender_name=sender_name, message=message, check_needs=check_needs, mode="discord_voice_chat", env_info=env_info)
        return response

    async def get_variable(self, variable_description):
        print("get_variable")
        system_content = self.load_system_content("get_variable")
        response = await self.llm.get_response(system_content=system_content, human_content=variable_description)
        response_list = response.split(',')
        print("response_list", response_list)
        random_response = random.choice(response_list)
        return random_response

    async def response_to_voice(self, voice_file_path, user_name, time):
        print("response_to_voice")
        transcription = self.transcription_agent.transcribe(voice_file_path)
        if "おだしょー" in transcription:
            transcription = transcription.replace("おだしょー", "")
        elif "おだしょ" in transcription:
            transcription = transcription.replace("おだしょ", "")
        elif "廣瀬" in transcription:
            transcription = transcription.replace("廣瀬", "")
        if self.voice_chat_log.get(user_name) is None:
            self.voice_chat_log[user_name] = ""
        self.voice_chat_log[user_name] += f" {transcription}"
        print("voice_chat_log", self.voice_chat_log[user_name])
        env_info = None
        # 返答が必要か、必要ないか、もう少し聞かないとわからないかを取得
        response = await self.check_needs(message=self.voice_chat_log[user_name], sender_name=user_name, mode="discord_voice_chat")
        print("check_needs", response)
        if response == "no_need_response":
            self.voice_chat_log[user_name] = ""
            return "Success"
        if response == "need_response" or response == "need_response_text":
            system_content = self.load_system_content(
                mode="discord_voice_chat")
            human_content = ""
            observation = await self.render_observation(message=self.voice_chat_log[user_name], sender_name=user_name, env_info=env_info)
            for key in self.chat_observations:
                human_content += observation[key]
            data = {"message": self.voice_chat_log[user_name],
                    "sender_name": user_name, "time": time}
            self.voice_chat_log[user_name] = ""
            response = await self.discord_skill_llm.get_response(system_content=system_content, human_content=human_content, data=data, need_memorise=True)
            return response
        return "Success"
