import type { RequestEnvelope } from '@shannon/common';

export interface ShannonCoreBridgeConfiguration {
  url: string;
  token: string;
  bindingsJson: string;
  timeoutMs: number;
  /**
   * `SHANNON_CORE_PLATFORM_REPLY=true`: a Discord text message in a bound conversation is answered by the companion's
   * `POST /v1/platform/reply` (her one mind) instead of this runtime's own model. Default off.
   */
  replyEnabled?: boolean;
  /** `SHANNON_CORE_PLATFORM_REPLY_PEOPLE=true`: also messages of people other than the bound owner. Default off (owner only). */
  replyPeopleEnabled?: boolean;
  /** How long a reply may take (a model turn, with tools): 5,000–60,000 ms, default 55,000. */
  replyTimeoutMs?: number;
}

interface ShannonCoreBridgeBinding {
  platform: 'discord';
  conversationId?: string;
  conversationIdPrefix?: string;
  ownerUserId: string;
}

export interface ShannonCoreBridge {
  mirrorDiscordTurn(envelope: RequestEnvelope, reply: string): Promise<void>;
  readDiscordContext(envelope: RequestEnvelope): Promise<ShannonCoreContextResult>;
  /** Her reply from the companion, or why this runtime answers with its own path. Never throws. */
  requestDiscordReply(envelope: RequestEnvelope): Promise<ShannonCoreReplyResult>;
}

export type ShannonCoreReplyResult =
  | { status: 'available'; reply: string; threadId: string; duplicate: boolean }
  | { status: 'ineligible' | 'unavailable' };

export type ShannonCoreContextResult =
  | { status: 'available'; projection: string; stateVersion: number; updatedAt: string }
  | { status: 'ineligible' | 'unavailable' };

export class ShannonCoreBridgeError extends Error {
  constructor(readonly code: 'CONFIG_INVALID' | 'REQUEST_INVALID' | 'UPSTREAM_UNAVAILABLE') {
    super(code);
    this.name = 'ShannonCoreBridgeError';
  }
}

export function createShannonCoreBridge(
  bridgeConfig: ShannonCoreBridgeConfiguration,
  fetcher: typeof fetch = fetch,
): ShannonCoreBridge | null {
  const url = bridgeConfig.url.trim();
  const token = bridgeConfig.token.trim();
  const bindingsJson = bridgeConfig.bindingsJson?.trim() ?? '';
  if (!url && !token && !bindingsJson) return null;
  if (!validBridgeUrl(url) || token.length < 32
    || !bindingsJson
    || !Number.isSafeInteger(bridgeConfig.timeoutMs)
    || bridgeConfig.timeoutMs < 500
    || bridgeConfig.timeoutMs > 10_000) {
    throw new ShannonCoreBridgeError('CONFIG_INVALID');
  }
  const replyTimeoutMs = bridgeConfig.replyTimeoutMs ?? 55_000;
  if (bridgeConfig.replyEnabled === true
    && (!Number.isSafeInteger(replyTimeoutMs) || replyTimeoutMs < 5_000 || replyTimeoutMs > 60_000)) {
    throw new ShannonCoreBridgeError('CONFIG_INVALID');
  }
  const bindings = validatedBindings(bindingsJson);
  const contextUrl = new URL(url);
  contextUrl.pathname = '/v1/platform/context';
  const replyUrl = new URL(url);
  replyUrl.pathname = '/v1/platform/reply';
  return Object.freeze({
    async mirrorDiscordTurn(envelope: RequestEnvelope, reply: string): Promise<void> {
      const ownerBody = discordTurnBody(envelope, reply);
      const binding = bindings.find(candidate => matchesConversation(candidate, ownerBody.conversationId));
      if (!binding) return;
      // Someone other than the owner: the core remembers them as a person of this conversation,
      // identified by the platform account. Without a display name there is nothing to remember.
      const otherPerson = binding.ownerUserId !== ownerBody.sourceUserId;
      const body = otherPerson ? personTurnBody(envelope, ownerBody) : ownerBody;
      if (!body) return;
      const response = await fetcher(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(bridgeConfig.timeoutMs),
      }).catch(() => { throw new ShannonCoreBridgeError('UPSTREAM_UNAVAILABLE'); });
      if (response.status === 200 || response.status === 201) return;
      // Remembering other people is best effort: a refusal, the switch being off, a changed
      // message under the same id, or a rate limit never fails the Discord turn.
      if (otherPerson && [403, 409, 429].includes(response.status)) return;
      throw new ShannonCoreBridgeError('UPSTREAM_UNAVAILABLE');
    },
    async readDiscordContext(envelope: RequestEnvelope): Promise<ShannonCoreContextResult> {
      const baseBody = discordContextBody(envelope);
      const binding = bindings.find(candidate => matchesConversation(candidate, baseBody.conversationId));
      if (!binding) return { status: 'ineligible' };
      // The core filters the projection by who is in the conversation. An owner-authored
      // request keeps today's shape; another person's request states the conversation kind
      // and names that person as a participant.
      const body = binding.ownerUserId === baseBody.sourceUserId
        ? baseBody
        : { ...baseBody, conversationKind: discordConversationKind(envelope), participants: [baseBody.sourceUserId] };
      let response: Response;
      try {
        response = await fetcher(contextUrl.toString(), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(bridgeConfig.timeoutMs),
        });
      } catch {
        return { status: 'unavailable' };
      }
      if (response.status !== 200) return { status: 'unavailable' };
      try {
        const decoded = await response.json() as Record<string, unknown>;
        if (decoded.schemaVersion !== 1
          || !Number.isSafeInteger(decoded.stateVersion)
          || typeof decoded.updatedAt !== 'string'
          || !validTimestamp(decoded.updatedAt)
          || !bounded(decoded.projection, 2_400)) return { status: 'unavailable' };
        return {
          status: 'available',
          projection: decoded.projection.trim(),
          stateVersion: decoded.stateVersion as number,
          updatedAt: new Date(decoded.updatedAt).toISOString(),
        };
      } catch {
        return { status: 'unavailable' };
      }
    },
    async requestDiscordReply(envelope: RequestEnvelope): Promise<ShannonCoreReplyResult> {
      if (bridgeConfig.replyEnabled !== true) return { status: 'ineligible' };
      const body = discordReplyBody(envelope);
      if (!body) return { status: 'ineligible' };
      // Only a bound conversation is ever sent; anyone but the bound owner only when explicitly switched on.
      const binding = bindings.find(candidate => matchesConversation(candidate, body.conversationId));
      if (!binding) return { status: 'ineligible' };
      const owner = binding.ownerUserId === body.sourceUserId;
      if (!owner && (bridgeConfig.replyPeopleEnabled !== true || !body.sourceDisplayName)) return { status: 'ineligible' };
      const { sourceDisplayName, ...ownerBody } = body;
      let response: Response;
      try {
        response = await fetcher(replyUrl.toString(), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(owner ? ownerBody : { ...ownerBody, sourceDisplayName }),
          redirect: 'error',
          signal: AbortSignal.timeout(replyTimeoutMs),
        });
      } catch {
        return { status: 'unavailable' };
      }
      if (response.status !== 200 && response.status !== 201) return { status: 'unavailable' };
      try {
        const decoded = await response.json() as Record<string, unknown>;
        if (!bounded(decoded.reply, 12_000) || !bounded(decoded.threadId, 200) || typeof decoded.duplicate !== 'boolean') {
          return { status: 'unavailable' };
        }
        return { status: 'available', reply: decoded.reply.trim(), threadId: decoded.threadId, duplicate: decoded.duplicate };
      } catch {
        return { status: 'unavailable' };
      }
    },
  });
}

/**
 * A Discord text message as `POST /v1/platform/reply` takes it, or null when this runtime answers it itself: voice,
 * malformed, an attachment or image URL (text only crosses the bridge), or this bot's own clarification follow-up.
 */
function discordReplyBody(envelope: RequestEnvelope) {
  const sourceRequestId = envelope.discord?.messageId ?? envelope.requestId;
  if (envelope.channel !== 'discord'
    || envelope.discord?.isVoiceChannel === true
    || !bounded(sourceRequestId, 160)
    || !bounded(envelope.conversationId, 240)
    || !bounded(envelope.sourceUserId, 160)
    || !bounded(envelope.text, 8_000)
    || !validTimestamp(envelope.timestampIso)
    || !companionText(envelope.text)) return null;
  const displayName = envelope.sourceDisplayName ?? envelope.discord?.userName;
  return {
    platform: 'discord' as const,
    requestId: sourceRequestId.trim(),
    conversationId: envelope.conversationId.trim(),
    conversationKind: envelope.discord?.isDM === true ? 'dm' as const : 'channel' as const,
    sourceUserId: envelope.sourceUserId.trim(),
    userMessage: envelope.text.trim(),
    observedAt: new Date(envelope.timestampIso).toISOString(),
    ...(bounded(displayName, 80) ? { sourceDisplayName: displayName.trim() } : {}),
  };
}

/** Text the companion may receive: no Discord attachment or image URLs, and not the agent-task clarification follow-up. */
function companionText(text: string): boolean {
  return !text.trimStart().startsWith('[追加要件への回答]')
    && !/https?:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\//i.test(text);
}

function discordContextBody(envelope: RequestEnvelope) {
  if (envelope.channel !== 'discord'
    || envelope.discord?.isVoiceChannel === true
    || !bounded(envelope.conversationId, 240)
    || !bounded(envelope.sourceUserId, 160)) {
    throw new ShannonCoreBridgeError('REQUEST_INVALID');
  }
  return {
    platform: 'discord' as const,
    conversationId: envelope.conversationId.trim(),
    sourceUserId: envelope.sourceUserId.trim(),
  };
}

function discordTurnBody(envelope: RequestEnvelope, reply: string) {
  const sourceRequestId = envelope.discord?.messageId ?? envelope.requestId;
  if (envelope.channel !== 'discord'
    || envelope.discord?.isVoiceChannel === true
    || !bounded(sourceRequestId, 160)
    || !bounded(envelope.conversationId, 240)
    || !bounded(envelope.sourceUserId, 160)
    || !bounded(envelope.text, 8_000)
    || !bounded(reply, 12_000)
    || !validTimestamp(envelope.timestampIso)) {
    throw new ShannonCoreBridgeError('REQUEST_INVALID');
  }
  return {
    platform: 'discord',
    requestId: sourceRequestId.trim(),
    conversationId: envelope.conversationId.trim(),
    sourceUserId: envelope.sourceUserId.trim(),
    userMessage: envelope.text.trim(),
    shannonReply: reply.trim(),
    observedAt: new Date(envelope.timestampIso).toISOString(),
  };
}

function discordConversationKind(envelope: RequestEnvelope): 'dm' | 'channel' {
  return envelope.discord?.isDM === true ? 'dm' : 'channel';
}

/** Adds what the core needs to remember a person: the account's shown name and the conversation kind. */
function personTurnBody(envelope: RequestEnvelope, body: ReturnType<typeof discordTurnBody>) {
  const displayName = (envelope.sourceDisplayName ?? envelope.discord?.userName ?? '').trim().slice(0, 80);
  if (!bounded(displayName, 80)) return null;
  return {
    ...body,
    conversationKind: discordConversationKind(envelope),
    sourceDisplayName: displayName,
    sourceKind: 'person' as const,
  };
}

function validBridgeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/v1/platform/turns') return false;
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '::1'].includes(url.hostname));
  } catch {
    return false;
  }
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !value.includes('\0');
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validatedBindings(raw: string): readonly ShannonCoreBridgeBinding[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new ShannonCoreBridgeError('CONFIG_INVALID');
  }
  if (!Array.isArray(decoded) || decoded.length < 1 || decoded.length > 64) {
    throw new ShannonCoreBridgeError('CONFIG_INVALID');
  }
  const bindings = decoded.map(candidate => validatedBinding(candidate));
  for (let index = 0; index < bindings.length; index += 1) {
    for (let other = index + 1; other < bindings.length; other += 1) {
      if (bindingsOverlap(bindings[index]!, bindings[other]!)) {
        throw new ShannonCoreBridgeError('CONFIG_INVALID');
      }
    }
  }
  return Object.freeze(bindings);
}

function validatedBinding(value: unknown): ShannonCoreBridgeBinding {
  if (!recordValue(value) || value.platform !== 'discord' || !bounded(value.ownerUserId, 160)) {
    throw new ShannonCoreBridgeError('CONFIG_INVALID');
  }
  const exact = bounded(value.conversationId, 240);
  const prefix = validDiscordConversationPrefix(value.conversationIdPrefix);
  if (exact === prefix) throw new ShannonCoreBridgeError('CONFIG_INVALID');
  return Object.freeze({
    platform: 'discord',
    ...(exact ? { conversationId: (value.conversationId as string).trim() } : {}),
    ...(prefix ? { conversationIdPrefix: (value.conversationIdPrefix as string).trim() } : {}),
    ownerUserId: value.ownerUserId.trim(),
  });
}

function matchesConversation(binding: ShannonCoreBridgeBinding, conversationId: string): boolean {
  return binding.conversationId === conversationId
    || (binding.conversationIdPrefix !== undefined
      && conversationId.startsWith(binding.conversationIdPrefix)
      && /^\d{1,32}$/.test(conversationId.slice(binding.conversationIdPrefix.length)));
}

function bindingsOverlap(left: ShannonCoreBridgeBinding, right: ShannonCoreBridgeBinding): boolean {
  if (left.conversationId && right.conversationId) return left.conversationId === right.conversationId;
  if (left.conversationIdPrefix && right.conversationIdPrefix) {
    return left.conversationIdPrefix === right.conversationIdPrefix;
  }
  const exact = left.conversationId ?? right.conversationId ?? '';
  const prefix = left.conversationIdPrefix ?? right.conversationIdPrefix ?? '\u0000';
  return exact.startsWith(prefix);
}

function validDiscordConversationPrefix(value: unknown): value is string {
  return typeof value === 'string' && /^discord:\d{1,32}:$/.test(value.trim());
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
