import type {
  NotionClientOutput,
  TwitterActionResult,
  TwitterClientInput,
  TwitterClientOutput,
} from '@shannon/common';

export type PostTweetResult = { isSuccess: boolean; errorMessage: string };

export interface TwitterToolPort {
  postMessage(input: Pick<TwitterClientInput, 'text' | 'replyId' | 'quoteTweetUrl' | 'imageUrl'>): Promise<PostTweetResult>;
  likeTweet(tweetId: string): Promise<TwitterActionResult>;
  retweetTweet(tweetId: string): Promise<TwitterActionResult>;
  quoteRetweet(text: string, quoteTweetUrl: string): Promise<TwitterActionResult>;
  getTweetContent(tweetId: string): Promise<TwitterClientOutput | null>;
  postScheduledMessage(input: Pick<TwitterClientInput, 'text' | 'quoteTweetUrl' | 'imageUrl' | 'topic'>): Promise<void>;
  checkReplies(): Promise<void>;
}

export interface NotionToolPort {
  getPageMarkdown(pageId: string): Promise<NotionClientOutput>;
}

export interface YoutubeToolPort {
  getVideoInfo(videoId: string): Promise<unknown>;
}

let twitterPort: TwitterToolPort | null = null;
let notionPort: NotionToolPort | null = null;
let youtubePort: YoutubeToolPort | null = null;

export function registerTwitterToolPort(port: TwitterToolPort): void {
  if (twitterPort) throw new Error('TwitterToolPort already registered');
  twitterPort = port;
}

export function registerNotionToolPort(port: NotionToolPort): void {
  if (notionPort) throw new Error('NotionToolPort already registered');
  notionPort = port;
}

export function registerYoutubeToolPort(port: YoutubeToolPort): void {
  if (youtubePort) throw new Error('YoutubeToolPort already registered');
  youtubePort = port;
}

export function getTwitterToolPort(): TwitterToolPort {
  if (!twitterPort) throw new Error('TwitterToolPort is not registered');
  return twitterPort;
}

export function getNotionToolPort(): NotionToolPort {
  if (!notionPort) throw new Error('NotionToolPort is not registered');
  return notionPort;
}

export function getYoutubeToolPort(): YoutubeToolPort {
  if (!youtubePort) throw new Error('YoutubeToolPort is not registered');
  return youtubePort;
}

export function clearPlatformToolPorts(): void {
  twitterPort = null;
  notionPort = null;
  youtubePort = null;
}
