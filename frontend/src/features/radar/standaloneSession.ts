import { RadarController } from './radarController';
import { createRadarClient } from './radarClient';

export interface RadarIdentityUser { uid: string; getIdToken(): Promise<string> }
export interface RadarIdentityClient {
  projectId: string;
  currentUser(): RadarIdentityUser | null;
  observe(callback: (user: RadarIdentityUser | null) => void): () => void;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}
type State = { kind: 'login' | 'verifying' | 'error'; error?: string } | { kind: 'ready'; controller: RadarController };
/** A standalone HTTP session: no legacy auth socket, localStorage or AgentProvider. */
export class StandaloneRadarSession {
  private state: State = { kind: 'login' };
  private listeners = new Set<() => void>();
  private generation = 0;
  private pending?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private blocked = false;
  private active = false;
  constructor(private readonly identity: RadarIdentityClient, private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init), private readonly now = Date.now) {}
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(state: State) { this.state = state; this.listeners.forEach(fn => fn()); }
  private clear() {
    this.generation++; this.pending?.abort(); this.pending = undefined; clearTimeout(this.timer);
    if (this.state.kind === 'ready') this.state.controller.stop();
  }
  start() {
    if (this.active) return; this.active = true;
    this.unsubscribe = this.identity.observe(user => { void this.changed(user); });
  }
  stop() { this.active = false; this.clear(); this.unsubscribe?.(); this.unsubscribe = undefined; this.set({ kind: 'login' }); }
  async login(email: string, password: string) {
    if (!this.active || this.state.kind === 'verifying') return;
    this.clear(); this.blocked = false; const generation = this.generation;
    this.set({ kind: 'verifying' });
    try { await this.identity.signIn(email, password); }
    catch { if (this.active && generation === this.generation) this.set({ kind: 'error', error: 'ログインできませんでした。アカウントと利用許可を確認してください。' }); }
  }
  async logout() {
    this.blocked = true; this.clear(); this.set({ kind: 'login' });
    const generation = this.generation;
    try { await this.identity.signOut(); }
    catch { if (this.active && generation === this.generation) this.set({ kind: 'error', error: 'ログアウトに失敗しました。表示は消去済みです。' }); }
  }
  private async changed(user: RadarIdentityUser | null) {
    this.clear();
    if (!this.active || this.blocked || !user) { this.set({ kind: 'login' }); return; }
    const generation = this.generation; const abort = new AbortController(); this.pending = abort;
    const current = () => this.active && !this.blocked && generation === this.generation && !abort.signal.aborted && this.identity.currentUser() === user;
    this.set({ kind: 'verifying' });
    const timeout = setTimeout(() => {
      if (current()) { this.clear(); this.set({ kind: 'error', error: '認証確認がタイムアウトしました。' }); }
    }, 15000);
    try {
      const token = await user.getIdToken(); if (!current()) return;
      const response = await this.fetcher('/api/radar/session', { signal: abort.signal, headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', credentials: 'omit', redirect: 'error' });
      const value = await response.json();
      if (!current()) return;
      if (!response.ok || value.projectId !== this.identity.projectId || value.uid !== user.uid || !Number.isSafeInteger(value.expiresAt)
        || value.expiresAt <= this.now() || value.expiresAt > this.now() + 3600000) throw Error();
      const expiresAt = value.expiresAt as number;
      const readable = () => current() && this.now() < expiresAt;
      const client = createRadarClient(async (path, init) => {
        if (!path.startsWith('/api/radar/') || /[\\\r\n]/.test(path) || !readable() || init.signal?.aborted) throw Error();
        const token = await user.getIdToken(); if (!readable() || init.signal?.aborted) throw Error();
        const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${token}`);
        const result = await this.fetcher(path, { ...init, headers, cache: 'no-store', credentials: 'omit', redirect: 'error' });
        if (!readable() || init.signal?.aborted) throw Error(); return result;
      });
      this.set({ kind: 'ready', controller: new RadarController(client, readable) });
      this.timer = setTimeout(() => { if (current()) { this.clear(); this.set({ kind: 'error', error: '認証期限が切れました。再ログインしてください。' }); } }, expiresAt - this.now());
    } catch { if (this.active && generation === this.generation) this.set({ kind: 'error', error: '本人の利用許可を確認できませんでした。' }); }
    finally {
      clearTimeout(timeout);
      if (this.active && generation === this.generation && abort.signal.aborted) this.set({ kind: 'error', error: '認証確認がタイムアウトしました。' });
    }
  }
}
