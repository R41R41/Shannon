import dotenv from 'dotenv';

dotenv.config();

/**
 * Helper to read a required env var, throwing if missing.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Helper to read an optional env var with a default.
 */
function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/**
 * Centralized application configuration.
 *
 * All environment variables are read here and exported as a typed object.
 * Services should import `config` instead of reading `process.env` directly.
 */
export const config = {
  /** Whether the app is running in dev mode */
  isDev: process.argv.includes('--dev') || process.env.IS_DEV === 'True',

  /** OpenAI API key (required, used by all LLM-related services) */
  openaiApiKey: required('OPENAI_API_KEY'),

  /** MongoDB connection URI */
  mongodbUri: required('MONGODB_URI'),

  /** Main HTTP server port */
  port: optional('PORT', '5000'),

  discord: {
    token: optional('DISCORD_TOKEN', ''),
    guilds: {
      toyama: {
        guildId: optional('TOYAMA_GUILD_ID', ''),
        channelId: optional('TOYAMA_CHANNEL_ID', ''),
      },
      douki: {
        guildId: optional('DOUKI_GUILD_ID', ''),
        channelId: optional('DOUKI_CHANNEL_ID', ''),
      },
      colab: {
        guildId: optional('COLAB_GUILD_ID', ''),
        channelId: optional('COLAB_CHANNEL_ID', ''),
      },
      aimine: {
        guildId: optional('AIMINE_GUILD_ID', ''),
        xChannelId: optional('AIMINE_X_CHANNEL_ID', ''),
        announceChannelId: optional('AIMINE_ANNOUNCE_CHANNEL_ID', ''),
        updateChannelId: optional('AIMINE_UPDATE_CHANNEL_ID', ''),
      },
      test: {
        guildId: optional('TEST_GUILD_ID', ''),
        xChannelId: optional('TEST_X_CHANNEL_ID', ''),
      },
    },
  },

  minecraft: {
    baseDir: optional('MINECRAFT_BASE_DIR', '/home/azureuser/minecraft'),
    serverBasePath: optional('SERVER_BASE_PATH', ''),
    botUserName: optional('MINECRAFT_BOT_USER_NAME', ''),
    botPassword: optional('MINECRAFT_BOT_PASSWORD', ''),
    uiModHost: optional('UI_MOD_HOST', 'localhost'),
  },

  youtube: {
    channelId: optional('YOUTUBE_CHANNEL_ID', ''),
    authCode: optional('YOUTUBE_AUTH_CODE', ''),
    clientId: optional('YOUTUBE_CLIENT_ID', ''),
    clientSecret: optional('YOUTUBE_CLIENT_SECRET', ''),
    refreshToken: optional('YOUTUBE_REFRESH_TOKEN', ''),
    liveUrl: optional('YOUTUBE_LIVE_URL', ''),
  },

  twitter: {
    userId: optional('TWITTER_USER_ID', ''),
    email: optional('TWITTER_EMAIL', ''),
    password: optional('TWITTER_PASSWORD', ''),
    twoFaCode: optional('TWITTER_TWO_FA_CODE', ''),
    totpSecret: optional('TWITTER_TOTP_SECRET', ''),
    loginData: optional('TWITTER_LOGIN_DATA', ''),
    authSession: optional('TWITTER_AUTH_SESSION', ''),
    apiKey: optional('TWITTER_API_KEY', ''),
    apiKeySecret: optional('TWITTER_API_KEY_SECRET', ''),
    accessToken: optional('TWITTER_ACCESS_TOKEN', ''),
    accessTokenSecret: optional('TWITTER_ACCESS_TOKEN_SECRET', ''),
    proxy1: optional('TWITTER_PROXY1', ''),
    proxy2: optional('TWITTER_PROXY2', ''),
    proxy3: optional('TWITTER_PROXY3', ''),
    twitterApiIoKey: optional('TWITTERAPI_IO_API_KEY', ''),
    loginCookies: optional('TWITTER_LOGIN_COOKIES', ''),
    /** 返信確率 (0.0〜1.0) */
    replyProbability: parseFloat(optional('TWITTER_REPLY_PROBABILITY', '0.3')),
    /** ポーリング間隔 (ミリ秒) */
    monitorIntervalMs: parseInt(optional('TWITTER_MONITOR_INTERVAL_MS', '1800000'), 10),
    /** 自動投稿: 1日あたりの最小投稿数 */
    minAutoPostsPerDay: parseInt(optional('TWITTER_MIN_AUTO_POSTS_PER_DAY', '8'), 10),
    /** 自動投稿: 1日あたりの最大投稿数 */
    maxAutoPostsPerDay: parseInt(optional('TWITTER_MAX_AUTO_POSTS_PER_DAY', '12'), 10),
    /** 自動投稿: 活動開始時間 (JST, 0-23) */
    autoPostStartHour: parseInt(optional('TWITTER_AUTO_POST_START_HOUR', '6'), 10),
    /** 自動投稿: 活動終了時間 (JST, 0-24) */
    autoPostEndHour: parseInt(optional('TWITTER_AUTO_POST_END_HOUR', '24'), 10),
    /** Webhook: コールバック URL のベース (例: https://sh4nnon.com) */
    webhookBaseUrl: optional('TWITTER_WEBHOOK_BASE_URL', ''),
    /** Webhook: チェック間隔秒 (デフォルト 100) */
    webhookInterval: parseInt(optional('TWITTER_WEBHOOK_INTERVAL', '100'), 10),
    /** 1日あたりの最大返信数 (Webhook + ポーリング合計) */
    maxRepliesPerDay: parseInt(optional('TWITTER_MAX_REPLIES_PER_DAY', '20'), 10),
    /** Twitter ユーザー名 (Webhook フィルタ用) */
    userName: optional('TWITTER_USER_NAME', ''),
    usernames: {
      aiminelab: optional('TWITTER_AIMINELAB_USERNAME', ''),
      yummy: optional('TWITTER_YUMMY_USERNAME', ''),
      rai: optional('TWITTER_RAI_USERNAME', ''),
      guriko: optional('TWITTER_GURIKO_USERNAME', ''),
    },
  },

  notion: {
    apiKey: optional('NOTION_API_KEY', ''),
  },

  google: {
    apiKey: optional('GOOGLE_API_KEY', ''),
    geminiApiKey: optional('GEMINI_API_KEY', optional('GOOGLE_API_KEY', '')),
    searchEngineId: optional('SEARCH_ENGINE_ID', ''),
  },

  wolframAlpha: {
    appId: optional('WOLFRAM_ALPHA_APPID', ''),
  },

  anthropic: {
    apiKey: optional('ANTHROPIC_API_KEY', ''),
  },

  groq: {
    apiKey: optional('GROQ_API_KEY', ''),
  },

  langfuse: {
    secretKey: optional('LANGFUSE_SECRET_KEY', ''),
    publicKey: optional('LANGFUSE_PUBLIC_KEY', ''),
    baseUrl: optional('LANGFUSE_BASE_URL', 'https://cloud.langfuse.com'),
  },

  voicepeak: {
    serverUrl: optional('VOICEPEAK_SERVER_URL', 'http://localhost:8090'),
    narrator: optional('VOICEPEAK_NARRATOR', 'Japanese Female4'),
  },

  /** バックグラウンド自己改善（Tier 2 コード適用など） */
  selfImprove: {
    /**
     * Tier 2 が検証に通ったら対象ファイルへ即書き込み。
     * false のときは従来どおり履歴に pending_review のみ。
     */
    autoApplyTier2:
      process.env.SELF_IMPROVE_AUTO_APPLY_TIER2 === 'true'
      || (process.argv.includes('--dev') || process.env.IS_DEV === 'True'),
    /** true のときのみ Tier 2 の delete を実行（危険・本番では使わない想定） */
    allowTier2Delete: process.env.SELF_IMPROVE_ALLOW_DELETE === 'true',

    /**
     * 夜間バッチ: 指定 UTC 時刻のウィンドウ内で1日1回レポート保存（既定は LLM 呼び出しなし＝課金ほぼゼロ）。
     * 高コスト処理はいずれも明示 opt-in。
     */
    nightly: {
      enabled: process.env.SELF_IMPROVE_NIGHTLY_ENABLED === 'true',
      hourUtc: Math.min(23, Math.max(0, parseInt(optional('SELF_IMPROVE_NIGHTLY_HOUR_UTC', '3'), 10))),
      minuteUtc: Math.min(59, Math.max(0, parseInt(optional('SELF_IMPROVE_NIGHTLY_MINUTE_UTC', '0'), 10))),
      windowMinutes: Math.min(120, Math.max(1, parseInt(optional('SELF_IMPROVE_NIGHTLY_WINDOW_MINUTES', '15'), 10))),
      minecraftSuites: optional('SELF_IMPROVE_NIGHTLY_MINECRAFT_SUITES', '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
      /** SkillPatcher 等で LLM 消費。既定オフ */
      minecraftAutoFix: process.env.SELF_IMPROVE_NIGHTLY_MINECRAFT_AUTOFIX === 'true',
      /** true のときのみ。Analyzer/Generator で OpenAI 等を複数回消費 */
      runReactiveImprovement: process.env.SELF_IMPROVE_NIGHTLY_RUN_REACTIVE === 'true',
      /** Anthropic 必須・高コスト。既定オフ */
      codeAgentEnabled: process.env.SELF_IMPROVE_NIGHTLY_CODE_AGENT === 'true',
      codeAgentMaxIter: Math.min(25, Math.max(1, parseInt(optional('SELF_IMPROVE_NIGHTLY_CODE_AGENT_MAX_ITER', '8'), 10))),
      codeAgentDescription: optional(
        'SELF_IMPROVE_NIGHTLY_CODE_AGENT_TASK',
        '夜間メンテナンス: backend の Shannon コード（cognitive/selfImprove, minebot を優先）を棚卸しする。mutableCodePolicy で許可されたパスのみ、明らかなバグ・型不整合を最小差分で修正し run_tsc で成功を確認する。不確実な大規模リファクタは禁止。finish で要約する。',
      ),
      /** Discord Incoming Webhook 等（任意） */
      morningWebhookUrl: optional('SELF_IMPROVE_MORNING_WEBHOOK_URL', ''),
    },
  },

  /** Routine (System 1) 自動生成 */
  routines: {
    autoGenerateEnabled:
      process.env.ROUTINE_AUTO_GENERATE_ENABLED === 'true' ||
      (process.env.IS_DEV === 'true' && process.env.ROUTINE_AUTO_GENERATE_ENABLED !== 'false'),
    /** パターンがルーチン候補になるための最小出現回数 */
    minOccurrences: Math.max(2, parseInt(optional('ROUTINE_MIN_OCCURRENCES', '3'), 10)),
    /** 自動生成のクールダウン (ms) */
    cooldownMs: parseInt(optional('ROUTINE_COOLDOWN_MS', String(30 * 60 * 1000)), 10),
  },

  ports: {
    http: optional('HTTP_PORT', '5000'),
    frontend: optional('FRONTEND_PORT', '5000'),
    ws: {
      openai: optional('WS_OPENAI_PORT', '5010'),
      voice: optional('WS_VOICE_PORT', '5020'),
      minecraft: optional('WS_MINECRAFT_PORT', '5030'),
      monitoring: optional('WS_MONITORING_PORT', '5011'),
      schedule: optional('WS_SCHEDULE_PORT', '5018'),
      status: optional('WS_STATUS_PORT', '5013'),
      planning: optional('WS_PLANNING_PORT', '5019'),
      emotion: optional('WS_EMOTION_PORT', '5020'),
      skill: optional('WS_SKILL_PORT', '5016'),
      auth: optional('WS_AUTH_PORT', '5017'),
    },
  },
} as const;

export type AppConfig = typeof config;
