import asyncio
from datetime import datetime
import importlib
import json
import os
import pkgutil
import openai
from openai import OpenAI
from langchain_openai import ChatOpenAI
from langchain.schema import SystemMessage
from langchain.agents import AgentExecutor, create_openai_tools_agent
from langchain_community.agent_toolkits.load_tools import load_tools
from langchain_core.messages import HumanMessage
from langchain import hub
from langchain.tools import BaseTool
import pytz
from .memory import Memory
import tempfile
import sys
import subprocess
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))


class TranscriptionAgent:
    def __init__(self):
        self.llm = OpenAI(api_key=os.environ["OPENAI_API_KEY"])

    def check_file_format(self, file_path):
        result = subprocess.run(
            ['ffmpeg', '-i', file_path], stderr=subprocess.PIPE, text=True)
        return result.stderr

    def convert_to_wav(self, input_file_path):
        output_file_path = input_file_path.rsplit('.', 1)[0] + '_converted.wav'
        if os.path.exists(output_file_path):
            os.remove(output_file_path)
        # サンプルレートとチャンネル数を明示的に指定
        subprocess.run(['ffmpeg', '-i', input_file_path, '-ar', '8000',
                       '-ac', '1', output_file_path], check=False, stderr=subprocess.PIPE)
        return output_file_path

    def transcribe(self, voice_file_path):
        try:
            with open(voice_file_path, "rb") as audio_file:
                response = self.llm.audio.transcriptions.create(
                    model="whisper-1", file=audio_file)
            return response.text
        except openai.BadRequestError as e:
            print(f"Error: {e}")
            raise e


class LLMAgent:
    def __init__(self, model_name: str = "gpt-4o-mini", temperature: int = 0, request_timout: int = 120):
        self.llm = ChatOpenAI(
            model_name=model_name,
            temperature=temperature,
            request_timeout=request_timout,
        )

    def render_system_message(self, content):
        system_message = SystemMessage(content=content)
        assert isinstance(system_message, SystemMessage)
        return system_message

    def render_human_message(self, *, content):
        return HumanMessage(content=content)

    async def get_response(self, system_content, human_content):
        messages = [
            self.render_system_message(content=system_content),
            self.render_human_message(content=human_content)
        ]
        response = await self.llm.ainvoke(
            input=messages
        )
        return response.content


class LLMSkillAgent:
    def __init__(
        self,
        model_name: str = "gpt-4o-mini",
        temperature: int = 0,
        request_timout: int = 120,
        tool_categories: list = ["default"]
    ):
        self.initialization_status = {
            "success": True, "result": "agent initialized successfully"}
        try:
            self.llm = ChatOpenAI(
                model_name=model_name,
                temperature=temperature,
                request_timeout=request_timout,
            )
            self.memory = Memory()
            self.tools = []
            self.default_tool_categories = [
                "default", "discord", "express_emotion", "file_control", "image_control", "minecraft", "search", "tool_control"]
            self.import_tools(tool_categories)
        except Exception as e:
            self.initialization_status = {"success": False, "result": f"{e}"}

    def import_tools(self, tool_categories):
        self.tools = []
        self.tools = load_tools(["llm-math"], llm=self.llm)
        if tool_categories:
            for category in tool_categories:
                if (category in self.default_tool_categories):
                    response = self.import_and_load_tools(category)
                if not response['success']:
                    return {"success": False, "result": response['result']}
        self.initialize_agent()

    def import_and_load_tools(self, tool_category):
        try:
            response = self.import_classes_from_directory(tool_category)
            if not response['success']:
                return {"success": False, "result": response['result']}
            for tool_class in response['result']:
                if issubclass(tool_class, BaseTool):
                    self.tools.append(tool_class())
            return {"success": True, "result": "tools loaded successfully"}
        except Exception as e:
            return {"success": False, "result": f"{e}"}

    def initialize_agent(self):
        try:
            self.prompt = hub.pull("hwchase17/openai-tools-agent")
            self.tool_agent = create_openai_tools_agent(
            llm=self.llm, tools=self.tools, prompt=self.prompt)
            self.tool_agent_executor = AgentExecutor(
                agent=self.tool_agent, tools=self.tools, verbose=True)
            print("agent initialized successfully")
        except Exception as e:
            print(f"agent initialization failed: {e}")

    def import_classes_from_directory(self, tool_category):
        current_dir = os.path.dirname(os.path.abspath(__file__))
        tools_dir = os.path.join(current_dir, "..", "tools")
        directory = os.path.join(tools_dir, tool_category)
        classes = []
        for root, _, files in os.walk(directory):
            for file in files:
                try:
                    if file.endswith(".py") and file != "__init__.py":
                        module_path = os.path.relpath(
                            os.path.join(root, file), directory)
                        module_name = module_path.replace(
                            os.sep, ".").replace(".py", "")
                        full_module_name = f"tools.{
                            tool_category}.{module_name}"
                        module = importlib.import_module(full_module_name)
                        for attribute_name in dir(module):
                            if attribute_name.endswith("Tool") and attribute_name != "BaseTool":
                                attribute = getattr(module, attribute_name)
                                if isinstance(attribute, type):
                                    classes.append(attribute)
                except Exception as e:
                    return {"success": False, "result": f"{e}"}
        return {"success": True, "result": classes}

    def render_system_message(self, content):
        system_message = SystemMessage(content=content)
        assert isinstance(system_message, SystemMessage)
        return system_message

    def render_human_message(self, *, content):
        return HumanMessage(content=content)

    async def get_response(self, system_content, human_content, data=None, need_memorise=False):
        if need_memorise:
            user_message = data["time"] + " " + \
                data["sender_name"] + ": " + data["message"]
            await self.memory.add_user_message(user_message=user_message)
        messages = [
            self.render_system_message(content=system_content),
            self.render_human_message(content=human_content)
        ]
        stm = self.memory.get_STM()
        response = await self.tool_agent_executor.ainvoke({
            "input": messages,
            "chat_history": stm
        })
        output_message = response["output"]
        time = datetime.now(pytz.timezone('Asia/Tokyo')
                            ).strftime('%Y-%m-%d %H:%M:%S')
        ai_message = time + " " + \
            "Shannon: " + output_message
        if need_memorise:
            await self.memory.add_ai_message(ai_message=ai_message)
        return output_message
