import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages';
import {
  DiscordClientInput,
  DiscordClarificationInput,
  DiscordGetServerEmojiInput,
  DiscordGetServerEmojiOutput,
  DiscordPlanningInput,
  DiscordScheduledPostInput,
  DiscordSendServerEmojiInput,
  DiscordSendServerEmojiOutput,
  DiscordSendTextMessageInput,
  DiscordSendTextMessageOutput,
  MinebotInput,
  MinecraftServerName,
  ServiceInput,
  TaskTreeState,
  YoutubeSubscriberUpdateOutput,
} from '@shannon/common';

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  ComponentType,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  ModalBuilder,
  ModalSubmitInteraction,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
  TextChannel,
  ThreadChannel,
  User,
} from 'discord.js';
import fs from 'fs';
import * as Jimp from 'jimp';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../../config/env.js';
import { classifyError, formatErrorForLog } from '../../errors/index.js';
import { getDiscordMemoryZone } from '../../utils/discord.js';
import { createLogger } from '../../utils/logger.js';
const logger = createLogger('Discord:Client');
import { voiceResponseChannelIds } from './voiceState.js';
import { loadServerChoices } from './serverChoices.js';
import { BaseClient } from '../common/BaseClient.js';
import { getEventBus } from '../eventBus/index.js';
import { getArtifactStore } from '../artifacts/artifactStore.js';
import { splitDiscordMessage, sendLongMessage } from './utils.js';
import { VoiceManager } from './voice/VoiceManager.js';
import {
  buildAcceptedClarificationAnswers,
  getClarificationSessionStore,
  ClarificationSession,
} from './clarificationSessionStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type VoteState = {
  [userId: string]: number | null; // userId -> index of voted option
};

const voteDurations: { [key: string]: number } = {
  '1m': 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};
export class DiscordBot extends BaseClient {
  private client: Client;
  private toyamaGuildId: string | null = null;
  private toyamaChannelId: string | null = null;
  private aiminelabGuildId: string | null = null;
  private aiminelabXChannelId: string | null = null;
  private aiminelabAnnounceChannelId: string | null = null;
  private aiminelabUpdateChannelId: string | null = null;
  private testGuildId: string | null = null;
  private testXChannelId: string | null = null;
  private doukiGuildId: string | null = null;
  private doukiChannelId: string | null = null;
  private colabGuildId: string | null = null;
  private colabChannelId: string | null = null;
  private progressMessages = new Map<string, { channelId: string; messageId: string; startedAt: number }>();
  private progressDetails = new Map<string, TaskTreeState>();
  private progressExpanded = new Set<string>();
  private static instance: DiscordBot;
  public isDev: boolean = false;
  public voiceManager: VoiceManager;
  public static getInstance(isDev?: boolean) {
    if (!DiscordBot.instance) {
      DiscordBot.instance = new DiscordBot('discord', isDev ?? false);
    }
    // isDev は初期化時にのみ設定。以降の呼び出しでは上書きしない
    if (isDev !== undefined) {
      DiscordBot.instance.isDev = isDev;
    }
    return DiscordBot.instance;
  }

  private constructor(serviceName: 'discord', isDev: boolean = false) {
    const eventBus = getEventBus();
    super(serviceName, eventBus);
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildIntegrations,
        GatewayIntentBits.GuildModeration,
      ],
      partials: [
        Partials.Channel,
        Partials.Message,
        Partials.ThreadMember,
      ],
    });
    this.eventBus = eventBus;

    this.voiceManager = new VoiceManager(this.client, eventBus, {
      getUserNickname: (user, guildId) => this.getUserNickname(user, guildId),
      shouldSkipGuild: (guildId) => this.shouldSkipGuild(guildId),
      getRecentMessages: (channelId, limit) => this.getRecentMessages(channelId, limit),
    });
    this.voiceManager.setupEventSubscriptions();

    this.client.once('ready', async () => {
      this.setupSlashCommands();
      await this.voiceManager.onReady();

      // 既存のアクティブスレッドに参加
      for (const [, guild] of this.client.guilds.cache) {
        try {
          const threads = await guild.channels.fetchActiveThreads();
          for (const [, thread] of threads.threads) {
            if (thread.joinable && !thread.joined) {
              await thread.join();
              logger.info(`[Discord] 既存スレッドに参加: ${thread.name}`);
            }
          }
        } catch (err) {
          logger.warn(`[Discord] ${guild.name} のスレッド取得失敗: ${err}`);
        }
      }

    });

    this.setUpChannels();
    this.setupEventHandlers();
  }

  private static readonly DEV_AIMINE_LOCK = '/tmp/shannon-dev-aimine.lock';

  /**
   * devモード起動時にロックファイルを作成し、終了時に削除する。
   * prodモードはこのファイルの有無でdevがアイマイラボを使用中か判定する。
   */
  private setupDevAimineLock(): void {
    fs.writeFileSync(DiscordBot.DEV_AIMINE_LOCK, String(process.pid));
    logger.info(`[Dev] アイマイラボ ロックファイル作成 (pid=${process.pid})`);

    const cleanup = () => {
      try { fs.unlinkSync(DiscordBot.DEV_AIMINE_LOCK); } catch {}
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  }

  private isDevHoldingAimine(): boolean {
    try {
      if (!fs.existsSync(DiscordBot.DEV_AIMINE_LOCK)) return false;
      const pid = parseInt(fs.readFileSync(DiscordBot.DEV_AIMINE_LOCK, 'utf-8').trim(), 10);
      if (isNaN(pid)) return false;
      process.kill(pid, 0); // プロセス生存チェック（シグナルは送らない）
      return true;
    } catch {
      // ファイルが無い or プロセスが既に死んでいる → ロック無効
      try { fs.unlinkSync(DiscordBot.DEV_AIMINE_LOCK); } catch {}
      return false;
    }
  }

  /**
   * devモードは既定でテストギルドだけを許可する。アイマイラボへの接続は
   * SHANNON_DEV_ALLOW_AIMINE=True を明示した場合に限る。
   * prodモードはテストギルドを扱わず、明示的なdev占有時だけアイマイラボも避ける。
   */
  private shouldSkipGuild(guildId: string | null): boolean {
    if (!guildId) return true;
    const isTestGuild = guildId === config.discord.guilds.test.guildId;
    if (this.isDev) {
      const isAimineGuild = guildId === config.discord.guilds.aimine.guildId;
      return !isTestGuild && !(config.discord.devAllowAimine && isAimineGuild);
    }
    if (isTestGuild) return true;
    if (guildId === config.discord.guilds.aimine.guildId && this.isDevHoldingAimine()) {
      return true;
    }
    return false;
  }

  private setUpChannels() {
    this.toyamaGuildId = config.discord.guilds.toyama.guildId;
    this.doukiGuildId = config.discord.guilds.douki.guildId;
    this.colabGuildId = config.discord.guilds.colab.guildId;
    this.toyamaChannelId = config.discord.guilds.toyama.channelId;
    this.doukiChannelId = config.discord.guilds.douki.channelId;
    this.colabChannelId = config.discord.guilds.colab.channelId;
    this.aiminelabGuildId = config.discord.guilds.aimine.guildId;
    this.aiminelabXChannelId = config.discord.guilds.aimine.xChannelId;
    this.aiminelabAnnounceChannelId =
      config.discord.guilds.aimine.announceChannelId;
    this.aiminelabUpdateChannelId =
      config.discord.guilds.aimine.updateChannelId;
    this.testGuildId = config.discord.guilds.test.guildId;
    this.testXChannelId = config.discord.guilds.test.xChannelId;
  }

  public async initialize() {
    try {
      if (this.isDev && config.discord.devAllowAimine) {
        this.setupDevAimineLock();
      }
      if (!config.discord.token) {
        logger.warn('Discord token が未設定のためログインをスキップ');
        return;
      }
      await this.client.login(config.discord.token);
      logger.info('Discord bot started', 'blue');
    } catch (error) {
      const sErr = classifyError(error, 'discord');
      logger.error(`Discord bot failed to start: ${formatErrorForLog(sErr)}`);
      this.eventBus.log(
        'discord:aiminelab_server',
        'red',
        `Discord bot failed to start: ${sErr.message}`
      );
    }
  }

  private async setupSlashCommands() {
    try {
      const serverChoices = loadServerChoices();

      const commands = [
        new SlashCommandBuilder()
          .setName('minecraft_server_status')
          .setDescription('Minecraftサーバーの状態を取得する')
          .addStringOption((option) =>
            option
              .setName('server_name')
              .setDescription('サーバー名')
              .setRequired(true)
              .addChoices(...serverChoices)
          ),
        new SlashCommandBuilder()
          .setName('minecraft_server_start')
          .setDescription('Minecraftサーバーを起動する')
          .addStringOption((option) =>
            option
              .setName('server_name')
              .setDescription('サーバー名')
              .setRequired(true)
              .addChoices(...serverChoices)
          ),
        new SlashCommandBuilder()
          .setName('minecraft_server_stop')
          .setDescription('Minecraftサーバーを停止する')
          .addStringOption((option) =>
            option
              .setName('server_name')
              .setDescription('サーバー名')
              .setRequired(true)
              .addChoices(...serverChoices)
          ),
        new SlashCommandBuilder()
          .setName('minebot_login')
          .setDescription('MinebotをMinecraftサーバーにログインさせる')
          .addStringOption((option) =>
            option
              .setName('server_name')
              .setDescription('サーバー名')
              .setRequired(true)
              .addChoices(...serverChoices)
          ),
        new SlashCommandBuilder()
          .setName('minebot_logout')
          .setDescription('MinebotをMinecraftサーバーからログアウトさせる'),
        new SlashCommandBuilder()
          .setName('vote')
          .setDescription('投票を開始します')
          .addStringOption(option =>
            option
              .setName('description')
              .setDescription('投票の説明')
              .setRequired(true)
          )
          .addStringOption(option =>
            option
              .setName('options')
              .setDescription('カンマ区切りの投票候補（例: 選択肢A,選択肢B,選択肢C）')
              .setRequired(true)
          )
          .addStringOption(option =>
            option
              .setName('duration')
              .setDescription('投票期間')
              .setRequired(true)
              .addChoices(
                { name: '1分', value: '1m' },
                { name: '1時間', value: '1h' },
                { name: '1日', value: '1d' },
                { name: '1週間', value: '1w' }
              )
          )
          .addIntegerOption(option =>
            option
              .setName('max_votes')
              .setDescription('1人あたりの最大投票数')
              .setRequired(true)
          ),
        new SlashCommandBuilder()
          .setName('dice')
          .setDescription('6面ダイスをn個振って出目を表示します')
          .addIntegerOption(option =>
            option
              .setName('count')
              .setDescription('振るダイスの個数（1~10）')
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(10)
          ),
        new SlashCommandBuilder()
          .setName('voice_join')
          .setDescription('シャノンをボイスチャンネルに参加させる'),
        new SlashCommandBuilder()
          .setName('voice_leave')
          .setDescription('シャノンをボイスチャンネルから退出させる'),
        new SlashCommandBuilder()
          .setName('generate_fillers')
          .setDescription('フィラー音声を生成する（初回のみ必要）'),
        new SlashCommandBuilder()
          .setName('voice_mode')
          .setDescription('音声モードを切り替える（chat / minebot）')
          .addStringOption(option =>
            option
              .setName('mode')
              .setDescription('音声モード')
              .setRequired(true)
              .addChoices(
                { name: 'chat（通常会話）', value: 'chat' },
                { name: 'minebot（Minecraft操作）', value: 'minebot' },
              )
          ),
      ];

      // コマンドをJSON形式に変換
      const commandsJson = commands.map((command) => command.toJSON());

      // コマンドを特定のギルドに登録（即時反映）
      // devモードは既定でテストギルドだけに登録する。
      const targetGuildIds = this.isDev
        ? [
            config.discord.guilds.test.guildId,
            ...(config.discord.devAllowAimine ? [config.discord.guilds.aimine.guildId] : []),
          ]
        : [config.discord.guilds.aimine.guildId];

      let registered = false;
      for (const guildId of targetGuildIds) {
        if (!guildId) continue;
        const guild = this.client.guilds.cache.get(guildId);
        if (guild) {
          await guild.commands.set(commandsJson);
          logger.success(`Slash commands registered to guild: ${guild.name}`);
          registered = true;
        } else {
          logger.warn(`Guild ${guildId} not found for command registration`);
        }
      }
      if (!registered && this.client.application) {
        await this.client.application.commands.set(commandsJson);
        logger.success('Slash commands registered globally (fallback)');
      }

      this.client.on('interactionCreate', async (interaction) => {
        try {
        if (this.shouldSkipGuild(interaction.guildId)) return;

        if (interaction.isButton() && interaction.customId.startsWith('shannon_clarify:')) {
          await this.handleClarificationButton(interaction);
          return;
        }
        if (interaction.isModalSubmit() && interaction.customId.startsWith('shannon_clarify_submit:')) {
          await this.handleClarificationSubmit(interaction);
          return;
        }
        if (interaction.isButton() && interaction.customId.startsWith('shannon_progress_detail:')) {
          await this.handleProgressDetail(interaction);
          return;
        }
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('shannon_clarify_select:')) {
          await this.handleClarificationSelect(interaction);
          return;
        }

        if (interaction.isButton() && interaction.customId === 'voice_ptt') {
          const handlers = this.voiceManager.setupVoiceInteractions();
          await handlers.handlePtt(interaction);
          return;
        }
        if (interaction.isButton() && interaction.customId === 'voice_generate_response') {
          const handlers = this.voiceManager.setupVoiceInteractions();
          await handlers.handleGenerateResponse(interaction);
          return;
        }

        if (!interaction.isCommand()) return;

        switch (interaction.commandName) {
          case 'minecraft_server_status':
            if (interaction.isChatInputCommand()) {
              const serverName: MinecraftServerName =
                interaction.options.getString(
                  'server_name',
                  true
                ) as MinecraftServerName;
              await interaction.deferReply();
              try {
                // ステータス取得のためにリスナーを設定
                const statusPromise = new Promise<string>((resolve) => {
                  const unsubscribe = this.eventBus.subscribe('web:status', (event) => {
                    const data = event.data as { service: string; status: string };
                    if (data.service === `minecraft:${serverName}`) {
                      unsubscribe();
                      resolve(data.status);
                    }
                  });
                  // 10秒でタイムアウト
                  setTimeout(() => {
                    unsubscribe();
                    resolve('timeout');
                  }, 10000);
                });

                this.eventBus.publish({
                  type: `minecraft:${serverName}:status`,
                  memoryZone: 'minecraft',
                  data: { serviceCommand: 'status' } as ServiceInput,
                });

                const status = await statusPromise;
                const statusEmoji = status === 'running' ? '🟢' : status === 'stopped' ? '🔴' : '⚪';
                await interaction.editReply(`${statusEmoji} **${serverName}**: ${status}`);
              } catch (error) {
                await interaction.editReply('ステータスの取得に失敗しました。');
                logger.error('Status error:', error);
              }
            }
            break;

          case 'minecraft_server_start':
            if (interaction.isChatInputCommand()) {
              const serverName: MinecraftServerName =
                interaction.options.getString(
                  'server_name',
                  true
                ) as MinecraftServerName;
              await interaction.deferReply();
              try {
                // ステータス取得のためにリスナーを設定
                const statusPromise = new Promise<string>((resolve) => {
                  const unsubscribe = this.eventBus.subscribe('web:status', (event) => {
                    const data = event.data as { service: string; status: string };
                    if (data.service === `minecraft:${serverName}`) {
                      unsubscribe();
                      resolve(data.status);
                    }
                  });
                  // 30秒でタイムアウト（起動に時間がかかる）
                  setTimeout(() => {
                    unsubscribe();
                    resolve('timeout');
                  }, 30000);
                });

                this.eventBus.publish({
                  type: `minecraft:${serverName}:status`,
                  memoryZone: 'minecraft',
                  data: { serviceCommand: 'start' } as ServiceInput,
                });

                const status = await statusPromise;
                if (status === 'running') {
                  await interaction.editReply(`🟢 **${serverName}** を起動しました！`);
                } else if (status === 'timeout') {
                  await interaction.editReply(`⏰ **${serverName}** の起動がタイムアウトしました。`);
                } else {
                  await interaction.editReply(`⚠️ **${serverName}** の起動に問題が発生しました。ステータス: ${status}`);
                }
              } catch (error) {
                await interaction.editReply('サーバーの起動に失敗しました。');
                logger.error('Start error:', error);
              }
            }
            break;

          case 'minecraft_server_stop':
            if (interaction.isChatInputCommand()) {
              const serverName: MinecraftServerName =
                interaction.options.getString(
                  'server_name',
                  true
                ) as MinecraftServerName;
              await interaction.deferReply();
              try {
                // 停止開始を通知
                await interaction.editReply(`⏳ **${serverName}** を停止中...\n（ワールド保存に時間がかかる場合があります）`);

                // ステータス取得のためにリスナーを設定
                const statusPromise = new Promise<string>((resolve) => {
                  const unsubscribe = this.eventBus.subscribe('web:status', (event) => {
                    const data = event.data as { service: string; status: string };
                    if (data.service === `minecraft:${serverName}`) {
                      unsubscribe();
                      resolve(data.status);
                    }
                  });
                  // 90秒でタイムアウト（ワールド保存に時間がかかる）
                  setTimeout(() => {
                    unsubscribe();
                    resolve('timeout');
                  }, 90000);
                });

                this.eventBus.publish({
                  type: `minecraft:${serverName}:status`,
                  memoryZone: 'minecraft',
                  data: { serviceCommand: 'stop' } as ServiceInput,
                });

                const status = await statusPromise;
                if (status === 'stopped') {
                  await interaction.editReply(`🔴 **${serverName}** を停止しました！`);
                } else if (status === 'timeout') {
                  await interaction.editReply(`⏰ **${serverName}** の停止がタイムアウトしました。`);
                } else {
                  await interaction.editReply(`⚠️ **${serverName}** の停止に問題が発生しました。ステータス: ${status}`);
                }
              } catch (error) {
                await interaction.editReply('サーバーの停止に失敗しました。');
                logger.error('Stop error:', error);
              }
            }
            break;

          case 'minebot_login':
            if (interaction.isChatInputCommand()) {
              const serverName: MinecraftServerName =
                interaction.options.getString(
                  'server_name',
                  true
                ) as MinecraftServerName;
              await interaction.deferReply();
              try {
                // spawn イベントを待つ（実際にログイン完了まで）
                const spawnPromise = new Promise<{ success: boolean; message?: string }>((resolve) => {
                  // spawnイベントのリスナー
                  const unsubscribeSpawn = this.eventBus.subscribe('minebot:spawned', () => {
                    unsubscribeSpawn();
                    resolve({ success: true });
                  });
                  // エラーイベントのリスナー
                  const unsubscribeError = this.eventBus.subscribe('minebot:error', (event) => {
                    unsubscribeError();
                    resolve({ success: false, message: (event.data as { message?: string })?.message });
                  });
                  // 120秒でタイムアウト（Microsoft認証に時間がかかる場合）
                  setTimeout(() => {
                    unsubscribeSpawn();
                    unsubscribeError();
                    resolve({ success: false, message: 'timeout' });
                  }, 120000);
                });

                // ログイン開始を通知
                await interaction.editReply(`⏳ Minebotを **${serverName}** にログイン中...\n（Microsoft認証が必要な場合、コンソールでコードを確認してください）`);

                this.eventBus.publish({
                  type: 'minebot:bot:status',
                  memoryZone: 'minebot',
                  data: { serviceCommand: 'start', serverName } as MinebotInput,
                });

                const result = await spawnPromise;
                if (result.success) {
                  await interaction.editReply(`🤖 Minebotが **${serverName}** にログインしました！`);
                } else if (result.message === 'timeout') {
                  await interaction.editReply(`⏰ Minebotのログインがタイムアウトしました（120秒）。\nMicrosoft認証が必要な場合はコンソールを確認してください。`);
                } else {
                  await interaction.editReply(`⚠️ Minebotのログインに失敗しました: ${result.message}`);
                }
              } catch (error) {
                await interaction.editReply('Minebotのログインに失敗しました。');
                logger.error('Minebot login error:', error);
              }
            }
            break;

          case 'minebot_logout':
            if (interaction.isChatInputCommand()) {
              await interaction.deferReply();
              try {
                // 完了イベントを待つ
                const logoutPromise = new Promise<{ success: boolean; message?: string }>((resolve) => {
                  const unsubscribe = this.eventBus.subscribe('minebot:stopped', () => {
                    unsubscribe();
                    resolve({ success: true });
                  });
                  // 30秒でタイムアウト
                  setTimeout(() => {
                    unsubscribe();
                    resolve({ success: false, message: 'timeout' });
                  }, 30000);
                });

                this.eventBus.publish({
                  type: 'minebot:bot:status',
                  memoryZone: 'minebot',
                  data: { serviceCommand: 'stop' } as MinebotInput,
                });

                const result = await logoutPromise;
                if (result.success) {
                  await interaction.editReply(`👋 Minebotがログアウトしました！`);
                } else if (result.message === 'timeout') {
                  await interaction.editReply(`⏰ Minebotのログアウトがタイムアウトしました。`);
                } else {
                  await interaction.editReply(`⚠️ Minebotのログアウトに問題が発生しました: ${result.message}`);
                }
              } catch (error) {
                await interaction.editReply('Minebotのログアウトに失敗しました。');
                logger.error('Minebot logout error:', error);
              }
            }
            break;

          case 'vote':
            if (interaction.isChatInputCommand()) {
              const description = interaction.options.getString('description', true);
              const options = interaction.options.getString('options', true);
              const duration = interaction.options.getString('duration', true);
              const maxVotes = interaction.options.getInteger('max_votes', true);
              await this.sendVoteMessage(interaction, description, options, duration, maxVotes);
            }
            break;
          case 'dice':
            if (interaction.isChatInputCommand()) {
              const count = interaction.options.getInteger('count', true);
              await this.sendDiceMessage(interaction, count);
            }
            break;

          case 'voice_join':
            if (interaction.isChatInputCommand()) {
              await this.voiceManager.handleVoiceJoin(interaction);
            }
            break;

          case 'voice_leave':
            if (interaction.isChatInputCommand()) {
              await this.voiceManager.handleVoiceLeave(interaction);
            }
            break;

          case 'generate_fillers':
            if (interaction.isChatInputCommand()) {
              await this.voiceManager.handleGenerateFillers(interaction);
            }
            break;

          case 'voice_mode':
            if (interaction.isChatInputCommand()) {
              const mode = interaction.options.getString('mode', true) as 'chat' | 'minebot';
              const guildId = interaction.guildId;
              if (!guildId) {
                await interaction.reply({ content: 'サーバー内で使用してください。', ephemeral: true });
                break;
              }
              this.voiceManager.handleVoiceModeCommand(guildId, mode);
              const modeLabel = mode === 'minebot' ? 'Minebot（Minecraft操作）' : 'Chat（通常会話）';
              await interaction.reply(`音声モードを **${modeLabel}** に切り替えました。`);
            }
            break;
        }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes('Unknown interaction')) {
            logger.warn(`[Discord] Interaction expired (token timed out): ${interaction.isCommand() ? interaction.commandName : interaction.isButton() ? interaction.customId : 'unknown'}`);
          } else {
            logger.error(`[Discord] Interaction handler error: ${errMsg}`);
          }
          if (interaction.isRepliable()) {
            const response = {
              content: '操作の処理に失敗しました。回答は保存されているので、もう一度お試しください。',
              flags: MessageFlags.Ephemeral,
            } as const;
            if (interaction.deferred || interaction.replied) {
              await interaction.followUp(response).catch(() => undefined);
            } else {
              await interaction.reply(response).catch(() => undefined);
            }
          }
        }
      });
      logger.success('Slash command setup completed');
    } catch (error) {
      logger.error(`Slash command setup error: ${error}`);
    }
  }

  private async sendDiceMessage(interaction: ChatInputCommandInteraction, count: number) {
    if (count < 1 || count > 10) {
      await interaction.reply('ダイスの個数は1~10で指定してください。');
      return;
    }
    // ダイスを振る
    const results = Array.from({ length: count }, () => Math.floor(Math.random() * 6) + 1);

    const diceSize = 32; // 1個あたりのサイズ（px）
    const canvasSize = diceSize * 1.5;

    const diceImages = await Promise.all(results.map(async (num) => {
      // 1. 画像読み込み
      let img = await Jimp.Jimp.read(path.join(__dirname, '../../../saves/images/dice/', `dice_${num}.png`));
      // 2. リサイズ
      const img2 = img.resize({ w: diceSize, h: diceSize });
      // 3. 回転
      const angle = Math.floor(Math.random() * 360);
      const img3 = img2.rotate(angle);

      // 4. はみ出し防止: 新しいキャンバスに中央配置
      const canvas = new Jimp.Jimp({ width: canvasSize, height: canvasSize, color: 0x00000000 });
      const x = (canvasSize - img3.bitmap.width) / 2;
      const y = (canvasSize - img3.bitmap.height) / 2;
      canvas.composite(img3, x, y);

      return canvas;
    }));

    // 横に結合
    const resultImage = new Jimp.Jimp({ width: canvasSize * count, height: canvasSize, color: 0x00000000 });
    diceImages.forEach((img, i) => {
      resultImage.composite(img, i * canvasSize, 0);
    });

    // 一時ファイルとして保存
    const filePath = path.join(__dirname, '../../../saves/images/dice', `dice_result_${Date.now()}.png`);
    await resultImage.write(filePath as `${string}.${string}`);
    interaction.reply({
      content: `🎲 ${count}個の6面ダイスを振った結果（合計: ${results.reduce((a, b) => a + b, 0)}）`,
      files: [filePath]
    });
    // 2秒後に一時ファイルを削除
    await new Promise(resolve => setTimeout(resolve, 2000));
    fs.unlinkSync(filePath);
    logger.info("ファイル削除");
  }

  /**
 * 投票メッセージを送信する関数
 * @param interaction DiscordのスラッシュコマンドなどのInteraction
 * @param options カンマ区切りの投票候補（例: "選択肢A,選択肢B,選択肢C"）
 * @param duration 投票期間（'1m', '1h', '1d', '1w' のいずれか）
 */
  private async sendVoteMessage(
    interaction: ChatInputCommandInteraction,
    description: string,
    options: string,
    duration: string,
    maxVotes: number
  ) {
    const optionList = options.split(',').map(opt => opt.trim());
    const voteId = `vote_${Date.now()}`;
    const voteState: { [userId: string]: number[] } = {};
    const voteCounts: number[] = Array(optionList.length).fill(0);

    const components = optionList.map((option, index) => {
      const customId = `${voteId}_option_${index}`;
      return new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(`0票 | ${option}`)
        .setStyle(ButtonStyle.Secondary);
    });

    // ボタンを5個ずつのActionRowにまとめる
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < components.length; i += 5) {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...components.slice(i, i + 5)));
    }

    const embed = new EmbedBuilder()
      .setTitle('📊 投票を開始します！')
      .setDescription(description + '\n' + '一人あたり' + maxVotes + '票まで投票できます。')
      .setColor(0x00ae86)
      .setFooter({ text: `投票終了まで: ${duration}` });

    const message = await interaction.reply({
      embeds: [embed],
      components: rows,
      fetchReply: true,
    });

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: voteDurations[duration] ?? voteDurations['1h'],
    });

    collector.on('collect', async i => {
      const userId = i.user.id;
      const pressedIndex = parseInt(i.customId.split('_').pop() || '0', 10);
      if (!voteState[userId]) voteState[userId] = [];

      // 既にこの候補に投票している場合は投票解除
      if (voteState[userId].includes(pressedIndex)) {
        voteState[userId] = voteState[userId].filter(idx => idx !== pressedIndex);
        voteCounts[pressedIndex]--;
      } else {
        // まだ投票していなくて、最大票数未満なら投票追加
        if (voteState[userId].length < maxVotes) {
          voteState[userId].push(pressedIndex);
          voteCounts[pressedIndex]++;
        } else {
          // 最大票数に達している場合は何もしない or メッセージ
          await i.reply({ content: `あなたは最大${maxVotes}票まで投票できます。`, ephemeral: true });
          return;
        }
      }

      // ボタンの状態更新
      const newComponents = optionList.map((option, index) => {
        const customId = `${voteId}_option_${index}`;
        const isVoted = voteState[userId].includes(index);
        return new ButtonBuilder()
          .setCustomId(customId)
          .setLabel(`${voteCounts[index]}票 | ${option}`)
          .setStyle(isVoted ? ButtonStyle.Success : ButtonStyle.Secondary);
      });

      // ボタンを5個ずつのActionRowにまとめる
      const newRows: ActionRowBuilder<ButtonBuilder>[] = [];
      for (let i = 0; i < newComponents.length; i += 5) {
        newRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...newComponents.slice(i, i + 5)));
      }

      await i.update({ components: newRows });
    });

    collector.on('end', async () => {
      const results = optionList
        .map((option, index) => `- ${option}: ${voteCounts[index]}票`)
        .join('\n');

      const resultEmbed = new EmbedBuilder()
        .setTitle('📊 投票結果')
        .setDescription(results)
        .setColor(0x00ae86);

      await message.edit({ embeds: [resultEmbed], components: [] });
    });
  }

  private getUserNickname(user: User, guildId?: string) {
    // ギルドIDが指定されていて、そのギルドのメンバーが取得できる場合
    if (guildId) {
      const guild = this.client.guilds.cache.get(guildId);
      if (guild) {
        const member = guild.members.cache.get(user.id);
        if (member && member.nickname) {
          return member.nickname;
        }
      }
    }

    // ギルドのニックネームがない場合はグローバル表示名を使用
    if (user.displayName) {
      return user.displayName;
    }

    // どちらもない場合はユーザー名を使用
    return user.username;
  }

  private getChannelName(channelId: string) {
    const channel = this.client.channels.cache.get(channelId);
    if (channel instanceof TextChannel) {
      return channel.name;
    }
    if (channel instanceof ThreadChannel) {
      return `${channel.parent?.name ?? 'unknown'}/${channel.name}`;
    }
    return channelId;
  }

  private getGuildName(channelId: string) {
    const channel = this.client.channels.cache.get(channelId);
    if (channel && 'guild' in channel) {
      return channel.guild.name;
    }
    return channelId;
  }

  private setupEventHandlers() {
    this.eventBus.subscribe('discord:status', async (event) => {
      const { serviceCommand } = event.data as DiscordClientInput;
      if (serviceCommand === 'start') {
        await this.start();
      } else if (serviceCommand === 'stop') {
        await this.stop();
      } else if (serviceCommand === 'status') {
        this.eventBus.publish({
          type: 'web:status',
          memoryZone: 'web',
          data: {
            service: 'discord',
            status: this.status,
          },
        });
      }
    });
    // スレッドが作成されたら自動参加（メッセージ受信のため）
    this.client.on('threadCreate', async (thread) => {
      if (!thread.joinable) return;
      try {
        await thread.join();
        logger.info(`[Discord] スレッドに参加: ${thread.name} (${thread.id})`);
      } catch (err) {
        logger.warn(`[Discord] スレッド参加失敗: ${thread.name}: ${err}`);
      }
    });

    this.client.on('messageCreate', async (message) => {
      try {
      // 全メッセージのデバッグログ（スレッド問題調査用）
      const isThread = message.channel?.isThread?.();
      if (isThread) {
        logger.info(`[Discord] スレッド内メッセージ受信: ch=${message.channelId} author=${message.author?.username} content="${message.content?.substring(0, 50)}"`);
      }

      if (this.status !== 'running') {
        if (isThread) logger.info(`[Discord] スレッドメッセージスキップ: status=${this.status}`);
        return;
      }
      // Partial メッセージの場合はfetchして完全なデータを取得
      if (message.partial) {
        try {
          message = await message.fetch();
        } catch (err) {
          logger.warn(`[Discord] Partial メッセージのfetch失敗: ${err}`);
          return;
        }
      }
      if (this.shouldSkipGuild(message.guildId)) {
        if (isThread) logger.info(`[Discord] スレッドメッセージスキップ: isDev=${this.isDev} guildId=${message.guildId}`);
        return;
      }

      logger.info(message.content);

      if (message.author.bot) return;
      const mentions = message.mentions.users.map((user) => ({
        nickname: this.getUserNickname(user, message.guildId ?? ''),
        id: user.id,
        isBot: user.bot,
      }));

      // mentionに自分が含まれているかどうかを確認
      const isMentioned = mentions.some(
        (mention) => mention.id === this.client.user?.id
      );
      if (mentions.length > 0 && !isMentioned) {
        if (isThread) logger.info(`[Discord] スレッドメッセージスキップ: 他ユーザーへのメンション`);
        return;
      }

      if (message.channelId === this.aiminelabUpdateChannelId) return;

      // アイマイラボ！サーバーではメンション時のみ返信
      if (message.guildId === this.aiminelabGuildId && !isMentioned) return;

      const messageContent = message.content.replace(
        /<@!?(\d+)>/g,
        (match, id) => {
          const mentionedUser = mentions.find((user) => user.id === id);
          return mentionedUser ? `@${mentionedUser.nickname}` : match;
        }
      );
      const nickname = this.getUserNickname(
        message.author,
        message.guildId ?? ''
      );
      const channelName = this.getChannelName(message.channelId);
      const guildName = this.getGuildName(message.channelId);
      const memoryZone = await getDiscordMemoryZone(message.guildId ?? '');
      const messageId = message.id;
      const userId = message.author.id;
      const guildId = message.guildId;
      const recentMessages = await this.getRecentMessages(message.channelId);

      // 画像URLを取得
      const imageUrls = message.attachments
        .filter((attachment) => attachment.contentType?.startsWith('image/'))
        .map((attachment) => attachment.url);

      // 返信先メッセージの画像URLを取得
      let replyContext = '';
      if (message.reference?.messageId) {
        try {
          const refMsg = await message.fetchReference();
          const refNickname = this.getUserNickname(refMsg.author, refMsg.guildId ?? '');
          const refImageUrls = refMsg.attachments
            .filter((att) => att.contentType?.startsWith('image/'))
            .map((att) => att.url);
          const refEmbedImages = refMsg.embeds
            .filter((e) => e.image?.url)
            .map((e) => e.image!.url);
          const allRefImages = [...refImageUrls, ...refEmbedImages];

          replyContext = `[返信先: ${refNickname}「${refMsg.content?.substring(0, 100) || ''}」`;
          if (allRefImages.length > 0) {
            replyContext += `\n返信先の画像: ${allRefImages.join('\n')}`;
          }
          replyContext += ']\n';
        } catch (err) {
          logger.warn(`[Discord] 返信先メッセージの取得に失敗: ${err}`);
        }
      }

      // スレッドの場合、スレッドの元投稿（スターターメッセージ）の画像をコンテキストに含める
      let threadStarterContext = '';
      const channelObj = this.client.channels.cache.get(message.channelId);
      if (channelObj instanceof ThreadChannel) {
        try {
          const starterMessage = await channelObj.fetchStarterMessage();
          if (starterMessage) {
            const starterImageUrls = starterMessage.attachments
              .filter((att) => att.contentType?.startsWith('image/'))
              .map((att) => att.url);
            const starterEmbedImages = starterMessage.embeds
              .filter((e) => e.image?.url)
              .map((e) => e.image!.url);
            const allStarterImages = [...starterImageUrls, ...starterEmbedImages];
            if (allStarterImages.length > 0) {
              const starterNickname = this.getUserNickname(starterMessage.author, starterMessage.guildId ?? '');
              threadStarterContext = `[スレッド元投稿: ${starterNickname}「${starterMessage.content?.substring(0, 100) || ''}」\nスレッド元投稿の画像: ${allStarterImages.join('\n')}]\n`;
            }
          }
        } catch (err) {
          logger.warn(`[Discord] スレッドスターターメッセージの取得に失敗: ${err}`);
        }
      }

      // テキストと画像URLを結合
      let contentWithImages = messageContent;
      if (imageUrls.length > 0) {
        contentWithImages += `\n画像: ${imageUrls.join('\n')}`;
      }
      if (replyContext) {
        contentWithImages = replyContext + contentWithImages;
      }
      if (threadStarterContext) {
        contentWithImages = threadStarterContext + contentWithImages;
      }

      // スレッドの場合は親チャンネルIDでフィルタリング
      const channel = this.client.channels.cache.get(message.channelId);
      const parentChannelId = (channel instanceof ThreadChannel)
        ? channel.parentId ?? message.channelId
        : message.channelId;

      if (
        guildId === this.toyamaGuildId &&
        parentChannelId !== this.toyamaChannelId
      )
        return;
      if (
        guildId === this.doukiGuildId &&
        parentChannelId !== this.doukiChannelId
      )
        return;
      if (
        guildId === this.colabGuildId &&
        parentChannelId !== this.colabChannelId
      )
        return;
      this.eventBus.log(
        memoryZone,
        'white',
        `${guildName} ${channelName}\n${nickname}: ${contentWithImages}`,
        true
      );
      logger.info(guildName + ' ' + channelName, 'blue');
      logger.info(nickname + ': ' + contentWithImages, 'blue');
      this.eventBus.publish({
        type: 'llm:get_discord_message',
        memoryZone: memoryZone,
        data: {
          text: contentWithImages,
          type: 'text',
          guildName: memoryZone,
          channelId: message.channelId,
          guildId: guildId,
          channelName: channelName,
          userName: nickname,
          messageId: messageId,
          userId: userId,
          recentMessages: recentMessages,
        } as DiscordSendTextMessageOutput,
      });
      } catch (err) {
        logger.error('[Discord] messageCreate ハンドラエラー:', err);
      }
    });
    this.client.on('speech', async (speech) => {
      if (this.status !== 'running') return;
      // テストモードの場合はテストサーバーのみ、それ以外の場合はテストサーバー以外を処理
      const channel = this.client.channels.cache.get(speech.channelId);
      if (!channel || !('guild' in channel)) return;

      if (this.shouldSkipGuild(channel.guild.id)) return;

      const memoryZone = await getDiscordMemoryZone(channel.guildId);

      const nickname = this.getUserNickname(speech.user, channel.guildId);
      this.eventBus.publish({
        type: 'llm:get_discord_message',
        memoryZone: memoryZone,
        data: {
          audio: speech.content,
          type: 'realtime_audio',
          channelId: speech.channelId,
          userName: nickname,
          guildId: channel.guild.id,
          guildName: channel.guild.name,
          channelName: channel.name,
          messageId: speech.messageId,
          userId: speech.userId,
        } as DiscordClientInput,
      });
    });

    // LLMからの応答を処理
    this.eventBus.subscribe('discord:post_message', async (event) => {
      if (this.status !== 'running') return;
      let { text, channelId, guildId, imageUrl, artifactIds } =
        event.data as DiscordSendTextMessageInput;

      if (voiceResponseChannelIds.has(channelId) && !text?.startsWith('🎤')) {
        logger.info(`[Discord] Voice processing active, skipping normal text post for channel ${channelId}`, 'yellow');
        return;
      }

      const channel = this.client.channels.cache.get(channelId);
      const channelName = this.getChannelName(channelId);
      const guildName = this.getGuildName(channelId);
      const memoryZone = await getDiscordMemoryZone(guildId);

      if (channel?.isTextBased() && 'send' in channel) {
        this.eventBus.log(
          memoryZone,
          'white',
          `${guildName} ${channelName}\nShannon: ${text}`,
          true
        );
        logger.info(guildName + ' ' + channelName, 'blue');
        logger.info('shannon: ' + text, 'blue');
        if (artifactIds?.length) {
          try {
            const bundles = await Promise.all(
              [...new Set(artifactIds)].slice(0, 3).map((id) => getArtifactStore().resolveBundle(id)),
            );
            const files = bundles.flatMap((bundle) => bundle.files)
              .filter((file) => file.role !== 'html')
              .slice(0, 10).map(
              (file) => new AttachmentBuilder(file.absolutePath, { name: file.fileName }),
            );
            const chunks = splitDiscordMessage(text ?? '');
            await channel.send({ content: chunks[0]?.slice(0, 2000) || undefined, files });
            for (let i = 1; i < chunks.length; i++) {
              await channel.send(chunks[i]);
            }
          } catch (artifactError) {
            logger.error('[Discord] 成果物送信エラー:', artifactError);
            await sendLongMessage(
              channel as TextChannel,
              `${text ?? ''}\n\n（ファイルの添付に失敗しました。少し待ってから再生成してください）`,
            );
          }
        } else if (imageUrl) {
          const content = (text ?? '').slice(0, 2000);
          try {
            // ローカルファイルパスの場合はAttachmentBuilderで添付
            if (imageUrl.startsWith('/') || imageUrl.startsWith('./') || imageUrl.startsWith('../')) {
              if (fs.existsSync(imageUrl)) {
                const fileName = path.basename(imageUrl);
                const attachment = new AttachmentBuilder(imageUrl, { name: fileName });
                await channel.send({ content, files: [attachment] });
              } else {
                logger.warn(`[Discord] 画像ファイルが見つかりません: ${imageUrl}`);
                await channel.send({ content: content + '\n(画像ファイルが見つかりませんでした)' });
              }
            } else {
              // 外部URLの場合はembed
              const embed = { image: { url: imageUrl } };
              await channel.send({ content, embeds: [embed] });
            }
          } catch (imgError) {
            logger.error('[Discord] 画像送信エラー:', imgError);
            // 画像送信失敗時はテキストだけ送信（クラッシュ防止）
            await sendLongMessage(channel as TextChannel, text ?? '');
          }
        } else {
          await sendLongMessage(channel as TextChannel, text ?? '');
        }
      }
    });
    this.eventBus.subscribe('discord:scheduled_post', async (event) => {
      if (this.status !== 'running') return;
      const { text, command, imageBuffer } = event.data as DiscordScheduledPostInput;
      if (
        command === 'forecast' ||
        command === 'fortune' ||
        command === 'about_today' ||
        command === 'news_today'
      ) {
        const message = text ?? '';

        const sendScheduledPost = async (channel: TextChannel) => {
          if (imageBuffer) {
            try {
              const attachment = new AttachmentBuilder(imageBuffer, { name: `${command}.jpg` });
              const chunks = splitDiscordMessage(message);
              await channel.send({ content: chunks[0], files: [attachment] });
              for (let i = 1; i < chunks.length; i++) {
                await channel.send(chunks[i]);
              }
            } catch (imgErr) {
              logger.error('[Discord] 定期投稿の画像送信エラー:', imgErr);
              await sendLongMessage(channel, message);
            }
          } else {
            await sendLongMessage(channel, message);
          }
        };

        if (this.isDev) {
          const xChannelId = this.testXChannelId ?? '';
          const channel = this.client.channels.cache.get(xChannelId);
          if (channel?.isTextBased() && 'send' in channel) {
            await sendScheduledPost(channel as TextChannel);
          }
        } else {
          if (event.memoryZone === 'discord:colab_server') {
            const colabChannel = this.client.channels.cache.get(
              this.colabChannelId ?? ''
            );
            if (colabChannel?.isTextBased() && 'send' in colabChannel) {
              await sendScheduledPost(colabChannel as TextChannel);
            }
          } else if (event.memoryZone === 'discord:douki_server') {
            const doukiChannel = this.client.channels.cache.get(
              this.doukiChannelId ?? ''
            );
            if (doukiChannel?.isTextBased() && 'send' in doukiChannel) {
              await sendScheduledPost(doukiChannel as TextChannel);
            }
          } else if (event.memoryZone === 'discord:toyama_server') {
            const toyamaChannel = this.client.channels.cache.get(
              this.toyamaChannelId ?? ''
            );
            if (toyamaChannel?.isTextBased() && 'send' in toyamaChannel) {
              await sendScheduledPost(toyamaChannel as TextChannel);
            }
          } else if (event.memoryZone === 'discord:test_server') {
            const testChannelId = this.testXChannelId ?? '';
            const channel = this.client.channels.cache.get(testChannelId);
            if (channel?.isTextBased() && 'send' in channel) {
              await sendScheduledPost(channel as TextChannel);
            }
          } else {
            const xChannelId = this.aiminelabXChannelId ?? '';
            const channel = this.client.channels.cache.get(xChannelId);
            if (channel?.isTextBased() && 'send' in channel) {
              await sendScheduledPost(channel as TextChannel);
            }
          }
        }
        return;
      }
    });
    this.eventBus.subscribe('discord:get_server_emoji', async (event) => {
      if (this.status !== 'running') return;
      const data = event.data as DiscordGetServerEmojiInput;
      const { guildId } = data;
      const guild = this.client.guilds.cache.get(guildId);
      const memoryZone = await getDiscordMemoryZone(guildId);
      if (guild) {
        const emojis = guild.emojis.cache.map((emoji) => emoji.toString());
        this.eventBus.publish({
          type: 'tool:get_server_emoji',
          memoryZone: memoryZone,
          data: {
            emojis: emojis,
          } as DiscordGetServerEmojiOutput,
        });
      }
    });
    this.eventBus.subscribe('discord:send_server_emoji', async (event) => {
      if (this.status !== 'running') return;
      try {
        const data = event.data as DiscordSendServerEmojiInput;
        const { guildId, channelId, messageId, emojiId } = data;
        const guild = this.client.guilds.cache.get(guildId);
        const channel = this.client.channels.cache.get(channelId);
        if (!channel?.isTextBased() || !('messages' in channel)) return;
        const message = await channel.messages.fetch(messageId);
        if (message) {
          // サーバーカスタム絵文字を探す
          const serverEmoji = guild?.emojis.cache.get(emojiId);
          if (serverEmoji) {
            await message.react(serverEmoji);
          } else {
            // Unicode 絵文字としてそのまま使う（例: "😂", "👍"）
            await message.react(emojiId);
          }
        }
        this.eventBus.publish({
          type: 'tool:send_server_emoji',
          memoryZone: 'null',
          data: {
            isSuccess: true,
            errorMessage: '',
          } as DiscordSendServerEmojiOutput,
        });
      } catch (error) {
        const sErr = classifyError(error, 'discord');
        logger.error(`Error sending server emoji: ${formatErrorForLog(sErr)}`);
        this.eventBus.publish({
          type: 'tool:send_server_emoji',
          memoryZone: 'null',
          data: {
            isSuccess: false,
            errorMessage: sErr.message,
          } as DiscordSendServerEmojiOutput,
        });
      }
    });
    this.eventBus.subscribe('discord:planning', async (event) => {
      if (this.status !== 'running') return;
      const { planning, channelId, taskId } = event.data as DiscordPlanningInput;
      const channel = this.client.channels.cache.get(channelId)
        ?? await this.client.channels.fetch(channelId).catch(() => null);
      logger.info(`discord:planning ${taskId}`);
      if (!channel?.isTextBased() || !('send' in channel) || !('messages' in channel)) return;
      this.progressDetails.set(taskId, planning);
      const tracked = this.progressMessages.get(taskId);

      if (planning.status === 'completed') {
        if (tracked) {
          const message = await channel.messages.fetch(tracked.messageId).catch(() => null);
          if (message) await message.delete().catch(() => undefined);
        }
        this.progressMessages.delete(taskId);
        this.progressDetails.delete(taskId);
        this.progressExpanded.delete(taskId);
        return;
      }

      if (planning.status === 'error') {
        const startedAt = tracked?.startedAt ?? Date.now();
        const failureEmbed = this.buildProgressFailureEmbed(planning, startedAt);
        if (tracked) {
          const message = await channel.messages.fetch(tracked.messageId).catch(() => null);
          if (message) await message.edit({ embeds: [failureEmbed], components: [] });
        } else {
          await channel.send({ embeds: [failureEmbed] });
        }
        this.progressMessages.delete(taskId);
        this.progressDetails.delete(taskId);
        this.progressExpanded.delete(taskId);
        return;
      }

      const startedAt = tracked?.startedAt ?? Date.now();
      const expanded = this.progressExpanded.has(taskId);
      const embed = this.buildProgressEmbed(planning, startedAt, expanded);
      const controls = this.buildProgressControls(taskId, expanded);
      if (tracked) {
        const message = await channel.messages.fetch(tracked.messageId).catch(() => null);
        if (message) {
          await message.edit({ embeds: [embed], components: [controls] });
          return;
        }
      }
      const sent = await channel.send({ embeds: [embed], components: [controls] });
      this.progressMessages.set(taskId, { channelId, messageId: sent.id, startedAt });
    });
    this.eventBus.subscribe('discord:request_clarification', async (event) => {
      if (this.status !== 'running') return;
      const input = event.data as DiscordClarificationInput;
      const channel = this.client.channels.cache.get(input.channelId)
        ?? await this.client.channels.fetch(input.channelId).catch(() => null);
      if (!channel?.isTextBased() || !('send' in channel)) return;

      const session = await getClarificationSessionStore().create(input);
      const embed = this.buildClarificationEmbed(session);
      const sent = await channel.send({ embeds: [embed], components: this.buildClarificationComponents(session) });
      await getClarificationSessionStore().attachMessage(session.clarificationId, sent.id);
    });
    this.eventBus.subscribe('youtube:subscriber_update', async (event) => {
      if (this.status !== 'running') return;
      const data = event.data as YoutubeSubscriberUpdateOutput;
      const { subscriberCount } = data;
      const guildId = config.discord.guilds.aimine.guildId;
      const guild = this.client.guilds.cache.get(guildId);
      if (guild) {
        const channel = guild.channels.cache.get(
          this.aiminelabAnnounceChannelId ?? ''
        );
        if (channel?.isTextBased() && 'send' in channel) {
          channel.send(`現在のチャンネル登録者数は${subscriberCount}人です。`);
        }
      }
    });
  }

  private buildClarificationEmbed(session: ClarificationSession, completed = false): EmbedBuilder {
    const lines = completed && session.answers
      ? session.questions.map((question) => `**${question.label}**\n${session.answers?.[question.id] || '指定なし'}`)
      : session.questions.map((question, index) => {
        const options = question.options?.length
          ? `\n候補: ${question.options.map((option, optionIndex) => `${optionIndex + 1}. ${option}`).join(' / ')} / その他（自由入力）`
          : question.kind === 'number'
            ? '\n数値で入力（補足も可）'
            : '\n自由入力';
        return `**${index + 1}. ${question.label}**${question.description ? `\n${question.description}` : ''}${options}`;
      });
    if (completed && session.answers?.['推奨条件']) {
      lines.unshift(`**承認した条件**\n${session.answers['推奨条件']}`);
    }
    return new EmbedBuilder()
      .setColor(completed ? 0x57f287 : 0x5b8def)
      .setTitle(completed ? '要件を受け取りました' : '少しだけ確認させてください')
      .setDescription([
        !completed && session.proposal ? `**推奨条件**\n${session.proposal}` : null,
        ...lines,
        completed ? '\n回答を反映して処理を再開します。' : '\n選択肢に合わない場合は、そのまま自由に入力できます。',
      ].filter(Boolean).join('\n\n').slice(0, 4000))
      .setFooter({ text: completed ? 'Shannon • 再開中' : 'Shannon • 回答待ち（24時間有効）' });
  }

  private buildClarificationComponents(session: ClarificationSession): Array<ActionRowBuilder<any>> {
    const rows: Array<ActionRowBuilder<any>> = [];
    session.questions.forEach((question, index) => {
      if (rows.length >= 4) return;
      if (question.kind !== 'single_select' && question.kind !== 'multi_select' && question.kind !== 'confirm') return;
      const sourceOptions = question.options?.length
        ? question.options
        : question.kind === 'confirm' ? ['はい', 'いいえ'] : [];
      const options = sourceOptions.slice(0, 7).map((option, optionIndex) => ({
        label: option.slice(0, 100),
        value: `option_${optionIndex}`,
        description: option.length > 100 ? option.slice(100, 200) : undefined,
      }));
      options.push({ label: 'その他（自由入力）', value: '__custom__', description: '選択肢にない内容を入力' });
      const select = new StringSelectMenuBuilder()
        .setCustomId(`shannon_clarify_select:${session.clarificationId}:${index}`)
        .setPlaceholder(question.label.slice(0, 150))
        .addOptions(options)
        .setMinValues(question.required === false ? 0 : 1)
        .setMaxValues(question.kind === 'multi_select' ? options.length : 1);
      rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
    });

    const buttons = new ActionRowBuilder<ButtonBuilder>();
    if (session.proposal) {
      buttons.addComponents(
        new ButtonBuilder().setCustomId(`shannon_clarify:accept:${session.clarificationId}`)
          .setLabel('この条件で開始').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`shannon_clarify:edit:${session.clarificationId}`)
          .setLabel('条件を変更').setStyle(ButtonStyle.Secondary),
      );
    } else {
      buttons.addComponents(
        new ButtonBuilder().setCustomId(`shannon_clarify:edit:${session.clarificationId}`)
          .setLabel('回答を送信').setStyle(ButtonStyle.Primary),
      );
    }
    rows.push(buttons);
    return rows;
  }

  private buildProgressControls(taskId: string, expanded: boolean): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`shannon_progress_detail:${taskId}`.slice(0, 100))
        .setLabel(expanded ? '詳細を隠す' : '詳細を表示')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  private buildProgressFailureEmbed(planning: TaskTreeState, startedAt: number): EmbedBuilder {
    const tasks = planning.hierarchicalSubTasks ?? [];
    const completed = tasks.filter((task) => task.status === 'completed').length;
    const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const rawReason = planning.error || planning.strategy || planning.lastFailureType || '不明なエラー';
    const timeout = rawReason.match(/LLM timeout \((\d+)s\)/i);
    const incompleteToolResults = /tool_calls.*tool messages|INVALID_TOOL_RESULTS/i.test(rawReason);
    const reason = timeout
      ? `AIモデルが${timeout[1]}秒以内に応答を完了できませんでした。`
      : incompleteToolResults
        ? '内部のツール実行履歴に不整合が発生しました。'
        : rawReason.replace(/^\s*エラー\s*:\s*/u, '').split(/\n\s*Troubleshooting URL:/i)[0].slice(0, 500);
    const progress = tasks.length > 0
      ? completed === tasks.length
        ? `${completed}件の処理は完了しましたが、結果の生成中に停止しました。`
        : `${completed}/${tasks.length}ステップ完了後に停止しました。`
      : '処理の開始後に停止しました。';
    return new EmbedBuilder()
      .setColor(0xed4245)
      .setAuthor({ name: 'シャノン • 処理失敗' })
      .setTitle('処理を完了できませんでした')
      .setDescription([
        `**原因**\n${reason}`,
        `**状況**\n${progress}`,
        '作業中の詳細ログは片付けました。同じ依頼を送ると再試行できます。',
      ].join('\n\n'))
      .setFooter({ text: `Shannon • 失敗 • ${elapsed}秒` });
  }

  private buildProgressEmbed(planning: TaskTreeState, startedAt: number, expanded = false): EmbedBuilder {
    const statusEmoji = (task: { status: string; recoverable?: boolean | null }) =>
      task.status === 'error' && task.recoverable === true
        ? '↻'
        : ({ completed: '✅', in_progress: '⏳', pending: '○', error: '⚠️' }[task.status] ?? '•');
    const compact = (value: string, limit: number) => {
      const normalized = value.replace(/\s+/g, ' ').trim();
      return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
    };
    const tasks = planning.hierarchicalSubTasks ?? [];
    const completed = tasks.filter((task) => task.status === 'completed').length;
    const readableGoal = (goal: string) => {
      const toolName = goal.match(/^([^ (]+)\(/)?.[1];
      const labels: Record<string, string> = {
        'google-search': 'Webで情報を検索',
        'search-places': '候補地を検索',
        'fetch-url': '公式ページを確認',
        'compute-route': '移動ルートを計算',
        'create-travel-brief': '旅行PDFを作成',
        'send-artifact-on-discord': 'PDFをDiscordへ送信',
      };
      return toolName && labels[toolName] ? labels[toolName] : goal;
    };
    const taskLine = (task: (typeof tasks)[number], includeResult: boolean) => {
      const indent = '\u00a0'.repeat(Math.min(task.depth ?? 0, 3) * 2);
      const result = task.failureReason ?? task.result;
      const retrying = task.status === 'error' && task.recoverable === true;
      const label = retrying ? `${readableGoal(task.goal)}（別の方法で続行）` : readableGoal(task.goal);
      return `${indent}${statusEmoji(task)} ${compact(label, 180)}`
        + (includeResult && result ? `\n${indent}  ↳ ${compact(result, 220)}` : '');
    };
    const inProgressTasks = tasks.filter((task) => task.status === 'in_progress');
    const blockingErrors = tasks.filter((task) => task.status === 'error' && task.recoverable !== true);
    const recoverableErrors = tasks.filter((task) => task.status === 'error' && task.recoverable === true);
    const activeTasks = inProgressTasks.length > 0
      ? [...inProgressTasks, ...blockingErrors]
      : [...blockingErrors, ...recoverableErrors.slice(-1)];
    const collapsedTasks = (activeTasks.length > 0
      ? activeTasks
      : tasks.filter((task) => task.status === 'completed').slice(-1)
    ).slice(0, 3);
    const collapsedLines = collapsedTasks.map((task) => taskLine(task, false));
    const hiddenCount = Math.max(0, tasks.length - collapsedTasks.length);
    if (hiddenCount > 0) collapsedLines.push(`…ほか ${hiddenCount} 件`);

    const detailLines: string[] = [];
    let detailLength = 0;
    for (const task of tasks) {
      const line = taskLine(task, true);
      if (detailLength + line.length > 3_100) {
        detailLines.push(`…ほか ${tasks.length - detailLines.length} 件`);
        break;
      }
      detailLines.push(line);
      detailLength += line.length;
    }
    const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const awaiting = planning.recoveryStatus === 'awaiting_user';
    const summary = planning.currentThinking || planning.strategy;
    return new EmbedBuilder()
      .setColor(planning.status === 'error' ? 0xed4245 : awaiting ? 0xfee75c : 0x5b8def)
      .setAuthor({ name: awaiting ? 'シャノン • 回答待ち' : 'シャノン • 作業中' })
      .setTitle(compact(planning.goal, 180))
      .setDescription([
        summary ? compact(summary, expanded ? 600 : 280) : null,
        expanded
          ? (detailLines.length ? detailLines.join('\n\n') : 'まだ詳細な手順はありません。')
          : (collapsedLines.length ? collapsedLines.join('\n') : null),
      ].filter(Boolean).join('\n\n').slice(0, 4000))
      .setFooter({
        text: `${completed}/${tasks.length || 1} 完了 • ${elapsed}秒 • ${expanded ? '詳細表示中 • ' : ''}完了時に自動で片付きます`,
      });
  }

  private async handleProgressDetail(interaction: ButtonInteraction): Promise<void> {
    const taskId = interaction.customId.replace('shannon_progress_detail:', '');
    const planning = this.progressDetails.get(taskId);
    if (!planning) {
      await interaction.reply({
        content: 'この作業は完了したため、進捗表示は片付けられました。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const expanded = !this.progressExpanded.has(taskId);
    if (expanded) this.progressExpanded.add(taskId);
    else this.progressExpanded.delete(taskId);
    const startedAt = this.progressMessages.get(taskId)?.startedAt ?? Date.now();
    await interaction.update({
      embeds: [this.buildProgressEmbed(planning, startedAt, expanded)],
      components: [this.buildProgressControls(taskId, expanded)],
    });
  }

  private async handleClarificationButton(interaction: ButtonInteraction): Promise<void> {
    const [, action, clarificationId] = interaction.customId.split(':');
    logger.info(`[Clarification] Button received: action=${action}, id=${clarificationId}`);

    // Discord requires an acknowledgement within three seconds. Accepting a proposal
    // never needs to open a modal, so acknowledge it before filesystem/network work.
    const acceptsProposal = action === 'accept';
    if (acceptsProposal) await interaction.deferUpdate();

    const store = getClarificationSessionStore();
    const session = await store.get(clarificationId);
    if (!session || session.status !== 'pending') {
      const response = { content: 'この確認は終了または期限切れです。', flags: MessageFlags.Ephemeral } as const;
      if (interaction.deferred) await interaction.followUp(response);
      else await interaction.reply(response);
      return;
    }
    if (interaction.user.id !== session.requesterUserId) {
      const response = { content: 'この確認には依頼者本人だけが回答できます。', flags: MessageFlags.Ephemeral } as const;
      if (interaction.deferred) await interaction.followUp(response);
      else await interaction.reply(response);
      return;
    }
    if (acceptsProposal && session.proposal) {
      await this.completeClarification(session, buildAcceptedClarificationAnswers(session));
      logger.info(`[Clarification] Accepted and resumed: id=${clarificationId}`);
      return;
    }

    const questionsForModal = session.questions.filter((question) => {
      if (question.kind === 'text' || question.kind === 'number') return true;
      const draft = session.draftAnswers?.[question.id];
      return !draft || draft === '__custom__';
    }).slice(0, 5);
    if (questionsForModal.length === 0) {
      await interaction.deferUpdate();
      await this.completeClarification(session, session.draftAnswers ?? {});
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`shannon_clarify_submit:${clarificationId}`)
      .setTitle('追加情報を入力');
    for (const question of questionsForModal) {
      const optionHint = question.options?.length
        ? question.options.map((option, index) => `${index + 1}:${option}`).join(' / ')
        : question.kind === 'number' ? '数値を入力' : '自由に入力';
      const input = new TextInputBuilder()
        .setCustomId(question.id)
        .setLabel(question.label.slice(0, 45))
        .setStyle(question.kind === 'text' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setPlaceholder(`${optionHint} / その他も自由入力可`.slice(0, 100))
        .setRequired(question.required !== false);
      if (question.defaultValue) input.setValue(question.defaultValue.slice(0, 4000));
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    }
    await interaction.showModal(modal);
  }

  private async handleClarificationSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const [, clarificationId, indexText] = interaction.customId.split(':');
    const store = getClarificationSessionStore();
    const session = await store.get(clarificationId);
    if (!session || session.status !== 'pending') {
      await interaction.reply({ content: 'この確認は終了または期限切れです。', ephemeral: true });
      return;
    }
    if (interaction.user.id !== session.requesterUserId) {
      await interaction.reply({ content: 'この確認には依頼者本人だけが回答できます。', ephemeral: true });
      return;
    }
    const question = session.questions[Number(indexText)];
    if (!question) {
      await interaction.reply({ content: '質問を特定できませんでした。', ephemeral: true });
      return;
    }
    const answer = interaction.values.includes('__custom__')
      ? '__custom__'
      : interaction.values.map((value) => {
        const optionIndex = Number(value.replace('option_', ''));
        return question.options?.[optionIndex]
          ?? (question.kind === 'confirm' ? ['はい', 'いいえ'][optionIndex] : value);
      }).join('、');
    await store.updateDraft(clarificationId, question.id, answer);
    await interaction.reply({
      content: answer === '__custom__'
        ? '「その他」を選びました。「回答を送信」または「条件を変更」から内容を入力してください。'
        : `「${question.label}」を保存しました。`,
      ephemeral: true,
    });
  }

  private async handleClarificationSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const clarificationId = interaction.customId.replace('shannon_clarify_submit:', '');
    const store = getClarificationSessionStore();
    const session = await store.get(clarificationId);
    if (!session || session.status !== 'pending') {
      await interaction.reply({ content: 'この確認は終了または期限切れです。', ephemeral: true });
      return;
    }
    if (interaction.user.id !== session.requesterUserId) {
      await interaction.reply({ content: 'この確認には依頼者本人だけが回答できます。', ephemeral: true });
      return;
    }

    const answers: Record<string, string> = { ...(session.draftAnswers ?? {}) };
    for (const question of session.questions) {
      let value: string;
      try {
        value = interaction.fields.getTextInputValue(question.id).trim();
      } catch {
        continue;
      }
      if (question.kind === 'number' && value && !Number.isFinite(Number(value.replace(/[,，]/g, '')))) {
        await interaction.reply({ content: `「${question.label}」は数値で入力してください。`, ephemeral: true });
        return;
      }
      answers[question.id] = value;
    }
    await interaction.deferUpdate();
    await this.completeClarification(session, answers);
  }

  private async completeClarification(session: ClarificationSession, answers: Record<string, string>): Promise<void> {
    const answered = await getClarificationSessionStore().answer(session.clarificationId, answers);
    if (!answered) return;
    const channel = this.client.channels.cache.get(session.channelId)
      ?? await this.client.channels.fetch(session.channelId).catch(() => null);
    if (!channel?.isTextBased() || !('messages' in channel)) return;

    if (session.messageId) {
      const formMessage = await channel.messages.fetch(session.messageId).catch(() => null);
      if (formMessage) await formMessage.edit({ embeds: [this.buildClarificationEmbed(answered, true)], components: [] });
    }
    const trackedProgress = this.progressMessages.get(session.taskId);
    if (trackedProgress) {
      const progressChannel = this.client.channels.cache.get(trackedProgress.channelId)
        ?? await this.client.channels.fetch(trackedProgress.channelId).catch(() => null);
      if (progressChannel?.isTextBased() && 'messages' in progressChannel) {
        const progressMessage = await progressChannel.messages.fetch(trackedProgress.messageId).catch(() => null);
        if (progressMessage) await progressMessage.delete().catch(() => undefined);
      }
      this.progressMessages.delete(session.taskId);
      this.progressDetails.delete(session.taskId);
    }

    const answerLines = session.questions.map((question) =>
      `- ${question.label}: ${answers[question.id] || '指定なし'}`,
    );
    if (answers['推奨条件']) answerLines.unshift(`- 承認した条件: ${answers['推奨条件']}`);
    const recentMessages = await this.getRecentMessages(session.channelId, 10);
    const guild = this.client.guilds.cache.get(session.guildId);
    this.eventBus.publish({
      type: 'llm:get_discord_message',
      memoryZone: 'discord:general',
      data: {
        type: 'text',
        guildName: guild?.name ?? 'discord',
        channelName: 'name' in channel ? String(channel.name) : 'channel',
        guildId: session.guildId,
        channelId: session.channelId,
        messageId: session.messageId ?? session.clarificationId,
        userId: session.requesterUserId,
        userName: session.requesterUserName ?? '依頼者',
        text: `[追加要件への回答]\n元の依頼: ${session.originalRequest}\n${answerLines.join('\n')}\nこの条件を反映して元の依頼を続行してください。`,
        recentMessages,
      } as DiscordSendTextMessageOutput,
    });
  }

  /**
   * 指定したチャンネルの直近のメッセージを取得
   * @param channelId 対象のチャンネルID
   * @param limit 取得するメッセージ数（デフォルト10件）
   * @returns 会話ログの配列
   */
  public async getRecentMessages(
    channelId: string,
    limit: number = 10
  ): Promise<BaseMessage[]> {
    try {
      let channel = this.client.channels.cache.get(channelId);
      // キャッシュにない場合はfetchを試みる（スレッドチャンネル等）
      if (!channel) {
        try { channel = await this.client.channels.fetch(channelId) ?? undefined; } catch { /* ignore */ }
      }
      if (!channel?.isTextBased() || !('messages' in channel)) {
        throw new Error('Invalid channel or not a text channel');
      }

      const messages = await channel.messages.fetch({ limit });
      const conversationLog = messages
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map((msg) => {
          const nickname = this.getUserNickname(msg.author, msg.guildId ?? '');
          const timestamp = new Date(msg.createdTimestamp).toLocaleString(
            'ja-JP',
            { timeZone: 'Asia/Tokyo' }
          );

          // 画像URLを取得
          const imageUrls = msg.attachments
            .filter((attachment) =>
              attachment.contentType?.startsWith('image/')
            )
            .map((attachment) => attachment.url);

          // テキストと画像URLを結合
          const contentWithImages =
            imageUrls.length > 0
              ? `${msg.content}\n画像: ${imageUrls.join('\n')}`
              : msg.content;

          if (msg.author.bot) {
            const voiceUserMatch = contentWithImages.match(/^🎤\s*(.+?):\s*/);
            if (voiceUserMatch) {
              const voiceUserName = voiceUserMatch[1];
              const voiceText = contentWithImages.replace(/^🎤\s*.+?:\s*/, '');
              return new HumanMessage(
                timestamp + ' ' + voiceUserName + ': ' + voiceText
              );
            }
            const shannonVoiceMatch = contentWithImages.match(/^🔊\s*シャノン:\s*/);
            if (shannonVoiceMatch) {
              const shannonText = contentWithImages.replace(/^🔊\s*シャノン:\s*/, '');
              return new AIMessage(
                timestamp + ' シャノン: ' + shannonText
              );
            }
            return new AIMessage(
              timestamp + ' ' + nickname + 'AI: ' + contentWithImages
            );
          } else {
            return new HumanMessage(
              timestamp + ' ' + nickname + ': ' + contentWithImages
            );
          }
        });

      return conversationLog;
    } catch (error) {
      const sErr = classifyError(error, 'discord');
      logger.error(`Error fetching recent messages: ${formatErrorForLog(sErr)}`);
      this.eventBus.log(
        'discord:aiminelab_server',
        'red',
        `Error fetching recent messages: ${sErr.message}`
      );
      return [];
    }
  }

  public getVoiceMode(guildId: string): 'chat' | 'minebot' {
    return this.voiceManager.getVoiceMode(guildId);
  }

  public getActiveVoiceInfo(): { guildId: string; channelId: string } | null {
    return this.voiceManager.getActiveVoiceInfo();
  }

  /**
   * voice_mode をリモートから切り替える（Minecraft 側から呼ばれる）
   * @returns 切り替え後のモード
   */
  public toggleVoiceMode(): { mode: 'chat' | 'minebot'; guildId: string } | null {
    return this.voiceManager.toggleVoiceMode();
  }

  /**
   * PTT を明示的に ON/OFF する（Minecraft 側から呼ばれる）
   */
  public remotePttSet(discordNames: string[], on: boolean): { active: boolean; userName: string; blocked?: boolean; blockedBy?: string } | null {
    return this.voiceManager.remotePttSet(discordNames, on);
  }
}
