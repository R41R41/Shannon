import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages';
import { MinebotSkillInput, MinebotVoiceChatInput } from '@shannon/common';
import fetch from 'node-fetch';
import { Vec3 } from 'vec3';
import { EventBus } from '../eventBus/eventBus.js';
import { config } from '../../config/env.js';
import { LLMService } from '../llm/client.js';
import { minebotAdapter } from '../common/adapters/index.js';
import { CONFIG } from './config/MinebotConfig.js';
import AutoFaceSpeaker from './constantSkills/autoFaceSpeaker.js';
import { EventReactionSystem } from './eventReaction/EventReactionSystem.js';
import { BotEventHandler } from './events/BotEventHandler.js';
import { MinebotHttpServer } from './http/MinebotHttpServer.js';
import { MinebotTaskRuntime } from './runtime/MinebotTaskRuntime.js';
import { SkillLoader } from './skills/SkillLoader.js';
import { SkillRegistrar } from './skills/SkillRegistrar.js';
import { CustomBot } from './types.js';
import { ConstantSkillInfo, LLMError, SkillExecutionError } from './types/index.js';
import { WorldKnowledgeService } from './knowledge/WorldKnowledgeService.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Minebot:SkillAgent');

/**
 * SkillAgent
 * Minecraftボットのスキル管理とイベント処理を統括するメインクラスあ
 * 
 * 責任:
 * - 各コンポーネントの初期化と調整
 * - チャットイベントの処理
 * - unified graph 実行を包む Minebot runtime との連携（緊急対応・UI同期）
 */
export class SkillAgent {
  private bot: CustomBot;
  private eventBus: EventBus;

  // コンポーネント
  private skillLoader: SkillLoader;
  private skillRegistrar: SkillRegistrar;
  private eventHandler: BotEventHandler;
  private eventReactionSystem: EventReactionSystem;
  private httpServer: MinebotHttpServer;
  private taskRuntime: MinebotTaskRuntime;

  // 状態
  private recentMessages: BaseMessage[] = [];
  private lastVoiceGuildId: string | null = null;
  private lastVoiceChannelId: string | null = null;

  constructor(bot: CustomBot, eventBus: EventBus) {
    this.bot = bot;
    this.eventBus = eventBus;

    // コンポーネント初期化
    this.skillLoader = new SkillLoader();
    this.skillRegistrar = new SkillRegistrar(eventBus);
    this.taskRuntime = new MinebotTaskRuntime(this.bot);
    this.eventHandler = new BotEventHandler(this.bot, this.taskRuntime, this.recentMessages);
    this.eventReactionSystem = new EventReactionSystem(this.bot, this.taskRuntime);
    this.httpServer = new MinebotHttpServer(this.bot, () => this.sendConstantSkills(), () => this.sendReactionSettings());
    this.httpServer.setTaskRuntime(this.taskRuntime);
  }

  /**
   * エージェントを起動
   */
  async startAgent() {
    try {
      log.info('🚀 Starting SkillAgent...', 'cyan');

      // スキル初期化
      const initSkillsResponse = await this.initSkills();
      if (!initSkillsResponse.success) {
        log.error(`❌ Skills initialization failed: ${initSkillsResponse.result}`);
        return { success: false, result: initSkillsResponse.result };
      }

      // チャットイベント登録
      await this.botOnChat();

      // ボットイベント登録
      this.eventHandler.registerAll();

      // 定期実行設定
      await this.setInterval();
      log.success('✅ setInterval done');

      // EventBus購読登録
      await this.registerEventBusSubscriptions();
      log.success('✅ registerEventBusSubscriptions done');

      this.taskRuntime.setExecutor((envelope, messages, options) =>
        LLMService.getInstance(config.isDev).invokeGraph(envelope, messages, options),
      );
      log.success('✅ minebot task runtime connected to unified graph');

      // タスクリスト更新コールバックを設定
      this.taskRuntime.setTaskListUpdateCallback((taskListState) => {
        void this.sendTaskListState(taskListState);
      });

      // EventReactionSystem初期化
      await this.eventReactionSystem.initialize();
      log.success('✅ EventReactionSystem initialized');

      // 緊急イベントハンドラーを設定（EventReactionSystemを使用）
      this.eventHandler.setEventReactionSystem(this.eventReactionSystem);
      log.success('✅ Event reaction system registered');

      // HTTPサーバーにEventReactionSystemを設定
      this.httpServer.setEventReactionSystem(this.eventReactionSystem);

      // チャットメッセージコールバックを設定
      this.httpServer.setOnChatMessageCallback(async (sender: string, message: string) => {
        log.info(`💬 Processing chat from ${sender}: ${message}`, 'cyan');
        // マイクラチャットと同様に処理（環境情報も渡す）
        await this.processMessage(
          sender,
          message,
          JSON.stringify(this.bot.environmentState),
          JSON.stringify(this.bot.selfState)
        );
      });

      // HTTPサーバー起動
      this.httpServer.start();

      // UI Modにスキル情報を送信
      await this.sendConstantSkills();
      await this.sendReactionSettings();

      log.success('🎉 SkillAgent started successfully');
      return { success: true, result: 'agent started' };
    } catch (error) {
      log.error(`❌ SkillAgent startup failed`, error);
      return { success: false, result: error };
    }
  }

  /**
   * スキルを初期化
   */
  private async initSkills() {
    log.info('🔧 Initializing skills...', 'cyan');

    // スキル読み込み
    const instantResult = await this.skillLoader.loadInstantSkills(this.bot);
    if (!instantResult.success || !instantResult.skills) {
      return { success: false, result: instantResult.result };
    }
    this.bot.instantSkills = instantResult.skills;

    const constantResult = await this.skillLoader.loadConstantSkills(this.bot);
    if (!constantResult.success || !constantResult.skills) {
      return { success: false, result: constantResult.result };
    }
    this.bot.constantSkills = constantResult.skills;

    // スキル登録
    this.skillRegistrar.registerInstantSkills(this.bot.instantSkills);
    this.skillRegistrar.registerConstantSkills(this.bot, this.bot.constantSkills);
    this.skillRegistrar.registerSkillControlEvents(this.bot);
    await LLMService.getInstance(config.isDev).registerMinebotTools(this.bot);

    // SelfImprovementDaemon に bot 参照を注入（プロアクティブ・スキル生成用）
    try {
      const { SelfImprovementDaemon } = await import('../llm/graph/cognitive/selfImprove/index.js');
      SelfImprovementDaemon.getInstance().setBot(this.bot);
    } catch {
      // non-critical: SelfImprovementDaemon がなくてもスキルは動作する
    }

    return { success: true, result: 'skills initialized' };
  }

  /**
   * チャットイベントを登録
   */
  private async botOnChat() {
    this.bot.on('chat', async (username, message) => {
      if (!this.bot.chatMode) {
        return;
      }

      // 自分の発言は記録のみ
      if (username === 'I_am_Shannon') {
        const currentTime = new Date().toLocaleString('ja-JP', {
          timeZone: 'Asia/Tokyo',
        });
        const newMessage = `${currentTime} ${username}: ${message}`;
        this.recentMessages.push(new AIMessage(newMessage));
        return;
      }

      log.info(`[${username}] ${message}`);
      if (!message) {
        return;
      }

      // 話しかけられたら向く（常時スキル）
      const autoFaceSpeaker = this.bot.constantSkills.getSkill('auto-face-speaker') as AutoFaceSpeaker | undefined;
      if (autoFaceSpeaker?.status) {
        await autoFaceSpeaker.onPlayerSpeak(username);
      }

      // コマンド処理
      if (await this.handleCommands(username, message)) {
        return;
      }

      // 「シャノン、」で始まるメッセージのみ処理
      if (!message.startsWith('シャノン、')) {
        return;
      }

      // 送信者情報を設定
      this.updateSenderInfo(username);

      // voice_mode がアクティブなら音声応答もセット
      if (this.lastVoiceGuildId && this.lastVoiceChannelId) {
        this.setupVoiceResponse(this.lastVoiceGuildId, this.lastVoiceChannelId);
      }

      // メッセージを処理
      await this.processMessage(
        username,
        message,
        JSON.stringify(this.bot.environmentState),
        JSON.stringify(this.bot.selfState)
      );
    });

    // EventBus経由のチャット送信
    this.eventBus.subscribe('minebot:chat', async (event) => {
      const { text } = event.data as MinebotSkillInput;
      if (text) {
        this.bot.chat(text);
      }
    });
  }

  /**
   * コマンド処理（.. ... .../ ./スキル名 ../スキル名）
   */
  private async handleCommands(username: string, message: string): Promise<boolean> {
    // .. - InstantSkill一覧表示
    if (message === '..') {
      const skill = this.bot.instantSkills.getSkill('display-instant-skill-list');
      if (skill) await skill.run();
      return true;
    }

    // ... - ConstantSkill一覧表示
    if (message === '...') {
      const skill = this.bot.instantSkills.getSkill('display-constant-skill-list');
      if (skill) await skill.run();
      return true;
    }

    // .../ - インベントリ表示
    if (message === '.../') {
      const skill = this.bot.instantSkills.getSkill('display-inventory');
      if (skill) await skill.run();
      return true;
    }

    // ..test-all [--fix] - 全テストスイートを順番に実行（オーバーナイト用）
    if (message.startsWith('..test-all')) {
      const autoFix = message.includes('--fix');
      const ALL_SUITES = [
        'info-skills', 'movement-skills', 'craft-skills',
        'furnace-skills', 'block-skills', 'inventory-skills',
        'combat-skills', 'new-skills',
      ];
      this.bot.chat(`🌙 全テスト開始 (${ALL_SUITES.length}スイート)${autoFix ? ' [自動修正ON]' : ''}...`);
      (async () => {
        try {
          const { SelfImprovementDaemon } = await import('../llm/graph/cognitive/selfImprove/index.js');
          const daemon = SelfImprovementDaemon.getInstance();
          const report = await daemon.runMultipleSuites(ALL_SUITES, {
            autoFix,
            trigger: 'manual',
          });
          if (report) {
            const s = report.summary;
            this.bot.chat(
              `🌙 全テスト完了: ${s.totalTested}件 / ` +
              `✅${s.passed} 🔧${s.fixed} ❌${s.unfixable} ⏭️${s.skipped}`,
            );
          } else {
            this.bot.chat('⚠️ テスト実行できませんでした');
          }
        } catch (err: any) {
          this.bot.chat(`❌ テストエラー: ${err.message?.substring(0, 80)}`);
        }
      })();
      return true;
    }

    // ..test スイート名 [--fix] - テストスイート JSON を実行
    if (message.startsWith('..test')) {
      const args = message.slice(6).trim();
      const autoFix = args.includes('--fix');
      const suiteName = args.replace('--fix', '').trim();
      if (!suiteName) {
        this.bot.chat('使い方: ..test <スイート名> [--fix]');
        return true;
      }
      this.bot.chat(`🧪 テスト開始: ${suiteName}${autoFix ? ' (自動修正ON)' : ''}...`);
      (async () => {
        try {
          const { SelfImprovementDaemon } = await import('../llm/graph/cognitive/selfImprove/index.js');
          const daemon = SelfImprovementDaemon.getInstance();
          const report = await daemon.runSelfTestFromFile(suiteName, {
            autoFix,
            trigger: 'manual',
          });
          if (report) {
            const s = report.summary;
            this.bot.chat(
              `🧪 テスト完了: ${s.totalTested}件 / ` +
              `✅${s.passed} 🔧${s.fixed} ❌${s.unfixable} ⏭️${s.skipped}`,
            );
          } else {
            this.bot.chat('⚠️ テスト実行できませんでした');
          }
        } catch (err: any) {
          this.bot.chat(`❌ テストエラー: ${err.message?.substring(0, 80)}`);
        }
      })();
      return true;
    }

    // ./スキル名 - InstantSkill実行
    if (message.startsWith('./')) {
      const [skillName, ...args] = message.slice(2).split(' ');
      await this.executeInstantSkill(skillName);
      return true;
    }

    // ../スキル名 - ConstantSkillトグル
    if (message.startsWith('../')) {
      const skillName = message.slice(3);
      await this.toggleConstantSkill(skillName);
      return true;
    }

    return false;
  }

  /**
   * InstantSkillを実行
   */
  private async executeInstantSkill(skillName: string): Promise<void> {
    try {
      const skill = this.bot.instantSkills.getSkill(skillName);
      if (!skill) {
        this.bot.chat(`${skillName}は存在しません`);
        return;
      }

      if (skill.status) {
        this.bot.chat(`${skillName}を停止します`);
        skill.status = false;
        return;
      }

      const paramsResponse = await this.bot.utils.getParams(
        this.bot,
        skill.params as any
      );
      if (!paramsResponse.success) {
        this.bot.chat(`${skillName} error: ${paramsResponse.result}`);
        return;
      }

      skill.status = true;
      const response = await skill.run(...Object.values(paramsResponse.result));
      skill.status = false;

      if (!response.success) {
        log.error(`${skillName} failed: ${response.result}`);
      } else {
        log.success(`${skillName} completed: ${response.result}`);
      }
    } catch (error) {
      const skillError = new SkillExecutionError(skillName, error as Error);
      log.error(`${skillName} error: ${skillError.message}`, error);
      this.bot.chat(`${skillName} error: ${skillError.message}`);
    }
  }

  /**
   * ConstantSkillのオン/オフを切り替え
   */
  private async toggleConstantSkill(skillName: string): Promise<void> {
    const skill = this.bot.constantSkills.getSkill(skillName);
    if (!skill) {
      this.bot.chat(`${skillName}は存在しません`);
      return;
    }

    skill.status = !skill.status;
    this.bot.chat(
      `常時スキル${skillName}のステータスを${skill.status ? 'オン' : 'オフ'}にしました`
    );
    await this.sendConstantSkills();
  }

  /**
   * 送信者情報を更新
   */
  private updateSenderInfo(username: string): void {
    this.bot.environmentState.senderName = username;

    // bot.players → bot.entities の順でプレイヤーエンティティを探す
    let position = this.bot.players[username]?.entity?.position ?? null;

    if (!position) {
      for (const e of Object.values(this.bot.entities)) {
        if (e === this.bot.entity) continue;
        if (e.type === 'player' && ((e as any).username === username || e.name === username)) {
          position = e.position;
          break;
        }
      }
    }

    if (position) {
      this.bot.environmentState.senderPosition = new Vec3(
        Number(position.x.toFixed(1)),
        Number(position.y.toFixed(1)),
        Number(position.z.toFixed(1))
      );
    } else {
      log.warn(`updateSenderInfo: ${username} のエンティティが見つかりません (players.entity=null, entities fallback失敗)`);
      this.bot.environmentState.senderPosition = null;
    }

    // 送信者の方を向く
    const faceToEntity = this.bot.instantSkills.getSkill('face-to-entity');
    if (faceToEntity) {
      faceToEntity.run(username);
    }
  }

  /**
   * FCA の音声応答コールバックをセットする
   */
  private setupVoiceResponse(guildId: string, channelId: string): void {
    this.lastVoiceGuildId = guildId;
    this.lastVoiceChannelId = channelId;
  }

  /**
   * メッセージを処理
   */
  private async processMessage(
    userName: string,
    message: string,
    environmentState?: string,
    selfState?: string,
    voiceResponseTarget?: { guildId: string; channelId: string },
  ) {
    try {
      const currentTime = new Date().toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
      });
      const newMessage = `${currentTime} ${userName}: ${message}`;
      this.recentMessages.push(new HumanMessage(newMessage));

      // メモリリーク防止: 直近50件を超えたら古いメッセージを削除
      if (this.recentMessages.length > 50) {
        this.recentMessages.splice(0, this.recentMessages.length - 50);
      }

      const envelope = minebotAdapter.toEnvelope({
        senderName: userName,
        senderId: userName,
        message,
        serverName: this.bot.connectedServerName || 'default',
        senderPosition: this.bot.environmentState.senderPosition
          ? {
              x: this.bot.environmentState.senderPosition.x,
              y: this.bot.environmentState.senderPosition.y,
              z: this.bot.environmentState.senderPosition.z,
            }
          : undefined,
        weather: this.bot.environmentState.weather,
        time: this.bot.environmentState.time,
        biome: this.bot.environmentState.biome,
        dimension: this.bot.environmentState.dimension?.toString?.() ?? undefined,
        bossbar: this.bot.environmentState.bossbar ?? undefined,
        botPosition: this.bot.selfState.botPosition
          ? {
              x: this.bot.selfState.botPosition.x,
              y: this.bot.selfState.botPosition.y,
              z: this.bot.selfState.botPosition.z,
            }
          : undefined,
        botHealth: Number(this.bot.health ?? 0),
        botFoodLevel: Number(this.bot.food ?? 0),
        botHeldItem: this.bot.selfState.botHeldItem,
        lookingAt: this.bot.selfState.lookingAt?.name,
        inventory: this.bot.selfState.inventory,
        nearbyEntities: Object.values(this.bot.entities)
          .filter((entity: any) => entity?.position && entity !== this.bot.entity)
          .map((entity: any) => entity.username || entity.name || entity.type)
          .filter(Boolean)
          .slice(0, 12),
        eventType: 'chat',
      });

      if (environmentState || selfState) {
        envelope.metadata = {
          ...(envelope.metadata ?? {}),
          environmentState,
          selfState,
        };
      }

      let immediateAckSent = false;

      const resumed = await this.taskRuntime.resumeAwaitingUserTask(message, {
        envelope,
        messages: [...this.recentMessages],
        environmentState: environmentState ?? null,
        selfState: selfState ?? null,
        onToolStarting: (toolName, args) => {
          if (immediateAckSent) return;
          const ack = this.buildImmediateToolAck(toolName, args);
          if (!ack) return;
          immediateAckSent = true;
          this.bot.chat(ack);
        },
      });
      if (resumed) {
        return;
      }

      const result = await this.taskRuntime.invoke({
        envelope,
        userMessage: message,
        messages: [...this.recentMessages],
        environmentState: environmentState ?? null,
        selfState: selfState ?? null,
        onToolStarting: (toolName, args) => {
          if (immediateAckSent) return;
          const ack = this.buildImmediateToolAck(toolName, args);
          if (!ack) return;
          immediateAckSent = true;
          this.bot.chat(ack);
        },
      });

      const graphResult = result?.graphResult;
      const responseText = graphResult?.actionPlan?.message ?? graphResult?.finalAnswer;
      if (voiceResponseTarget && responseText) {
        this.eventBus.publish({
          type: 'minebot:voice_response',
          memoryZone: 'minebot',
          data: {
            guildId: voiceResponseTarget.guildId,
            channelId: voiceResponseTarget.channelId,
            responseText,
          },
        });
      }
    } catch (error) {
      const llmError = new LLMError('message-processing', error as Error);
      log.error(`Message processing failed: ${llmError.message}`, error);
      this.bot.chat('エラーが発生しました。もう一度お試しください。');
    }
  }

  private buildImmediateToolAck(
    toolName: string,
    args?: Record<string, unknown>,
  ): string | null {
    const targetName =
      typeof args?.targetName === 'string' && args.targetName.trim()
        ? args.targetName.trim()
        : null;

    switch (toolName) {
      case 'follow-entity':
        return targetName
          ? `${targetName}のところに向かうね。`
          : '今そっちに向かうね。';
      // move-to は内部的に何度も呼ばれるためチャット不要
      case 'enter-portal':
        return '今そっちへ行ってみるね。';
      case 'flee-from':
        return 'いったん安全な場所に離れるね。';
      default:
        return null;
    }
  }

  /**
   * 定期実行タスクを設定
   */
  private async setInterval() {
    setInterval(() => {
      this.bot.emit('taskPer100ms');
    }, CONFIG.INTERVAL_100MS);

    setInterval(() => {
      this.bot.emit('taskPer1000ms');
    }, CONFIG.INTERVAL_1000MS);

    setInterval(() => {
      this.bot.emit('taskPer5000ms');
    }, CONFIG.INTERVAL_5000MS);

    // 60秒ごとにボット状態をスナップショット保存
    setInterval(() => {
      if (!this.bot.entity) return;
      const wk = WorldKnowledgeService.getInstance(this.bot.connectedServerName || 'default');
      const pos = this.bot.entity.position;
      wk.recordSnapshot({
        position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
        health: this.bot.health ?? 0,
        food: this.bot.food ?? 0,
        dimension: (this.bot as any).game?.dimension || 'overworld',
        biome: '',
        inventory: (this.bot.inventory?.items() || []).map((item: any) => ({ name: item.name, count: item.count })),
      }).catch(() => {});
    }, 60000);
  }

  /**
   * EventBus購読を登録
   */
  private async registerEventBusSubscriptions() {
    // Discord音声経由のMinebotチャット
    this.eventBus.subscribe('minebot:voice_chat', async (event) => {
      const { userName, message, guildId, channelId } = event.data as MinebotVoiceChatInput;
      const mcName = CONFIG.resolveMinecraftName(userName);
      log.info(`🎙️ Voice chat from ${userName} (MC: ${mcName}): ${message}`, 'cyan');

      this.lastVoiceGuildId = guildId;
      this.lastVoiceChannelId = channelId;

      this.updateSenderInfo(mcName);
      this.setupVoiceResponse(guildId, channelId);

      await this.processMessage(
        mcName,
        message,
        JSON.stringify(this.bot.environmentState),
        JSON.stringify(this.bot.selfState),
        { guildId, channelId },
      );
    });

    // スキル読み込みイベント
    this.eventBus.subscribe('minebot:loadSkills', async (event) => {
      try {
        const initSkillsResponse = await this.initSkills();
        this.eventBus.publish({
          type: `minebot:skillResult`,
          memoryZone: 'minecraft',
          data: {
            success: initSkillsResponse.success,
            result: initSkillsResponse.result,
          },
        });
      } catch (error) {
        this.eventBus.publish({
          type: `minebot:skillResult`,
          memoryZone: 'minecraft',
          data: {
            success: false,
            result: `error: ${error}`,
          },
        });
      }
    });
  }

  /**
   * ConstantSkillsの状態をUI Modに送信
   */
  async sendConstantSkills() {
    try {
      const skills: ConstantSkillInfo[] = this.bot.constantSkills.getSkills().map((skill) => ({
        skillName: skill.skillName,
        description: skill.description,
        status: skill.status,
      }));

      await fetch(`${CONFIG.UI_MOD_BASE_URL}/constant_skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(skills),
      });

      log.debug('📤 Constant skills sent to UI Mod');
    } catch (error) {
      log.error('❌ Failed to send constant skills', error);
    }
  }

  /**
   * 反応設定をUI Modに送信
   */
  async sendReactionSettings() {
    try {
      const settings = this.eventReactionSystem.getSettingsState();

      await fetch(`${CONFIG.UI_MOD_BASE_URL}/reaction_settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(settings),
      });

      log.debug('📤 Reaction settings sent to UI Mod');
    } catch (error) {
      log.error('❌ Failed to send reaction settings', error);
    }
  }

  /**
   * EventReactionSystemを取得
   */
  getEventReactionSystem(): EventReactionSystem {
    return this.eventReactionSystem;
  }

  /**
   * HTTPサーバーを取得
   */
  getHttpServer(): MinebotHttpServer {
    return this.httpServer;
  }

  getTaskRuntime() {
    return this.taskRuntime;
  }

  /**
   * タスクリスト状態をUI Modに送信
   */
  async sendTaskListState(taskListState: any) {
    try {
      await fetch(`${CONFIG.UI_MOD_BASE_URL}/task_list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(taskListState),
      });
      log.debug(`📤 Task list sent: tasks=${taskListState.tasks?.length || 0}, emergency=${taskListState.emergencyTask ? 'yes' : 'no'}`);
    } catch {
      // UI Mod not available — silently skip
    }
  }
}
