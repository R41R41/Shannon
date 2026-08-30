/** LINE IDs are channel/provider scoped. Never identify people by their display name. */
export const lineUserId = (v: unknown): v is string => typeof v === 'string' && /^U[0-9a-f]{32}$/.test(v);
export const lineGroupId = (v: unknown): v is string => typeof v === 'string' && /^C[0-9a-f]{32}$/.test(v);
export interface LinePolicy {
  enabled: boolean;
  botUserId: string;
  personalUserId: string;
  allowedGroupIds: readonly string[];
  groupMode: 'addressed' | 'all';
  chatMaxPer24Hours: number;
  pushMaxPerMonth: number;
  pushMaxPer24Hours: number;
  quietStartJst: number;
  quietEndJst: number;
}
export interface LineTurn {
  eventId: string; messageId: string; timestamp: number; replyToken: string;
  kind: 'personal' | 'group'; conversationId: string; userId: string;
  text: string; quotedMessageId?: string;
}
const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const messageId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,64}$/.test(v);
export function lineScope(source: unknown, p: LinePolicy): { kind: 'personal' | 'group'; id: string; userId: string } | undefined {
  const s = source as Record<string, unknown> | null;
  if (!p.enabled || !s || !lineUserId(s.userId) || s.userId === p.botUserId) return;
  if (s.type === 'user' && s.userId === p.personalUserId) return { kind: 'personal', id: `personal:${s.userId}`, userId: s.userId };
  if (s.type === 'group' && lineGroupId(s.groupId) && p.allowedGroupIds.includes(s.groupId))
    return { kind: 'group', id: `group:${s.groupId}`, userId: s.userId };
}
export function parseLineTurn(value: unknown, p: LinePolicy, now: number): LineTurn | undefined {
  const e = value as any; const s = lineScope(e?.source, p); const m = e?.message;
  if (!s || e.type !== 'message' || e.mode !== 'active' || m?.type !== 'text' || !token(e.webhookEventId)
    || !messageId(m.id) || !token(e.replyToken) || !Number.isSafeInteger(e.timestamp)
    || e.timestamp > now + 5000 || now - e.timestamp > 55000
    || typeof m.text !== 'string' || !m.text.trim() || m.text.length > 4000) return;
  const mentions = m.mention?.mentionees;
  const addressed = /^(?:シャノン|shannon|\/shannon)(?:[\s、，,:：!?！？]|$)/i.test(m.text.trim())
    || (Array.isArray(mentions) && mentions.some((v: any) => v?.type === 'user' && v.userId === p.botUserId));
  if (s.kind === 'group' && p.groupMode === 'addressed' && !addressed) return;
  return { eventId: e.webhookEventId, messageId: m.id, timestamp: e.timestamp, replyToken: e.replyToken,
    kind: s.kind, conversationId: s.id, userId: s.userId, text: m.text,
    ...(messageId(m.quotedMessageId) ? { quotedMessageId: m.quotedMessageId } : {}) };
}
export function lineQuiet(p: LinePolicy, now: number): boolean {
  const h = new Date(now + 9 * 3600000).getUTCHours();
  return p.quietStartJst === p.quietEndJst ? false : p.quietStartJst < p.quietEndJst
    ? h >= p.quietStartJst && h < p.quietEndJst : h >= p.quietStartJst || h < p.quietEndJst;
}
export interface LineChatMessage { role: 'user' | 'assistant'; content: string }
export type LineSendResult = { status: 'accepted'; messageId?: string } | { status: 'unknown' | 'failed' };
