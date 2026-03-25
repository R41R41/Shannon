import path from 'path';
import type { Express } from 'express';
import { AutoTweetMode, TwitterClientInput, TwitterReplyOutput } from '@shannon/common';
import { config } from '../config/env.js';
import { getEventBus } from '../services/eventBus/index.js';
import { logger } from '../utils/logger.js';

export function registerTestRoutes(app: Express): void {
  // POST: 定期投稿テスト (生成 -> Twitter実投稿)
  // body: { command: 'fortune' | 'forecast' | 'about_today' | 'news_today' }
  // query: ?dry_run=true で投稿せずに生成結果のみ返す
  app.post('/api/test/scheduled-post', async (req, res) => {
    const key = req.headers['x-api-key'] as string | undefined;
    if (!key || key !== config.twitter.twitterApiIoKey) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const command = (req.body as { command?: string })?.command;
    const dryRun = req.query.dry_run === 'true';
    const validCommands = ['fortune', 'forecast', 'about_today', 'news_today'];
    if (!command || !validCommands.includes(command)) {
      res.status(400).json({ error: `command must be one of: ${validCommands.join(', ')}` });
      return;
    }
    try {
      let post = '';
      let imagePrompt: string | undefined;

      if (command === 'fortune') {
        const { PostFortuneAgent } = await import('../services/llm/agents/postFortuneAgent.js');
        const agent = await PostFortuneAgent.create();
        const result = await agent.createPost();
        post = result.text;
        imagePrompt = result.imagePrompt;
      } else if (command === 'forecast') {
        const { PostWeatherAgent } = await import('../services/llm/agents/postWeatherAgent.js');
        const agent = await PostWeatherAgent.create();
        const result = await agent.createPost();
        post = result.text;
        imagePrompt = result.imagePrompt;
      } else if (command === 'about_today') {
        const { PostAboutTodayAgent } = await import('../services/llm/agents/postAboutTodayAgent.js');
        const agent = await PostAboutTodayAgent.create();
        const result = await agent.createPost();
        post = result.text;
        imagePrompt = result.imagePrompt;
      } else if (command === 'news_today') {
        const { PostNewsAgent } = await import('../services/llm/agents/postNewsAgent.js');
        const agent = await PostNewsAgent.create();
        const result = await agent.createPost();
        post = result.text;
        imagePrompt = result.imagePrompt;
      }
      logger.info(`[Test:ScheduledPost] ${command} 生成完了: ${post.slice(0, 100)}...`);

      // 画像生成 + アップロード（全 command 共通、dry_run でなければ）
      let mediaId: string | null = null;
      if (!dryRun && imagePrompt) {
        try {
          const { generateImage } = await import('../services/llm/utils/generateImage.js');
          const imgBuf = await generateImage(imagePrompt, '1024x1024', 'low');
          if (imgBuf) {
            const { TwitterClient } = await import('../services/twitter/client.js');
            const twitterClient = TwitterClient.getInstance();
            mediaId = await twitterClient.uploadMedia(imgBuf, `${command}.jpg`) ?? null;
            if (mediaId) {
              logger.info(`[Test:ScheduledPost] ${command} 画像アップロード成功: ${mediaId}`);
            }
          }
        } catch (imgErr) {
          logger.warn(`[Test:ScheduledPost] ${command} 画像失敗（テキストのみ）: ${imgErr}`);
        }
      }

      if (!dryRun && post) {
        const eventBus = getEventBus();
        eventBus.publish({
          type: 'twitter:post_scheduled_message',
          memoryZone: 'twitter:schedule_post',
          data: {
            text: post,
            ...(mediaId ? { imageUrl: mediaId } : {}),
          } as TwitterClientInput,
        });
        logger.info(`[Test:ScheduledPost] ${command} Twitter投稿イベント発行${mediaId ? ' (画像付き)' : ''}`);
      }
      res.status(200).json({
        ok: true,
        command,
        tweet: post,
        posted: !dryRun,
        ...(dryRun && imagePrompt ? { imagePrompt } : {}),
        ...(mediaId ? { mediaId } : {}),
      });
    } catch (err) {
      logger.error(`[Test:ScheduledPost] ${command} エラー`, err);
      res.status(500).json({ error: String(err) });
    }
  });

  // POST: 自動ツイートテスト (生成 -> Twitter実投稿)
  // body: { mode?: 'trend' | 'watchlist' | 'big_account_quote' | 'original' }
  // query: ?dry_run=true で投稿せずに生成結果のみ返す
  app.post('/api/test/auto-tweet', async (req, res) => {
    const key = req.headers['x-api-key'] as string | undefined;
    if (!key || key !== config.twitter.twitterApiIoKey) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const dryRun = req.query.dry_run === 'true';
    const mode = ((req.body as { mode?: string })?.mode) || 'trend';
    const validModes = ['trend', 'watchlist', 'big_account_quote', 'original'];
    if (!validModes.includes(mode)) {
      res.status(400).json({ error: `mode must be one of: ${validModes.join(', ')}` });
      return;
    }
    try {
      const axios = (await import('axios')).default;
      const { AutoTweetAgent } = await import('../services/llm/agents/autoTweetAgent.js');
      const agent = await AutoTweetAgent.create();

      let trends: Array<{ name: string; query: string; rank: number; metaDescription?: string }> = [];
      if (mode === 'trend') {
        const trendsRes = await axios.get('https://api.twitterapi.io/twitter/trends', {
          headers: { 'X-API-Key': config.twitter.twitterApiIoKey },
          params: { woeid: '23424856' },
        });
        trends = (trendsRes.data?.trends ?? []).map((t: Record<string, unknown>, i: number) => {
          const trend = t.trend && typeof t.trend === 'object' ? (t.trend as Record<string, unknown>) : t;
          return {
            name: (trend.name as string) ?? '',
            query: ((trend.target as Record<string, unknown>)?.query as string) ?? (trend.query as string) ?? (trend.name as string) ?? '',
            rank: (trend.rank as number) ?? i + 1,
            metaDescription: ((trend.meta_description ?? trend.metaDescription) as string | undefined) ?? undefined,
          };
        });
      }

      const now = new Date();
      const month = now.getMonth() + 1;
      const day = now.getDate();
      const dayOfWeek = ['日', '月', '火', '水', '木', '金', '土'][now.getDay()];
      const todayInfo = `今日: ${now.getFullYear()}年${month}月${day}日(${dayOfWeek})`;

      let recentPosts: string[] = [];
      try {
        const fs = await import('fs');
        const recentPostsPath = path.resolve('saves/recent_auto_posts.json');
        if (fs.existsSync(recentPostsPath)) {
          recentPosts = JSON.parse(fs.readFileSync(recentPostsPath, 'utf-8'));
        }
      } catch { /* ignore */ }

      logger.info(`[Test:AutoTweet] mode=${mode}, トレンド${trends.length}件, 直近投稿${recentPosts.length}件`);
      const result = await agent.generateTweet(trends, todayInfo, recentPosts, undefined, mode as AutoTweetMode);
      logger.info(`[Test:AutoTweet] 生成結果: ${JSON.stringify(result)}`);

      if (!dryRun && result) {
        const eventBus = getEventBus();
        eventBus.publish({
          type: 'twitter:post_scheduled_message',
          memoryZone: 'twitter:post',
          data: {
            text: result.text,
            ...(result.type === 'quote_rt' && result.quoteUrl
              ? { quoteTweetUrl: result.quoteUrl }
              : {}),
          } as TwitterClientInput,
        });
        logger.info(`[Test:AutoTweet] Twitter投稿イベント発行 (type=${result.type})`);
      }
      res.status(200).json({
        ok: true,
        mode,
        result,
        trendsUsed: trends.length,
        recentPostsLoaded: recentPosts.length,
        posted: !dryRun && !!result,
      });
    } catch (err) {
      logger.error('[Test:AutoTweet] エラー', err);
      res.status(500).json({ error: String(err) });
    }
  });

  // POST: メンバーTweetへの返信テスト (ライ・ヤミーなどのツイートに反応)
  // body: { tweetUrl?: string }  省略時はライの最新ツイートを自動取得
  // query: ?dry_run=true で投稿せずに生成結果のみ返す
  app.post('/api/test/member-tweet', async (req, res) => {
    const key = req.headers['x-api-key'] as string | undefined;
    if (!key || key !== config.twitter.twitterApiIoKey) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const dryRun = req.query.dry_run === 'true';
    const inputTweetUrl = (req.body as { tweetUrl?: string })?.tweetUrl;
    try {
      const axios = (await import('axios')).default;
      const { MemberTweetAgent } = await import('../services/llm/agents/memberTweetAgent.js');
      const agent = await MemberTweetAgent.create();

      // tweetUrl が指定されていればそのツイートを取得、なければライの最新ツイートを取得
      let tweetId: string;
      let tweetText: string;
      let authorName: string;
      let authorUserName: string;
      let tweetUrl: string;

      if (inputTweetUrl) {
        // URL から tweetId を抽出
        const match = inputTweetUrl.match(/\/status\/(\d+)/);
        if (!match) {
          res.status(400).json({ error: 'tweetUrl の形式が不正です (例: https://x.com/user/status/ID)' });
          return;
        }
        tweetId = match[1];
        const detailRes = await axios.get('https://api.twitterapi.io/twitter/tweets', {
          headers: { 'X-API-Key': config.twitter.twitterApiIoKey },
          params: { tweet_ids: tweetId },
        });
        const t = detailRes.data?.tweets?.[0];
        if (!t) {
          res.status(404).json({ error: `ツイート ${tweetId} が見つかりません` });
          return;
        }
        tweetText = t.text ?? '';
        authorName = t.author?.name ?? '';
        authorUserName = t.author?.userName ?? '';
        tweetUrl = t.url || inputTweetUrl;
      } else {
        // ライの最新ツイートを advanced_search で取得（user/tweets より安定）
        const raiUserName = config.twitter.usernames?.rai || 'R4iR4i000';
        const tweetsRes = await axios.get('https://api.twitterapi.io/twitter/tweet/advanced_search', {
          headers: { 'X-API-Key': config.twitter.twitterApiIoKey },
          params: { query: `from:${raiUserName} -is:reply`, queryType: 'Latest', count: 1 },
        });
        const tweets = tweetsRes.data?.tweets ?? [];
        if (tweets.length === 0) {
          res.status(404).json({ error: `@${raiUserName} のツイートが見つかりません` });
          return;
        }
        const t = tweets[0];
        tweetId = t.id;
        tweetText = t.text ?? '';
        authorName = t.author?.name ?? '';
        authorUserName = t.author?.userName ?? '';
        tweetUrl = t.url || `https://x.com/${authorUserName}/status/${tweetId}`;
      }

      logger.info(`[Test:MemberTweet] 対象: @${authorUserName} "${tweetText.slice(0, 60)}" (id=${tweetId})`);

      const result = await agent.respond({
        text: tweetText,
        authorName,
        authorUserName,
        repliedTweet: '',
        repliedTweetAuthorName: '',
      });

      logger.info(`[Test:MemberTweet] 生成結果: ${JSON.stringify(result)}`);

      if (!dryRun && result) {
        const eventBus = getEventBus();
        if (result.type === 'quote_rt') {
          eventBus.publish({
            type: 'twitter:post_message',
            memoryZone: 'twitter:post',
            data: { text: result.text, quoteTweetUrl: tweetUrl } as TwitterClientInput,
          });
        } else {
          eventBus.publish({
            type: 'twitter:post_message',
            memoryZone: 'twitter:post',
            data: { text: result.text, replyId: tweetId } as TwitterClientInput,
          });
        }
        logger.info(`[Test:MemberTweet] Twitter投稿イベント発行 (type=${result.type})`);
      }

      res.status(200).json({
        ok: true,
        result,
        sourceTweet: { tweetId, tweetUrl, text: tweetText, authorName, authorUserName },
        posted: !dryRun && !!result,
      });
    } catch (err) {
      logger.error('[Test:MemberTweet] エラー', err);
      res.status(500).json({ error: String(err) });
    }
  });

  // POST: 一般返信テスト (シャノンの投稿への返信に対して返信を生成)
  // body: { text?: string, authorName?: string }  省略時はシャノン宛リプライを自動取得
  // query: ?dry_run=true で投稿せずに生成結果のみ返す
  app.post('/api/test/reply-comment', async (req, res) => {
    const key = req.headers['x-api-key'] as string | undefined;
    if (!key || key !== config.twitter.twitterApiIoKey) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const dryRun = req.query.dry_run === 'true';
    const inputText = (req.body as { text?: string })?.text;
    const inputAuthorName = (req.body as { authorName?: string })?.authorName;
    try {
      const axios = (await import('axios')).default;
      const { ReplyTwitterCommentAgent } = await import('../services/llm/agents/replyTwitterComment.js');
      const agent = await ReplyTwitterCommentAgent.create();

      let commentText: string;
      let authorName: string;
      let repliedTweet: string | null = null;
      let repliedTweetAuthorName: string | null = null;

      if (inputText && inputAuthorName) {
        commentText = inputText;
        authorName = inputAuthorName;
      } else {
        const shannonUserName = config.twitter.userName || 'Sh4nnon_AI';
        const mentionsRes = await axios.get('https://api.twitterapi.io/twitter/tweet/advanced_search', {
          headers: { 'X-API-Key': config.twitter.twitterApiIoKey },
          params: { query: `to:${shannonUserName} -from:${shannonUserName}`, queryType: 'Latest', count: 5 },
        });
        const mentions = mentionsRes.data?.tweets ?? [];
        if (mentions.length === 0) {
          res.status(404).json({ error: `@${shannonUserName} へのリプライが見つかりません` });
          return;
        }
        const pick = mentions[Math.floor(Math.random() * mentions.length)];
        commentText = pick.text ?? '';
        authorName = pick.author?.name ?? pick.author?.userName ?? 'unknown';

        if (pick.inReplyToId) {
          try {
            const parentRes = await axios.get('https://api.twitterapi.io/twitter/tweets', {
              headers: { 'X-API-Key': config.twitter.twitterApiIoKey },
              params: { tweet_ids: pick.inReplyToId },
            });
            const parent = parentRes.data?.tweets?.[0];
            if (parent) {
              repliedTweet = parent.text ?? null;
              repliedTweetAuthorName = parent.author?.name ?? null;
            }
          } catch { /* ignore */ }
        }
      }

      logger.info(`[Test:ReplyComment] 対象: ${authorName}「${commentText.slice(0, 60)}」`);

      const replyText = await agent.reply(
        commentText,
        authorName,
        repliedTweet,
        repliedTweetAuthorName,
      );

      logger.info(`[Test:ReplyComment] 生成結果: ${replyText}`);

      res.status(200).json({
        ok: true,
        generatedReply: replyText,
        sourceComment: { text: commentText, authorName, repliedTweet, repliedTweetAuthorName },
        posted: false,
      });
    } catch (err) {
      logger.error('[Test:ReplyComment] エラー', err);
      res.status(500).json({ error: String(err) });
    }
  });
}
