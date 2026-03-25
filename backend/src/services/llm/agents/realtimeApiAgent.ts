import WebSocket from 'ws';
import { config } from '../../../config/env.js';
import { models } from '../../../config/models.js';
import { logger } from '../../../utils/logger.js';
import { EventBus } from '../../eventBus/eventBus.js';
import { getEventBus } from '../../eventBus/index.js';

export class RealtimeAPIService {
  private static instance: RealtimeAPIService;
  private ws: WebSocket | null = null;
  private eventBus: EventBus;
  private initialized: boolean = false;
  public onTextResponse: ((text: string) => void) | null;
  public onTextDoneResponse: (() => void) | null;
  public onAudioResponse: ((audio: Uint8Array) => void) | null;
  public onAudioDoneResponse: (() => void) | null;
  public onUserTranscriptResponse: ((text: string) => void) | null = null;
  private callbackTextQueue: string[] = [];
  private callbackAudioQueue: Uint8Array[] = [];
  private isProcessingTextQueue: boolean = false;
  private isProcessingAudioQueue: boolean = false;
  private responseAudioBuffer: Uint8Array = new Uint8Array(0);
  private isTextResponseComplete: boolean = false;
  private isAudioResponseComplete: boolean = false;
  private isUserTranscriptResponseComplete: boolean = true;
  private isVadMode: boolean = false;
  private noVadSessionConfig: Record<string, unknown>;
  private vadSessionConfig: Record<string, unknown>;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectDelay: number = 5000; // 5秒
  private sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private static SESSION_REFRESH_MS = 55 * 60 * 1000; // 55分（60分上限の前に更新）

  constructor() {
    const eventBus = getEventBus();
    this.eventBus = eventBus;
    this.initialized = false; // 初期化状態を追跡
    this.onTextResponse = null; // テキストレスポンス用コールバック
    this.onTextDoneResponse = null; // テキスト完了用コールバック
    this.onAudioResponse = null; // 音声レスポンス用コールバック
    this.onAudioDoneResponse = null; // 音声完了用コールバック
    this.onUserTranscriptResponse = null; // ユーザー音声レスポンス用コールバック
    this.responseAudioBuffer = new Uint8Array(0);
    this.noVadSessionConfig = {
      type: 'session.update',
      session: {
        turn_detection: null,
        modalities: ['text', 'audio'],
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: models.whisper },
        instructions:
          'あなたは優秀なアシスタントAI「シャノン」です。敬語を使って日本語で丁寧に簡潔に答えてください。',
        tool_choice: 'none', // オプション：function callingを使用する場合に必要
        voice: 'sage', // 利用可能なオプション: alloy, ash, ballad, coral, echo, sage, shimmer, verse
        temperature: 0.8, // 0.6 から 1.2 の間
        tools: [],
      },
    };
    this.vadSessionConfig = {
      type: 'session.update',
      session: {
        turn_detection: { type: 'server_vad' },
        modalities: ['text', 'audio'],
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: models.whisper },
        instructions:
          'あなたは優秀なアシスタントAI「シャノン」です。敬語を使って日本語で丁寧に簡潔に答えてください。',
        tool_choice: 'none', // オプション：function callingを使用する場合に必要
        voice: 'sage', // 利用可能なオプション: alloy, ash, ballad, coral, echo, sage, shimmer, verse
        temperature: 0.8, // 0.6 から 1.2 の間
        tools: [],
      },
    };

    this.initialize().catch((e) =>
      logger.error(`[RealtimeAPI] 初回接続失敗 (リトライします): ${e}`)
    );
  }

  public static getInstance(): RealtimeAPIService {
    if (!RealtimeAPIService.instance) {
      RealtimeAPIService.instance = new RealtimeAPIService();
    }
    return RealtimeAPIService.instance;
  }

  setTextCallback(callback: (text: string) => void) {
    this.onTextResponse = (text: string) => {
      this.callbackTextQueue.push(text);
      this.processTextQueue(callback);
    };
  }

  setUserTranscriptCallback(callback: (text: string) => void) {
    this.onUserTranscriptResponse = callback;
  }

  setAudioCallback(callback: (audio: Uint8Array) => void) {
    this.onAudioResponse = (audio: Uint8Array) => {
      this.callbackAudioQueue.push(audio);
      this.processAudioQueue(callback);
    };
  }

  private processTextQueue(callback: (text: string) => void) {
    if (this.isProcessingTextQueue) return;
    if (!this.isUserTranscriptResponseComplete) return;
    this.isProcessingTextQueue = true;

    const processNext = () => {
      if (!this.isUserTranscriptResponseComplete) {
        this.isProcessingTextQueue = false;
        return;
      }

      if (this.callbackTextQueue.length > 0) {
        const text = this.callbackTextQueue.shift();
        if (text) {
          callback(text);
        }
        setTimeout(processNext, 50);
      } else {
        this.isProcessingTextQueue = false;
        if (this.isTextResponseComplete && this.onTextDoneResponse) {
          this.onTextDoneResponse();
          this.isTextResponseComplete = false;
        }
      }
    };

    processNext();
  }

  private processAudioQueue(callback: (audio: Uint8Array) => void) {
    if (this.isProcessingAudioQueue) return;
    this.isProcessingAudioQueue = true;

    const processNext = () => {
      if (this.callbackAudioQueue.length > 0) {
        const audio = this.callbackAudioQueue.shift();
        if (audio) {
          callback(audio);
        }
        setTimeout(processNext, 10);
      } else {
        this.isProcessingAudioQueue = false;
        if (this.isAudioResponseComplete && this.onAudioDoneResponse) {
          this.onAudioDoneResponse();
          this.isAudioResponseComplete = false;
        }
      }
    };

    processNext();
  }

  setTextDoneCallback(callback: () => void) {
    this.callbackTextQueue = [];
    this.onTextDoneResponse = callback;
  }

  setAudioDoneCallback(callback: () => void) {
    this.callbackAudioQueue = [];
    this.onAudioDoneResponse = callback;
  }

  private async initialize() {
    if (this.initialized) return;
    logger.debug('RealtimeAPI initialized');

    const url = `wss://api.openai.com/v1/realtime?model=${models.realtime}`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${config.openaiApiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      this.ws.on('open', () => {
        logger.success('Connected to OpenAI Realtime API');
        if (this.ws) {
          this.ws.send(JSON.stringify(this.noVadSessionConfig));
        }
        this.initialized = true;
        this.reconnectAttempts = 0;
        this.scheduleSessionRefresh();
        resolve(true);
      });

      this.ws.on('message', (message: WebSocket.Data) => {
        const data = JSON.parse(message.toString());

        switch (data.type) {
          case 'session.created':
            logger.debug('Session created');
            break;

          case 'session.updated':
            logger.debug('Session updated');
            break;

          case 'response.created':
            logger.info('Response creation started', 'blue');
            this.eventBus.log('web', 'blue', 'Response creation started');
            break;

          case 'response.text.delta':
            if (this.onTextResponse) {
              this.onTextResponse(data.delta);
            }
            break;

          case 'response.text.done':
            logger.success('Text done');
            this.eventBus.log('web', 'green', 'Text done');
            this.isTextResponseComplete = true;
            if (!this.isProcessingTextQueue && this.onTextDoneResponse) {
              this.onTextDoneResponse();
              this.isTextResponseComplete = false;
            }
            break;

          case 'input_audio_buffer.committed':
            logger.success('Speech committed');
            this.eventBus.log('web', 'green', 'Speech committed');
            this.isUserTranscriptResponseComplete = false;
            break;

          case 'input_audio_buffer.append':
            // console.log(
            // 	"\x1b[32minput_audio_buffer.append\x1b[0m",
            // 	data.audio.length
            // );
            break;

          case 'input_audio_buffer.debug':
            logger.warn(`Current OpenAI buffer state: ${JSON.stringify(data, null, 2)}`);
            break;

          case 'response.audio.delta':
            if (this.onAudioResponse) {
              this.onAudioResponse(data.delta);
            }
            break;

          case 'response.audio.done':
            logger.success(`Response Audio completed: ${this.responseAudioBuffer.length} bytes`);
            this.eventBus.log('web', 'green', 'Response Audio completed');
            this.isAudioResponseComplete = true;
            if (!this.isProcessingAudioQueue && this.onAudioDoneResponse) {
              this.onAudioDoneResponse();
              this.isAudioResponseComplete = false;
            }
            break;

          case 'response.audio_transcript.delta':
            if (this.onTextResponse) {
              this.onTextResponse(data.delta);
            }
            break;

          case 'response.audio_transcript.done':
            logger.success('Transcript done');
            this.eventBus.log('web', 'green', 'Transcript done');
            this.isTextResponseComplete = true;
            if (!this.isProcessingTextQueue && this.onTextDoneResponse) {
              this.onTextDoneResponse();
              this.isTextResponseComplete = false;
            }
            break;

          case 'conversation.item.input_audio_transcription.completed':
            logger.success('Transcript completed');
            this.eventBus.log('web', 'green', 'Transcript completed');
            this.isUserTranscriptResponseComplete = true;
            if (this.onUserTranscriptResponse && data.transcript) {
              this.onUserTranscriptResponse(data.transcript);
            }
            break;

          case 'error':
            logger.error(`Server error: ${JSON.stringify(data)}`);
            this.eventBus.log('web', 'red', 'Server error', true);
            if (data.error?.code === 'session_expired') {
              logger.info('[RealtimeAPI] セッション期限切れ。自動再接続します...', 'cyan');
              if (this.sessionRefreshTimer) {
                clearTimeout(this.sessionRefreshTimer);
                this.sessionRefreshTimer = null;
              }
              this.initialized = false;
              this.reconnectAttempts = 0;
              this.scheduleReconnect();
            }
            break;

          default:
            break;
        }
      });

      let settled = false;

      this.ws.on('error', (error) => {
        logger.error(`WebSocket error: ${error}`);
        this.eventBus.log('web', 'red', 'WebSocket error');
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      this.ws.on('close', () => {
        logger.debug('WebSocket connection closed');
        this.eventBus.log('web', 'red', 'WebSocket connection closed');
        this.initialized = false;
        if (!settled) {
          settled = true;
          reject(new Error('WebSocket closed before open'));
        }
        this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect() {
    if (this.initialized) return;
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 60000);
    logger.debug(`[RealtimeAPI] ${delay / 1000}秒後に再接続します (試行 ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      logger.error(`[RealtimeAPI] 最大再接続回数 (${this.maxReconnectAttempts}) を超えました。再接続を停止します。`);
      return;
    }
    setTimeout(() => {
      if (!this.initialized) {
        this.initialize().catch((e) =>
          logger.error(`[RealtimeAPI] 再接続失敗: ${e}`)
        );
      }
    }, delay);
  }

  private scheduleSessionRefresh() {
    if (this.sessionRefreshTimer) {
      clearTimeout(this.sessionRefreshTimer);
    }
    this.sessionRefreshTimer = setTimeout(() => {
      logger.debug('[RealtimeAPI] セッション更新: 55分経過のため再接続します');
      this.initialized = false;
      if (this.ws) {
        try { this.ws.close(); } catch { /* ignore */ }
        this.ws = null;
      }
      this.initialize().catch((e) =>
        logger.error(`[RealtimeAPI] セッション更新失敗: ${e}`)
      );
    }, RealtimeAPIService.SESSION_REFRESH_MS);
  }

  private async ensureConnection() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.info('WebSocket not connected, attempting to reconnect...');
      await this.initialize();
    }
  }

  async inputText(text: string) {
    try {
      await this.ensureConnection();

      const textMessage = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      };
      this.ws?.send(JSON.stringify(textMessage));

      const responseRequest = {
        type: 'response.create',
        response: { modalities: ['text'] },
      };
      this.ws?.send(JSON.stringify(responseRequest));
    } catch (error) {
      logger.error('Error processing text input:', error);
      throw error;
    }
  }

  async inputAudioBufferAppend(data: string) {
    try {
      await this.ensureConnection();

      const audioMessage = {
        type: 'input_audio_buffer.append',
        audio: data,
      };
      this.ws?.send(JSON.stringify(audioMessage));
    } catch (error) {
      logger.error(`Error processing voice input: ${error}`);
      throw error;
    }
  }

  async inputAudioBufferCommit() {
    if (this.ws) {
      const commitMessage = {
        type: 'input_audio_buffer.commit',
      };
      logger.info(`inputAudioBufferCommit ${JSON.stringify(commitMessage)}`);
      this.ws.send(JSON.stringify(commitMessage));

      const responseRequest = {
        type: 'response.create',
        response: {
          modalities: ['audio', 'text'],
        },
      };
      this.ws.send(JSON.stringify(responseRequest));
    }
  }

  async vadModeChange(data: boolean) {
    if (this.ws) {
      this.isVadMode = data;
      if (this.isVadMode) {
        logger.info('VAD mode change: true', 'cyan');
        this.eventBus.log('web', 'cyan', 'VAD mode change: true');
        this.ws.send(JSON.stringify(this.vadSessionConfig));
      } else {
        logger.info('VAD mode change: false', 'cyan');
        this.eventBus.log('web', 'cyan', 'VAD mode change: false');
        this.ws.send(JSON.stringify(this.noVadSessionConfig));
      }
    }
  }

  cleanup() {
    if (this.sessionRefreshTimer) {
      clearTimeout(this.sessionRefreshTimer);
      this.sessionRefreshTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private async connect() {
    try {
      const url = `wss://api.openai.com/v1/realtime?model=${models.realtime}`;

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${config.openaiApiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      this.ws.onclose = this.handleDisconnect.bind(this);
      this.setupWebSocketHandlers();

      // セッション設定を送信
      await this.initializeSession();

      this.reconnectAttempts = 0; // 接続成功したらリセット
      this.eventBus.log('web', 'white', 'Connected to OpenAI Realtime API');
    } catch (error) {
      this.eventBus.log('web', 'red', JSON.stringify(error), true);
      this.handleDisconnect();
    }
  }

  private handleDisconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      this.eventBus.log(
        'web',
        'white',
        `Attempting reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts}`
      );

      setTimeout(() => {
        this.connect();
      }, this.reconnectDelay);
    } else {
      this.eventBus.log('web', 'red', 'Max reconnection attempts reached');
    }
  }

  private async initializeSession() {
    if (!this.ws) return;

    // 基本的なセッション設定
    const sessionConfig = {
      type: 'session.update',
      session: {
        turn_detection: null,
        modalities: ['text', 'audio'],
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: models.whisper },
        instructions:
          'あなたは優秀なアシスタントAI「シャノン」です。敬語を使って日本語で丁寧に簡潔に答えてください。',
        voice: 'sage',
        temperature: 0.8,
      },
    };

    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject('No WebSocket connection');

      const timeout = setTimeout(() => {
        reject('Session initialization timeout');
      }, 10000);

      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data.toString());
        if (data.type === 'session.created') {
          clearTimeout(timeout);
          resolve();
        }
      };

      this.ws.send(JSON.stringify(sessionConfig));
    });
  }

  private setupWebSocketHandlers() {
    // Implementation of setupWebSocketHandlers method
  }
}
