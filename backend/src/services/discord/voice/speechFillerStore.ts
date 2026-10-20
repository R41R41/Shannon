/**
 * dc-voice: the head's fillers ("うん。" ...) kept as PCM in memory, so `decision.filler` can be played the instant
 * it arrives. The list comes from GET /voice/fillers; each text is voiced once through POST /voice/speech.
 */
import type { ShannonCoreVoiceClient, VoiceFillerItem } from '../../integration/shannonCoreVoiceClient.js';

export interface StoredFiller {
  id: string;
  text: string;
  /** s16le, 24 kHz, mono. */
  pcm: Buffer;
}

export interface FillerSource {
  get(id: string): StoredFiller | undefined;
  ids(): string[];
}

const MAX_FILLERS = 24;
const MAX_FILLER_BYTES = 24_000 * 2 * 8; // 8 s of audio is not a filler
const REFRESH_AFTER_MS = 30 * 60_000;

export class SpeechFillerStore implements FillerSource {
  private readonly items = new Map<string, StoredFiller>();
  private loadedAt = 0;
  private loading: Promise<number> | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  get(id: string): StoredFiller | undefined { return this.items.get(id); }
  ids(): string[] { return [...this.items.keys()]; }
  get size(): number { return this.items.size; }

  /** Replace the contents (tests, or a warm-up done elsewhere). */
  set(items: StoredFiller[]): void {
    this.items.clear();
    for (const item of items) this.items.set(item.id, item);
    this.loadedAt = this.now();
  }

  /** Fetch the list and voice every filler. Returns how many are ready. Never throws; shares an in-flight run. */
  warmUp(client: ShannonCoreVoiceClient, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<number> {
    if (this.loading) return this.loading;
    if (!options.force && this.items.size > 0 && this.now() - this.loadedAt < REFRESH_AFTER_MS) {
      return Promise.resolve(this.items.size);
    }
    this.loading = this.load(client, options.signal).finally(() => { this.loading = null; });
    return this.loading;
  }

  private async load(client: ShannonCoreVoiceClient, signal?: AbortSignal): Promise<number> {
    const list = await client.fillers({ signal });
    if (list.status !== 'ok') return this.items.size;
    const wanted = list.items.slice(0, MAX_FILLERS);
    const loaded: StoredFiller[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < wanted.length && !signal?.aborted) {
        const item = wanted[next++]!;
        const pcm = await this.voice(client, item, signal);
        if (pcm) loaded.push({ id: item.id, text: item.text, pcm });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (loaded.length > 0) this.set(loaded);
    return this.items.size;
  }

  private async voice(client: ShannonCoreVoiceClient, item: VoiceFillerItem, signal?: AbortSignal): Promise<Buffer | null> {
    const speech = await client.speech(item.text, { style: item.style || undefined, signal });
    if (speech.status !== 'ok') return null;
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of speech.chunks) {
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > MAX_FILLER_BYTES) return null;
    }
    return bytes > 0 ? Buffer.concat(chunks) : null;
  }
}

let shared: SpeechFillerStore | null = null;

export function getSpeechFillerStore(): SpeechFillerStore {
  shared ??= new SpeechFillerStore();
  return shared;
}
