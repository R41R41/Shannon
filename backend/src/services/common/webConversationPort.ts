import {
  bindWebConversation,
  WEB_CONVERSATION_REQUIRED,
  type WebConversationBinding,
  type WebConversationPort,
  type WebConversationRequest,
} from '../../modules/conversation/webConversation.js';

export interface WebConversationTransport {
  postMessage(binding: WebConversationBinding, message: string, signal?: AbortSignal): Promise<void>;
  publishPlanning(binding: WebConversationBinding, planning: unknown, taskId: string, signal?: AbortSignal): Promise<void>;
}

let registeredTransport: WebConversationTransport | undefined;

/** Bootstrap only. No connections or timers are started by this module. */
export function registerWebConversationTransport(transport: WebConversationTransport): void {
  if (registeredTransport && registeredTransport !== transport) throw new Error('Web conversation transport already registered');
  registeredTransport = transport;
}

export function createRequestWebConversation(
  request?: WebConversationRequest,
  signal?: AbortSignal,
  transport: WebConversationTransport | undefined = registeredTransport,
): WebConversationPort {
  const binding = bindWebConversation(request);
  return Object.freeze({
    async postMessage(input) {
      if (!binding || !transport || signal?.aborted || typeof input.message !== 'string' || !input.message.trim()) {
        return { status: 'denied' as const, message: WEB_CONVERSATION_REQUIRED };
      }
      try {
        await transport.postMessage(binding, input.message, signal);
        return { status: 'sent' as const, message: '現在のWebセッションへの送信を受理しました。' };
      } catch {
        return { status: 'denied' as const, message: WEB_CONVERSATION_REQUIRED };
      }
    },
    async publishPlanning(input) {
      if (!binding || !transport || signal?.aborted || !input.taskId.trim()) {
        return { status: 'denied' as const, message: WEB_CONVERSATION_REQUIRED };
      }
      try {
        await transport.publishPlanning(binding, input.planning, input.taskId, signal);
        return { status: 'sent' as const, message: '計画更新を現在のWebセッションへ通知しました。' };
      } catch {
        return { status: 'denied' as const, message: WEB_CONVERSATION_REQUIRED };
      }
    },
  } satisfies WebConversationPort);
}

export function bindRequestWebConversation(tools: readonly unknown[], request?: WebConversationRequest, signal?: AbortSignal): void {
  const port = createRequestWebConversation(request, signal);
  for (const tool of tools) {
    const target = tool as { setWebConversationPort?: (port: WebConversationPort) => void };
    target.setWebConversationPort?.(port);
  }
}
