import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  DiscordVoiceEnqueueInput,
  DiscordVoiceMessageOutput,
  DiscordVoiceQueueEndInput,
  DiscordVoiceQueueStartInput,
  DiscordVoiceStatusInput,
  DiscordVoiceStreamTextInput,
  MemoryZone,
  MinebotVoiceResponseOutput,
} from '@shannon/common';
import OpenAI from 'openai';
import type { RequestEnvelope, ShannonGraphState } from '@shannon/common';
import { classifyError, formatErrorForLog } from '../../../errors/index.js';
import { getDiscordMemoryZone } from '../../../utils/discord.js';
import { getVoiceGateway } from '../../runtime/voiceGateway.js';
import { voiceResponseChannelIds } from '../../discord/voiceState.js';
import {
  areFillersReady,
  selectFiller,
  getFillerSequence,
  getToolFillerAudio,
  getPreToolFillerAudio,
  type FillerSelection,
} from '../../discord/voiceFiller.js';
import { VoicepeakClient } from '../../voicepeak/client.js';
import type { VoicepeakEmotion } from '../../voicepeak/client.js';
import {
  discordAdapter,
  type DiscordNativeEvent,
} from '../../common/adapters/index.js';
import { logger } from '../../../utils/logger.js';

const VOICE_ALLOWED_TOOLS = [
  'google-search', 'fetch-url', 'chat-on-discord',
  'get-discord-images', 'describe-image', 'wolfram-alpha',
  'search-by-wikipedia', 'get-discord-recent-messages',
  'search-weather',
];

function splitIntoSentences(text: string): string[] {
  const parts = text.split(/(?<=[。！？!?])\s*/);
  const sentences: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length > 0) sentences.push(trimmed);
  }
  return sentences.length > 0 ? sentences : [text];
}

export type InvokeGraphFn = (
  envelope: RequestEnvelope,
  legacyMessages?: import('@langchain/core/messages').BaseMessage[],
  options?: {
    onToolStarting?: (toolName: string, args?: Record<string, unknown>) => void;
    onTaskTreeUpdate?: (taskTree: import('@shannon/common').TaskTreeState) => void;
  },
) => Promise<ShannonGraphState>;

export interface VoiceProcessorDeps {
  openaiClient: OpenAI;
  groqClient: OpenAI;
  voicepeakClient: VoicepeakClient;
  voiceCharacterPrompt: string;
  invokeGraph: InvokeGraphFn;
  config: { groqApiKey?: string };
}

export class VoiceProcessor {
  private openaiClient: OpenAI;
  private groqClient: OpenAI;
  private voicepeakClient: VoicepeakClient;
  private voiceCharacterPrompt: string;
  private invokeGraph: InvokeGraphFn;
  private groqApiKey?: string;

  constructor(deps: VoiceProcessorDeps) {
    this.openaiClient = deps.openaiClient;
    this.groqClient = deps.groqClient;
    this.voicepeakClient = deps.voicepeakClient;
    this.voiceCharacterPrompt = deps.voiceCharacterPrompt;
    this.invokeGraph = deps.invokeGraph;
    this.groqApiKey = deps.config.groqApiKey;
  }

  /** Update the voice character prompt (e.g. after hot-reload). */
  setVoiceCharacterPrompt(prompt: string) {
    this.voiceCharacterPrompt = prompt;
  }

  private publishVoiceStatus(memoryZone: MemoryZone, guildId: string, status: string, detail?: string) {
    getVoiceGateway().publishStatus({ guildId, status, detail } as DiscordVoiceStatusInput);
  }

  private async getVoiceMode(guildId: string): Promise<'chat' | 'minebot'> {
    try {
      const { DiscordBot } = await import('../../discord/client.js');
      return DiscordBot.getInstance().getVoiceMode(guildId);
    } catch {
      return 'chat';
    }
  }

  async processDiscordVoiceMessage(message: DiscordVoiceMessageOutput) {
    const memoryZone = await getDiscordMemoryZone(message.guildId);
    const voiceGateway = getVoiceGateway();
    const voiceMsg = message as DiscordVoiceMessageOutput & { audioBuffer?: Buffer; text?: string };
    const audioBuffer: Buffer | undefined = voiceMsg.audioBuffer;
    const directText: string | undefined = voiceMsg.text;
    const isDirectText = !!directText && directText.length > 0;

    if (!isDirectText && (!audioBuffer || audioBuffer.length === 0)) {
      logger.warn('[LLM] Empty audio buffer received from Discord voice');
      return;
    }

    // 1. STT (skip if text provided directly via "音声回答を生成" button)
    const voiceStartTime = Date.now();
    let transcribedText: string;
    let sttMs = 0;

    if (isDirectText) {
      transcribedText = directText!;
      logger.info(`[LLM] Voice direct text input: "${transcribedText}" from ${message.userName}`, 'cyan');
    } else {
      this.publishVoiceStatus(memoryZone, message.guildId, 'stt');
      try {
        const audioBlob = new Blob([new Uint8Array(audioBuffer!)], { type: 'audio/wav' });
        const audioFile = new File([audioBlob], 'voice.wav', { type: 'audio/wav' });

        const sttClient = this.groqApiKey ? this.groqClient : this.openaiClient;
        const sttModel = this.groqApiKey ? 'whisper-large-v3-turbo' : 'whisper-1';
        const transcription = await sttClient.audio.transcriptions.create({
          model: sttModel,
          file: audioFile,
          language: 'ja',
          prompt: 'シャノンとの日常会話です。',
        });
        transcribedText = transcription.text.trim();
      } catch (error) {
        const sErr = classifyError(error, 'llm');
        logger.error(`[LLM] Whisper STT failed: ${formatErrorForLog(sErr)}`);
        return;
      }
      sttMs = Date.now() - voiceStartTime;

      if (!transcribedText || transcribedText.length === 0) {
        logger.info('[LLM] Empty transcription, skipping', 'yellow');
        return;
      }

      const whisperHallucinations = [
        'ご視聴ありがとうございました',
        'ご視聴いただきありがとうございます',
        'ご視聴頂きありがとうございました',
        'チャンネル登録よろしくお願いします',
        '字幕は自動生成されています',
        'ご視聴ありがとうございます',
        'おやすみなさい',
        'Thanks for watching',
        'Thank you for watching',
        'Subscribe to my channel',
        'Subtitles by',
        'はじめしゃちょー',
        'エンディング',
        'チャンネル登録',
        '高評価',
        'いいねボタン',
        'お気に入り登録',
        '次の動画',
        '次回の動画',
        '次回へつづき',
        'お楽しみに',
        'ご覧いただき',
        'グッドボタン',
        'よろしくお願いします',
        '最後までご視聴',
      ];
      if (whisperHallucinations.some(h => transcribedText.includes(h))) {
        logger.info(`[LLM] Whisper hallucination filtered: "${transcribedText}"`, 'yellow');
        return;
      }

      logger.info(`[LLM] Voice STT (${sttMs}ms): "${transcribedText}" from ${message.userName}`, 'cyan');
    }

    // Post transcribed text to Discord (skip for direct text - already visible in chat)
    if (!isDirectText) {
      voiceGateway.postTranscript(
        message.channelId,
        message.guildId,
        `🎤 ${message.userName}: ${transcribedText}`,
      );
    }

    // 2. Filler selection (fast ~300ms with mini)
    this.publishVoiceStatus(memoryZone, message.guildId, 'filler_select');
    const fillerStartTime = Date.now();
    let fillerResult: FillerSelection = { fillerIds: [], fillerOnly: false, needsTools: false };
    let fillerSequence: { audioBuffers: Buffer[]; combinedText: string; totalDurationMs: number } | null = null;

    if (areFillersReady()) {
      try {
        const recentContext = message.recentMessages
          ?.slice(-5)
          .map((m: BaseMessage) =>
            m.content?.toString().replace(/^\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{1,2}:\d{1,2} /, '') ?? '',
          )
          .filter(Boolean)
          .join('\n') || '';
        fillerResult = await selectFiller(transcribedText, message.userName, recentContext || undefined);
        if (fillerResult.fillerIds.length > 0) {
          fillerSequence = getFillerSequence(fillerResult.fillerIds);
          const fillerMs = Date.now() - fillerStartTime;
          logger.info(
            `[Voice] Filler selected: [${fillerResult.fillerIds.join('+')}] "${fillerSequence.combinedText}" ` +
            `(${Math.round(fillerSequence.totalDurationMs)}ms audio, fillerOnly=${fillerResult.fillerOnly}, needsTools=${fillerResult.needsTools}) (${fillerMs}ms)`,
            'cyan'
          );
        } else {
          const fillerMs = Date.now() - fillerStartTime;
          logger.info(`[Voice] No filler selected (${fillerMs}ms)`, 'cyan');
        }
      } catch {
        /* filler selection is best-effort */
      }
    }

    voiceResponseChannelIds.add(message.channelId);

    // 2b. Filler-only: queue fillers and return
    if (fillerResult.fillerOnly && fillerSequence && fillerSequence.audioBuffers.length > 0) {
      voiceGateway.startQueue({
        guildId: message.guildId,
        channelId: message.channelId,
      } as DiscordVoiceQueueStartInput);
      for (const buf of fillerSequence.audioBuffers) {
        voiceGateway.enqueueAudio({
          guildId: message.guildId,
          audioBuffer: buf,
        } as DiscordVoiceEnqueueInput);
      }
      voiceGateway.endQueue({
        guildId: message.guildId,
        channelId: message.channelId,
        text: fillerSequence.combinedText,
      } as DiscordVoiceQueueEndInput);
      const totalMs = Date.now() - voiceStartTime;
      logger.info(`[Voice] Filler-only response (${Math.round(fillerSequence.totalDurationMs)}ms audio). STT: ${sttMs}ms | Total: ${totalMs}ms`, 'cyan');
      voiceResponseChannelIds.delete(message.channelId);
      return;
    }

    // 3. Start voice queue and enqueue fillers immediately
    voiceGateway.startQueue({
      guildId: message.guildId,
      channelId: message.channelId,
    } as DiscordVoiceQueueStartInput);

    if (fillerSequence && fillerSequence.audioBuffers.length > 0) {
      for (const buf of fillerSequence.audioBuffers) {
        voiceGateway.enqueueAudio({
          guildId: message.guildId,
          audioBuffer: buf,
        } as DiscordVoiceEnqueueInput);
      }
      logger.info(`[Voice] Filler enqueued (${fillerSequence.audioBuffers.length} clip(s), ${Math.round(fillerSequence.totalDurationMs)}ms)`, 'cyan');
    }

    // 3b. Pre-tool filler: enqueue a "please wait" clip when tools are expected
    let preToolText = '';
    if (fillerResult.needsTools) {
      const preToolFiller = getPreToolFillerAudio();
      if (preToolFiller) {
        voiceGateway.enqueueAudio({
          guildId: message.guildId,
          audioBuffer: preToolFiller.audio,
        } as DiscordVoiceEnqueueInput);
        preToolText = preToolFiller.text;
        logger.info(`[Voice] Pre-tool filler enqueued: "${preToolFiller.text}"`, 'cyan');
      }
    }

    // 3c. Minebot mode: delegate to Minebot FCA instead of Shannon LLM
    const voiceMode = await this.getVoiceMode(message.guildId);
    if (voiceMode === 'minebot') {
      logger.info(`[Voice] Minebot mode — routing to minebot:voice_chat`, 'magenta');
      this.publishVoiceStatus(memoryZone, message.guildId, 'llm', '🤖 Minebot処理中...');
      voiceGateway.routeToMinebotVoice({
        userName: message.userName,
        message: transcribedText,
        guildId: message.guildId,
        channelId: message.channelId,
      });
      return;
    }

    // 4. Run LLM in parallel (fillers are already playing)
    this.publishVoiceStatus(memoryZone, message.guildId, 'llm');
    const llmStartTime = Date.now();
    const fillerCombinedText = [fillerSequence?.combinedText, preToolText].filter(Boolean).join('') || '';
    const userMessageForLlm = fillerCombinedText
      ? `${transcribedText}\n\n[system: 音声会話でフィラー「${fillerCombinedText}」が既に再生済みです。あなたの応答はフィラーの直後に音声で再生されます。重要なルール: (1) フィラーと同じ言葉・同じ意味の文を絶対に含めないこと (2) フィラーの続きとして自然に繋がる内容だけを生成すること (3) 挨拶・相槌・リアクション等はフィラーで済んでいるので、本題の回答から始めること]`
      : transcribedText;

    const info = {
      guildName: message.guildName,
      channelName: message.channelName,
      guildId: message.guildId,
      channelId: message.channelId,
      voiceChannelId: message.voiceChannelId,
      userId: message.userId,
      inputMethod: 'voice',
    };
    const infoJson = JSON.stringify(info, null, 2);
    const infoMessage = this.voiceCharacterPrompt
      ? `${infoJson}\n\n${this.voiceCharacterPrompt}`
      : infoJson;

    const responsePromise = voiceGateway.waitForTextReply(message.channelId, true);

    const voiceOnToolStarting = (toolName: string) => {
      this.publishVoiceStatus(memoryZone, message.guildId, 'llm', `🔧 ツール使用中: ${toolName}`);
      const toolAudio = getToolFillerAudio(toolName);
      if (toolAudio) {
        voiceGateway.enqueueAudio({
          guildId: message.guildId,
          audioBuffer: toolAudio,
        } as DiscordVoiceEnqueueInput);
        logger.info(`[Voice] Tool filler enqueued for: ${toolName}`, 'cyan');
      }
    };

    // 5. Streaming TTS: synthesize each sentence as soon as LLM emits it
    let streamedSentenceCount = 0;
    const ttsStartTime = Date.now();

    const onStreamSentence = async (sentence: string) => {
      if (streamedSentenceCount === 0) {
        this.publishVoiceStatus(memoryZone, message.guildId, 'tts');
      }
      try {
        voiceGateway.streamSentence({
          guildId: message.guildId,
          channelId: message.channelId,
          sentence,
        } as DiscordVoiceStreamTextInput);
        const wavBuf = await this.voicepeakClient.synthesize(sentence);
        voiceGateway.enqueueAudio({
          guildId: message.guildId,
          audioBuffer: wavBuf,
        } as DiscordVoiceEnqueueInput);
        streamedSentenceCount++;
        logger.info(`[Voice] Streamed sentence #${streamedSentenceCount} TTS enqueued: "${sentence.substring(0, 40)}..."`, 'cyan');
      } catch (err) {
        logger.error(`[Voice] Streaming TTS failed for sentence: "${sentence.substring(0, 40)}..."`, err);
      }
    };

    // Build envelope via ChannelAdapter (voice variant)
    const voiceEnvelope = discordAdapter.toEnvelope({
      text: userMessageForLlm,
      type: 'voice',
      guildName: message.guildName,
      channelId: message.channelId,
      guildId: message.guildId,
      channelName: message.channelName,
      userName: message.userName,
      messageId: '',
      userId: message.userId,
      recentMessages: message.recentMessages as unknown[],
      isVoiceChannel: true,
    } as DiscordNativeEvent);
    // Inject voice-specific metadata
    voiceEnvelope.metadata = {
      ...voiceEnvelope.metadata,
      environmentState: infoMessage,
    };

    const graphResult = await this.invokeGraph(
      voiceEnvelope,
      message.recentMessages
        ? [...message.recentMessages, new HumanMessage(userMessageForLlm)]
        : [],
    );
    const responseText = await responsePromise;
    const llmMs = Date.now() - llmStartTime;
    voiceResponseChannelIds.delete(message.channelId);

    if (!responseText) {
      logger.warn('[LLM] No response text for voice message');
      voiceGateway.endQueue({
        guildId: message.guildId,
        channelId: message.channelId,
        text: '',
      } as DiscordVoiceQueueEndInput);
      return;
    }

    // 6. Fallback: if streaming didn't emit any sentences, use batch TTS
    if (streamedSentenceCount === 0) {
      this.publishVoiceStatus(memoryZone, message.guildId, 'tts');
      try {
        const sentences = splitIntoSentences(responseText);
        const convertedSentences = await Promise.all(
          sentences.map(s => this.voicepeakClient.convertEnglishToKatakana(s)),
        );
        logger.info(`[Voice] Fallback: batch TTS for ${sentences.length} sentence(s) (katakana pre-converted)`, 'cyan');
        for (const cs of convertedSentences) {
          const wavBuf = await this.voicepeakClient.synthesizePreprocessed(cs);
          voiceGateway.enqueueAudio({
            guildId: message.guildId,
            audioBuffer: wavBuf,
          } as DiscordVoiceEnqueueInput);
        }
      } catch (error) {
        logger.error('[Voice] Fallback batch TTS failed:', error);
      }
    }

    const ttsMs = Date.now() - ttsStartTime;
    const totalMs = Date.now() - voiceStartTime;
    logger.info(
      `[Voice] STT: ${sttMs}ms | LLM: ${llmMs}ms | TTS: ${ttsMs}ms (${streamedSentenceCount} streamed) | Total: ${totalMs}ms`,
      'cyan'
    );

    // 7. Signal queue completion with full text for Discord post
    voiceGateway.endQueue({
      guildId: message.guildId,
      channelId: message.channelId,
      text: responseText,
    } as DiscordVoiceQueueEndInput);
  }

  async processMinebotVoiceResponse(data: MinebotVoiceResponseOutput) {
    const { guildId, channelId, responseText } = data;
    const voiceGateway = getVoiceGateway();
    if (!responseText) {
      logger.warn('[Minebot Voice] Empty response text');
      voiceGateway.endQueue({
        guildId,
        channelId,
        text: '',
      } as DiscordVoiceQueueEndInput);
      return;
    }

    const memoryZone = await getDiscordMemoryZone(guildId);
    logger.info(`[Minebot Voice] TTS for response: "${responseText.substring(0, 60)}..."`, 'magenta');
    this.publishVoiceStatus(memoryZone, guildId, 'tts', '🤖 Minebot TTS...');

    try {
      const sentences = splitIntoSentences(responseText);
      const { emotion, convertedSentences } = await this.voicepeakClient.preprocessBatch(responseText, sentences);
      for (const cs of convertedSentences) {
        const wavBuf = await this.voicepeakClient.synthesizePreprocessed(cs, { emotion });
        voiceGateway.enqueueAudio({
          guildId,
          audioBuffer: wavBuf,
        } as DiscordVoiceEnqueueInput);
      }
    } catch (error) {
      logger.error('[Minebot Voice] TTS failed:', error);
    }

    voiceGateway.endQueue({
      guildId,
      channelId,
      text: responseText,
    } as DiscordVoiceQueueEndInput);

    voiceResponseChannelIds.delete(channelId);
    logger.info(`[Minebot Voice] Response complete`, 'magenta');
  }
}
