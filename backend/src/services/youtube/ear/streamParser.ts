/**
 * Cuts the body of a `liveChatMessages.streamList` connection into the JSON objects it carries, however they are framed.
 *
 * What is known: Google's reference gives `GET https://www.googleapis.com/youtube/v3/liveChat/messages/stream` with a
 * `LiveChatMessageListResponse` as the response, and says it is "a server-streamed RPC". What is NOT documented anywhere I could read
 * (2026-10-30): how the HTTP body of that stream is delimited. So the parser takes every framing a Google server-streaming REST answer
 * is known to use, and does not guess between them:
 *   - a JSON array that grows:      `[{...},\n{...},\n{...}` ... `]`   (Google's standard transcoding of a server stream)
 *   - one JSON object per line:     `{...}\n{...}\n`                   (NDJSON)
 *   - server-sent events:           `data: {...}\n\n` (with `event:`, `id:`, `retry:` and `:comment` lines skipped)
 * and an object that is wrapped as `{"result": {...}}` (grpc-gateway style) is unwrapped by the caller.
 *
 * It reads top-level `{ ... }` values by counting braces outside of strings, so an object split across chunks (at any byte) is kept
 * until it is whole, and nothing is parsed twice.
 */
export class JsonStreamParser {
  private buffer = '';
  /** Where the next top-level token starts (when not inside an object). */
  private pos = 0;
  /** Start of the object being read, or -1. */
  private start = -1;
  private scanned = 0;
  private depth = 0;
  private inString = false;
  private escaped = false;

  /** Adds text and returns the objects that are complete now, in order. Throws on something that cannot be part of the stream. */
  push(text: string): unknown[] {
    this.buffer += text;
    const out: unknown[] = [];
    for (;;) {
      if (this.start === -1) {
        if (!this.seekObject()) break;
      }
      const end = this.scanObject();
      if (end === -1) break;
      const raw = this.buffer.slice(this.start, end + 1);
      this.start = -1;
      this.pos = end + 1;
      try {
        out.push(JSON.parse(raw));
      } catch (error) {
        throw new Error(`a streamed object is not JSON (${error instanceof Error ? error.message : 'parse error'})`);
      }
    }
    this.compact();
    return out;
  }

  /** What is left unread (a half object); non-empty at the end of a connection means it was cut mid-object. */
  get remainder(): string {
    return this.start === -1 ? this.buffer.slice(this.pos).replace(/[\s,[\]]/gu, '') : this.buffer.slice(this.start);
  }

  /** Skips separators and SSE lines up to the next `{`. False when more text is needed. */
  private seekObject(): boolean {
    for (;;) {
      while (this.pos < this.buffer.length && /[\s,[\]]/u.test(this.buffer[this.pos])) this.pos += 1;
      if (this.pos >= this.buffer.length) return false;
      const rest = this.buffer.slice(this.pos, this.pos + 7);
      const char = rest[0];
      if (char === '{') {
        this.start = this.pos;
        this.scanned = this.pos;
        this.depth = 0;
        this.inString = false;
        this.escaped = false;
        return true;
      }
      if (rest.startsWith('data:')) { this.pos += 5; continue; }
      if (char === ':' || /^(event|id|retry):/u.test(rest)) {
        const newline = this.buffer.indexOf('\n', this.pos);
        if (newline === -1) return false;
        this.pos = newline + 1;
        continue;
      }
      // Could still become `data:` / `event:` / `retry:` / `id:` once more text arrives.
      if (rest.length < 6 && ['data:', 'event:', 'retry:', 'id:'].some(word => word.startsWith(rest))) return false;
      throw new Error(`unexpected "${rest.slice(0, 12).replace(/\s+/gu, ' ')}" in the stream`);
    }
  }

  /** Index of the `}` that closes the object that starts at `start`, or -1 while it is not whole. */
  private scanObject(): number {
    for (let i = this.scanned; i < this.buffer.length; i += 1) {
      const char = this.buffer[i];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') this.inString = false;
        continue;
      }
      if (char === '"') this.inString = true;
      else if (char === '{') this.depth += 1;
      else if (char === '}') {
        this.depth -= 1;
        if (this.depth === 0) return i;
      }
    }
    this.scanned = this.buffer.length;
    return -1;
  }

  private compact(): void {
    const keep = this.start === -1 ? this.pos : this.start;
    if (keep === 0) return;
    this.buffer = this.buffer.slice(keep);
    if (this.start !== -1) {
      this.scanned -= keep;
      this.start = 0;
    }
    this.pos = 0;
  }
}
