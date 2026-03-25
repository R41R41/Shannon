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

export class MinebotClient extends BaseClient {
  private bot: CustomBot | null = null;
  public isDev: boolean = false;
  private static instance: MinebotClient;
  private skillAgent: SkillAgent | null = null;
  private unsubscribeFunctions: (() => void)[] = [];

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

    log.info(`🔌 ${serverName} (port:${port}, v${version}) に接続します`, 'cyan');

    this.bot = mineflayer.createBot({
      host: '127.0.0.1',
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
      this.eventBus.log('minecraft', 'green', 'Bot has logged in.');
    });

    // タイムアウト・切断のログ
    this.bot.on('kicked', (reason: string) => {
      log.error(`🚫 Bot was kicked: ${reason}`);
      this.eventBus.log('minecraft', 'red', `Bot was kicked: ${reason}`);
    });

    this.bot.on('end', (reason: string) => {
      log.error(`🔌 Bot disconnected: ${reason}`);
      this.eventBus.log('minecraft', 'red', `Bot disconnected: ${reason}`);
    });

    this.bot.on('error', (err: Error) => {
      log.error(`❌ Bot error: ${err.message}`, err);
      this.eventBus.log('minecraft', 'red', `Bot error: ${err.message}`);
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

  private async startBot(data: MinebotInput) {
    try {
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
