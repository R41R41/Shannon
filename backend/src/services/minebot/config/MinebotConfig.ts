import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../../../config/env.js';
import { models } from '../../../config/models.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:Config');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Minebot設定の一元管理クラス
 * 全ての設定値を1箇所で管理し、変更を容易にする
 */
export class MinebotConfig {
  // ===== LLM設定 =====

  /** Execution用モデル */
  readonly EXECUTION_MODEL = models.minebot.execution;

  /** Planning時の温度パラメータ（創造性重視） */
  readonly TEMPERATURE_PLANNING = 1.0;

  /** Execution時の温度パラメータ（確実性重視） */
  readonly TEMPERATURE_EXECUTION = 0.1;

  /** スキル実行のデフォルトタイムアウト（ミリ秒）。0 = 無制限 */
  readonly SKILL_TIMEOUT_MS = 120_000;

  // ===== サーバー設定 =====

  /** MinebotのAPIサーバーポート（環境変数で上書き可能） */
  readonly MINEBOT_API_PORT = parseInt(process.env.MINEBOT_API_PORT || '8092', 10);

  /** UI Modのサーバーポート */
  readonly UI_MOD_PORT = 8091;

  /** UI Mod クライアントサイドHTTPサーバーのポート（スクリーンショット用） */
  readonly UI_MOD_CLIENT_PORT = 8093;

  /** UI Modのサーバーホスト */
  readonly UI_MOD_HOST = config.minecraft.uiModHost;

  /** サーバー名ごとのUI Mod HTTPサーバーポートマッピング */
  readonly MINECRAFT_UI_MOD_PORTS: Record<string, number> = {
    '1.21.4-test': 8081,
    '1.19.0-youtube': 8081,
    '1.21.1-play': 8081,
    '1.21.4-fabric-youtube': 8081,
    '1.21.11-fabric-youtube': 8081,
    '1.21.11-fabric-test': 8085,
  };

  /** 指定サーバーのUI Mod HTTPポートを取得 */
  getUiModPort(serverName: string): number {
    return this.MINECRAFT_UI_MOD_PORTS[serverName] ?? this.UI_MOD_PORT;
  }

  /** 指定サーバーのUI ModサーバーのベースURLを取得 */
  getUiModBaseUrl(serverName: string): string {
    return `http://${this.UI_MOD_HOST}:${this.getUiModPort(serverName)}`;
  }

  /** 現在接続中のサーバーのUI Mod BaseURL（接続時に更新される） */
  private _currentUiModBaseUrl: string = `http://${config.minecraft.uiModHost}:8081`;

  /** 現在のUI ModサーバーURLを設定（ボット接続時に呼び出す） */
  setCurrentUiModBaseUrl(serverName: string): void {
    this._currentUiModBaseUrl = this.getUiModBaseUrl(serverName);
  }

  /** 現在接続中サーバーのUI ModサーバーのベースURL */
  get UI_MOD_BASE_URL(): string {
    return this._currentUiModBaseUrl;
  }

  /** UI Mod クライアントサーバーのベースURL（スクリーンショット用） */
  get UI_MOD_CLIENT_BASE_URL(): string {
    return `http://${this.UI_MOD_HOST}:${this.UI_MOD_CLIENT_PORT}`;
  }

  // ===== パス設定 =====

  /** プロンプトディレクトリ */
  readonly PROMPTS_DIR = join(__dirname, '../../../../saves/prompts');

  /** InstantSkillsディレクトリ */
  readonly INSTANT_SKILLS_DIR = join(__dirname, '../instantSkills');

  /** ConstantSkillsディレクトリ */
  readonly CONSTANT_SKILLS_DIR = join(__dirname, '../constantSkills');

  /** ConstantSkills状態保存JSON */
  readonly CONSTANT_SKILLS_JSON = join(
    __dirname,
    '../../../../saves/minecraft/constantSkills.json'
  );

  // ===== タスク設定 =====

  /** Function Calling モードを使用するか（true: 新方式, false: 旧LangGraph方式） */
  readonly USE_FUNCTION_CALLING = true;

  /** 最大リトライ回数 */
  readonly MAX_RETRY_COUNT = 10;

  /** タスクタイムアウト（ミリ秒） */
  readonly TASK_TIMEOUT = 10000;

  /** タスクキューの最大サイズ */
  readonly MAX_QUEUE_SIZE = 10;

  /** LangGraphの再帰制限 */
  readonly LANGGRAPH_RECURSION_LIMIT = 64;

  // ===== ログ設定 =====

  /** 保持する最大ログ数 */
  readonly MAX_LOGS = 200;

  /** プロンプトに含める最新メッセージ数 */
  readonly MAX_RECENT_MESSAGES = 5; // 8→5に削減（最新の結果だけで十分）

  /** エラーメッセージの最大保持数 */
  readonly MAX_ERROR_MESSAGES = 5;

  // ===== Minecraft接続設定 =====

  /** Minecraftサーバーのベースディレクトリ */
  readonly MINECRAFT_BASE_DIR = config.minecraft.baseDir;

  /** サーバー名とポートのマッピング */
  readonly MINECRAFT_SERVERS: Record<string, number> = {
    '1.21.4-test': 25566,
    '1.19.0-youtube': 25564,
    '1.21.1-play': 25565,
    '1.21.4-fabric-youtube': 25566,
    '1.21.11-fabric-youtube': 25566,
    '1.21.11-fabric-test': 25567,
  };

  /** チェックタイムアウト間隔（ミリ秒） - サーバーのKeep-Alive応答用 */
  readonly CHECK_TIMEOUT_INTERVAL = 30 * 1000; // 30秒（サーバーのデフォルトタイムアウトに合わせる）

  // ===== Discord → Minecraft ユーザー名マッピング =====
  // key: Discord の getUserNickname() で返される名前（小文字）
  // value: Minecraft のプレイヤー名
  readonly DISCORD_TO_MINECRAFT_NAMES: Record<string, string> = {
    'ライ': 'Rai1241',
    'らい博士': 'Rai1241',
    'ryo07010': 'Rai1241',
    'ヤミー': 'yummy34',
    'yummy3434': 'yummy34',
    'グリコ': 'guriko8670',
    '12357': 'guriko8670',
  };

  resolveMinecraftName(discordName: string): string {
    return this.DISCORD_TO_MINECRAFT_NAMES[discordName] ?? discordName;
  }

  /** Minecraft 名 → Discord 名の逆引き（全候補を返す） */
  resolveDiscordNames(mcName: string): string[] {
    const names: string[] = [];
    for (const [discordName, minecraft] of Object.entries(this.DISCORD_TO_MINECRAFT_NAMES)) {
      if (minecraft === mcName) names.push(discordName);
    }
    return names;
  }

  // ===== Minecraft名 → 表示名（LLM向け） =====
  readonly MINECRAFT_TO_DISPLAY_NAMES: Record<string, string> = {
    'Rai1241': 'ライ',
    'yummy34': 'ヤミー',
    'guriko8670': 'グリコ',
  };

  resolveDisplayName(mcName: string): string {
    return this.MINECRAFT_TO_DISPLAY_NAMES[mcName] ?? mcName;
  }

  // ===== 定期実行間隔 =====

  /** 100ms間隔タスク */
  readonly INTERVAL_100MS = 100;

  /** 1秒間隔タスク */
  readonly INTERVAL_1000MS = 1000;

  /** 5秒間隔タスク */
  readonly INTERVAL_5000MS = 5000;

  // ===== UI送信設定 =====

  /** UI Modに送信するログ数 */
  readonly UI_LOG_COUNT = 50;

  /** UI Modに送信する最新ログ数 */
  readonly UI_RECENT_LOG_COUNT = 100;

  // ===== エラー処理設定 =====

  /** エラー判定キーワード */
  readonly ERROR_KEYWORDS = ['エラー', '失敗', 'スキップ', 'error', 'failed'];

  // ===== 環境変数の取得とバリデーション =====

  /** OpenAI API Key */
  get OPENAI_API_KEY(): string {
    return config.openaiApiKey;
  }

  /** Minecraft Bot Username */
  get MINECRAFT_BOT_USER_NAME(): string {
    return config.minecraft.botUserName;
  }

  /** Minecraft Bot Password */
  get MINECRAFT_BOT_PASSWORD(): string {
    return config.minecraft.botPassword;
  }

  /** 開発モードかどうか */
  get IS_DEV(): boolean {
    return config.isDev;
  }

  /**
   * 環境変数の検証
   * アプリケーション起動時に呼び出して、必要な環境変数が設定されているか確認
   */
  validateEnvironment(): void {
    const missingVars: string[] = [];

    try {
      this.OPENAI_API_KEY;
    } catch {
      missingVars.push('OPENAI_API_KEY');
    }

    try {
      this.MINECRAFT_BOT_USER_NAME;
    } catch {
      missingVars.push('MINECRAFT_BOT_USER_NAME');
    }

    try {
      this.MINECRAFT_BOT_PASSWORD;
    } catch {
      missingVars.push('MINECRAFT_BOT_PASSWORD');
    }

    if (missingVars.length > 0) {
      const error = new Error(
        `Missing required environment variables: ${missingVars.join(', ')}`
      );
      log.error(`❌ Environment validation failed: ${error.message}`);
      throw error;
    }

    log.success('✅ All required environment variables are set');
  }

  /**
   * 設定値のサマリーを表示（デバッグ用）
   */
  logConfiguration(): void {
    log.info(
      `📋 Minebot Configuration: ` +
      `LLM=[Exec:${this.EXECUTION_MODEL}] ` +
      `Ports=[API:${this.MINEBOT_API_PORT}, UI:${this.UI_MOD_PORT}] ` +
      `Task=[retry:${this.MAX_RETRY_COUNT}, timeout:${this.TASK_TIMEOUT}ms, queue:${this.MAX_QUEUE_SIZE}] ` +
      `Dev=${this.IS_DEV}`
    );
  }
}

// シングルトンインスタンスをエクスポート
export const CONFIG = new MinebotConfig();
