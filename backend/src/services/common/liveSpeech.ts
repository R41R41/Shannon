/**
 * Her live lines for the room she plays in (session dc-live; the API's `SHANNON_MINECRAFT_LIVE_SPEECH`, docs/minecraft-body-contract.md).
 * The companion writes a line about something that happened to her Minecraft body and hands it to the body in a reply to its control
 * poll (`speech`); the body puts it where she is, and says what it did in a later poll (`speechReceipts`). Where she is belongs to the
 * Discord side (a voice channel she is in, else one text channel the body is set to), so Minebot only knows this registry: the Discord
 * bot registers a sink at start-up, and a body with none (the switch off, no bot) says nothing and tells nothing.
 *
 * Wire mirror of the API's `contracts/minecraftControlContract.ts` (`MinecraftLiveSpeech`, `MinecraftLiveSpeechReceipt`, `MinecraftLiveRoom`).
 */
export interface LiveSpeechItem {
  id: string;
  text: string;
  urgency: 'ordinary' | 'urgent';
  /** ISO 8601: past this the line is about a moment that is over, and nothing is said. */
  expiresAt: string;
  kind: string;
}

export type LiveSpeechOutcome = 'spoken' | 'posted' | 'declined' | 'failed';
export interface LiveSpeechReceipt {
  id: string;
  outcome: LiveSpeechOutcome;
  /** Closed words: `busy`, `expired`, `no_room`, `no_channel`, `error`, `not_in_voice`. */
  reason?: string;
  /** The Discord conversation (`discord:<guild>:<channel>`) a posted line went into; never for a spoken one (the voice records its own). */
  conversationId?: string;
}

/** The room as the body reads it: in a voice channel or not, someone speaking now, and how long since someone spoke or wrote. */
export interface LiveRoom { voice: boolean; humanSpeaking: boolean; sinceHumanMs: number | null }

export interface LiveSpeechSink {
  room(): LiveRoom;
  /** Puts the line where she is, or says why not. Never throws: a failure is a `failed` receipt. */
  speak(item: LiveSpeechItem): Promise<LiveSpeechReceipt>;
}

let registered: LiveSpeechSink | null = null;

/** Bootstrap only: the Discord bot's sink. A second registration replaces the first (a restarted bot). */
export function registerLiveSpeechSink(sink: LiveSpeechSink | null): void {
  registered = sink;
}

export function getLiveSpeechSink(): LiveSpeechSink | null {
  return registered;
}

/** Receipts are sent in this many polls after they are made: the API has no acknowledgement for them, and a repeat is harmless there. */
export const LIVE_RECEIPT_POLLS = 5;
const MAX_RECEIPTS = 8, MAX_TEXT = 400;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;

/**
 * The control loop's side of the lines: it takes what a reply carries (one line at a time; an id it has already taken is ignored), runs
 * the sink on it off the poll's path, and gives back the room and the receipts for the next polls. Nothing here can fail or delay a poll.
 */
export class LiveSpeechCourier {
  private readonly seen = new Set<string>();
  private readonly receipts: Array<{ receipt: LiveSpeechReceipt; left: number }> = [];
  private running = false;

  constructor(private readonly sink: () => LiveSpeechSink | null = getLiveSpeechSink, private readonly now: () => number = Date.now) {}

  /** Whether there is a sink to speak through: a poll carries the room and the receipts only then. */
  get active(): boolean { return this.sink() !== null; }

  room(): LiveRoom | undefined {
    try { return this.sink()?.room(); } catch { return undefined; }
  }

  /** The receipts for this poll (each is sent in `LIVE_RECEIPT_POLLS` polls), at most eight. */
  takeReceipts(): LiveSpeechReceipt[] {
    const out = this.receipts.slice(0, MAX_RECEIPTS).map(entry => entry.receipt);
    for (const entry of this.receipts) entry.left -= 1;
    for (let index = this.receipts.length - 1; index >= 0; index--) if (this.receipts[index]!.left <= 0) this.receipts.splice(index, 1);
    return out;
  }

  /** The reply's lines: the first one not taken before, while none is running. */
  accept(items: unknown): void {
    try {
      const sink = this.sink();
      if (!sink || !Array.isArray(items)) return;
      const item = items.map(valid).find((candidate): candidate is LiveSpeechItem => candidate !== null && !this.seen.has(candidate.id));
      if (!item || this.running) return;
      this.seen.add(item.id);
      if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value as string);
      this.running = true;
      void this.run(sink, item).finally(() => { this.running = false; });
    } catch { /* a line never fails a poll */ }
  }

  private async run(sink: LiveSpeechSink, item: LiveSpeechItem): Promise<void> {
    let receipt: LiveSpeechReceipt;
    if (Date.parse(item.expiresAt) <= this.now()) receipt = { id: item.id, outcome: 'declined', reason: 'expired' };
    else {
      try { receipt = await sink.speak(item); } catch { receipt = { id: item.id, outcome: 'failed', reason: 'error' }; }
    }
    this.receipts.push({ receipt: { ...receipt, id: item.id }, left: LIVE_RECEIPT_POLLS });
  }
}

function valid(value: unknown): LiveSpeechItem | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const text = typeof item.text === 'string' ? item.text.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim() : '';
  if (typeof item.id !== 'string' || !ID.test(item.id) || !text || text.length > MAX_TEXT) return null;
  if (typeof item.expiresAt !== 'string' || !Number.isFinite(Date.parse(item.expiresAt))) return null;
  const kind = typeof item.kind === 'string' && /^[a-z_]{1,40}$/u.test(item.kind) ? item.kind : 'unknown';
  return { id: item.id, text, urgency: item.urgency === 'urgent' ? 'urgent' : 'ordinary', expiresAt: item.expiresAt, kind };
}
