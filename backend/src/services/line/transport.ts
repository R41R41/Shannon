import type { LineSendResult } from '../../modules/conversation/lineConversation.js';
import type { LineTransport } from './ports.js';
import { lineUserId } from '../../modules/conversation/lineConversation.js';
/** The only outbound LINE API surface: fixed HTTPS host, no redirects, no automatic retry. */
export class LineHttpTransport implements LineTransport {
  constructor(private readonly accessToken: string, private readonly http: typeof fetch = fetch) {}
  reply(replyToken: string, text: string, signal: AbortSignal) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(replyToken)) throw new Error('LINE_SEND_INVALID');
    return this.send('reply', { replyToken }, text, signal);
  }
  push(userId: string, text: string, retryKey: string, signal: AbortSignal) {
    if (!lineUserId(userId) || !/^[0-9a-f-]{36}$/.test(retryKey)) throw new Error('LINE_SEND_INVALID');
    return this.send('push', { to: userId }, text, signal, retryKey);
  }
  private async send(kind: 'reply' | 'push', target: Record<string, string>, text: string, signal: AbortSignal, retryKey?: string): Promise<LineSendResult> {
    if (!text.trim() || text.length > 4500) throw new Error('LINE_SEND_INVALID');
    if (signal.aborted) return { status: 'failed' };
    try {
      const response = await this.http(`https://api.line.me/v2/bot/message/${kind}`, { method: 'POST', redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json', ...(retryKey ? { 'X-Line-Retry-Key': retryKey } : {}) },
        body: JSON.stringify({ ...target, messages: [{ type: 'text', text }] }) });
      // Never log provider responses, request bodies, reply tokens or credentials.
      if (!response.ok) { await response.body?.cancel(); return { status: response.status >= 500 || response.status === 409 ? 'unknown' : 'failed' }; }
      const body = await response.json() as any;
      const id = body?.sentMessages?.[0]?.id;
      return { status: 'accepted', ...(typeof id === 'string' && /^\d{1,64}$/.test(id) ? { messageId: id } : {}) };
    } catch { return { status: 'unknown' }; }
  }
}
