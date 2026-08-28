import { createHash, randomUUID } from 'node:crypto';
import type { LinePolicy, LineSendResult } from '../../modules/conversation/lineConversation.js';
import { lineQuiet } from '../../modules/conversation/lineConversation.js';
export const lineKey = (value: string) => createHash('sha256').update(value).digest('hex');
const DAY = 86400000;
export interface LineEntry {
  id: string; kind: 'chat' | 'control' | 'push'; at: number; status: 'reserved' | 'pending' | 'sending' | 'accepted' | 'unknown' | 'failed' | 'cancelled';
  scope: string; expiresAt: number; text?: string; messageId?: string; retryKey?: string; consentVersion?: number;
}
export interface LineState {
  schemaVersion: 1; revision: number; botUserId: string; personalUserId: string;
  optedIn: boolean; consentVersion: number; controlAt: number; entries: LineEntry[];
}
export interface LineStatePort {
  read(botUserId: string): Promise<LineState | null>;
  compareAndSwap(botUserId: string, revision: number, next: LineState): Promise<boolean>;
}
/** Durable reservations precede both LLM and send calls; uncertain operations never refund/retry. */
export class LineLedger {
  constructor(private readonly store: LineStatePort, private readonly policy: LinePolicy, private readonly now = Date.now) {}
  async read(): Promise<LineState> {
    const p = this.policy;
    const state = await this.store.read(p.botUserId) ?? { schemaVersion: 1 as const, revision: 0, botUserId: p.botUserId,
      personalUserId: p.personalUserId, optedIn: false, consentVersion: 0, controlAt: 0, entries: [] };
    if (state.schemaVersion !== 1 || state.botUserId !== p.botUserId || state.personalUserId !== p.personalUserId)
      throw new Error('LINE_BINDING_CHANGED');
    return structuredClone(state);
  }
  private async update<T>(change: (state: LineState, now: number) => { value: T; write: boolean }): Promise<T> {
    for (let attempt = 0; attempt < 16; attempt++) {
      const state = await this.read(); const expected = state.revision; const now = this.now();
      // Keep push reservations across month boundaries. Content is shorter-lived than accounting.
      state.entries = state.entries.filter(e => e.at > now - (e.kind === 'push' ? 62 * DAY : DAY));
      for (const e of state.entries) if (e.expiresAt <= now) { delete e.text; delete e.messageId; }
      const result = change(state, now);
      if (!result.write) return result.value;
      state.revision++;
      if (await this.store.compareAndSwap(this.policy.botUserId, expected, state)) return result.value;
    }
    throw new Error('LINE_LEDGER_BUSY');
  }
  async reserveChat(eventId: string, scope: string): Promise<boolean> {
    const id = lineKey(`event:${eventId}`);
    return this.update((s, now) => {
      if (s.entries.some(e => e.id === id) || s.entries.length >= 2000
        || s.entries.filter(e => e.kind === 'chat' && e.at > now - DAY).length >= this.policy.chatMaxPer24Hours)
        return { value: false, write: false };
      s.entries.push({ id, kind: 'chat', at: now, expiresAt: now + DAY, scope: lineKey(scope), status: 'reserved' });
      return { value: true, write: true };
    });
  }
  async consent(eventId: string, timestamp: number, on: boolean): Promise<boolean> {
    const id = lineKey(`event:${eventId}`);
    return this.update((s, now) => {
      if (s.entries.some(e => e.id === id) || (on && s.entries.length >= 2000) || timestamp < s.controlAt
        || (timestamp === s.controlAt && (on || !s.optedIn))) return { value: false, write: false };
      s.optedIn = on; s.controlAt = timestamp; s.consentVersion++;
      if (!on) for (const e of s.entries) if (e.kind === 'push') { delete e.text; delete e.messageId;
        if (e.status === 'pending') e.status = 'cancelled'; }
      if (s.entries.length < 2000) s.entries.push({ id, kind: 'control', at: now, expiresAt: now + DAY, scope: lineKey(`personal:${s.personalUserId}`), status: 'reserved' });
      return { value: true, write: true };
    });
  }
  async finish(id: string, result: LineSendResult | { status: 'cancelled' }): Promise<void> {
    await this.update(s => {
      const e = s.entries.find(e => e.id === id);
      if (!e || !['reserved', 'sending'].includes(e.status)) return { value: undefined, write: false };
      e.status = result.status;
      if (result.status === 'accepted' && result.messageId && e.text) e.messageId = result.messageId;
      if (result.status !== 'accepted') delete e.text;
      return { value: undefined, write: true };
    });
  }
  async enqueue(digest: { id: string; ownerUserId: string; text: string; expiresAt: number }): Promise<string | undefined> {
    const id = lineKey(`digest:${digest.id}`); const p = this.policy;
    if (digest.ownerUserId !== p.personalUserId || !p.personalUserId || !/^[A-Za-z0-9:_-]{1,128}$/.test(digest.id)
      || !digest.text.trim() || digest.text.length > 4500 || !Number.isSafeInteger(digest.expiresAt)) return;
    return this.update((s, now) => {
      const month = new Date(now + 9 * 3600000).toISOString().slice(0, 7);
      const push = s.entries.filter(e => e.kind === 'push');
      if (!p.enabled || !s.optedIn || lineQuiet(p, now) || digest.expiresAt <= now || digest.expiresAt > now + DAY
        || s.entries.length >= 2000 || s.entries.some(e => e.id === id)
        || push.filter(e => new Date(e.at + 9 * 3600000).toISOString().slice(0, 7) === month).length >= p.pushMaxPerMonth
        || push.filter(e => e.at > now - DAY).length >= p.pushMaxPer24Hours) return { value: undefined, write: false };
      s.entries.push({ id, kind: 'push', at: now, expiresAt: digest.expiresAt, scope: lineKey(`personal:${p.personalUserId}`),
        status: 'pending', text: digest.text, retryKey: randomUUID(), consentVersion: s.consentVersion });
      return { value: id, write: true };
    });
  }
  async claim(id: string): Promise<LineEntry | undefined> {
    return this.update((s, now) => {
      const e = s.entries.find(e => e.id === id && e.kind === 'push' && e.status === 'pending');
      if (!e) return { value: undefined, write: false };
      if (!s.optedIn || e.consentVersion !== s.consentVersion || e.expiresAt <= now || !e.text) {
        e.status = 'cancelled'; delete e.text; return { value: undefined, write: true };
      }
      if (lineQuiet(this.policy, now)) return { value: undefined, write: false };
      e.status = 'sending'; return { value: structuredClone(e), write: true };
    });
  }
  async quote(messageId: string): Promise<string | undefined> {
    const s = await this.read();
    return s.optedIn ? s.entries.find(e => e.kind === 'push' && e.status === 'accepted'
      && e.messageId === messageId && e.expiresAt > this.now() && e.consentVersion === s.consentVersion)?.text : undefined;
  }
}
