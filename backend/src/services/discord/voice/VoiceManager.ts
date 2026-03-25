import { BaseMessage } from '@langchain/core/messages';
import {
  DiscordClientInput,
  DiscordVoiceEnqueueInput,
  DiscordVoiceFillerInput,
  DiscordVoiceQueueEndInput,
  DiscordVoiceQueueStartInput,
  DiscordVoiceResponseInput,
  DiscordVoiceStatusInput,
  DiscordVoiceStreamTextInput,
} from '@shannon/common';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  GuildMember,
  Message,
  TextChannel,
  User,
  VoiceChannel,
} from 'discord.js';
import {
  AudioPlayer,
  AudioPlayerStatus,
  EndBehaviorType,
  VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';
import OpusPackage from '@discordjs/opus';
const { OpusEncoder } = OpusPackage;
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../../../utils/logger.js';
const logger = createLogger('Discord:Voice');
import { getDiscordMemoryZone } from '../../../utils/discord.js';
import { voiceResponseChannelIds } from '../voiceState.js';
import { loadFillers, generateAllFillers } from '../voiceFiller.js';
import { sendLongMessage } from '../utils.js';
import { EventBus } from '../../eventBus/eventBus.js';

export interface VoiceManagerHelpers {
  getUserNickname: (user: User, guildId?: string) => string;
  shouldSkipGuild: (guildId: string | null) => boolean;
  getRecentMessages: (channelId: string, limit?: number) => Promise<BaseMessage[]>;
}

export class VoiceManager {
  private client: Client;
  private eventBus: EventBus;
  private helpers: VoiceManagerHelpers;

  // ── Voice state ───────────────────────────────────────────────────────
  private voiceConnections: Map<string, VoiceConnection> = new Map();
  private audioPlayers: Map<string, AudioPlayer> = new Map();
  private userAudioBuffers: Map<string, Buffer[]> = new Map();
  private userSpeakingTimers: Map<string, NodeJS.Timeout> = new Map();
  private voiceProcessingLock: Map<string, boolean> = new Map();
  private activeVoiceUsers: Map<string, string | null> = new Map(); // guildId -> userId or null
  private voiceTextChannelIds: Map<string, string> = new Map(); // guildId -> textChannelId
  private voiceQueues: Map<string, {
    buffers: Buffer[];
    done: boolean;
    notify: (() => void) | null;
    channelId: string;
    text: string;
  }> = new Map();
  private voicePttMessages: Map<string, { channelId: string; messageId: string }> = new Map(); // guildId -> PTT message
  private voiceStreamMessages: Map<string, { message: Message; accumulatedText: string }> = new Map(); // guildId -> streaming Discord message
  private voiceModeMap: Map<string, 'chat' | 'minebot'> = new Map(); // guildId -> voice mode

  private static readonly VOICE_TEXT_CHANNELS_PATH = path.resolve(
    new URL(import.meta.url).pathname,
    '../../../../saves/voice_text_channels.json'
  );

  static readonly VOICE_STATUS_LABELS: Record<string, string> = {
    listening: '\u{1F442} 聞き取り中…',
    stt: '\u{1F4DD} 音声認識中…',
    filler_select: '\u{1F3AF} フィラー選択中…',
    llm: '\u{1F9E0} 回答生成中…',
    tts: '\u{1F50A} 音声生成中…',
    speaking: '\u{1F5E3}\uFE0F 再生中…',
    idle: '',
  };

  constructor(client: Client, eventBus: EventBus, helpers: VoiceManagerHelpers) {
    this.client = client;
    this.eventBus = eventBus;
    this.helpers = helpers;
  }

  // ── Lifecycle / init ──────────────────────────────────────────────────

  /** Call once after the Discord client is ready to load fillers */
  async onReady(): Promise<void> {
    loadFillers().catch(err => logger.warn(`[Discord] Filler loading failed: ${err}`));
    await this.autoRejoinVoice().catch(err =>
      logger.warn(`[Discord Voice] Auto-rejoin failed: ${err}`)
    );
  }

  /** Register all EventBus voice subscriptions */
  setupEventSubscriptions(): void {
    // --- Voice queue events (streaming pipeline) ---
    this.eventBus.subscribe('discord:voice_queue_start', async (event) => {
      const { guildId, channelId } = event.data as DiscordVoiceQueueStartInput;
      this.voiceStreamMessages.delete(guildId);
      this.voiceQueues.set(guildId, {
        buffers: [],
        done: false,
        notify: null,
        channelId,
        text: '',
      });
      this.consumeVoiceQueue(guildId);
    });

    this.eventBus.subscribe('discord:voice_enqueue', async (event) => {
      const { guildId, audioBuffer } = event.data as DiscordVoiceEnqueueInput;
      const queue = this.voiceQueues.get(guildId);
      if (!queue) return;
      queue.buffers.push(audioBuffer);
      if (queue.notify) {
        queue.notify();
        queue.notify = null;
      }
    });

    this.eventBus.subscribe('discord:voice_queue_end', async (event) => {
      const { guildId, channelId, text } = event.data as DiscordVoiceQueueEndInput;
      const queue = this.voiceQueues.get(guildId);
      if (!queue) return;
      queue.done = true;
      queue.text = text;
      queue.channelId = channelId;
      if (queue.notify) {
        queue.notify();
        queue.notify = null;
      }
    });

    this.eventBus.subscribe('discord:voice_stream_text', async (event) => {
      const { guildId, channelId, sentence } = event.data as DiscordVoiceStreamTextInput;
      try {
        const textChannel = this.client.channels.cache.get(channelId);
        if (!textChannel?.isTextBased() || !('send' in textChannel)) return;

        const existing = this.voiceStreamMessages.get(guildId);
        if (existing) {
          existing.accumulatedText += sentence;
          await existing.message.edit(`🔊 シャノン: ${existing.accumulatedText}`);
        } else {
          const msg = await (textChannel as TextChannel).send(`🔊 シャノン: ${sentence}`);
          this.voiceStreamMessages.set(guildId, { message: msg, accumulatedText: sentence });
        }
      } catch (err) {
        logger.warn(`[Discord Voice] Stream text update failed: ${err}`);
      }
    });

    this.eventBus.subscribe('discord:voice_status', async (event) => {
      const { guildId, status, detail } = event.data as DiscordVoiceStatusInput;
      await this.updateVoiceStatusDisplay(guildId, status, detail);
    });

    // --- Legacy voice events (fallback) ---
    this.eventBus.subscribe('discord:play_voice_filler', async (event) => {
      const { guildId, audioBuffers } = event.data as DiscordVoiceFillerInput;
      try {
        for (const buf of audioBuffers) {
          await this.playAudioInVoiceChannel(guildId, buf);
        }
      } catch (error) {
        logger.error('[Discord Voice] Filler playback error:', error);
      }
    });

    this.eventBus.subscribe('discord:post_voice_response', async (event) => {
      const { channelId, voiceChannelId, guildId, text, audioBuffer, audioBuffers } =
        event.data as DiscordVoiceResponseInput;

      try {
        const textChannel = this.client.channels.cache.get(channelId);
        if (textChannel?.isTextBased() && 'send' in textChannel) {
          await sendLongMessage(textChannel as TextChannel, `🔊 シャノン: ${text}`);
        }

        if (audioBuffers && audioBuffers.length > 0) {
          for (const buf of audioBuffers) {
            await this.playAudioInVoiceChannel(guildId, buf);
          }
        } else {
          await this.playAudioInVoiceChannel(guildId, audioBuffer);
        }
      } catch (error) {
        logger.error('[Discord Voice] Error playing voice response:', error);
      }
    });
  }

  /** Handle voice button interactions (call from interactionCreate handler) */
  setupVoiceInteractions(): {
    handlePtt: (interaction: ButtonInteraction) => Promise<void>;
    handleGenerateResponse: (interaction: ButtonInteraction) => Promise<void>;
  } {
    return {
      handlePtt: (interaction: ButtonInteraction) => this.handleVoicePttButton(interaction),
      handleGenerateResponse: (interaction: ButtonInteraction) => this.handleVoiceGenerateResponse(interaction),
    };
  }

  // ── Slash command handlers ────────────────────────────────────────────

  async handleVoiceJoin(interaction: ChatInputCommandInteraction): Promise<void> {
    const member = interaction.member as GuildMember;
    const voiceChannel = member.voice.channel;

    if (!voiceChannel) {
      await interaction.reply({ content: 'ボイスチャンネルに参加してから実行してください。', ephemeral: true });
      return;
    }

    if (this.voiceConnections.has(interaction.guildId!)) {
      await interaction.reply({ content: '既にボイスチャンネルに参加しています。', ephemeral: true });
      return;
    }

    await interaction.deferReply();
    const guildId = interaction.guildId!;

    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      const player = createAudioPlayer();
      connection.subscribe(player);

      this.voiceConnections.set(guildId, connection);
      this.audioPlayers.set(guildId, player);
      this.activeVoiceUsers.set(guildId, null);
      this.voiceTextChannelIds.set(guildId, interaction.channelId);
      this.saveVoiceTextChannel(guildId, interaction.channelId);

      connection.on(VoiceConnectionStatus.Ready, () => {
        logger.success(`[Discord Voice] Connected to ${voiceChannel.name}`);
        this.setupVoiceReceiver(connection, guildId, interaction.channelId);
      });

      connection.on(VoiceConnectionStatus.Disconnected, () => {
        logger.info('[Discord Voice] Disconnected', 'yellow');
        this.cleanupVoiceConnection(guildId);
      });

      connection.on(VoiceConnectionStatus.Destroyed, () => {
        logger.info('[Discord Voice] Connection destroyed', 'yellow');
        this.cleanupVoiceConnection(guildId);
      });

      const row = this.buildVoiceButtonRow({ isActive: false });

      const reply = await interaction.editReply({
        content: `🎙️ **${voiceChannel.name}** に参加しました！\n下のボタンを押すと通話が始まり、もう一度押すと終了します。`,
        components: [row],
      });
      this.voicePttMessages.set(guildId, { channelId: interaction.channelId, messageId: reply.id });
    } catch (error) {
      logger.error('[Discord Voice] Failed to join:', error);
      await interaction.editReply('ボイスチャンネルへの参加に失敗しました。');
    }
  }

  async handleVoiceLeave(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const connection = this.voiceConnections.get(guildId) || getVoiceConnection(guildId);

    if (!connection) {
      await interaction.reply({ content: 'ボイスチャンネルに参加していません。', ephemeral: true });
      return;
    }

    connection.destroy();
    this.cleanupVoiceConnection(guildId);
    await interaction.reply('👋 ボイスチャンネルから退出しました。');
  }

  async handleGenerateFillers(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: 64 });
    const count = await generateAllFillers();
    await interaction.editReply(`フィラー音声を ${count} 個生成しました。`);
  }

  handleVoiceModeCommand(guildId: string, mode: 'chat' | 'minebot'): void {
    this.voiceModeMap.set(guildId, mode);
  }

  // ── Button interaction handlers ───────────────────────────────────────

  private async handleVoicePttButton(interaction: ButtonInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const activeUser = this.activeVoiceUsers.get(guildId);

    if (!this.voiceConnections.has(guildId)) {
      await interaction.reply({ content: 'シャノンはボイスチャンネルに参加していません。', ephemeral: true });
      return;
    }

    if (activeUser && activeUser !== userId) {
      const activeUserObj = this.client.users.cache.get(activeUser);
      const activeName = activeUserObj ? this.helpers.getUserNickname(activeUserObj, guildId) : 'Unknown';
      await interaction.reply({ content: `現在 **${activeName}** が通話中です。終了するまでお待ちください。`, ephemeral: true });
      return;
    }

    if (activeUser === userId) {
      this.activeVoiceUsers.set(guildId, null);
      logger.info(`[Discord Voice] PTT OFF: ${interaction.user.username}`, 'yellow');

      const row = this.buildVoiceButtonRow({ isActive: false });

      await interaction.update({
        content: `🎙️ ボイスチャンネルに参加中\n下のボタンを押すと通話が始まり、もう一度押すと終了します。`,
        components: [row],
      });
    } else {
      this.activeVoiceUsers.set(guildId, userId);
      const nickname = this.helpers.getUserNickname(interaction.user, guildId);
      logger.info(`[Discord Voice] PTT ON: ${interaction.user.username}`, 'cyan');

      const row = this.buildVoiceButtonRow({ isActive: true, nickname });

      await interaction.update({
        content: `🎙️ **${nickname}** が通話中です。シャノンが音声を聞いています。`,
        components: [row],
      });
    }
  }

  private async handleVoiceGenerateResponse(interaction: ButtonInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const channelId = interaction.channelId;

    if (!this.voiceConnections.has(guildId)) {
      await interaction.reply({ content: 'シャノンはボイスチャンネルに参加していません。', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const channel = this.client.channels.cache.get(channelId);
      if (!channel?.isTextBased() || !('messages' in channel)) {
        await interaction.editReply('テキストチャンネルが見つかりません。');
        return;
      }

      const rawMessages = await (channel as TextChannel).messages.fetch({ limit: 15 });
      const sorted = rawMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      let lastUserText: string | null = null;
      let lastUserName: string | null = null;
      let lastUserId: string | null = null;

      for (const msg of sorted.reverse().values()) {
        if (msg.author.bot) continue;

        lastUserText = msg.content;
        lastUserName = this.helpers.getUserNickname(msg.author, guildId);
        lastUserId = msg.author.id;
        break;
      }

      if (!lastUserText) {
        const shannonMessages = [...sorted.values()].reverse();
        for (const msg of shannonMessages) {
          if (!msg.author.bot) continue;
          const match = msg.content.match(/^🎤\s*(.+?):\s*(.+)$/);
          if (match) {
            lastUserName = match[1];
            lastUserText = match[2];
            lastUserId = interaction.user.id;
            break;
          }
        }
      }

      if (!lastUserText) {
        await interaction.editReply('直近のユーザーメッセージが見つかりませんでした。');
        return;
      }

      const guild = this.client.guilds.cache.get(guildId);
      const guildName = guild?.name ?? '';
      const channelName = 'name' in channel ? (channel as TextChannel).name : '';
      const voiceConnection = this.voiceConnections.get(guildId);
      const voiceChannelId = voiceConnection?.joinConfig.channelId ?? '';
      const memoryZone = await getDiscordMemoryZone(guildId);
      const recentMessages = await this.helpers.getRecentMessages(channelId, 10);

      this.eventBus.publish({
        type: 'llm:get_discord_message',
        memoryZone,
        data: {
          type: 'voice',
          text: lastUserText,
          audioBuffer: Buffer.alloc(0),
          guildId,
          guildName,
          channelId,
          channelName,
          voiceChannelId,
          userId: lastUserId ?? interaction.user.id,
          userName: lastUserName ?? this.helpers.getUserNickname(interaction.user, guildId),
          recentMessages,
        } as unknown as DiscordClientInput,
      });

      logger.info(`[Discord Voice] Generate response from text: "${lastUserText}" by ${lastUserName}`, 'cyan');
      await interaction.editReply(`💬 「${lastUserText}」に対する音声回答を生成中…`);
    } catch (error) {
      logger.error('[Discord Voice] Generate response failed:', error);
      await interaction.editReply('音声回答の生成に失敗しました。');
    }
  }

  // ── UI helpers ────────────────────────────────────────────────────────

  buildVoiceButtonRow(options: { isActive: boolean; nickname?: string | null }): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('voice_ptt')
        .setLabel(options.isActive ? `🔴 ${options.nickname ?? 'ユーザー'} が通話中... (押して終了)` : '🎤 話す')
        .setStyle(options.isActive ? ButtonStyle.Danger : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('voice_generate_response')
        .setLabel('💬 音声回答を生成')
        .setStyle(ButtonStyle.Primary),
    );
  }

  // ── Auto-rejoin ───────────────────────────────────────────────────────

  async autoRejoinVoice(): Promise<void> {
    for (const [, guild] of this.client.guilds.cache) {
      try {
        const me = guild.members.me;
        if (!me?.voice.channel) continue;

        const voiceChannel = me.voice.channel as VoiceChannel;
        logger.info(`[Discord Voice] Auto-rejoin: ${voiceChannel.name} (${guild.name})`, 'cyan');

        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: guild.id,
          adapterCreator: guild.voiceAdapterCreator,
          selfDeaf: false,
        });

        const player = createAudioPlayer();
        connection.subscribe(player);

        this.voiceConnections.set(guild.id, connection);
        this.audioPlayers.set(guild.id, player);
        this.activeVoiceUsers.set(guild.id, null);

        const savedChannelId = this.loadVoiceTextChannel(guild.id);
        if (savedChannelId) {
          this.voiceTextChannelIds.set(guild.id, savedChannelId);
          logger.info(`[Discord Voice] Auto-rejoin: restored text channel from saved config`, 'cyan');
        } else {
          const textChannel = guild.channels.cache.find(
            ch => ch.isTextBased() && !ch.isThread() && ch.permissionsFor(me)?.has('SendMessages')
          );
          if (textChannel) {
            this.voiceTextChannelIds.set(guild.id, textChannel.id);
          }
        }

        connection.on(VoiceConnectionStatus.Ready, () => {
          logger.success(`[Discord Voice] Auto-rejoin connected: ${voiceChannel.name}`);
          const textChannelId = this.voiceTextChannelIds.get(guild.id) ?? '';
          this.setupVoiceReceiver(connection, guild.id, textChannelId);
        });

        connection.on(VoiceConnectionStatus.Disconnected, () => {
          logger.info('[Discord Voice] Auto-rejoin disconnected', 'yellow');
          this.cleanupVoiceConnection(guild.id);
        });

        connection.on(VoiceConnectionStatus.Destroyed, () => {
          logger.info('[Discord Voice] Auto-rejoin destroyed', 'yellow');
          this.cleanupVoiceConnection(guild.id);
        });
      } catch (err) {
        logger.error(`[Discord Voice] Auto-rejoin error (${guild.name}):`, err);
      }
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  cleanupVoiceConnection(guildId: string): void {
    this.voiceConnections.delete(guildId);
    this.audioPlayers.delete(guildId);
    this.activeVoiceUsers.delete(guildId);
    this.voiceTextChannelIds.delete(guildId);
    this.deleteVoiceTextChannel(guildId);
    for (const [key, timer] of this.userSpeakingTimers) {
      if (key.startsWith(guildId)) {
        clearTimeout(timer);
        this.userSpeakingTimers.delete(key);
      }
    }
    for (const key of this.userAudioBuffers.keys()) {
      if (key.startsWith(guildId)) {
        this.userAudioBuffers.delete(key);
      }
    }
    this.voiceProcessingLock.delete(guildId);
    this.voicePttMessages.delete(guildId);
  }

  // ── Voice text channel persistence ────────────────────────────────────

  private saveVoiceTextChannel(guildId: string, channelId: string): void {
    try {
      let data: Record<string, string> = {};
      if (fs.existsSync(VoiceManager.VOICE_TEXT_CHANNELS_PATH)) {
        data = JSON.parse(fs.readFileSync(VoiceManager.VOICE_TEXT_CHANNELS_PATH, 'utf-8'));
      }
      data[guildId] = channelId;
      fs.writeFileSync(VoiceManager.VOICE_TEXT_CHANNELS_PATH, JSON.stringify(data, null, 2));
    } catch { /* best-effort */ }
  }

  private loadVoiceTextChannel(guildId: string): string | undefined {
    try {
      if (!fs.existsSync(VoiceManager.VOICE_TEXT_CHANNELS_PATH)) return undefined;
      const data = JSON.parse(fs.readFileSync(VoiceManager.VOICE_TEXT_CHANNELS_PATH, 'utf-8'));
      return data[guildId] as string | undefined;
    } catch {
      return undefined;
    }
  }

  private deleteVoiceTextChannel(guildId: string): void {
    try {
      if (!fs.existsSync(VoiceManager.VOICE_TEXT_CHANNELS_PATH)) return;
      const data = JSON.parse(fs.readFileSync(VoiceManager.VOICE_TEXT_CHANNELS_PATH, 'utf-8'));
      delete data[guildId];
      fs.writeFileSync(VoiceManager.VOICE_TEXT_CHANNELS_PATH, JSON.stringify(data, null, 2));
    } catch { /* best-effort */ }
  }

  // ── Status display ────────────────────────────────────────────────────

  async updateVoiceStatusDisplay(guildId: string, status: string, detail?: string): Promise<void> {
    const pttMsg = this.voicePttMessages.get(guildId);
    if (!pttMsg) return;

    try {
      const channel = this.client.channels.cache.get(pttMsg.channelId);
      if (!channel?.isTextBased() || !('messages' in channel)) return;

      const message = await (channel as TextChannel).messages.fetch(pttMsg.messageId).catch(() => null);
      if (!message) return;

      const activeUserId = this.activeVoiceUsers.get(guildId);
      const activeUser = activeUserId ? this.client.users.cache.get(activeUserId) : null;
      const nickname = activeUser ? this.helpers.getUserNickname(activeUser, guildId) : null;

      const statusLabel = VoiceManager.VOICE_STATUS_LABELS[status] || '';
      const statusLine = statusLabel
        ? `\n${statusLabel}${detail ? ` ${detail}` : ''}`
        : '';

      const isActive = !!activeUserId;
      const row = this.buildVoiceButtonRow({ isActive, nickname });

      const baseContent = isActive
        ? `🎙️ **${nickname}** が通話中です。シャノンが音声を聞いています。`
        : '🎙️ ボイスチャンネルに参加中\n下のボタンを押すと通話が始まり、もう一度押すと終了します。';

      await message.edit({
        content: `${baseContent}${statusLine}`,
        components: [row],
      });
    } catch {
      // best-effort UI update
    }
  }

  // ── Voice receiver ────────────────────────────────────────────────────

  setupVoiceReceiver(connection: VoiceConnection, guildId: string, textChannelId: string): void {
    const receiver = connection.receiver;

    receiver.speaking.on('start', (userId) => {
      const activeUser = this.activeVoiceUsers.get(guildId);
      if (!activeUser || activeUser !== userId) return;
      if (this.voiceProcessingLock.get(guildId)) return;

      const bufferKey = `${guildId}:${userId}`;

      const existingTimer = this.userSpeakingTimers.get(bufferKey);
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.userSpeakingTimers.delete(bufferKey);
      }

      if (!this.userAudioBuffers.has(bufferKey)) {
        this.userAudioBuffers.set(bufferKey, []);
      }

      const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
      });

      opusStream.on('error', (err) => {
        logger.warn(`[Discord Voice] AudioReceiveStream error (${userId}): ${err.message}`);
      });

      opusStream.on('data', (chunk: Buffer) => {
        if (this.activeVoiceUsers.get(guildId) !== userId) return;
        const buffers = this.userAudioBuffers.get(bufferKey);
        if (buffers) {
          buffers.push(chunk);
        }
      });

      opusStream.on('end', () => {
        const timer = setTimeout(async () => {
          this.userSpeakingTimers.delete(bufferKey);
          const audioBuffers = this.userAudioBuffers.get(bufferKey);
          this.userAudioBuffers.delete(bufferKey);

          if (!audioBuffers || audioBuffers.length === 0) return;
          if (this.activeVoiceUsers.get(guildId) !== userId) return;

          try {
            const pcmBuffer = this.decodeOpusBuffers(audioBuffers);
            if (pcmBuffer.length < 48000) return; // 0.5秒未満は無視（ノイズ防止）

            await this.processVoiceInput(pcmBuffer, userId, guildId, textChannelId);
          } catch (err) {
            logger.error('[Discord Voice] Error processing audio:', err);
          }
        }, 300);
        this.userSpeakingTimers.set(bufferKey, timer);
      });
    });
  }

  // ── Audio encoding / decoding ─────────────────────────────────────────

  decodeOpusBuffers(opusBuffers: Buffer[]): Buffer {
    const encoder = new OpusEncoder(48000, 2);
    const pcmChunks: Buffer[] = [];

    for (const opusPacket of opusBuffers) {
      try {
        const pcm = encoder.decode(opusPacket);
        pcmChunks.push(pcm);
      } catch {
        // skip corrupted packets
      }
    }

    return Buffer.concat(pcmChunks);
  }

  createWavBuffer(pcmBuffer: Buffer, sampleRate: number = 48000, channels: number = 2, bitsPerSample: number = 16): Buffer {
    const dataSize = pcmBuffer.length;
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
    header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
  }

  // ── Voice processing ──────────────────────────────────────────────────

  private async processVoiceInput(pcmBuffer: Buffer, userId: string, guildId: string, textChannelId: string): Promise<void> {
    if (this.voiceProcessingLock.get(guildId)) return;
    this.voiceProcessingLock.set(guildId, true);

    try {
      const wavBuffer = this.createWavBuffer(pcmBuffer);

      const user = this.client.users.cache.get(userId);
      const nickname = user ? this.helpers.getUserNickname(user, guildId) : 'Unknown';
      const memoryZone = await getDiscordMemoryZone(guildId);

      const guild = this.client.guilds.cache.get(guildId);
      const guildName = guild?.name ?? '';
      const textChannel = this.client.channels.cache.get(textChannelId);
      const channelName = textChannel && 'name' in textChannel ? textChannel.name : '';

      const voiceConnection = this.voiceConnections.get(guildId);
      const voiceChannelId = voiceConnection?.joinConfig.channelId ?? '';

      const recentMessages = await this.helpers.getRecentMessages(textChannelId, 10);

      this.eventBus.publish({
        type: 'llm:get_discord_message',
        memoryZone: memoryZone,
        data: {
          type: 'voice',
          text: '',
          audioBuffer: wavBuffer,
          guildId,
          guildName,
          channelId: textChannelId,
          channelName,
          voiceChannelId,
          userId,
          userName: nickname,
          recentMessages,
        } as unknown as DiscordClientInput,
      });
    } finally {
      this.voiceProcessingLock.set(guildId, false);
    }
  }

  // ── Audio playback ────────────────────────────────────────────────────

  async playAudioInVoiceChannel(guildId: string, wavBuffer: Buffer): Promise<void> {
    const player = this.audioPlayers.get(guildId);
    if (!player) {
      logger.warn('[Discord Voice] No audio player for guild');
      return;
    }

    const connection = this.voiceConnections.get(guildId);
    if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) {
      logger.warn(`[Discord Voice] Connection not ready (status=${connection?.state.status ?? 'none'}), skipping playback`);
      return;
    }

    return new Promise<void>((resolve, reject) => {
      try {
        const stream = Readable.from(wavBuffer);
        const resource = createAudioResource(stream);

        logger.debug(`[Discord Voice] Playing audio: ${Math.round(wavBuffer.length / 1024)}KB buffer`);
        player.play(resource);

        player.once(AudioPlayerStatus.Idle, () => {
          logger.debug('[Discord Voice] Audio playback finished');
          resolve();
        });
        player.once('error', (err) => {
          logger.error('[Discord Voice] Playback error:', err);
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private async consumeVoiceQueue(guildId: string): Promise<void> {
    const queue = this.voiceQueues.get(guildId);
    if (!queue) return;

    try {
      let isFirstPlay = true;
      while (true) {
        if (queue.buffers.length > 0) {
          if (isFirstPlay) {
            await this.updateVoiceStatusDisplay(guildId, 'speaking');
            isFirstPlay = false;
          }
          const buf = queue.buffers.shift()!;
          await this.playAudioInVoiceChannel(guildId, buf);
          continue;
        }

        if (queue.done) break;

        await new Promise<void>((resolve) => {
          queue.notify = resolve;
        });
      }

      if (queue.text) {
        const streamMsg = this.voiceStreamMessages.get(guildId);
        if (streamMsg) {
          try {
            await streamMsg.message.edit(`🔊 シャノン: ${queue.text}`);
          } catch {
            const textChannel = this.client.channels.cache.get(queue.channelId);
            if (textChannel?.isTextBased() && 'send' in textChannel) {
              await sendLongMessage(textChannel as TextChannel, `🔊 シャノン: ${queue.text}`);
            }
          }
        } else {
          const textChannel = this.client.channels.cache.get(queue.channelId);
          if (textChannel?.isTextBased() && 'send' in textChannel) {
            await sendLongMessage(textChannel as TextChannel, `🔊 シャノン: ${queue.text}`);
          }
        }
      }
    } catch (error) {
      logger.error('[Discord Voice] Queue playback error:', error);
    } finally {
      this.voiceStreamMessages.delete(guildId);
      this.voiceQueues.delete(guildId);
      await this.updateVoiceStatusDisplay(guildId, 'idle');
    }
  }

  // ── Public API (delegated from DiscordBot) ────────────────────────────

  getVoiceMode(guildId: string): 'chat' | 'minebot' {
    return this.voiceModeMap.get(guildId) ?? 'chat';
  }

  getActiveVoiceInfo(): { guildId: string; channelId: string } | null {
    // 1. ローカルMapから検索
    for (const [guildId, connection] of this.voiceConnections.entries()) {
      if (connection.state.status === VoiceConnectionStatus.Ready) {
        const channelId = connection.joinConfig.channelId;
        if (channelId) return { guildId, channelId };
      }
      logger.debug(`[Discord Voice] getActiveVoiceInfo: guild=${guildId} status=${connection.state.status} (not Ready)`);
    }

    // 2. @discordjs/voice のグローバル状態にフォールバック
    for (const [, guild] of this.client.guilds.cache) {
      const fallback = getVoiceConnection(guild.id);
      if (fallback && fallback.state.status === VoiceConnectionStatus.Ready) {
        const channelId = fallback.joinConfig.channelId;
        if (channelId) {
          logger.info(`[Discord Voice] getActiveVoiceInfo: recovered from global state guild=${guild.id}`, 'cyan');
          this.voiceConnections.set(guild.id, fallback);
          return { guildId: guild.id, channelId };
        }
      }
    }

    if (this.voiceConnections.size === 0) {
      logger.debug('[Discord Voice] getActiveVoiceInfo: voiceConnections is empty');
    }
    return null;
  }

  /**
   * voice_mode をリモートから切り替える（Minecraft 側から呼ばれる）
   * @returns 切り替え後のモード
   */
  toggleVoiceMode(): { mode: 'chat' | 'minebot'; guildId: string } | null {
    const info = this.getActiveVoiceInfo();
    if (!info) return null;
    const current = this.getVoiceMode(info.guildId);
    const next: 'chat' | 'minebot' = current === 'chat' ? 'minebot' : 'chat';
    this.voiceModeMap.set(info.guildId, next);
    logger.info(`[Discord Voice] Mode toggled remotely: ${current} -> ${next}`, 'magenta');
    return { mode: next, guildId: info.guildId };
  }

  /**
   * PTT を明示的に ON/OFF する（Minecraft 側から呼ばれる）
   */
  remotePttSet(discordNames: string[], on: boolean): { active: boolean; userName: string; blocked?: boolean; blockedBy?: string } | null {
    const info = this.getActiveVoiceInfo();
    if (!info) return null;
    const { guildId, channelId: voiceChannelId } = info;

    // OFF 要求 — 収集済み音声を即座に処理してから activeUser をクリア
    if (!on) {
      const activeUser = this.activeVoiceUsers.get(guildId);
      if (!activeUser) return { active: false, userName: '' };

      const bufferKey = `${guildId}:${activeUser}`;
      const audioBuffers = this.userAudioBuffers.get(bufferKey);
      this.userAudioBuffers.delete(bufferKey);

      const existingTimer = this.userSpeakingTimers.get(bufferKey);
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.userSpeakingTimers.delete(bufferKey);
      }

      this.activeVoiceUsers.set(guildId, null);
      const userObj = this.client.users.cache.get(activeUser);
      const name = userObj ? this.helpers.getUserNickname(userObj, guildId) : 'Unknown';
      logger.info(`[Discord Voice] Remote PTT OFF: ${name}`, 'yellow');
      this.updatePttMessage(guildId, false);

      if (audioBuffers && audioBuffers.length > 0) {
        const textChannelId = this.voiceTextChannelIds.get(guildId) ?? '';
        logger.info(`[Discord Voice] PTT release: processing ${audioBuffers.length} audio chunks immediately`, 'cyan');
        (async () => {
          try {
            const pcmBuffer = this.decodeOpusBuffers(audioBuffers);
            if (pcmBuffer.length < 48000) {
              logger.debug('[Discord Voice] PTT release: audio too short, skipping');
              return;
            }
            await this.processVoiceInput(pcmBuffer, activeUser, guildId, textChannelId);
          } catch (err) {
            logger.error('[Discord Voice] PTT release processing error:', err);
          }
        })();
      }

      return { active: false, userName: name };
    }

    // ON 要求 — 既に別のユーザーがアクティブなら blocked を返す
    const activeUser = this.activeVoiceUsers.get(guildId);
    if (activeUser) {
      const userObj = this.client.users.cache.get(activeUser);
      const activeName = userObj ? this.helpers.getUserNickname(userObj, guildId) : 'Unknown';

      // 自分自身がアクティブなら正常
      const voiceChannel = this.client.channels.cache.get(voiceChannelId) as VoiceChannel | undefined;
      if (voiceChannel) {
        const lowerNames = discordNames.map(n => n.toLowerCase());
        for (const [memberId] of voiceChannel.members) {
          if (memberId === activeUser) {
            const nick = voiceChannel.members.get(memberId)?.nickname?.toLowerCase() ?? '';
            const display = voiceChannel.members.get(memberId)?.user.displayName?.toLowerCase() ?? '';
            const username = voiceChannel.members.get(memberId)?.user.username?.toLowerCase() ?? '';
            if (lowerNames.includes(nick) || lowerNames.includes(display) || lowerNames.includes(username)) {
              return { active: true, userName: activeName, blocked: false };
            }
          }
        }
      }

      logger.info(`[Discord Voice] Remote PTT blocked: ${discordNames.join(', ')} (active: ${activeName})`, 'yellow');
      return { active: true, userName: activeName, blocked: true, blockedBy: activeName };
    }

    // Discord ボイスチャンネルのメンバーから該当ユーザーを検索
    const voiceChannel = this.client.channels.cache.get(voiceChannelId) as VoiceChannel | undefined;
    if (!voiceChannel) return null;

    const lowerNames = discordNames.map(n => n.toLowerCase());
    for (const [memberId, member] of voiceChannel.members) {
      if (member.user.bot) continue;
      const nick = member.nickname?.toLowerCase() ?? '';
      const display = member.user.displayName?.toLowerCase() ?? '';
      const username = member.user.username?.toLowerCase() ?? '';
      if (lowerNames.includes(nick) || lowerNames.includes(display) || lowerNames.includes(username)) {
        this.activeVoiceUsers.set(guildId, memberId);
        const name = this.helpers.getUserNickname(member.user, guildId);
        logger.info(`[Discord Voice] Remote PTT ON: ${name} (${memberId})`, 'cyan');
        this.updatePttMessage(guildId, true, name);
        return { active: true, userName: name, blocked: false };
      }
    }

    logger.warn(`[Discord Voice] Remote PTT: matching Discord user not found for names: ${discordNames.join(', ')}`);
    return null;
  }

  async updatePttMessage(guildId: string, isActive: boolean, nickname?: string): Promise<void> {
    const pttInfo = this.voicePttMessages.get(guildId);
    if (!pttInfo) return;
    try {
      const channel = this.client.channels.cache.get(pttInfo.channelId) as TextChannel | undefined;
      if (!channel) return;
      const msg = await channel.messages.fetch(pttInfo.messageId).catch(() => null);
      if (!msg) return;
      const row = this.buildVoiceButtonRow({ isActive, nickname });
      const content = isActive
        ? `🎙️ **${nickname}** が通話中です。シャノンが音声を聞いています。`
        : `🎙️ ボイスチャンネルに参加中\n下のボタンを押すと通話が始まり、もう一度押すと終了します。`;
      await msg.edit({ content, components: [row] });
    } catch {
      /* best-effort UI update */
    }
  }
}
