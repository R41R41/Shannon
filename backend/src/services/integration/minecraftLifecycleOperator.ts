import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MinecraftLifecycleCommand, MinecraftLifecycleReceipt, MinecraftLifecycleReply } from './minecraftLifecycleContract.js';
import { MINECRAFT_LIFECYCLE_PATH } from './minecraftLifecycleContract.js';
import { MinecraftLifecycleNative } from './minecraftLifecycleNative.js';

interface JournalEntry { command: MinecraftLifecycleCommand; receipt?: MinecraftLifecycleReceipt }
/** Single-writer operator journal. Begin commits before the actuator; a crash does not replay a lifecycle effect. */
export class LifecycleOperationJournal {
  readonly entries: Map<string, JournalEntry>;
  constructor(private readonly file: string) {
    const decoded = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    if (!Array.isArray(decoded) || decoded.length > 10000 || decoded.some(v => !v?.command?.id)) throw Error('LIFECYCLE_JOURNAL_INVALID');
    this.entries = new Map(decoded.map(v => [v.command.id, v]));
  }
  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`, fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify([...this.entries.values()])); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
    const directory = fs.openSync(path.dirname(this.file), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
  begin(command: MinecraftLifecycleCommand): boolean {
    if (this.entries.has(command.id)) return false;
    if (this.entries.size >= 10000) throw Error('LIFECYCLE_JOURNAL_FULL');
    this.entries.set(command.id, { command }); this.persist(); return true;
  }
  settle(receipt: MinecraftLifecycleReceipt): void {
    const row = this.entries.get(receipt.id); if (!row) throw Error('LIFECYCLE_JOURNAL_MISSING');
    if (row.receipt) { if (JSON.stringify(row.receipt) !== JSON.stringify(receipt)) throw Error('LIFECYCLE_RECEIPT_CONFLICT'); return; }
    row.receipt = receipt; this.persist();
  }
  get held(): boolean { return [...this.entries.values()].some(v => !v.receipt || v.receipt.outcome === 'unknown' || !v.receipt.inputsReleased); }
}
export class MinecraftLifecycleOperator {
  readonly connectionId = randomUUID();
  private sequence = 0;
  private active: { id: string; controller: AbortController } | null = null;
  private polling = false;
  private acknowledged = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(readonly options: { baseUrl: string; token: string; native: MinecraftLifecycleNative; journal: LifecycleOperationJournal; fetcher?: typeof fetch; pollMilliseconds?: number }) {}
  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return (this.options.fetcher ?? fetch)(`${this.options.baseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(2000), ...(signal ? [signal] : [])]) });
  }
  async authorize(command: MinecraftLifecycleCommand, signal: AbortSignal): Promise<boolean> {
    try { const response = await this.post(`${MINECRAFT_LIFECYCLE_PATH}/permit`, { id: command.id }, signal); return response.ok && (await response.json() as { allowed?: unknown }).allowed === true; } catch { return false; }
  }
  start(): void {
    if (this.timer || this.closed) return;
    const tick = async () => { try { await this.poll(); } catch { /* durable receipts retained; no effect retried */ }
      finally { if (!this.closed) { this.timer = setTimeout(tick, this.options.pollMilliseconds ?? 500); this.timer.unref(); } } };
    void tick();
  }
  async poll(): Promise<void> {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      const state = await this.options.native.observe();
      // Entries begun by a former process remain unknown, even when the present state happens to look like the goal.
      for (const row of this.options.journal.entries.values()) if (!row.receipt && row.command.id !== this.active?.id) this.options.journal.settle({
        id: row.command.id, connectionId: row.command.connectionId, serverId: row.command.serverId, action: row.command.action,
        outcome: 'unknown', code: 'state_unknown', inputsReleased: false, observedAt: new Date().toISOString(), state });
      const receipts = [...this.options.journal.entries.values()].flatMap(row => row.receipt && !this.acknowledged.has(row.command.id) ? [row.receipt] : []).slice(0, 16);
      const response = await this.post(MINECRAFT_LIFECYCLE_PATH, { schemaVersion: 1, connectionId: this.connectionId, sequence: this.sequence++, states: [state], receipts });
      if (!response.ok) throw Error('LIFECYCLE_HTTP');
      const reply = await response.json() as MinecraftLifecycleReply;
      if (reply.schemaVersion !== 1 || !Array.isArray(reply.commands) || reply.commands.length > 1 || !Array.isArray(reply.cancel) || !Array.isArray(reply.acknowledged)) throw Error('LIFECYCLE_REPLY');
      for (const id of reply.acknowledged) if (receipts.some(r => r.id === id)) this.acknowledged.add(id);
      const active = this.active;
      for (const id of reply.cancel) if (active && id === active.id) active.controller.abort('authority_revoked');
      for (const command of reply.commands) this.accept(command);
    } catch (error) { this.active?.controller.abort('operator_disconnected'); throw error; }
    finally { this.polling = false; }
  }
  private accept(command: MinecraftLifecycleCommand): void {
    if (!command || command.schemaVersion !== 1 || command.connectionId !== this.connectionId
      || !Number.isFinite(Date.parse(command.issuedAt)) || Date.parse(command.issuedAt) > Date.now()
      || !Number.isFinite(Date.parse(command.deadlineAt)) || Date.parse(command.issuedAt) >= Date.parse(command.deadlineAt)
      || command.serverId !== this.options.native.ports.serverId || !['start', 'stop', 'login', 'logout'].includes(command.action)
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(command.id) || this.active || this.options.journal.held) return;
    if (!this.options.journal.begin(command)) return;
    const controller = new AbortController(); this.active = { id: command.id, controller };
    const timer = setTimeout(() => controller.abort('deadline'), Math.max(0, Date.parse(command.deadlineAt) - Date.now()));
    void this.options.native.execute(command, controller.signal).then(receipt => this.options.journal.settle(receipt)).catch(() => undefined)
      .finally(() => { clearTimeout(timer); this.active = null; });
  }
  stop(): void { this.closed = true; clearTimeout(this.timer); this.active?.controller.abort('operator_closed'); }
}
