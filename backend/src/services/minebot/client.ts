import { bindMinecraftMemory, revokeMinecraftMemory } from './runtime/memoryContext.js';
import {
  MinebotInput,
  MinebotStartOrStopInput,
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
import {
  emitMinebotError,
  emitMinebotSpawned,
  emitMinebotStopped,
} from '../runtime/minebotLifecycleRegistry.js';
import { logToWeb } from '../runtime/logging.js';
import { registerServiceCommandHandler } from '../runtime/serviceCommandRegistry.js';
import { emitWebServiceStatus } from '../web/webNotificationHub.js';
import { CONFIG } from './config/MinebotConfig.js';
import { SkillAgent } from './skillAgent.js';
import { ConstantSkills, CustomBot, InstantSkills } from './types.js';
import { Utils } from './utils/index.js';
import { installPlayerLoadedHandshake } from './utils/playerLoadedHandshake.js';
import { installTierToolMaterialRepair } from './utils/registryRepairs.js';
import { installAirSupplyDefault } from './utils/airSupplyDefault.js';
import { edgeGuardPlugin } from './utils/edgeGuard.js';
import { breathingReflexPlugin } from './utils/breathingReflex.js';
import { exertionMeterPlugin } from './utils/exertionMeter.js';
import { threatTrackerPlugin } from './utils/threatTracker.js';
import { toolWearPlugin } from './utils/toolWear.js';
import { landmarkWatcherPlugin } from './utils/landmarks.js';
import { placeMemoryPlugin } from './utils/placeMemory.js';
import { loadFloorLayer } from './utils/floorLayer.js';
import { fireballDeflectPlugin } from './utils/fireballDeflect.js';
import { shieldBlockPlugin } from './utils/shieldBlock.js';
import { knockBracePlugin } from './utils/knockBrace.js';
import { digConfirmationPlugin } from './utils/digConfirmation.js';
import { serverRefusalPlugin } from './utils/serverRefusals.js';
import { lavaDigGuardPlugin, lavaReflexPlugin } from './utils/lavaSafety.js';
import { gazeGuardPlugin } from './utils/gazeGuard.js';
import { exposureDigGuardPlugin } from './utils/exposureGuard.js';
import { promptPlacePlugin } from './utils/promptPlace.js';
import { installCollisionTolerance } from './utils/collisionTolerance.js';
import { installSyncInflate } from './utils/syncInflate.js';
import { cancelActiveActions } from './execution/ActionExecution.js';
import { installBotLoopWatch } from './utils/eventLoopWatch.js';
import { installRespawnTracker } from './utils/respawnSettle.js';
import { ReconnectBudget, reconnectKindOfEnd, reconnectKindOfKick, type ReconnectKind } from './utils/reconnectPolicy.js';

installCollisionTolerance();
// Run 24: the inflater waited for turns of a busy event loop, and the keep-alive waited behind the Nether's chunks until the server timed
// the body out. Packets are inflated as they arrive (utils/syncInflate).
installSyncInflate();
import { installMotionRecorder } from './utils/motionRecorder.js';
import { installTrailRecorder } from './utils/trailRecorder.js';
import { installLinkWatch } from './utils/linkWatch.js';
import { installArrivalNote } from './utils/arrivalNote.js';
import { installDimensionKeeper } from './utils/dimensionKeeper.js';
import { installSpawnScan } from './utils/worldScan.js';
import { installToolChoice } from './utils/toolChoice.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Minebot:Client');

// 環境変数の検証
CONFIG.validateEnvironment();

/** The process's own error handlers are installed by the first login only. */
let processHandlersInstalled = false;

export class MinebotClient extends BaseClient {
  private bot: CustomBot | null = null;
  public isDev: boolean = false;
  private static instance: MinebotClient;
  private skillAgent: SkillAgent | null = null;
  private serviceCommandsRegistered = false;
  /** 直前の接続パラメータ（自動再接続用） */
  private lastBotData: MinebotInput | null = null;
  private autoReconnecting = false;
  /** How often the body goes back in by itself after the connection ended (utils/reconnectPolicy). */
  private readonly reconnectBudget = new ReconnectBudget();
  private lifecycleBusy = false;
  private explicitlyDisconnected = false;
  private connectionEnded = true;
  private reconnectEpoch = 0;

  constructor(serviceName: 'minebot', isDev: boolean) {
    super(serviceName);
    this.isDev = isDev;
  }

  public static getInstance(isDev: boolean = false) {
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
    const version = CONFIG.serverVersion(serverName as string);

    if (!port) {
      throw new Error(`Unknown server: ${serverName}`);
    }

    const memoryIdentity = CONFIG.getMemoryIdentity(serverName as string);
    log.info(`🔌 ${serverName} (host:${CONFIG.MINECRAFT_HOST}, port:${port}, v${version}) に接続します`, 'cyan');

    // A throwaway world on this machine (docs/minebot-ui-mod-fca.md, "確認の手順") is not online-mode: the bot joins it without a
    // Microsoft login. Only for the companion-body world that is named for it, never for a table's world, and only on loopback.
    const offlineLab = process.env.MINEBOT_LAB_OFFLINE_AUTH === 'on' && serverName !== 'shannon-home'
      && CONFIG.companionBodyFor(serverName as string) !== null && ['127.0.0.1', 'localhost'].includes(CONFIG.MINECRAFT_HOST);
    this.bot = mineflayer.createBot({
      host: CONFIG.MINECRAFT_HOST,
      port,
      username,
      auth: offlineLab ? 'offline' : 'microsoft',
      version,
      checkTimeoutInterval: CONFIG.CHECK_TIMEOUT_INTERVAL,
      skipValidation: true,
    }) as CustomBot;
    // Each bot gets its plugins' listeners (spawn, physicsTick: about a dozen each), above the emitter's default of ten: raised before
    // the plugins load. The count is logged at each login, so a growth from one login to the next shows in the log.
    this.bot.setMaxListeners(40);
    this.connectionEnded = false;
    this.explicitlyDisconnected = false;
    const connectedBot = this.bot;
    installPlayerLoadedHandshake(connectedBot);
    installTierToolMaterialRepair(connectedBot);
    installAirSupplyDefault(connectedBot);
    installMotionRecorder(connectedBot);
    // The cells the body walks through rock are kept for the way back whatever dug them (stair-mine, mine-block, the route search), not only the tunnel walk.
    installTrailRecorder(connectedBot as any);
    // Run 20: a connection dropped for silence with 70 s unaccounted for in the journal. The loop's lateness, the ticks, the chunks and the
    // slow handlers are written when it is late, and a worker thread says where the main thread stands while it is stuck (utils/eventLoopWatch).
    installBotLoopWatch(connectedBot as any);
    installRespawnTracker(connectedBot);
    // The connection's own record (utils/linkWatch): keep-alives in and out, how late, the dimension changes; written when one is late and at the end.
    installLinkWatch(connectedBot as any);
    // The dimension as the server names it in the login and respawn packets, when mineflayer's own reading of its number leaves it wrong (a portal).
    installDimensionKeeper(connectedBot as any);
    // How the body came to be here, for the observation: a reconnect after a drop is not a respawn after a death (run 24: a shelter dug over magma).
    installArrivalNote(connectedBot as any, this.autoReconnecting ? 'reconnect' : 'login');
    // r4 (LLM-centric mode only): after each spawn, once the chunks have arrived, what the loaded area holds, for the observation's world.scan.
    // After the arrival note, so the scan names how the body came (a login, a reconnect, a portal, a respawn).
    installSpawnScan(connectedBot as any, { log: line => log.info(`🗺️ ${line}`) });
    connectedBot.on('spawn', () => this.reconnectBudget.noteSpawned(Date.now()));
    bindMinecraftMemory(connectedBot, memoryIdentity);
    connectedBot.once('end', () => revokeMinecraftMemory(connectedBot));
    connectedBot.once('kicked', () => revokeMinecraftMemory(connectedBot));

    this.bot.loadPlugin(pathfinder);
    this.bot.loadPlugin(collectBlock);
    this.bot.loadPlugin(projectile);
    this.bot.loadPlugin(pvp);
    this.bot.loadPlugin(toolPlugin);
    // Plugins are injected at login: the wear-aware tool choice goes in once they exist.
    this.bot.once('spawn', () => installToolChoice(this.bot));
    cmd.allowConsoleInput = true;
    this.bot.loadPlugin(cmd);
    const minecraftHawkEye = pkg.default;
    try {
      this.bot.loadPlugin(minecraftHawkEye);
    } catch (error) {
      log.error('HawkEye plugin load failed', error);
    }
    // Last, so its physics tick listener has the final say over every mover's controls.
    this.bot.loadPlugin(edgeGuardPlugin);
    this.bot.loadPlugin(breathingReflexPlugin);
    this.bot.loadPlugin(exertionMeterPlugin);
    this.bot.loadPlugin(threatTrackerPlugin);
    this.bot.loadPlugin(toolWearPlugin);
    this.bot.loadPlugin(landmarkWatcherPlugin);
    this.bot.loadPlugin(placeMemoryPlugin);
    this.bot.loadPlugin(digConfirmationPlugin);
    this.bot.loadPlugin(serverRefusalPlugin);
    this.bot.loadPlugin(lavaDigGuardPlugin);
    this.bot.loadPlugin(exposureDigGuardPlugin);
    this.bot.loadPlugin(promptPlacePlugin);
    this.bot.loadPlugin(lavaReflexPlugin);
    this.bot.loadPlugin(gazeGuardPlugin);
    this.bot.loadPlugin(fireballDeflectPlugin);
    this.bot.loadPlugin(shieldBlockPlugin);
    this.bot.loadPlugin(knockBracePlugin);
    // The floor's eat, armour and retreat reflexes (ADR-0010 D8), after the others. Common-FCA mode only: legacy mode keeps
    // its own constant skills for these, and two eaters would fight.
    // MINEBOT_FCA_REFLEXES / MINEBOT_FCA_REFLEX_OFF (floorConfig, docs/minecraft-body-reflexes-p8.md): unset loads the whole layer (the floor,
    // the low-health flee and idle pickup, the combat-knowledge providers); `floor` is the 2026-10-16 production floor alone; `off` loads no
    // floor (rollback). The reflex ledger always counts what the resident reflexes do (P8).
    if (process.env.MINEBOT_COMMON_FCA === 'on') loadFloorLayer(this.bot);

    this.bot.on('login', async () => {
      log.info(`✅ Bot has logged in. listeners spawn=${connectedBot.listenerCount('spawn')} physicsTick=${connectedBot.listenerCount('physicsTick')} `
        + `process.uncaughtException=${process.listenerCount('uncaughtException')}`);
      void logToWeb('minecraft', 'green', 'Bot has logged in.');
    });

    /** The kick that ended this connection, if one did (its word decides whether the body goes back in; the `end` that follows does not). */
    let kickReason: string | null = null;
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
      kickReason = readableReason;
      log.error(`🚫🚫🚫 BOT KICKED 🚫🚫🚫 reason: ${readableReason}`);
      void logToWeb('minecraft', 'red', `Bot was kicked: ${readableReason}`);

      const kind = reconnectKindOfKick(readableReason);
      if (kind && this.bot === connectedBot) this.scheduleAutoReconnect(kind, readableReason);
      else if (!kind) log.warn(`🚫 この kick は自動で入り直す種類ではありません（${readableReason}）`);
    });

    this.bot.on('end', (reason: string) => {
      const current = this.bot === connectedBot;
      if (current) this.connectionEnded = true;
      // Nothing can be done on a closed connection: the actions still running on it end now, so that they do not hold the body's
      // lease (a move that waited out its whole time left the release unconfirmed, and the next login could not start).
      try { cancelActiveActions(connectedBot, 'disconnected'); } catch { /* the connection is gone anyway */ }
      const trace = new Error('disconnect trace').stack;
      log.error(`🔌🔌🔌 BOT DISCONNECTED 🔌🔌🔌 reason: "${reason ?? 'unknown'}" | trace: ${trace}`);
      void logToWeb('minecraft', 'red', `Bot disconnected: ${reason ?? 'unknown'}`);
      // A connection that ended without a kick and without anyone's stop (the socket closed, was reset, timed out): back in, after a pause.
      if (current && kickReason === null && !this.explicitlyDisconnected) {
        const kind = reconnectKindOfEnd(reason);
        if (kind) this.scheduleAutoReconnect(kind, String(reason));
      }
    });

    this.bot.on('error', (err: Error) => {
      log.error(`❌❌❌ BOT ERROR ❌❌❌ ${err.message}`, err);
      void logToWeb('minecraft', 'red', `Bot error: ${err.message}`);
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
      void logToWeb('minecraft', 'green', 'Bot has respawned.');
    });

    this.skillAgent = new SkillAgent(this.bot);
    const result = await this.skillAgent.startAgent();
    if (!result.success) {
      void logToWeb(
        'minecraft',
        'red',
        `Skill agent failed to start: ${result.result}`
      );
      throw new Error(`Skill agent failed to start: ${result.result}`);
    }

    // Once a process: each login used to add another pair, so a body kept from run to run piled them up.
    if (!processHandlersInstalled) {
      processHandlersInstalled = true;
      process.on('uncaughtException', (error) => {
        void logToWeb(
          'minecraft',
          'red',
          `未処理の例外が発生しました: ${error.message}`
        );
      });

      process.on('unhandledRejection', (reason: unknown, _promise) => {
        const error =
          reason instanceof Error ? reason : new Error(String(reason));
        void logToWeb(
          'minecraft',
          'red',
          `未処理のPromise拒否が発生しました: ${error.message}`
        );
      });
    }

    this.bot.on('spawn', () => {
      void logToWeb('minecraft', 'green', 'Minecraft bot spawned');
      emitMinebotSpawned();
    });
  }

  private getStatus() {
    if (!this.bot) {
      return 'stopped';
    }
    return 'running';
  }

  public async initialize() {
    this.setupServiceCommands();
  }

  private setupServiceCommands() {
    if (this.serviceCommandsRegistered) return;
    this.serviceCommandsRegistered = true;

    registerServiceCommandHandler('minebot', async (serviceCommand) => {
      if (serviceCommand === 'start') {
        await this.start();
      } else if (serviceCommand === 'stop') {
        await this.stop();
      } else if (serviceCommand === 'status') {
        emitWebServiceStatus({
          service: 'minebot',
          status: this.status,
        });
      }
    });

    registerServiceCommandHandler('minebot:bot', async (serviceCommand, input) => {
      if (this.status !== 'running') return;
      if (this.lifecycleBusy) return;
      const data = {
        serviceCommand,
        serverName: input?.serverName,
      } as MinebotInput;

      if (serviceCommand === 'start') {
        this.reconnectEpoch++;
        const result = await this.startBot(data);
        if (!result) return;
        emitWebServiceStatus({
          service: 'minebot:bot',
          status: this.getStatus(),
        });
      } else if (serviceCommand === 'stop') {
        this.reconnectEpoch++;
        this.explicitlyDisconnected = true;
        const result = await this.stopBot(data);
        if (!result) return;
        emitWebServiceStatus({
          service: 'minebot:bot',
          status: this.getStatus(),
        });
      } else if (serviceCommand === 'status') {
        emitWebServiceStatus({
          service: 'minebot:bot',
          status: this.getStatus(),
        });
      }
    });
  }

  /**
   * 接続が終わった後、自動でボットを入り直させる。
   * - chat_validation_failed の kick: mineflayer #3838（累積21通でチャット署名チェーンが壊れる）の回避策。
   * - 沈黙の kick（disconnect.timeout）や、kick なしに閉じた接続: 実走20 で、復活直後の 400m の移動中に
   *   サーバーに切られ、体は入り直さないまま実走が終わった。
   * 間隔は広げ、窓の中の回数には上限がある（reconnectPolicy）。止められた時（stop・logout）は入り直さない。
   */
  private scheduleAutoReconnect(kind: ReconnectKind, why: string): void {
    if (this.autoReconnecting || !this.lastBotData) return;
    const plan = this.reconnectBudget.next(Date.now(), kind);
    if (!plan.allowed) {
      log.error(`❌ 自動で入り直すのをやめます（短い間に${plan.attempt}回続けて切れました。理由: ${why}）`);
      void logToWeb('minecraft', 'red', `Auto-reconnect given up after ${plan.attempt} tries: ${why}`);
      return;
    }
    this.autoReconnecting = true;
    const epoch = this.reconnectEpoch;
    log.warn(`🔄 接続が切れました（${kind}: ${why}）→ ${Math.round(plan.delayMs / 1000)}秒後に自動で入り直します（${plan.attempt}回目）`);
    setTimeout(async () => {
      try {
        if (epoch !== this.reconnectEpoch || this.lifecycleBusy || this.explicitlyDisconnected || !this.lastBotData) return;
        log.info('🔄 自動再接続を開始します…');
        let stopped = false;
        try { stopped = await this.stopBot(this.lastBotData!); } catch { /* ignore */ }
        if (!stopped) {
          // The connection is dead: no input can still be held on it. A release that could not be confirmed (an action still winding down,
          // the common-FCA body's own answer) must not keep the old agent's HTTP port, or the new login could not start.
          log.warn('🔄 古い体の停止を確認できませんでした。接続は切れているので、強制的に片づけて入り直します');
          try { await this.skillAgent?.getHttpServer().stop(); } catch { /* the port may already be free */ }
          try { this.skillAgent?.getTaskRuntime()?.forceStop(); } catch { /* ignore */ }
          this.skillAgent = null;
          this.bot = null;
          this.connectionEnded = true;
        }
        await new Promise(r => setTimeout(r, 2_000));
        if (epoch !== this.reconnectEpoch || this.explicitlyDisconnected || !this.lastBotData) return;
        const ok = await this.startBot(this.lastBotData!);
        if (ok) {
          log.info('✅ 自動再接続に成功しました');
          void logToWeb('minecraft', 'green', `Auto-reconnected after ${kind}`);
        } else {
          log.error('❌ 自動再接続に失敗しました');
        }
      } catch (e) {
        log.error('❌ 自動再接続エラー', e);
      } finally {
        this.autoReconnecting = false;
      }
    }, plan.delayMs);
  }

  private async startBot(data: MinebotInput) {
    try {
      this.lastBotData = data;
      await this.setUpBot(data);
      void logToWeb('minecraft', 'green', 'Minecraft bot started');
      return true;
    } catch (error) {
      void logToWeb(
        'minecraft',
        'red',
        `Botの起動に失敗しました: ${error}`
      );
      emitMinebotError(`${error}`);
      return false;
    }
  }

  private async stopBot(data: MinebotInput) {
    try {
      if (!this.bot) {
        throw new Error('Botが初期化されていません');
      }
      revokeMinecraftMemory(this.bot);
      if (this.skillAgent) {
        // Companion body mode: open requests are reported to her mind as run over (also done on 'end').
        if (!await this.skillAgent.stopCompanionBody()) throw Error('COMMON_FCA_BODY_RELEASE_UNKNOWN');
        const httpServer = this.skillAgent.getHttpServer();
        await httpServer.stop();
      }
      log.info('🛑 Bot.quit() を明示的に呼び出します（ユーザー操作による停止）');
      this.bot.quit();
      // The keep-alive clock of this client is not left to ring after it is gone (run 24: 120 s after the drop, on a body that had gone back in).
      try { (this.bot as any)._client?.removeAllListeners?.('keep_alive'); } catch { /* the client is gone anyway */ }
      if (this.skillAgent?.getTaskRuntime()) {
        this.skillAgent.getTaskRuntime()?.forceStop();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      this.skillAgent = null;
      this.bot = null;
      this.connectionEnded = true;
      void logToWeb('minecraft', 'green', 'Minecraft bot stopped');
      emitMinebotStopped();
      return true;
    } catch (error) {
      void logToWeb(
        'minecraft',
        'red',
        `Botの停止に失敗しました: ${error}`
      );
      return false;
    }
  }

  /** Content-free native lifecycle state; a created mineflayer object alone is never proof of joining. */
  public lifecycleState(): { phase: 'joined' | 'absent' | 'unknown'; serverName: string | null; uuid: string | null } {
    const bot = this.bot;
    if ((!bot || this.connectionEnded) && !this.autoReconnecting) return { phase: 'absent', serverName: null, uuid: null };
    if (!bot || this.connectionEnded) return { phase: 'unknown', serverName: this.lastBotData?.serverName ?? null, uuid: null };
    return { phase: bot.entity && bot.player?.uuid ? 'joined' : 'unknown', serverName: bot.connectedServerName ?? null, uuid: bot.player?.uuid?.toLowerCase() ?? null };
  }
  /** Uses the existing configured native body, with no old planner fallback or process spawn permission. */
  public async lifecycleLogin(serverName: string, signal: AbortSignal): Promise<void> {
    if (this.lifecycleBusy || this.status !== 'running' || process.env.MINEBOT_COMMON_FCA !== 'on' || !CONFIG.companionBodyFor(serverName)) throw Error('LIFECYCLE_BODY_UNAVAILABLE');
    signal.throwIfAborted();
    if (this.bot && !this.connectionEnded) throw Error('LIFECYCLE_BODY_BUSY');
    this.lifecycleBusy = true;
    this.reconnectEpoch++;
    try {
      if (this.bot && !await this.stopBot(this.lastBotData!)) throw Error('LIFECYCLE_BODY_CLEANUP_UNKNOWN');
      signal.throwIfAborted();
      if (!await this.startBot({ serverName, serviceCommand: 'start' } as MinebotInput)) throw Error('LIFECYCLE_LOGIN_UNKNOWN');
    } finally { this.lifecycleBusy = false; }
  }
  public async lifecycleLogout(serverName: string, signal: AbortSignal): Promise<void> {
    if (this.lifecycleBusy || this.bot && this.bot.connectedServerName !== serverName) throw Error('LIFECYCLE_BODY_BUSY');
    signal.throwIfAborted();
    this.explicitlyDisconnected = true;
    this.reconnectEpoch++;
    this.autoReconnecting = false;
    this.lifecycleBusy = true;
    try {
      const bot = this.bot;
      if (!bot) return;
      const ended = this.connectionEnded ? Promise.resolve() : new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(Error('LIFECYCLE_LOGOUT_UNKNOWN')); }, 5000);
        const onEnd = () => { cleanup(); resolve(); };
        const cleanup = () => { clearTimeout(timer); bot.removeListener('end', onEnd); };
        bot.once('end', onEnd);
      });
      // Attach a rejection handler while native cleanup runs; it does not make a timeout an acknowledgement.
      void ended.catch(() => undefined);
      if (!await this.stopBot({ serverName, serviceCommand: 'stop' } as MinebotInput)) throw Error('LIFECYCLE_LOGOUT_UNKNOWN');
      await ended;
      this.lastBotData = null;
    } finally { this.lifecycleBusy = false; }
  }
}
