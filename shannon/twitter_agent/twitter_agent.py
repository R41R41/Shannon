from datetime import datetime
from io import BytesIO
import logging
import os
import aiohttp
from pytz import timezone
import requests
import utils as U
from tweepy import asynchronous
import tweepy


class TwitterAgent:
    def __init__(self, CONSUMER_KEY, CONSUMER_SECRET, ACCESS_TOKEN, ACCESS_SECRET, X_CHANNEL_ID, TOYAMA_CHANNEL_ID):
        self.video_count = 0
        auth = tweepy.OAuthHandler(CONSUMER_KEY, CONSUMER_SECRET)
        auth.set_access_token(ACCESS_TOKEN, ACCESS_SECRET)
        self.client_v1 = tweepy.API(auth)
        self.client = asynchronous.AsyncClient(
            consumer_key=CONSUMER_KEY,
            consumer_secret=CONSUMER_SECRET,
            access_token=ACCESS_TOKEN,
            access_token_secret=ACCESS_SECRET
        )
        self.X_CHANNEL_ID = X_CHANNEL_ID
        self.TOYAMA_CHANNEL_ID = TOYAMA_CHANNEL_ID

    async def request_get_twitter_bot(self, request_url):
        async with aiohttp.ClientSession() as session:
            try:
                async with session.get(request_url) as response:
                    if response.status == 200:
                        return await response.text()
            except Exception as e:
                logging.error(f"{datetime.now()} - 未知のエラー: {e}")

    async def request_post_twitter_bot(self, request_url):
        async with aiohttp.ClientSession() as session:
            try:
                async with session.post(request_url) as response:
                    if response.status == 200:
                        return await response.text()
            except Exception as e:
                logging.error(f"{datetime.now()} - 未知のエラー: {e}")

    async def post_weather_data(self):
        print("post_weather_data")
        response = await U.send_request(
            destination="shannon", endpoint="post_weather_data", data={}, request_type="get")
        text = response["text"]
        await self.post_and_report(text=text, category="天気予報データ")
        return

    async def post_weather_comment(self):
        print("post_weather_comment")
        response = await U.send_request(
            destination="shannon", endpoint="post_weather_comment", data={}, request_type="get")
        text = response["text"]
        await self.post_and_report(text=text, category="天気予報コメント")
        return

    async def post_weather(self):
        print("post_weather")
        await self.post_weather_data()
        await self.post_weather_comment()
        return

    async def post_fortune(self):
        response = await U.send_request(
            destination="shannon", endpoint="post_fortune", data={}, request_type="get")
        text = response["text"]
        await self.post_and_report(text=text, category="今日の運勢")
        return

    async def post_aboutToday(self):
        response = await U.send_request(
            destination="shannon", endpoint="post_about_today", data={}, request_type="get")
        text = response["text"]
        await self.post_and_report(text=text, category="今日は何の日？")
        return

    async def post_and_report(self, text, category, image_url: str = None):
        print("post_and_report")
        count = 0
        length = len(text)
        while length > 140 and count < 5:
            # text = await self.llm.get_short_comment(text)
            count += 1
            length = len(text)
        if length <= 140:
            success = await self.try_tweet(text, image_url)
            if success:
                await self.report_on_discord(text=f"{category}のポストに成功しました")
                await self.report_on_discord(text=text, embed_image_url=image_url)
                await self.send_message_to_discord(text=text, embed_image_url=image_url)
            else:
                await self.report_on_discord(text=f"{category}のポストに失敗しました")
        else:
            await self.report_on_discord(text=f"{category}のポストを140字以内に収められませんでした")

    async def report_on_discord(self, text, embed_image_url: str = None):
        print("report_on_discord")
        channel_id = self.X_CHANNEL_ID
        data = {"text": text, "embed_image_url": embed_image_url,
                "channel_id": channel_id, "file_path": None}
        response = await U.send_request(endpoint="chat", data=data, destination="discord_bot", request_type="post")
        return response

    async def send_message_to_discord(self, text, embed_image_url: str = None):
        print("send_message_to_discord")
        channel_id = self.TOYAMA_CHANNEL_ID
        data = {"text": text, "embed_image_url": embed_image_url,
                "channel_id": channel_id, "file_path": None}
        response = await U.send_request(endpoint="chat", data=data, destination="discord_bot", request_type="post")
        return response

    async def try_tweet(self, text, image_url: str = None):
        print("try_tweet")
        try:
            if image_url:
                response = requests.get(image_url)
                media = self.client_v1.media_upload(
                    'image.jpg', file=BytesIO(response.content))
                await self.client.create_tweet(text=text, media_ids=[media.media_id])
            else:
                await self.client.create_tweet(text=text)
            return True
        except Exception as e:  # 例外をキャッチ
            logging.error(f"{datetime.now()} - エラー: {e}")
            await self.report_on_discord(text=f"以下のエラーが出ました\n{str(e)}")
            return False

    async def get_latest_video(self):
        response = await U.send_request(
            destination="youtube_bot", endpoint="get_latest_video", data={}, request_type="get")
        return response["response"]

    async def post_latest_video(self):
        latest_video = await self.get_latest_video()
        publish_time = datetime.strptime(
            latest_video['publishTime'], "%Y-%m-%dT%H:%M:%SZ")
        publish_time = publish_time.replace(tzinfo=timezone('UTC'))
        publish_time = publish_time.astimezone(timezone('Asia/Tokyo'))
        day_of_week = ['月', '火', '水', '木', '金', '土', '日']
        publish_time_str = publish_time.strftime("%m月%d日")
        publish_time_str += '(' + day_of_week[publish_time.weekday()] + ')'
        publish_time_str += publish_time.strftime("%H:%M")
        latest_video['publishTime'] = publish_time_str
        latest_video['title'] = latest_video['title'].split('#')[0]
        text = f"動画が投稿されたよ！\n{latest_video['title']}\n{
            latest_video['publishTime']}\n{latest_video['url']}"
        await self.post_and_report(text=text, category="最新の動画", image_url=latest_video["thumbnail"])
        return

    async def check_and_post_latest_video(self):
        has_added = await self.check_has_added_youtube_video()
        if has_added:
            await self.post_latest_video()

    async def check_has_added_youtube_video(self):
        response = await U.send_request(
            destination="youtube_bot", endpoint="status", data={}, request_type="get")
        if not response:
            return False
        response = await U.send_request(
            destination="youtube_bot", endpoint="get_video_count", data={}, request_type="get")
        if not response:
            return False
        video_count = response["response"]
        if self.video_count:
            if video_count > self.video_count:
                self.video_count = video_count
                return True
            else:
                self.video_count = video_count
                return False
        else:
            self.video_count = video_count
