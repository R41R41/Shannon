/** Internal capability for the originating Web session, not ingress authentication. */

export interface WebConversationRequest {
  channel: string;
  requestId: string;
  conversationId: string;
  sourceUserId: string;
  metadata?: { sessionId?: string };
}

export interface WebConversationBinding {
  readonly requestId: string;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly subjectId: string;
}

const issued = new WeakSet<object>();
export const WEB_CONVERSATION_REQUIRED = '現在のWebセッションへの許可がないため実行しません。';
export class WebConversationDeniedError extends Error {
  constructor() { super(WEB_CONVERSATION_REQUIRED); }
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

export function bindWebConversation(request?: WebConversationRequest): WebConversationBinding | undefined {
  if (!request || request.channel !== 'web') return undefined;
  if (!nonempty(request.requestId) || !nonempty(request.conversationId) || !nonempty(request.sourceUserId)) return undefined;
  const fromMetadata = request.metadata?.sessionId;
  const fromConversation = request.conversationId.startsWith('web:') ? request.conversationId.slice(4) : undefined;
  const sessionId = nonempty(fromMetadata) ? fromMetadata : fromConversation;
  if (!sessionId) return undefined;
  const binding = Object.freeze({
    requestId: request.requestId,
    conversationId: request.conversationId,
    sessionId,
    subjectId: request.sourceUserId,
  });
  issued.add(binding);
  return binding;
}

export function hasWebConversation(binding: unknown): binding is WebConversationBinding {
  return typeof binding === 'object' && binding !== null && issued.has(binding);
}

export interface WebPostMessageResult { status: 'sent' | 'denied'; message: string }

export interface WebConversationPort {
  postMessage(input: { message: string }): Promise<WebPostMessageResult>;
  publishPlanning(input: { planning: unknown; taskId: string }): Promise<WebPostMessageResult>;
}
