import { RadarClientError, type RadarClient, type RadarErrorCode, type SourceInput, type SourcesSnapshot, type PreviewSnapshot, type AuditSnapshot, sourceIdValid } from './radarClient';

export interface RadarSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'collecting' | 'hidden' | 'expired' | 'error' | 'closed';
  data: { sources: SourcesSnapshot; preview: PreviewSnapshot; audit: AuditSnapshot } | null;
  error?: RadarErrorCode;
}
/** Per-mounted-session controller. Collection requires an explicit selection; no polling or mutation retry. */
export class RadarController {
  private state: RadarSnapshot = Object.freeze({ status: 'idle', data: null });
  private listeners = new Set<() => void>();
  private generation = 0;
  private pending?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private active = false;
  private visible = true;
  private deadline = 0;
  constructor(private readonly client: RadarClient, private readonly currentSession: () => boolean,
    private readonly monotonicNow: () => number = () => performance.now()) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(state: RadarSnapshot) { this.state = Object.freeze(state); this.listeners.forEach(l => l()); }
  clear(status: RadarSnapshot['status'] = 'expired') {
    ++this.generation; this.pending?.abort(); this.pending = undefined; clearTimeout(this.timer); this.timer = undefined;
    this.deadline = 0; this.set({ status, data: null });
  }
  activate() { this.active = true; this.visible = true; this.clear('idle'); }
  stop() { this.active = false; this.clear('closed'); }
  visibility(visible: boolean) { this.visible = visible; this.clear(visible ? 'expired' : 'hidden'); }
  isReadable() { return this.active && this.visible && this.currentSession() && this.state.status === 'ready' && this.monotonicNow() < this.deadline; }
  private allowed() { return this.active && this.visible && this.currentSession(); }
  private current(n: number) { return n === this.generation && this.allowed() && !this.pending?.signal.aborted; }
  async load(minimumRevision = 0): Promise<void> {
    if (!this.allowed() || this.state.status === 'saving' || this.state.status === 'collecting') return;
    this.clear('loading'); const n = this.generation; const abort = this.pending = new AbortController();
    const started = this.monotonicNow();
    try {
      const sources = await this.client.sources(abort.signal);
      if (!this.current(n)) return;
      const preview = await this.client.preview(abort.signal);
      if (!this.current(n)) return;
      const audit = await this.client.audit(abort.signal);
      if (!this.current(n)) return;
      if (sources.revision !== preview.revision || sources.revision !== audit.revision || sources.revision < minimumRevision) throw new RadarClientError('conflict');
      for (const item of preview.items) {
        const entry = sources.sources.find(s => s.id === item.sourceId)?.source;
        if (!entry || !entry.enabled || entry.revision !== item.sourceRevision
          || entry.consentExpiresAt <= preview.servedAt || !entry.articleHosts.includes(new URL(item.card.sourceUrl).hostname))
          throw new RadarClientError('invalid');
      }
      // Server-relative TTL minus the entire round trip avoids extending a deadline because of client wall-clock skew.
      const remaining = Math.min(60000, preview.validUntil - preview.servedAt, audit.validUntil - audit.servedAt) - (this.monotonicNow() - started);
      if (!Number.isFinite(remaining) || remaining <= 0) { this.clear('expired'); return; }
      this.deadline = this.monotonicNow() + remaining;
      this.set({ status: 'ready', data: { sources, preview, audit } });
      this.timer = setTimeout(() => { if (n === this.generation) this.clear('expired'); }, remaining);
    } catch (error) {
      if (this.current(n)) this.set({ status: 'error', data: null, error: error instanceof RadarClientError ? error.code : 'network' });
    }
  }
  async save(id: string, source: SourceInput) { return this.mutate(id, source); }
  async revoke(id: string) { return this.mutate(id); }
  async collect(sourceIds: string[]): Promise<void> {
    if (this.state.status === 'saving' || this.state.status === 'collecting') return;
    if (!this.isReadable() || !this.state.data) { this.clear('expired'); return; }
    const data = this.state.data;
    if (data.sources.collectionAvailable !== true) return;
    if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 3 || new Set(sourceIds).size !== sourceIds.length
      || !sourceIds.every(id => sourceIdValid(id) && data.sources.sources.some(entry => entry.id === id && entry.source?.enabled
        && entry.source.consentExpiresAt > data.preview.servedAt))) return;
    const selected = [...sourceIds]; const expected = data.sources.revision;
    return this.perform('collecting', signal => this.client.collect(selected, expected, signal));
  }
  cancelCollection() {
    if (this.state.status !== 'collecting') return;
    this.clear('error'); this.set({ status: 'error', data: null, error: 'uncertain' });
  }
  private async mutate(id: string, source?: SourceInput): Promise<void> {
    if (this.state.status === 'saving' || this.state.status === 'collecting') return;
    if (!this.isReadable() || !this.state.data) { this.clear('expired'); return; }
    const expectedRevision = this.state.data.sources.revision;
    const input = source ? structuredClone(source) : undefined;
    return this.perform('saving', signal => input ? this.client.save(id, expectedRevision, input, signal)
      : this.client.revoke(id, expectedRevision, signal));
  }
  private async perform(status: 'saving' | 'collecting', operation: (signal: AbortSignal) => Promise<{ revision: number }>) {
    this.clear(status); const n = this.generation; const abort = this.pending = new AbortController();
    try {
      const result = await operation(abort.signal);
      if (!this.current(n)) return;
      this.set({ status: 'idle', data: null });
      await this.load(result.revision); // Read back only; never automatically repeat collection or mutation.
    } catch (error) {
      if (this.current(n)) this.set({ status: 'error', data: null,
        error: error instanceof RadarClientError && ['invalid', 'conflict', 'authorization'].includes(error.code) ? error.code : 'uncertain' });
    }
  }
}
