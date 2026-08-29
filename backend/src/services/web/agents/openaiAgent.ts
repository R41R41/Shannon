import {
  OpenAIMessageOutput,
  OpenAITextInput,
  OpenAIRealTimeTextInput,
  OpenAIRealTimeAudioInput,
  OpenAICommandInput,
} from '@shannon/common';
import {
  WebSocketServiceBase,
  WebSocketServiceConfig,
} from '../../common/WebSocketService.js';
import { logger } from '../../../utils/logger.js';
import { deliverWebMessageToLlm } from '../webNotificationBridge.js';
import { getWebNotificationHub } from '../webNotificationHub.js';

export class OpenAIClientService extends WebSocketServiceBase {
  private static instance: OpenAIClientService | null = null;
  private hubUnsubscribe: (() => void) | null = null;

  private constructor(config: WebSocketServiceConfig) {
    super(config);

    this.hubUnsubscribe = getWebNotificationHub().onPostMessage((data) => {
      if (data.sessionId) return;
      if (data.type === 'text' && data.text) void getWebNotificationHub().log('web', 'white', data.text, true);
      this.broadcast(data);
    });
  }

  public static getInstance(
    config: WebSocketServiceConfig
  ): OpenAIClientService {
    if (!OpenAIClientService.instance) {
      OpenAIClientService.instance = new OpenAIClientService(config);
    }
    return OpenAIClientService.instance;
  }

  protected initialize() {
    this.onAuthenticatedConnection((ws) => {
      logger.debug('New OpenAI client connected');

      this.handleNewConnection(ws);

      ws.on('close', () => {
        logger.debug('OpenAI client disconnected');
      });

      this.onMessage(ws, (message) => {
        try {
          const data = JSON.parse(message.toString());

          if (data.type === 'ping') {
            this.broadcast({ type: 'pong' } as OpenAIMessageOutput);
            return;
          }
          logger.info(
            `valid web message received in openai agent: ${
              data.type === 'realtime_audio'
                ? data.type + ' ' + data.realtime_audio?.length
                : data.type === 'audio'
                ? data.type + ' ' + data.audio?.length
                : JSON.stringify(data)
            }`,
            'blue',
          );
          if (data.type === 'realtime_text' && data.realtime_text) {
            void getWebNotificationHub().log('web', 'white', data.realtime_text);
            deliverWebMessageToLlm({
              type: 'realtime_text',
              realtime_text: data.realtime_text,
            } as OpenAIRealTimeTextInput);
          } else if (
            data.type === 'text' &&
            data.text &&
            data.recentChatLog &&
            data.senderName
          ) {
            void getWebNotificationHub().log('web', 'white', data.text, true);
            deliverWebMessageToLlm({
              type: 'text',
              text: data.text,
              senderName: this.getContext(ws).principal.name,
              recentChatLog: data.recentChatLog,
            } as OpenAITextInput);
          } else if (data.type === 'realtime_audio' && data.realtime_audio) {
            deliverWebMessageToLlm({
              type: 'realtime_audio',
              realtime_audio: data.realtime_audio,
              command: 'realtime_audio_append',
            } as OpenAIRealTimeAudioInput);
          } else if (
            data.type === 'realtime_audio' &&
            data.command === 'realtime_audio_commit'
          ) {
            deliverWebMessageToLlm({
              type: 'command',
              command: 'realtime_audio_commit',
            } as OpenAICommandInput);
          } else if (data.type === 'command' && data.command) {
            void getWebNotificationHub().log('web', 'white', 'received realtime voice commit', true);
            deliverWebMessageToLlm({
              type: 'command',
              command: data.command,
            } as OpenAICommandInput);
          } else if (data.command === 'realtime_vad_on') {
            void getWebNotificationHub().log('web', 'white', 'received realtime vad on');
            deliverWebMessageToLlm({
              type: 'command',
              command: data.command,
            } as OpenAICommandInput);
          } else if (data.command === 'realtime_vad_off') {
            void getWebNotificationHub().log('web', 'white', 'received realtime vad off');
            deliverWebMessageToLlm({
              type: 'command',
              command: data.command,
            } as OpenAICommandInput);
          }
        } catch (error) {
          void getWebNotificationHub().log('web', 'red', 'Error processing message:' + error, true);
          logger.error('Error processing message:', error);
        }
      });
    });
  }

  public start() {
    super.start();
  }

  public disconnect() {
    this.hubUnsubscribe?.();
    this.hubUnsubscribe = null;
  }
}
