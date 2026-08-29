import {
  MinecraftServerName,
  ServiceInput,
  ServiceOutput,
  ServiceStatus
} from '@shannon/common';
import { exec } from 'child_process';
import dotenv from 'dotenv';
import { promisify } from 'util';
import { BaseClient } from '../common/BaseClient.js';
import { config } from '../../config/env.js';
import { getEventBus } from '../eventBus/index.js';
import { emitWebServiceStatus } from '../web/webNotificationHub.js';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

// サーバー名とtmuxセッション名のマッピング
const SERVER_TMUX_SESSIONS: Record<string, string> = {
  '1.21.4-fabric-youtube': 'minecraft-youtube',
  '1.21.4-test': 'minecraft-test',
  '1.19.0-youtube': 'minecraft-youtube-old',
  '1.21.1-play': 'minecraft-play',
  '1.21.11-fabric-test': 'minecraft-test-12111',
};

// start.sh に渡す追加引数のマッピング（ワールド名など）
const SERVER_START_ARGS: Record<string, string> = {
  '1.21.11-fabric-test': 'world_test',
};

export class MinecraftClient extends BaseClient {
  private static instance: MinecraftClient;
  private minecraftClients: MinecraftClient[];
  private serverStatuses: Map<string, boolean> = new Map();
  private readonly VALID_SERVERS: MinecraftServerName[] = [
    '1.21.4-fabric-youtube',
    '1.21.4-test',
    '1.19.0-youtube',
    '1.21.1-play',
    '1.21.11-fabric-test',
  ];
  private readonly SERVER_BASE_PATH = config.minecraft.serverBasePath;
  public isDev: boolean = false;

  public static getInstance(isDev: boolean = false) {
    const eventBus = getEventBus();
    if (!MinecraftClient.instance) {
      MinecraftClient.instance = new MinecraftClient('minecraft', isDev);
    }
    MinecraftClient.instance.isDev = isDev;
    return MinecraftClient.instance;
  }

  constructor(serviceName: 'minecraft', isDev: boolean) {
    const eventBus = getEventBus();
    super(serviceName, eventBus);
    this.minecraftClients = [];
  }

  public async initialize() {
    await this.setupEventBus();
  }

  public async startServer(
    serverName: MinecraftServerName
  ): Promise<{ success: boolean; message: string }> {
    // 現在のステータスを確認
    const currentStatus = await this.getServerStatus(serverName);
    if (currentStatus === 'running') {
      return { success: false, message: 'サーバーは既に起動しています' };
    }

    try {
      const serverPath = `${this.SERVER_BASE_PATH}/${serverName}`;
      const startArgs = SERVER_START_ARGS[serverName] || '';
      logger.info(`Starting server at ${serverPath}`);
      await execAsync(`cd ${serverPath} && ./start.sh ${startArgs}`);
      this.serverStatuses.set(serverName, true);
      return { success: true, message: `${serverName}を起動しました` };
    } catch (error: any) {
      return {
        success: false,
        message: `サーバー起動エラー: ${error.message}`,
      };
    }
  }

  public async stopServer(
    serverName: MinecraftServerName
  ): Promise<{ success: boolean; message: string }> {
    // 現在のステータスを確認
    const currentStatus = await this.getServerStatus(serverName);
    if (currentStatus === 'stopped') {
      return { success: false, message: 'サーバーは既に停止しています' };
    }
    try {
      const serverPath = `${this.SERVER_BASE_PATH}/${serverName}`;
      // stop.shがあれば使用、なければtmuxでstopコマンド送信
      try {
        await execAsync(`cd ${serverPath} && ./stop.sh`);
      } catch {
        // stop.shがない場合はtmuxでstopコマンドを送信
        const tmuxSession = SERVER_TMUX_SESSIONS[serverName];
        if (tmuxSession) {
          await execAsync(`tmux send-keys -t ${tmuxSession} "stop" Enter`);
          // 停止を待つ
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
      this.serverStatuses.set(serverName, false);
      return { success: true, message: `${serverName}を停止しました` };
    } catch (error: any) {
      return {
        success: false,
        message: `サーバー停止エラー: ${error.message}`,
      };
    }
  }

  public async getServerStatus(
    serverName: MinecraftServerName
  ): Promise<ServiceStatus> {
    try {
      // tmuxセッションを確認
      const tmuxSession = SERVER_TMUX_SESSIONS[serverName];
      if (tmuxSession) {
        const { stdout } = await execAsync('tmux list-sessions 2>/dev/null || true');
        const isRunning = stdout.includes(tmuxSession);
        this.serverStatuses.set(serverName, isRunning);
        return isRunning ? 'running' : 'stopped';
      }
      // フォールバック: screenを確認
      const { stdout } = await execAsync('screen -ls');
      const isRunning = stdout.includes(serverName.split('-')[1]);
      this.serverStatuses.set(serverName, isRunning);
      return isRunning ? 'running' : 'stopped';
    } catch (error) {
      // コマンドが失敗した場合は停止中と判断
      this.serverStatuses.set(serverName, false);
      return 'stopped';
    }
  }

  public async getAllServerStatus(): Promise<
    {
      serverName: MinecraftServerName;
      status: boolean;
    }[]
  > {
    const statuses: { serverName: MinecraftServerName; status: boolean }[] = [];
    try {
      const { stdout } = await execAsync('screen -ls');
      for (const server of this.VALID_SERVERS) {
        const screenName = server.split('-')[1];
        const isRunning = stdout.includes(screenName);
        this.serverStatuses.set(server, isRunning);
        statuses.push({ serverName: server, status: isRunning });
      }
    } catch (error) {
      // screen -ls が失敗した場合は全て停止中と判断
      for (const server of this.VALID_SERVERS) {
        this.serverStatuses.set(server, false);
        statuses.push({ serverName: server, status: false });
      }
    }
    return statuses;
  }

  private async setupEventBus() {
    this.eventBus.subscribe('minecraft:status', async (event) => {
      const { serviceCommand } = event.data as ServiceInput;
      if (serviceCommand === 'start') {
        await this.start();
      } else if (serviceCommand === 'stop') {
        await this.stop();
      } else if (serviceCommand === 'status') {
        emitWebServiceStatus({
          service: 'minecraft',
          status: this.status,
        });
      }
    });
    // サーバー管理用のイベントハンドラを設定
    for (const server of this.VALID_SERVERS) {
      this.eventBus.subscribe(`minecraft:${server}:status`, async (event) => {
        if (this.status !== 'running') return;
        const { serviceCommand } = event.data as ServiceInput;
        if (serviceCommand === 'start') {
          const result = await this.startServer(server);
          logger.info(`MinecraftClient: Start server result: ${JSON.stringify(result)}`);
          const status = await this.getServerStatus(server);
          emitWebServiceStatus({
            service: `minecraft:${server}`,
            status,
          });
        } else if (serviceCommand === 'stop') {
          const result = await this.stopServer(server);
          logger.info(`MinecraftClient: Stop server result: ${JSON.stringify(result)}`);
          const status = await this.getServerStatus(server);
          emitWebServiceStatus({
            service: `minecraft:${server}`,
            status,
          });
        } else if (serviceCommand === 'status') {
          const status = await this.getServerStatus(server);
          emitWebServiceStatus({
            service: `minecraft:${server}`,
            status,
          });
        }
      });
    }
  }
}
