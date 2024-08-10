import os
import openai
from openai import OpenAI
import sys
import subprocess
sys.path.append(os.path.join(os.path.dirname(
    os.path.abspath(__file__)), "..", "tools"))


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
