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
import { deliverWebMessageToLlm } from '../../runtime/llmInboundDispatch.js';
import { getWebNotificationHub } from '../webNotificationHub.js';
import { releaseWebRealtimeInput } from '../webRealtimeInputLock.js';

export class OpenAIClientService extends WebSocketServiceBase {
  private static instance: OpenAIClientService | null = null;
  private hubUnsubscribe: (() => void) | null = null;

  private constructor(config: WebSocketServiceConfig) {
    super(config);

    this.hubUnsubscribe = getWebNotificationHub().onPostMessage((data) => {
      this.broadcastWebPayload(data, data);
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
        releaseWebRealtimeInput(this.getWebSessionId(ws));
        logger.debug('OpenAI client disconnected');
      });

      this.onMessage(ws, (message) => {
        try {
          const data = JSON.parse(message.toString());
          const sessionId = this.getWebSessionId(ws);

          if (data.type === 'ping') {
            this.broadcast({ type: 'pong' } as OpenAIMessageOutput);
            return;
          }
          if (data.type === 'web:bind-session' && typeof data.sessionId === 'string') {
            this.bindWebSession(ws, data.sessionId);
            return;
          }
          if (!sessionId) {
            logger.warn('[OpenAIClientService] Dropping web message without bound session');
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
            void getWebNotificationHub().log('web', 'white', data.realtime_text, false, sessionId);
            deliverWebMessageToLlm({
              type: 'realtime_text',
              realtime_text: data.realtime_text,
              sessionId,
            } as OpenAIRealTimeTextInput & { sessionId: string });
          } else if (
            data.type === 'text' &&
            data.text &&
            data.recentChatLog &&
            data.senderName
          ) {
            void getWebNotificationHub().log('web', 'white', data.text, true, sessionId);
            deliverWebMessageToLlm({
              type: 'text',
              text: data.text,
              senderName: this.getContext(ws).principal.name,
              recentChatLog: data.recentChatLog,
              sessionId,
              sourceUserId: this.getContext(ws).principal.uid,
            } as OpenAITextInput & { sessionId: string; sourceUserId: string });
          } else if (data.type === 'realtime_audio' && data.realtime_audio) {
            deliverWebMessageToLlm({
              type: 'realtime_audio',
              realtime_audio: data.realtime_audio,
              command: 'realtime_audio_append',
              sessionId,
            } as OpenAIRealTimeAudioInput & { sessionId: string });
          } else if (
            data.type === 'realtime_audio' &&
            data.command === 'realtime_audio_commit'
          ) {
            deliverWebMessageToLlm({
              type: 'command',
              command: 'realtime_audio_commit',
              sessionId,
            } as OpenAICommandInput & { sessionId: string });
          } else if (data.type === 'command' && data.command) {
            void getWebNotificationHub().log('web', 'white', 'received realtime voice commit', true, sessionId);
            deliverWebMessageToLlm({
              type: 'command',
              command: data.command,
              sessionId,
            } as OpenAICommandInput & { sessionId: string });
          } else if (data.command === 'realtime_vad_on') {
            void getWebNotificationHub().log('web', 'white', 'received realtime vad on', false, sessionId);
            deliverWebMessageToLlm({
              type: 'command',
              command: data.command,
              sessionId,
            } as OpenAICommandInput & { sessionId: string });
          } else if (data.command === 'realtime_vad_off') {
            void getWebNotificationHub().log('web', 'white', 'received realtime vad off', false, sessionId);
            deliverWebMessageToLlm({
              type: 'command',
              command: data.command,
              sessionId,
            } as OpenAICommandInput & { sessionId: string });
          }
        } catch (error) {
          const sessionId = this.getWebSessionId(ws);
          void getWebNotificationHub().log('web', 'red', 'Error processing message:' + error, true, sessionId);
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
