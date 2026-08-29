import express from 'express';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TwitterClient } from '../../../src/services/twitter/client';

/** Webhook 内の `fetch` をモックしても、テストクライアントは実 HTTP で叩けるようにする */
const nativeFetch = globalThis.fetch.bind(globalThis);

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function emptyTwitterApiResponse(): Response {
  return { json: async () => ({ tweets: [] }) } as Response;
}

vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
  },
}));

const twitterCfg = vi.hoisted(() => ({
  userId: 'bot-self-id',
  twitterApiIoKey: 'webhook-test-key',
}));

const twitterPort = vi.hoisted(() => ({
  likeTweet: vi.fn(),
}));

const llmDispatch = vi.hoisted(() => ({
  deliverTwitterReplyToLlm: vi.fn(),
}));

vi.mock('../../../src/config/env.js', () => ({
  config: { twitter: twitterCfg },
}));

vi.mock('../../../src/services/runtime/platformToolGateway.js', () => ({
  getTwitterToolPort: () => twitterPort,
}));

vi.mock('../../../src/services/runtime/llmInboundDispatch.js', () => ({
  deliverTwitterReplyToLlm: llmDispatch.deliverTwitterReplyToLlm,
}));

import { registerWebhookRoutes } from '../../../src/routes/webhookRoutes.js';

function createMockTwitterClient(
  overrides: Partial<{
    isReplyLimitReached: () => boolean;
  }> = {},
): TwitterClient {
  return {
    processedTweetIds: new Set<string>(),
    saveProcessedIds: vi.fn(),
    isReplyLimitReached: vi.fn(() => overrides.isReplyLimitReached?.() ?? false),
    incrementReplyCount: vi.fn(),
  } as unknown as TwitterClient;
}

function mountApp(twitterClient: TwitterClient | null) {
  const app = express();
  app.use(express.json());
  registerWebhookRoutes(app, twitterClient);
  return app;
}

async function withServer(
  app: express.Application,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe('registerWebhookRoutes /api/webhook/twitter', () => {
  beforeEach(() => {
    twitterPort.likeTweet.mockReset();
    llmDispatch.deliverTwitterReplyToLlm.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (requestUrl(input).includes('twitterapi.io')) {
          return emptyTwitterApiResponse();
        }
        return nativeFetch(input, init);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET は 200 で検証用レスポンスを返す', async () => {
    const app = mountApp(createMockTwitterClient());
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/webhook/twitter`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok?: boolean };
      expect(body.ok).toBe(true);
    });
  });

  it('twitterClient が null のとき POST は 503', async () => {
    const app = mountApp(null);
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/webhook/twitter`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': twitterCfg.twitterApiIoKey,
        },
        body: JSON.stringify({ tweets: [] }),
      });
      expect(res.status).toBe(503);
    });
  });

  it('X-API-Key が不正なら 401', async () => {
    const app = mountApp(createMockTwitterClient());
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/webhook/twitter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'wrong' },
        body: JSON.stringify({ tweets: [{ id: '1', text: 'a', author: { id: 'x' } }] }),
      });
      expect(res.status).toBe(401);
    });
  });

  it('tweets が空なら processed 0', async () => {
    const app = mountApp(createMockTwitterClient());
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/webhook/twitter`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': twitterCfg.twitterApiIoKey,
        },
        body: JSON.stringify({ tweets: [] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { processed?: number };
      expect(body.processed).toBe(0);
    });
  });

  it('自分自身のツイートは無視する', async () => {
    const client = createMockTwitterClient();
    const app = mountApp(client);
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/webhook/twitter`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': twitterCfg.twitterApiIoKey,
        },
        body: JSON.stringify({
          tweets: [
            {
              id: 'self1',
              text: 'me',
              author: { id: twitterCfg.userId, userName: 'bot' },
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
    });
    expect(llmDispatch.deliverTwitterReplyToLlm).not.toHaveBeenCalled();
  });

  it('引用RT rule では like と deliverTwitterReplyToLlm を呼ぶ', async () => {
    const client = createMockTwitterClient();
    const app = mountApp(client);
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/webhook/twitter`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': twitterCfg.twitterApiIoKey,
        },
        body: JSON.stringify({
          rule_tag: 'quote-rt-rule',
          tweets: [
            {
              id: 'q1',
              text: 'quote text',
              author: { id: 'other', userName: 'u', name: 'U' },
              quoted_tweet: { text: 'orig', author: { name: 'Author' } },
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { processed?: number };
      expect(body.processed).toBe(1);
    });

    expect(twitterPort.likeTweet).toHaveBeenCalledWith('q1');
    expect(llmDispatch.deliverTwitterReplyToLlm).toHaveBeenCalledOnce();
    expect(client.processedTweetIds.has('q1')).toBe(true);
  });

  it('日次上限時は引用RT で返信イベントを出さない（いいねは送る）', async () => {
    const client = createMockTwitterClient({ isReplyLimitReached: () => true });
    const app = mountApp(client);
    await withServer(app, async (base) => {
      await fetch(`${base}/api/webhook/twitter`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': twitterCfg.twitterApiIoKey,
        },
        body: JSON.stringify({
          rule_tag: 'x-quote-rt',
          tweets: [
            {
              id: 'q2',
              text: 'q',
              author: { id: 'o' },
              quoted_tweet: { text: 'o' },
            },
          ],
        }),
      });
    });

    expect(twitterPort.likeTweet).toHaveBeenCalledWith('q2');
    expect(llmDispatch.deliverTwitterReplyToLlm).not.toHaveBeenCalled();
  });

  it('通常リプライはスレッド取得後に deliverTwitterReplyToLlm を送る', async () => {
    const client = createMockTwitterClient();
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).includes('twitterapi.io')) {
        return {
          json: async () => ({
            tweets: [
              {
                text: 'parent text',
                author: { name: 'Parent' },
                inReplyToId: null,
              },
            ],
          }),
        } as Response;
      }
      return nativeFetch(input, init);
    });

    const app = mountApp(client);
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/webhook/twitter`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': twitterCfg.twitterApiIoKey,
        },
        body: JSON.stringify({
          tweets: [
            {
              id: 'reply1',
              text: 'child',
              author: { id: 'user1', userName: 'u1' },
              inReplyToId: 'parent-id',
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
    });

    await vi.waitFor(() => {
      expect(llmDispatch.deliverTwitterReplyToLlm).toHaveBeenCalled();
    });

    const data = llmDispatch.deliverTwitterReplyToLlm.mock.calls[0][0] as {
      replyId?: string;
      conversationThread?: { authorName: string; text: string }[];
    };
    expect(data.replyId).toBe('reply1');
    expect(data.conversationThread?.length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.some((c) => requestUrl(c[0] as RequestInfo).includes('twitterapi.io'))).toBe(
      true,
    );
  });

  it('同一 tweetId は二重処理しない', async () => {
    const client = createMockTwitterClient();
    client.processedTweetIds.add('dup1');
    const app = mountApp(client);
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/webhook/twitter`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': twitterCfg.twitterApiIoKey,
        },
        body: JSON.stringify({
          rule_tag: 'quote-rt',
          tweets: [
            {
              id: 'dup1',
              text: 'x',
              author: { id: 'a' },
              quoted_tweet: { text: 'y' },
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { processed?: number };
      expect(body.processed).toBe(0);
    });
    expect(llmDispatch.deliverTwitterReplyToLlm).not.toHaveBeenCalled();
  });
});
