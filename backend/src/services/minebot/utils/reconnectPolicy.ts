/**
 * When the body goes back into the world by itself after the connection ended, and how often it tries.
 *
 * Before run 20 only one kick ("chat_validation_failed") was answered with a new login. The server's "Timed out" kick (the
 * body was silent for too long) and a connection that was simply closed left the body out of the world until someone logged it in
 * again, and an unfinished task waited three minutes to be written off. Now a kick for silence, and a connection that ended on
 * its own (not by anyone's stop, and not by a kick that says the body is not wanted: banned, not whitelisted, logged in
 * elsewhere), is answered with a new login after a pause that grows, a few times, until the body has stayed up a while.
 */

export type ReconnectKind = 'chat_validation' | 'timeout' | 'connection_lost';

const SERVER_SAYS_NO = /(duplicate_login|banned|not_whitelisted|whitelist|ip_banned|kicked_for|name_taken|invalid_player_data|incompatible|outdated|unverified|authentication|session|disconnect\.kicked|disconnect\.spam|disconnect\.flying|disconnect\.packets|idling)/i;

/** What a kick (the server's word) calls for, or null when the body should stay out. */
export function reconnectKindOfKick(reason: string): ReconnectKind | null {
  if (!reason) return null;
  if (reason.includes('chat_validation_failed')) return 'chat_validation';
  if (SERVER_SAYS_NO.test(reason)) return null;
  if (/disconnect\.timeout|timed out|timeout|keepAliveError/i.test(reason)) return 'timeout';
  return null;
}

/** What the end of a connection with no kick calls for (the reason is the socket's or the protocol's), or null for the body's own quit. */
export function reconnectKindOfEnd(reason: string | undefined): ReconnectKind | null {
  const text = String(reason ?? '');
  if (/disconnect\.quitting|quitting|isolated progressive trial/i.test(text)) return null;
  if (/socketClosed|ECONNRESET|EPIPE|ETIMEDOUT|ECONNABORTED|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|timed out|keepAliveError|read ECONNRESET/i.test(text)) return 'connection_lost';
  return null;
}

export interface ReconnectPlan { allowed: boolean; delayMs: number; attempt: number }

/** The pauses before the 1st, 2nd, ... try inside the window (ms). */
const DELAYS_MS = [8_000, 15_000, 30_000, 60_000, 90_000];

/**
 * At most DELAYS_MS.length tries within `windowMs`; the history is forgotten once the body has been in the world for `stableMs`
 * (`noteSpawned` / `next` are given the clock, so that tests need no timers).
 */
export class ReconnectBudget {
  private tries: number[] = [];
  private spawnedAt: number | null = null;

  constructor(private readonly windowMs = 15 * 60_000, private readonly stableMs = 120_000) {}

  noteSpawned(now: number): void { this.spawnedAt = now; }

  next(now: number, kind: ReconnectKind = 'connection_lost'): ReconnectPlan {
    if (this.spawnedAt !== null && now - this.spawnedAt >= this.stableMs) this.tries = [];
    this.tries = this.tries.filter(at => now - at < this.windowMs);
    if (this.tries.length >= DELAYS_MS.length) return { allowed: false, delayMs: 0, attempt: this.tries.length };
    const attempt = this.tries.length;
    this.tries.push(now);
    // The old kick keeps its short first pause; a silence kick or a lost connection is given a little longer to clear.
    const delayMs = kind === 'chat_validation' ? DELAYS_MS[0] : Math.max(DELAYS_MS[0], DELAYS_MS[attempt]);
    return { allowed: true, delayMs, attempt: attempt + 1 };
  }
}
