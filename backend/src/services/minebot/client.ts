import {
  MinebotInput,
  MinebotStartOrStopInput,
  ServiceInput,
  ServiceOutput,
} from '@shannon/common';
import pkg from 'minecrafthawkeye';
import mineflayer from 'mineflayer';
import { plugin as cmd } from 'mineflayer-cmd';
import { plugin as collectBlock } from 'mineflayer-collectblock';
import { pathfinder } from 'mineflayer-pathfinder';
import { plugin as projectile } from 'mineflayer-projectile';
import { plugin as pvp } from 'mineflayer-pvp';
import { plugin as toolPlugin } from 'mineflayer-tool';
import { BaseClient } from '../common/BaseClient.js';
import { getEventBus } from '../eventBus/index.js';
import { CONFIG } from './config/MinebotConfig.js';
import { SkillAgent } from './skillAgent.js';
import { ConstantSkills, CustomBot, InstantSkills } from './types.js';
import { Utils } from './utils/index.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Minebot:Client');

// 環境変数の検証
CONFIG.validateEnvironment();

/** chat_validation_failed で kick された場合に自動再接続するまでのディレイ（ms） */
const AUTO_RECONNECT_DELAY_MS = 8_000;
const CHAT_VALIDATION_FAILED = 'chat_validation_failed';

export class MinebotClient extends BaseClient {
  private bot: CustomBot | null = null;
  public isDev: boolean = false;
  private static instance: MinebotClient;
  private skillAgent: SkillAgent | null = null;
  private unsubscribeFunctions: (() => void)[] = [];
  /** 直前の接続パラメータ（自動再接続用） */
  private lastBotData: MinebotInput | null = null;
  private autoReconnecting = false;

  constructor(serviceName: 'minebot', isDev: boolean) {
    const eventBus = getEventBus();
    super(serviceName, eventBus);
  }

  public static getInstance(isDev: boolean = false) {
    const eventBus = getEventBus();
    if (!MinebotClient.instance) {
      MinebotClient.instance = new MinebotClient('minebot', isDev);
    }
    MinebotClient.instance.isDev = isDev;
    return MinebotClient.instance;
  }

  private async setUpBot(data: MinebotInput) {
    const username = CONFIG.MINECRAFT_BOT_USER_NAME;
    const password = CONFIG.MINECRAFT_BOT_PASSWORD;

    const { serverName } = data as MinebotStartOrStopInput;
    const port = CONFIG.MINECRAFT_SERVERS[serverName as string];
    const version = serverName?.split('-')[0];

    if (!port) {
      throw new Error(`Unknown server: ${serverName}`);
    }

    log.info(`🔌 ${serverName} (host:${CONFIG.MINECRAFT_HOST}, port:${port}, v${version}) に接続します`, 'cyan');

    this.bot = mineflayer.createBot({
      host: CONFIG.MINECRAFT_HOST,
      port,
      username,
      auth: 'microsoft',
      version,
      checkTimeoutInterval: CONFIG.CHECK_TIMEOUT_INTERVAL,
      skipValidation: true,
    }) as CustomBot;

    this.bot.loadPlugin(pathfinder);
    this.bot.loadPlugin(collectBlock);
    this.bot.loadPlugin(projectile);
    this.bot.loadPlugin(pvp);
    this.bot.loadPlugin(toolPlugin);
    cmd.allowConsoleInput = true;
    this.bot.loadPlugin(cmd);
    const minecraftHawkEye = pkg.default;
    try {
      this.bot.loadPlugin(minecraftHawkEye);
    } catch (error) {
      log.error('HawkEye plugin load failed', error);
    }

    this.bot.on('login', async () => {
      log.info('✅ Bot has logged in.');
      this.eventBus.log('minecraft', 'green', 'Bot has logged in.');
    });

    this.bot.on('kicked', (reason: any) => {
      let readableReason: string;
      if (typeof reason === 'string') {
        try {
          const parsed = JSON.parse(reason);
          readableReason = parsed.text ?? parsed.translate ?? JSON.stringify(parsed);
        } catch { readableReason = reason; }
      } else if (reason && typeof reason === 'object') {
        readableReason = reason.text ?? reason.translate ?? JSON.stringify(reason);
      } else {
        readableReason = String(reason);
      }
      log.error(`🚫🚫🚫 BOT KICKED 🚫🚫🚫 reason: ${readableReason}`);
      this.eventBus.log('minecraft', 'red', `Bot was kicked: ${readableReason}`);

      if (readableReason.includes(CHAT_VALIDATION_FAILED)) {
        log.warn(`🔄 chat_validation_failed による kick → ${AUTO_RECONNECT_DELAY_MS / 1000}秒後に自動再接続します`);
        this.scheduleAutoReconnect();
      }
    });

    this.bot.on('end', (reason: string) => {
      const trace = new Error('disconnect trace').stack;
      log.error(`🔌🔌🔌 BOT DISCONNECTED 🔌🔌🔌 reason: "${reason ?? 'unknown'}" | trace: ${trace}`);
      this.eventBus.log('minecraft', 'red', `Bot disconnected: ${reason ?? 'unknown'}`);
    });

    this.bot.on('error', (err: Error) => {
      log.error(`❌❌❌ BOT ERROR ❌❌❌ ${err.message}`, err);
      this.eventBus.log('minecraft', 'red', `Bot error: ${err.message}`);
    });

    (this.bot as any)._client?.on('end', (reason: string) => {
      log.error(`🔌 [protocol-level] _client end: "${reason ?? 'unknown'}"`);
    });

    (this.bot as any)._client?.on('error', (err: Error) => {
      log.error(`❌ [protocol-level] _client error: ${err.message}`, err);
    });

    this.bot.isTest = CONFIG.IS_DEV;
    this.bot.chatMode = true;
    this.bot.connectedServerName = serverName as string;
    CONFIG.setCurrentUiModBaseUrl(serverName as string);
    log.info(`🌐 UI Mod BaseURL: ${CONFIG.UI_MOD_BASE_URL}`);
    this.bot.attackEntity = null;
    this.bot.runFromEntity = null;
    this.bot.goal = null;
    this.bot.interruptExecution = false;
    this.bot.instantSkills = new InstantSkills();
    this.bot.constantSkills = new ConstantSkills();
    this.bot.utils = new Utils(this.bot);
    this.bot.selfState = {
      botPosition: null,
      botHealth: '20/20',
      botFoodLevel: '20/20',
      botExperienceLevel: 0,
      botTotalExperience: 0,
      botExperienceBarProgress: 0,
      botHeldItem: '',
      lookingAt: null,
      inventory: [],
    };
    this.bot.environmentState = {
      senderName: '',
      senderPosition: null,
      weather: '',
      time: '',
      biome: '',
      dimension: null,
      bossbar: null,
    };
    this.bot.activeFurnaces = [];
    await new Promise((resolve) => setTimeout(resolve, 1000));
    this.bot.utils.setMovements(
      this.bot,
      true,
      true,
      true,
      true,
      true,
      true,
      1,
      true
    );

    this.bot.on('respawn', () => {
      if (!this.bot) {
        throw new Error('Botが初期化されていません');
      }
      this.bot.attackEntity = null;
      this.bot.runFromEntity = null;
      this.bot.goal = null;
      this.eventBus.log('minecraft', 'green', 'Bot has respawned.');
    });

    this.skillAgent = new SkillAgent(this.bot, this.eventBus);
    const result = await this.skillAgent.startAgent();
    if (!result.success) {
      this.eventBus.log(
        'minecraft',
        'red',
        `Skill agent failed to start: ${result.result}`
      );
      throw new Error(`Skill agent failed to start: ${result.result}`);
    }

    process.on('uncaughtException', (error) => {
      this.eventBus.log(
        'minecraft',
        'red',
        `未処理の例外が発生しました: ${error.message}`
      );
    });

    process.on('unhandledRejection', (reason: unknown, promise) => {
      const error =
        reason instanceof Error ? reason : new Error(String(reason));
      this.eventBus.log(
        'minecraft',
        'red',
        `未処理のPromise拒否が発生しました: ${error.message}`
      );
    });

    this.bot.on('spawn', () => {
      this.eventBus.log('minecraft', 'green', 'Minecraft bot spawned');
      // Discord等にspawn完了を通知
      this.eventBus.publish({
        type: 'minebot:spawned',
        memoryZone: 'minebot',
        data: { success: true },
      });
    });
  }

  private getStatus() {
    if (!this.bot) {
      return 'stopped';
    }
    return 'running';
  }

  public async initialize() {
    await this.setupEventBus();
  }

  private async setupEventBus() {
    // 既存のsubscribeを解除
    this.unsubscribeFunctions.forEach(unsubscribe => unsubscribe());
    this.unsubscribeFunctions = [];

    // 新しいsubscribeを追加
    const unsubscribe1 = this.eventBus.subscribe('minebot:status', async (event) => {
      const { serviceCommand } = event.data as ServiceInput;
      if (serviceCommand === 'start') {
        await this.start();
      } else if (serviceCommand === 'stop') {
        await this.stop();
      } else if (serviceCommand === 'status') {
        this.eventBus.publish({
          type: 'web:status',
          memoryZone: 'web',
          data: {
            service: 'minebot',
            status: this.status,
          },
        });
      }
    });
    this.unsubscribeFunctions.push(unsubscribe1);

    const unsubscribe2 = this.eventBus.subscribe('minebot:bot:status', async (event) => {
      if (this.status !== 'running') return;
      const { serviceCommand } = event.data as ServiceInput;
      if (serviceCommand === 'start') {
        const result = await this.startBot(event.data as MinebotInput);
        if (!result) return;
        const status = this.getStatus();
        this.eventBus.publish({
          type: `web:status`,
          memoryZone: 'web',
          data: {
            service: `minebot:bot`,
            status: status,
          } as ServiceOutput,
        });
      } else if (serviceCommand === 'stop') {
        const result = await this.stopBot(event.data as MinebotInput);
        if (!result) return;
        const status = this.getStatus();
        this.eventBus.publish({
          type: `web:status`,
          memoryZone: 'web',
          data: {
            service: `minebot:bot`,
            status: status,
          } as ServiceOutput,
        });
      } else if (serviceCommand === 'status') {
        const status = this.getStatus();
        this.eventBus.publish({
          type: 'web:status',
          memoryZone: 'web',
          data: {
            service: 'minebot:bot',
            status: status,
          } as ServiceOutput,
        });
      }
    });
    this.unsubscribeFunctions.push(unsubscribe2);
  }

  /**
   * chat_validation_failed で kick された後、自動でボットを再接続する。
   * mineflayer #3838: 累積21通でチャット署名チェーンが壊れるバグの回避策。
   */
  private scheduleAutoReconnect(): void {
    if (this.autoReconnecting || !this.lastBotData) return;
    this.autoReconnecting = true;
    setTimeout(async () => {
      try {
        log.info('🔄 自動再接続を開始します…');
        // 既存ボットをクリーンアップ
        try { await this.stopBot(this.lastBotData!); } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, 2_000));
        const ok = await this.startBot(this.lastBotData!);
        if (ok) {
          log.info('✅ 自動再接続に成功しました');
          this.eventBus.log('minecraft', 'green', 'Auto-reconnected after chat_validation_failed');
        } else {
          log.error('❌ 自動再接続に失敗しました');
        }
      } catch (e) {
        log.error('❌ 自動再接続エラー', e);
      } finally {
        this.autoReconnecting = false;
      }
    }, AUTO_RECONNECT_DELAY_MS);
  }

  private async startBot(data: MinebotInput) {
    try {
      this.lastBotData = data;
      await this.setUpBot(data);
      this.eventBus.log('minecraft', 'green', 'Minecraft bot started');
      return true;
    } catch (error) {
      this.eventBus.log(
        'minecraft',
        'red',
        `Botの起動に失敗しました: ${error}`
      );
      // Discord等にエラーを通知
      this.eventBus.publish({
        type: 'minebot:error',
        memoryZone: 'minebot',
        data: { message: `${error}` },
      });
      return false;
    }
  }

  private async stopBot(data: MinebotInput) {
    try {
      if (!this.bot) {
        throw new Error('Botが初期化されていません');
      }
      // port 8082を開放
      if (this.skillAgent) {
        const httpServer = this.skillAgent.getHttpServer();
        await httpServer.stop();
      }
      log.info('🛑 Bot.quit() を明示的に呼び出します（ユーザー操作による停止）');
      this.bot.quit();
      if (this.skillAgent?.getTaskRuntime()) {
        this.skillAgent.getTaskRuntime()?.forceStop();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      this.skillAgent = null;
      this.bot = null;
      this.eventBus.log('minecraft', 'green', 'Minecraft bot stopped');
      // Discord等にstop完了を通知
      this.eventBus.publish({
        type: 'minebot:stopped',
        memoryZone: 'minebot',
        data: { success: true },
      });
      return true;
    } catch (error) {
      this.eventBus.log(
        'minecraft',
        'red',
        `Botの停止に失敗しました: ${error}`
      );
      return false;
    }
  }
}
