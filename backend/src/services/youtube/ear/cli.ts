/**
 * The ear as a process of its own, for the head's bench (`scripts/stream-bench/` of the head repo) and for trying it by hand.
 * It is the same `StreamEar` that the runtime starts inside the `youtube` service, wired from environment variables only.
 *
 *   cd backend
 *   SHANNON_CORE_PLATFORM_URL=http://127.0.0.1:18080/v1/platform/turns \
 *   SHANNON_CORE_PLATFORM_TOKEN=<bridge token> \
 *   YOUTUBE_API_BASE=http://127.0.0.1:18081/youtube/v3 \
 *   YOUTUBE_ACCESS_TOKEN=bench-token \
 *   npx tsx src/services/youtube/ear/cli.ts
 *
 * (without tsx: `TS_NODE_TRANSPILE_ONLY=true node --loader ts-node/esm src/services/youtube/ear/cli.ts`.)
 *
 * Environment
 *   SHANNON_CORE_PLATFORM_URL    required. The head; only its origin is used (the path of the Discord bridge URL is fine).
 *   SHANNON_CORE_PLATFORM_TOKEN  required. The bridge token (`SHANNON_PLATFORM_BRIDGE_TOKEN` of the head).
 *   YOUTUBE_API_BASE             the YouTube Data API v3 base; default https://www.googleapis.com/youtube/v3. A fake API goes here
 *                                (`<base>/liveBroadcasts`, `<base>/videos`, `<base>/liveChat/messages`).
 *   YOUTUBE_ACCESS_TOKEN         a fixed access token; the OAuth refresh is skipped. Without it YOUTUBE_CLIENT_ID,
 *                                YOUTUBE_CLIENT_SECRET and YOUTUBE_REFRESH_TOKEN are used like the runtime does.
 *   YOUTUBE_LIVE_URL             optional. This video is the broadcast (no liveBroadcasts.list).
 *   YOUTUBE_CHANNEL_ID           optional. Sent to the head when YouTube's answer carries no channel.
 *   EAR_STATE_EVERY_MS           optional, default 5000. EAR_DISCOVERY_EVERY_MS default 15000.
 *   EAR_MIN_POLL_MS / EAR_MAX_POLL_MS   optional, default 1000 / 10000. The bounds the polling interval YouTube asks for is kept in.
 *   EAR_HEAD_TIMEOUT_MS          optional, default 5000.
 *
 * Output: one JSON line on stdout, `{"ear":"ready"}`, once the loop runs (the runtime logger's lines follow on stdout). On SIGINT/SIGTERM the ear stops and prints `{"ear":"stopped","status":{...}}` (counters: comments read vs sent, API units),
 * then exits 0. A bad configuration prints `{"ear":"error","message":"..."}` and exits 2.
 */
import { OAuth2Client } from 'google-auth-library';
import { HeadStreamClient } from './headStreamClient.js';
import { StreamEar } from './streamEar.js';
import { oauthTokenProvider } from './oauthTokenProvider.js';
import { YoutubeLiveApi, type TokenProvider } from './youtubeLiveApi.js';

function fail(message: string): never {
  process.stdout.write(`${JSON.stringify({ ear: 'error', message })}\n`);
  process.exit(2);
}

function number(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) fail(`${name} must be a positive number`);
  return value;
}

async function main(): Promise<void> {
  const url = process.env.SHANNON_CORE_PLATFORM_URL?.trim() ?? '';
  const token = process.env.SHANNON_CORE_PLATFORM_TOKEN?.trim() ?? '';
  if (!url || !token) fail('SHANNON_CORE_PLATFORM_URL and SHANNON_CORE_PLATFORM_TOKEN are required');
  try { new URL(url); } catch { fail('SHANNON_CORE_PLATFORM_URL is not a URL'); }

  let getAccessToken: TokenProvider;
  const fixed = process.env.YOUTUBE_ACCESS_TOKEN?.trim();
  if (fixed) {
    getAccessToken = async () => fixed;
  } else {
    const { YOUTUBE_CLIENT_ID: id, YOUTUBE_CLIENT_SECRET: secret, YOUTUBE_REFRESH_TOKEN: refresh } = process.env;
    if (!id || !secret || !refresh) fail('YOUTUBE_ACCESS_TOKEN, or YOUTUBE_CLIENT_ID + YOUTUBE_CLIENT_SECRET + YOUTUBE_REFRESH_TOKEN, is required');
    const client = new OAuth2Client(id, secret, 'http://localhost');
    client.setCredentials({ refresh_token: refresh });
    getAccessToken = oauthTokenProvider(client);
  }

  const youtube = new YoutubeLiveApi({ getAccessToken, ...(process.env.YOUTUBE_API_BASE?.trim() ? { baseUrl: process.env.YOUTUBE_API_BASE.trim() } : {}) });
  const head = new HeadStreamClient({ url, token, timeoutMs: number('EAR_HEAD_TIMEOUT_MS') ?? 5_000 });
  const stateEveryMs = number('EAR_STATE_EVERY_MS');
  const discoveryEveryMs = number('EAR_DISCOVERY_EVERY_MS');
  const minPollMs = number('EAR_MIN_POLL_MS');
  const maxPollMs = number('EAR_MAX_POLL_MS');
  const liveUrl = process.env.YOUTUBE_LIVE_URL?.trim();
  const channelId = process.env.YOUTUBE_CHANNEL_ID?.trim();
  const ear = new StreamEar({
    head,
    youtube,
    ...(liveUrl ? { liveUrl } : {}),
    ...(channelId ? { channelId } : {}),
    ...(stateEveryMs ? { stateEveryMs } : {}),
    ...(discoveryEveryMs ? { discoveryEveryMs } : {}),
    ...(minPollMs ? { minPollMs } : {}),
    ...(maxPollMs ? { maxPollMs } : {}),
  });

  const stop = async () => {
    await ear.stop();
    process.stdout.write(`${JSON.stringify({ ear: 'stopped', status: ear.status() })}\n`);
    process.exit(0);
  };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });

  ear.start();
  process.stdout.write(`${JSON.stringify({ ear: 'ready' })}\n`);
}

void main().catch(error => fail(error instanceof Error ? error.message : String(error)));
