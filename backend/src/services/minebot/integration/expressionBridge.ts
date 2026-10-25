/**
 * Her face on her Minecraft skin (ExpressionMod 1.3, `expressionmod:emote_sync` / `dialogue_sync`; owner 2026-10-26). Her one mind
 * decides the face: this reads `GET /v1/body/presence` (`mood.expression`, at the interval presence asks for) and sends it from the
 * bot's own connection; the server forwards it, as her own, to every player with the mod. A short reflex face (a hit, a near death)
 * is shown at once by the body (`flash`) and then gives way to her mind's face again. No model, memory or navigation here; nothing it
 * learns goes back into what her body does. Ported from ExpressionMod's `integration/minebot/expression-bridge.mjs` (2026-10-08).
 */
export const EXPRESSIONS = Object.freeze(['joyful', 'excited', 'amused', 'laughing', 'bashful', 'embarrassed', 'relieved',
  'surprised', 'curious', 'thinking', 'confused', 'determined', 'tender', 'calm', 'jealous', 'wry', 'exasperated', 'annoyed', 'concerned', 'sad',
  'sleepy', 'neutral'] as const);
export type BridgeExpression = typeof EXPRESSIONS[number];
export const CHANNELS = Object.freeze({ emote: 'expressionmod:emote_sync', dialogue: 'expressionmod:dialogue_sync', ready: 'expressionmod:bridge_ready' });
type Activity = 'idle' | 'listening' | 'thinking' | 'speaking';

const validUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const isExpression = (value: unknown): value is BridgeExpression => typeof value === 'string' && (EXPRESSIONS as readonly string[]).includes(value);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** The face her mind last gave, held until a little after the next read is due (an unreachable mind fades to neutral). */
export class PresenceLease {
  etag: string | undefined;
  expression: BridgeExpression = 'neutral';
  until = 0;
  pollMs = 10_000;
  accept(data: unknown, now: number): boolean {
    const value = data as { schemaVersion?: unknown; etag?: unknown; pollAfterSeconds?: unknown; unchanged?: unknown; mood?: { expression?: unknown } } | null;
    if (!value || value.schemaVersion !== 1 || typeof value.etag !== 'string' || !/^[0-9a-f]{16}$/.test(value.etag)
      || typeof value.pollAfterSeconds !== 'number' || !Number.isFinite(value.pollAfterSeconds) || value.pollAfterSeconds < 1 || value.pollAfterSeconds > 300) return false;
    const unchanged = value.unchanged === true;
    if (unchanged ? !this.etag || value.etag !== this.etag : !isExpression(value.mood?.expression)) return false;
    if (!unchanged) this.expression = value.mood!.expression as BridgeExpression;
    this.etag = value.etag;
    this.pollMs = value.pollAfterSeconds * 1000;
    this.until = now + Math.min(30_000, this.pollMs * 2 + 5000);
    return true;
  }
  sample(now: number): { expression: BridgeExpression; remaining: number } {
    return { expression: now < this.until ? this.expression : 'neutral', remaining: Math.max(0, this.until - now) };
  }
}

function varint(value: number): Buffer {
  const bytes: number[] = []; let v = BigInt(value);
  do { const b = Number(v & 127n); v >>= 7n; bytes.push(v ? b | 128 : b); } while (v);
  return Buffer.from(bytes);
}
function string(value: string): Buffer { const bytes = Buffer.from(value, 'utf8'); return Buffer.concat([varint(bytes.length), bytes]); }
export function emoteBytes(uuid: string, name: string, expression: string, lease: number): Buffer {
  return Buffer.concat([string(uuid), string(name), string(expression), varint(clamp(Math.round(lease), 1, 30_000))]);
}
export function dialogueBytes(uuid: string, name: string, activity: string, lease: number, target: { yaw: number; pitch: number } | null): Buffer {
  const end = Buffer.alloc(9); end[0] = target ? 1 : 0;
  end.writeFloatBE(target?.yaw ?? 0, 1); end.writeFloatBE(target?.pitch ?? 0, 5);
  return Buffer.concat([string(uuid), string(name), string(activity), varint(clamp(Math.round(lease), 250, 5000)), end]);
}

interface BridgeEntity { position?: { x: number; y: number; z: number }; yaw?: number; height?: number }
export interface ExpressionBridgeBot {
  username?: string;
  entity?: BridgeEntity | null;
  player?: { uuid?: string } | null;
  players?: Record<string, { uuid?: string; entity?: BridgeEntity | null }> | null;
  _client: {
    uuid?: string;
    write(name: 'custom_payload', packet: { channel: string; data: Buffer }): void;
    on(event: 'custom_payload', listener: (packet: { channel?: string; data?: unknown }) => void): unknown;
    removeListener(event: 'custom_payload', listener: (packet: { channel?: string; data?: unknown }) => void): unknown;
  };
  on(event: 'spawn' | 'end', listener: () => void): unknown;
  removeListener(event: 'spawn' | 'end', listener: () => void): unknown;
}

/** Local visual target only. No coordinates leave this process; bot.look and navigation are never called. */
export function speakerAngles(bot: Pick<ExpressionBridgeBot, 'entity' | 'players'>, uuid: string | undefined): { yaw: number; pitch: number } | null {
  const self = bot.entity;
  const other = Object.values(bot.players ?? {}).find(player => player?.uuid?.toLowerCase() === uuid?.toLowerCase())?.entity;
  if (!self?.position || !other?.position || typeof self.yaw !== 'number' || !Number.isFinite(self.yaw)) return null;
  const dx = other.position.x - self.position.x, dz = other.position.z - self.position.z;
  const dy = other.position.y + (other.height ?? 1.8) * 0.9 - self.position.y - (self.height ?? 1.8) * 0.9;
  const distance = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(distance) || distance > 8 || distance < 0.1) return null;
  const diff = Math.atan2(-dx, -dz) - self.yaw;
  const yaw = -Math.atan2(Math.sin(diff), Math.cos(diff)) * 180 / Math.PI;
  const pitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI;
  // A face cannot look behind itself. Body orientation stays the existing controller's.
  return Math.abs(yaw) <= 60 ? { yaw: clamp(yaw, -30, 30), pitch: clamp(pitch, -30, 30) } : null;
}

async function readJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > 65_536) throw new Error('RESPONSE_LIMIT');
  const reader = response.body?.getReader(); if (!reader) throw new Error('RESPONSE_EMPTY');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength; if (length > 65_536) throw new Error('RESPONSE_LIMIT'); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export interface ExpressionTurn { speaking(): void; finish(): void }
export interface ExpressionBridge {
  start(): void;
  stop(): void;
  beginTurn(speakerUuid: string): ExpressionTurn;
  /** Her body's reflex face for a moment (a hit, a near death), then her mind's face again. */
  flash(expression: BridgeExpression, milliseconds: number): void;
  /** Read her mind's face now (after a game moment was sent), instead of at the next interval. */
  refresh(): void;
}

type Timer = ReturnType<typeof setTimeout>;

/** Construct only for the configured companion world and device. */
export class MinebotExpressionBridge implements ExpressionBridge {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly clock: () => number;
  private readonly setTimer: (work: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer | undefined) => void;
  private lease = new PresenceLease();
  private running = false;
  private ready = false;
  private generation = 0;
  private activity: Activity = 'idle';
  private activityUntil = 0;
  private thinkingAt = 0;
  private turnId = 0;
  private speaker: string | undefined;
  private lastEmoteAt = Number.NEGATIVE_INFINITY;
  private lastExpression: BridgeExpression | undefined;
  private flashExpression: BridgeExpression | undefined;
  private flashUntil = 0;
  private failures = 0;
  private inFlight = false;
  private refreshRequested = false;
  private abort: AbortController | undefined;
  private pollTimer: Timer | undefined;
  private tickTimer: Timer | undefined;
  private readonly onPayload = (packet: { channel?: string; data?: unknown }) => {
    if (packet.channel === CHANNELS.ready && Buffer.isBuffer(packet.data) && packet.data.length === 1 && packet.data[0] === 1) {
      this.ready = true; this.publish(true);
    }
  };
  private readonly onSpawn = () => this.advertise();
  private readonly onEnd = () => this.stop();

  constructor(private readonly bot: ExpressionBridgeBot, options: { baseUrl: string; token: string; fetcher?: typeof fetch; clock?: () => number;
    setTimer?: (work: () => void, ms: number) => Timer; clearTimer?: (timer: Timer | undefined) => void }) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('EXPRESSION_URL_MUST_BE_LOOPBACK');
    if (typeof options.token !== 'string' || options.token.length < 16 || /[\r\n]/.test(options.token)) throw new Error('EXPRESSION_TOKEN_MISSING');
    this.baseUrl = url.origin; this.token = options.token;
    this.fetcher = options.fetcher ?? fetch; this.clock = options.clock ?? (() => performance.now());
    this.setTimer = options.setTimer ?? ((work, ms) => setTimeout(work, ms));
    this.clearTimer = options.clearTimer ?? (timer => { if (timer) clearTimeout(timer); });
  }

  start(): void {
    if (this.running) return;
    this.running = true; this.generation++;
    this.bot._client.on('custom_payload', this.onPayload); this.bot.on('spawn', this.onSpawn); this.bot.on('end', this.onEnd);
    if (this.bot.entity) this.advertise();
    void this.poll(this.generation); this.tick(this.generation);
  }

  stop(): void {
    if (!this.running) return;
    this.activity = 'idle'; this.activityUntil = 0; this.flashUntil = 0;
    this.publish(true, true);
    this.running = false; this.ready = false; this.generation++; this.turnId++;
    this.refreshRequested = false;
    this.abort?.abort(); this.clearTimer(this.pollTimer); this.clearTimer(this.tickTimer);
    this.bot._client.removeListener('custom_payload', this.onPayload); this.bot.removeListener('spawn', this.onSpawn); this.bot.removeListener('end', this.onEnd);
    this.lease = new PresenceLease();
  }

  beginTurn(speakerUuid: string): ExpressionTurn {
    const id = ++this.turnId; this.speaker = validUuid(speakerUuid) ? speakerUuid : undefined;
    this.activity = 'listening'; this.thinkingAt = this.clock() + 600; this.activityUntil = this.clock() + 65_000; this.publish();
    let spoken = false;
    return {
      speaking: () => {
        if (!this.running || id !== this.turnId) return;
        spoken = true; this.activity = 'speaking'; this.activityUntil = this.clock() + 2200; this.publish();
        // Her mind's actual face after the turn, without inventing one for the reply.
        this.refresh();
      },
      finish: () => {
        if (!this.running || id !== this.turnId || spoken) return;
        this.activity = 'idle'; this.activityUntil = 0; this.publish();
      },
    };
  }

  flash(expression: BridgeExpression, milliseconds: number): void {
    if (!this.running || !isExpression(expression)) return;
    this.flashExpression = expression; this.flashUntil = this.clock() + clamp(milliseconds, 250, 5000);
    this.publish(true);
  }

  refresh(): void {
    // One read at a time: a read in flight is followed by another at once rather than overlapped.
    if (!this.running) return;
    if (this.inFlight) { this.refreshRequested = true; return; }
    if (!this.pollTimer) return;
    this.clearTimer(this.pollTimer); this.pollTimer = undefined; void this.poll(this.generation);
  }

  private advertise(): void {
    if (!this.running) return;
    this.ready = false;
    // Registered after a late start too: ExpressionMod answers with its protocol version (`bridge_ready`).
    this.bot._client.write('custom_payload', { channel: 'minecraft:register', data: Buffer.from(Object.values(CHANNELS).join('\0')) });
  }

  private async poll(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation) return;
    this.pollTimer = undefined; this.inFlight = true;
    let delay = this.lease.pollMs;
    const url = new URL('/v1/body/presence', this.baseUrl); url.searchParams.set('scopeKey', 'owner');
    if (this.lease.etag) url.searchParams.set('etag', this.lease.etag);
    const abort = this.abort = new AbortController(); const timer = this.setTimer(() => abort.abort(), 5000);
    try {
      const response = await this.fetcher(url, { method: 'GET', headers: { authorization: `Bearer ${this.token}` }, redirect: 'error', signal: abort.signal });
      if (!this.running || generation !== this.generation) return;
      if (response.status === 401 || response.status === 403) { this.stop(); return; }
      if (!response.ok) throw new Error('PRESENCE_UNAVAILABLE');
      const data = await readJson(response);
      if (!this.running || generation !== this.generation) return;
      if (!this.lease.accept(data, this.clock())) throw new Error('PRESENCE_INVALID');
      this.failures = 0; delay = this.lease.pollMs; this.publish(true);
    } catch {
      // Nothing of the request, the answer, the token or her mood is logged.
      if (this.running && generation === this.generation) {
        this.failures += 1; delay = Math.min(30_000, 5000 * 2 ** Math.min(3, this.failures - 1));
      }
    } finally { this.clearTimer(timer); if (this.abort === abort) this.inFlight = false; }
    if (this.running && generation === this.generation) {
      if (this.refreshRequested) { delay = 0; this.refreshRequested = false; }
      this.pollTimer = this.setTimer(() => { void this.poll(generation); }, delay);
    }
  }

  private tick(generation: number): void {
    if (!this.running || generation !== this.generation) return;
    this.publish(); this.tickTimer = this.setTimer(() => this.tick(generation), 1000);
  }

  private publish(force = false, clearing = false): void {
    if (!this.running || !this.ready) return;
    const uuid = this.bot.player?.uuid ?? this.bot._client.uuid;
    const name = this.bot.username;
    if (!validUuid(uuid) || typeof name !== 'string' || !/^[.A-Za-z0-9_]{1,17}$/.test(name)) return;
    const now = this.clock();
    const mind = this.lease.sample(now);
    // A reflex face shows over her mind's for its moment; its lease is its own remaining time.
    const reflex = now < this.flashUntil && this.flashExpression;
    const face = reflex ? { expression: this.flashExpression!, remaining: this.flashUntil - now } : mind;
    try {
      if (force || now - this.lastEmoteAt >= 5000 || face.expression !== this.lastExpression) {
        this.bot._client.write('custom_payload', { channel: CHANNELS.emote,
          data: emoteBytes(uuid, name, clearing ? 'neutral' : face.expression, Math.max(1, face.remaining)) });
        this.lastEmoteAt = now; this.lastExpression = face.expression;
      }
      const activity = now < this.activityUntil ? (this.activity === 'listening' && now >= this.thinkingAt ? 'thinking' : this.activity) : 'idle';
      const target = activity === 'idle' ? null : speakerAngles(this.bot, this.speaker);
      this.bot._client.write('custom_payload', { channel: CHANNELS.dialogue, data: dialogueBytes(uuid, name, activity, 5000, target) });
    } catch { /* A closing game socket never stops her task runtime; the leases expire on the observers. */ }
  }
}
