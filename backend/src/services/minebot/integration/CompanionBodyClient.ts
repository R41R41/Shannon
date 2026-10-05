import { randomUUID } from 'node:crypto';

/**
 * Minebot as Shannon's Minecraft body (shannon-ios docs/minecraft-body-contract.md). Her one mind is the
 * companion server: it writes what she says in game chat, remembers who said what, and keeps her death as an
 * experience. The body only sends what a player wrote to her and closed game facts, never coordinates,
 * inventories or chat she was not part of.
 */
export interface CompanionTurn {
  reply: string;
  /** `request`: the task was queued as a request on the companion; the claim loop takes it, the body does not act on it here. */
  intent?: { kind: 'none' | 'task' | 'stop'; goal: string; request?: { id: string } };
  duplicate: boolean;
  ignored?: string;
}

/** The body's present, sent with each turn so her mind knows what she is doing. Game state only. */
export interface CompanionBodyNow {
  task?: string;
  dimension?: 'overworld' | 'the_nether' | 'the_end';
  health?: number;
  food?: number;
  timeOfDay?: 'day' | 'night' | 'dawn' | 'dusk';
  recentAdvancements?: string[];
  busyWith?: 'campaign' | 'request' | 'idle';
}

/** A request her mind queued for this body (phase 4): from the owner's phone, voice, or his own game chat. */
export interface CompanionRequest {
  id: string;
  goal: string;
  surface: 'text' | 'voice' | 'minecraft';
  createdAt: string;
  leaseExpiresAt: string;
}

export type CompanionProgressPhase = 'accepted' | 'started' | 'working';
export type CompanionReportOutcome = 'done' | 'failed' | 'stopped';
export type CompanionReportCode = 'gave_up' | 'died' | 'error' | 'timeout' | 'queue_full' | 'run_over' | 'cancelled' | 'unsupported' | 'unknown';
export interface CompanionGained { item: string; count: number }

export interface CompanionBodyOptions {
  /** Loopback only: the body talks to a companion on the same machine. */
  baseUrl: string;
  /** The paired device token of this body. */
  token: string;
  serverId: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

const TURN_TIMEOUT_MS = 30_000;
const EVENT_TIMEOUT_MS = 5_000;
const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const CAUSE = /^[a-z0-9_.-]{1,32}:[a-z0-9_./-]{1,64}$/;
const REQUEST_ID = /^[0-9a-f-]{36}$/;
/** The companion holds a claim open for at most 25 seconds; the body waits a little longer for the answer. */
export const COMPANION_CLAIM_WAIT_SECONDS = 25;
const CLAIM_TIMEOUT_MS = (COMPANION_CLAIM_WAIT_SECONDS + 10) * 1000;

export function companionBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('COMPANION_URL_MUST_BE_LOOPBACK');
  }
  return url.origin;
}

export class CompanionBodyClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private sequence = 0;

  constructor(private readonly options: CompanionBodyOptions) {
    this.baseUrl = companionBaseUrl(options.baseUrl);
    if (!SERVER_ID.test(options.serverId)) throw new Error('COMPANION_SERVER_ID_INVALID');
    if (options.token.length < 16) throw new Error('COMPANION_TOKEN_MISSING');
    this.fetcher = options.fetcher ?? fetch;
  }

  /** One message a player wrote to her. Null when the companion could not answer: the body then stays silent or answers itself. */
  async turn(input: { speakerUuid: string; speakerName: string; message: string; kind?: 'channel' | 'dm'; observedAt?: Date;
    body?: CompanionBodyNow }): Promise<CompanionTurn | null> {
    const body = {
      requestId: `${this.options.serverId}-${Date.now()}-${++this.sequence}`,
      serverId: this.options.serverId,
      conversation: { kind: input.kind ?? 'channel' },
      speaker: { uuid: input.speakerUuid, name: input.speakerName },
      message: input.message.slice(0, 600),
      observedAt: (input.observedAt ?? new Date()).toISOString(),
      ...(input.body ? { body: input.body } : {}),
    };
    // A network failure or 5xx may be retried once with the same requestId: the companion answers it only once.
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.post('/v1/body/minecraft/turns', body, this.options.timeoutMs ?? TURN_TIMEOUT_MS).catch(() => null);
      if (response && response.status < 500) {
        if (!response.ok) return null;
        const data = await response.json().catch(() => null) as CompanionTurn | null;
        return data && typeof data.reply === 'string' && data.reply.trim() ? data : null;
      }
    }
    return null;
  }

  /** Her Minecraft body died. `othersPresent`: other players were on the server. */
  async died(cause: string, othersPresent: boolean, at = new Date()): Promise<boolean> {
    const event = { id: `${this.options.serverId}-death-${at.getTime()}-${randomUUID().slice(0, 8)}`, type: 'game.died',
      audience: othersPresent ? 'others' : 'owner', occurredAt: at.toISOString(),
      cause: CAUSE.test(cause) ? cause : 'minecraft:generic' };
    const response = await this.post('/v1/body/events', { scopeKey: 'owner', events: [event] }, EVENT_TIMEOUT_MS).catch(() => null);
    return !!response?.ok;
  }

  /**
   * The long-poll claim of requests (phase 4). `holding`: the requests this body is still working on (their leases are
   * renewed; any other it was handed is closed on the companion). Null when the companion could not be reached.
   */
  async claim(holding: readonly string[], waitSeconds = COMPANION_CLAIM_WAIT_SECONDS, signal?: AbortSignal): Promise<{ request: CompanionRequest | null; cancel: string[] } | null> {
    const timeout = AbortSignal.timeout((Math.min(COMPANION_CLAIM_WAIT_SECONDS, waitSeconds) + 10) * 1000);
    const response = await this.post('/v1/body/minecraft/claim', { scopeKey: 'owner', waitSeconds: Math.min(COMPANION_CLAIM_WAIT_SECONDS, Math.max(0, Math.floor(waitSeconds))), holding: holding.slice(0, 4) },
      CLAIM_TIMEOUT_MS, signal ? AbortSignal.any([signal, timeout]) : timeout).catch(() => null);
    if (!response?.ok) return null;
    const data = await response.json().catch(() => null) as { request?: unknown; cancel?: unknown } | null;
    if (!data) return null;
    const request = data.request as Partial<CompanionRequest> | null | undefined;
    const valid = request && typeof request.id === 'string' && REQUEST_ID.test(request.id) && typeof request.goal === 'string' && request.goal.trim()
      ? { id: request.id, goal: request.goal.slice(0, 120), surface: (['text', 'voice', 'minecraft'].includes(String(request.surface)) ? request.surface : 'text') as CompanionRequest['surface'],
        createdAt: String(request.createdAt ?? ''), leaseExpiresAt: String(request.leaseExpiresAt ?? '') } : null;
    const cancel = Array.isArray(data.cancel) ? data.cancel.filter((id): id is string => typeof id === 'string' && REQUEST_ID.test(id)) : [];
    return { request: valid, cancel };
  }

  /** The body is working on a request. `cancel: true`: the owner asked it to stop. Null when the companion could not be reached. */
  async progress(id: string, phase: CompanionProgressPhase, step?: string): Promise<{ state: string; cancel: boolean } | null> {
    const label = step?.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    const response = await this.post(`/v1/body/minecraft/requests/${id}/progress`, { scopeKey: 'owner', phase, ...(label ? { step: label } : {}) }, EVENT_TIMEOUT_MS).catch(() => null);
    if (!response?.ok) return null;
    const data = await response.json().catch(() => null) as { state?: unknown; cancel?: unknown } | null;
    return data && typeof data.state === 'string' ? { state: data.state, cancel: data.cancel === true } : null;
  }

  /**
   * The result of a request: an outcome, a code, and the items gained (closed facts only). Null when the companion
   * could not be reached (try again); a 404 answers `{ state: 'unknown', recorded: false }` (nothing to retry).
   */
  async report(id: string, outcome: CompanionReportOutcome, detail: { code?: CompanionReportCode; gained?: readonly CompanionGained[] } = {}): Promise<{ state: string; recorded: boolean } | null> {
    const gained = (detail.gained ?? []).filter(entry => /^[a-z0-9_]{1,64}$/.test(entry.item) && Number.isInteger(entry.count) && entry.count > 0)
      .slice(0, 6).map(entry => ({ item: entry.item, count: Math.min(100_000, entry.count) }));
    const response = await this.post(`/v1/body/minecraft/requests/${id}/report`, { scopeKey: 'owner', outcome,
      ...(outcome !== 'done' && detail.code ? { code: detail.code } : {}), ...(gained.length ? { gained } : {}) }, EVENT_TIMEOUT_MS).catch(() => null);
    if (!response) return null;
    if (response.status === 404 || response.status === 400 || response.status === 403) return { state: 'unknown', recorded: false };
    if (!response.ok) return null;
    const data = await response.json().catch(() => null) as { state?: unknown; recorded?: unknown } | null;
    return data && typeof data.state === 'string' ? { state: data.state, recorded: data.recorded === true } : null;
  }

  private post(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    return this.fetcher(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.token}` },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
  }
}

/** Game chat lines are at most 256 characters; a longer reply is split at sentence ends where it can be. */
export function chatLines(reply: string, limit = 256): string[] {
  const lines: string[] = [];
  let rest = reply.replace(/\s+/g, ' ').trim();
  while (rest.length > limit) {
    const cut = Math.max(rest.lastIndexOf('。', limit - 1), rest.lastIndexOf('！', limit - 1), rest.lastIndexOf('？', limit - 1));
    const at = cut >= limit / 2 ? cut + 1 : limit;
    lines.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) lines.push(rest);
  return lines;
}

/** Vanilla time of day (0..24000 ticks) as the four parts the companion knows. */
export function timeOfDayPart(ticks: number): 'day' | 'night' | 'dawn' | 'dusk' {
  const t = ((ticks % 24000) + 24000) % 24000;
  if (t < 1000 || t >= 23000) return 'dawn';
  if (t < 12000) return 'day';
  if (t < 13800) return 'dusk';
  return 'night';
}

/** `advancements.story.smelt_iron.title` (the key in the chat announcement) as `minecraft:story/smelt_iron`. */
export function advancementId(titleKey: string): string | null {
  const match = /^advancements\.([a-z_]+)\.([a-z0-9_]+)\.title$/.exec(titleKey);
  return match ? `minecraft:${match[1]}/${match[2]}` : null;
}

/**
 * The damage type behind a vanilla death message (`death.attack.lava`, `death.fell.accident.ladder`), as the
 * namespaced id the companion knows. Unknown or unusual messages are `minecraft:generic`.
 */
export function deathCause(translationKey: string): string {
  if (translationKey.startsWith('death.fell.')) return 'minecraft:fall';
  const match = /^death\.attack\.([A-Za-z]+)/.exec(translationKey);
  if (!match) return 'minecraft:generic';
  const name = match[1].replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  if (name === 'mob') return 'minecraft:mob_attack';
  if (name === 'player') return 'minecraft:player_attack';
  return `minecraft:${name}`;
}
