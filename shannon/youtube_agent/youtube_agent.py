import os
from googleapiclient.discovery import build
from dotenv import load_dotenv
import utils as U
load_dotenv()


class YoutubeAgent:
    def __init__(
        self,
    ):
        self.api_key = os.getenv('GOOGLE_CLOUD_API_KEY')
        self.youtube = build('youtube', 'v3', developerKey=self.api_key)
        self.channel_id = os.getenv('YOUTUBE_CHANNEL_ID')
        self.video_list_file_path = U.f_join(
            'saves', 'youtube', 'video_list.json')
        self.subscriber_count_file_path = U.f_join(
            'saves', 'youtube', 'subscriber_count.json')
        self.video_list = U.json_load(self.video_list_file_path)
        self.subscriber_count = U.json_load(self.subscriber_count_file_path)
        if not self.subscriber_count:
            self.subscriber_count = [0]

    async def check_subscriber_count(self):
        try:
            response = self.youtube.channels().list(
                id=self.channel_id,
                part='statistics'
            ).execute()
            subscriber_count = response['items'][0]['statistics']['subscriberCount']
            if int(subscriber_count) > self.subscriber_count[0]:
                self.subscriber_count[0] = int(subscriber_count)
                U.json_dump(self.subscriber_count,
                            self.subscriber_count_file_path)
                print(f"新しい登録者数を検知しました: {subscriber_count}")
                data = {"subscriber_count": subscriber_count}
                await U.send_request(
                    destination="discord_bot", endpoint="increase_youtube_subscriber_count", data=data, request_type="post")
            return self.subscriber_count[0]
        except Exception as e:
            print(f"API呼び出し中にエラーが発生しました: {e}")
            return None

    async def get_latest_video(self):
        try:
            video_response = self.youtube.search().list(
                channelId=self.channel_id,
                part='snippet',
                maxResults=50
            ).execute()

            videos = video_response['items']

            videos.sort(key=lambda x: x['snippet']
                        ['publishTime'], reverse=True)
            latest_video = videos[0]
            video_id = latest_video["id"]["videoId"]
            video_url = f"https://www.youtube.com/watch?v={video_id}"
            data = {
                "url": video_url,
                "title": latest_video['snippet']['title'],
                "description": latest_video['snippet']['description'],
                "publishTime": latest_video['snippet']['publishTime'],
                "thumbnail": latest_video['snippet']['thumbnails']['high']['url']
            }
            return data
        except Exception as e:
            print(f"API呼び出し中にエラーが発生しました: {e}")
            return None

    async def check_video_list(self):
        try:
            video_response = self.youtube.search().list(
                channelId=self.channel_id,
                part='snippet',
                maxResults=50
            ).execute()
            videos = video_response['items']
            for video in videos:
                if video['id']['kind'] != "youtube#video":
                    continue
                video_id = video["id"]["videoId"]
                if not any(v['id'] == video_id for v in self.video_list):
                    self.video_list.append(
                        {"id": video_id, "title": video["snippet"]["title"]})
                    print(f"新しい動画を検知しました: {
                        video["id"]["videoId"], video['snippet']['title']}")
                    U.json_dump(self.video_list,
                                self.video_list_file_path, ensure_ascii=False)

                # await U.send_request(
                #     destination="twitter_bot", endpoint="post_latest_video", data={}, request_type="get")
            return self.video_list
        except Exception as e:
            print(f"API呼び出し中にエラーが発生しました: {e}")
            return None

    async def reply_comment(self):
        # TODO: 実装
        return None
