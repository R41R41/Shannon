from datetime import datetime
import logging
import os
import aiohttp

IS_TEST = os.getenv('IS_TEST') == 'True'


def destination_to_port(destination):
    if IS_TEST:
        switcher = {
            "shannon": "3001",
            "shannon_voice_client": "3051",
            "minecraft_server": "3101",
            "minecraft_bot": "3201",
            "mineflayer": "3251",
            "discord_bot": "3301",
            "twitter_bot": "3401",
            "youtube_bot": "3501",
            "voice_receiver": "3351",
            "discord_voice_client": "3341",
        }
    else:
        switcher = {
            "shannon": "3000",
            "shannon_voice_client": "3050",
            "minecraft_server": "3100",
            "minecraft_bot": "3200",
            "mineflayer": "3250",
            "discord_bot": "3300",
            "twitter_bot": "3400",
            "youtube_bot": "3500",
            "voice_receiver": "3350",
            "discord_voice_client": "3340",
        }
    return switcher.get(destination, None)


async def send_request(endpoint, data, destination, request_type="post"):
    print(f"send_request to {request_type} {destination}:{endpoint} {data}")
    port = destination_to_port(destination=destination)
    if not port:
        print(f"destination {destination} not found")
    url = f"http://localhost:{port}/{endpoint}"
    async with aiohttp.ClientSession() as session:
        try:
            if request_type == "get":
                async with session.get(url, json=data) as response:
                    json_response = await response.json()
                    return json_response
            elif request_type == "post":
                async with session.post(url, json=data) as response:
                    json_response = await response.json()
                    return json_response
        except Exception as e:
            logging.error(
                f"{datetime.now()} - Send request to {destination} failed: {e}")
