import type { Express } from 'express';
import { TwitterClientInput, TwitterReplyOutput } from '@shannon/common';
import { config } from '../config/env.js';
import { getEventBus } from '../services/eventBus/index.js';
import { TwitterClient } from '../services/twitter/client.js';
import { logger } from '../utils/logger.js';
import { safeAsync } from '../utils/safeAsync.js';

export function registerWebhookRoutes(app: Express, twitterClient: TwitterClient | null): void {
  // GET: twitterapi.io が Webhook URL 保存時に検証リクエストを送る
  app.get('/api/webhook/twitter', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // POST: 実際の Webhook ペイロード受信
  app.post('/api/webhook/twitter', (req, res) => {
    try {
      if (!twitterClient) {
        res.status(503).json({ error: 'Twitter service not available' });
        return;
      }

      // X-API-Key ヘッダーで送信元を検証
      const receivedKey = req.headers['x-api-key'] as string | undefined;
      if (!receivedKey || receivedKey !== config.twitter.twitterApiIoKey) {
        logger.warn('[Webhook] Twitter webhook: 不正な API Key');
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const body = req.body as {
        event_type?: string;
        rule_id?: string;
        rule_tag?: string;
        tweets?: Array<{
          id?: string;
          text?: string;
          author?: { id?: string; userName?: string; username?: string; screenName?: string; name?: string };
          quoted_tweet?: { text?: string; author?: { name?: string; userName?: string } };
          quotedTweet?: { text?: string; author?: { name?: string; userName?: string } };
          inReplyToId?: string;
          in_reply_to_status_id?: string;
          in_reply_to_tweet_id?: string;
          url?: string;
        }>;
        timestamp?: number;
      };

      const { tweets, rule_tag } = body;

      if (!tweets || tweets.length === 0) {
        res.status(200).json({ ok: true, processed: 0 });
        return;
      }

      logger.info(
        `[Webhook] Twitter webhook 受信: ${tweets.length}件 (rule: ${rule_tag})${tweets.length > 0 ? ` from:@${tweets[0].author?.userName ?? '?'} "${(tweets[0].text ?? '').slice(0, 60)}"` : ''}`
      );

      const eventBus = getEventBus();
      const myUserId = config.twitter.userId;
      const isQuoteRTWebhook = rule_tag?.includes('quote-rt') ?? false;
      let processed = 0;

      for (const tweet of tweets) {
        const author = tweet.author;
        const authorId = author?.id ?? '';
        const authorUserName = author?.userName ?? author?.username ?? author?.screenName ?? '';
        const authorName = author?.name ?? authorUserName;
        const tweetId = tweet.id ?? '';
        const tweetText = tweet.text ?? '';

        // 自分自身のツイートは無視
        if (authorId === myUserId) continue;

        // 処理済みチェック (ポーリングとの二重返信防止)
        if (twitterClient.processedTweetIds.has(tweetId)) {
          logger.info(`[Webhook] 既に処理済み: ${tweetId}`);
          continue;
        }

        // 処理済みとしてマーク & ファイル永続化
        twitterClient.processedTweetIds.add(tweetId);
        twitterClient.saveProcessedIds();

        // ─── 引用RT検知 ───
        if (isQuoteRTWebhook) {
          const quotedTweet = tweet.quoted_tweet ?? tweet.quotedTweet ?? null;
          const quotedText = quotedTweet?.text ?? '';
          const quotedAuthor = quotedTweet?.author?.name ?? quotedTweet?.author?.userName ?? 'Shannon';

          logger.info(
            `[Webhook] 引用RT検知: @${authorUserName} が引用「${tweetText.slice(0, 60)}...」` +
            ` (元ツイート: "${quotedText.slice(0, 60)}...")`,
            'green'
          );

          // いいね
          eventBus.publish({
            type: 'twitter:like_tweet',
            memoryZone: 'twitter:post',
            data: { tweetId, text: '' } as TwitterClientInput,
          });

          // 日次返信上限チェック
          if (twitterClient.isReplyLimitReached()) {
            logger.info(`[Webhook] 日次返信上限のため引用RTへの返信をスキップ: ${tweetId}`);
            processed++;
            continue;
          }

          twitterClient.incrementReplyCount();

          // LLM に返信生成を依頼 (引用RTである文脈を conversationThread で伝える)
          eventBus.publish({
            type: 'llm:post_twitter_reply',
            memoryZone: 'twitter:post',
            data: {
              replyId: tweetId,
              text: tweetText,
              authorName,
              authorId: authorId || null,
              repliedTweet: quotedText || null,
              repliedTweetAuthorName: quotedAuthor,
              conversationThread: [
                { authorName: quotedAuthor, text: `[元ツイート] ${quotedText}` },
                { authorName, text: `[引用RT] ${tweetText}` },
              ],
            } as TwitterReplyOutput,
          });

          processed++;
          continue;
        }

        // ─── 通常リプライ処理 ───
        // 日次返信上限チェック
        if (twitterClient.isReplyLimitReached()) {
          logger.info(`[Webhook] 日次返信上限に到達: ${tweetId} (by @${authorUserName}) をスキップ`);
          continue;
        }

        // 返信先の元ツイートID
        const inReplyToId =
          tweet.inReplyToId ?? tweet.in_reply_to_status_id ?? tweet.in_reply_to_tweet_id ?? null;

        logger.info(
          `[Webhook] リプライ検知: @${authorUserName} "${tweetText.slice(0, 50)}..." (返信先: ${inReplyToId})`
        );

        // 会話スレッドを非同期で遡って取得してから LLM に渡す
        const tc = twitterClient;
        safeAsync('Webhook:fetchThread', async () => {
          const thread: Array<{ authorName: string; text: string }> = [];
          const MAX_CHAIN_DEPTH = 5;

          try {
            let currentReplyToId = inReplyToId;
            for (let depth = 0; depth < MAX_CHAIN_DEPTH && currentReplyToId; depth++) {
              const tweetRes = await fetch(
                `https://api.twitterapi.io/twitter/tweets?tweet_ids=${currentReplyToId}`,
                { headers: { 'X-API-Key': config.twitter.twitterApiIoKey } }
              );
              const tweetData = await tweetRes.json() as {
                tweets?: Array<{
                  text?: string;
                  author?: { name?: string; userName?: string; username?: string };
                  inReplyToId?: string;
                  in_reply_to_status_id?: string;
                }>;
              };
              const t = tweetData?.tweets?.[0];
              if (!t) break;

              const tAuthor = t.author?.name ?? t.author?.userName ?? t.author?.username ?? '不明';
              thread.unshift({ authorName: tAuthor, text: t.text ?? '' });

              // さらに上の親ツイートを辿る
              currentReplyToId = t.inReplyToId ?? t.in_reply_to_status_id ?? null;
            }
          } catch (err) {
            logger.warn(`[Webhook] 会話スレッド取得失敗: ${err}`);
          }

          logger.info(`[Webhook] 会話スレッド: ${thread.length}件取得 (最大${MAX_CHAIN_DEPTH})`);

          // 返信カウンタをインクリメント
          tc.incrementReplyCount();

          // 後方互換: thread[0] を repliedTweet として渡す
          const rootTweet = thread.length > 0 ? thread[0] : null;

          eventBus.publish({
            type: 'llm:post_twitter_reply',
            memoryZone: 'twitter:post',
            data: {
              replyId: tweetId,
              text: tweetText,
              authorName,
              repliedTweet: rootTweet?.text ?? null,
              repliedTweetAuthorName: rootTweet?.authorName ?? null,
              conversationThread: thread.length > 0 ? thread : null,
            } as TwitterReplyOutput,
          });
        });

        processed++;
      }

      res.status(200).json({ ok: true, processed });
    } catch (error) {
      logger.error('[Webhook] Twitter webhook エラー', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });
}
