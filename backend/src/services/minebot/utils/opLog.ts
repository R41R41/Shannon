import fs from 'node:fs';
import path from 'node:path';
import type { HandStart } from '../integration/commonFca/continueContract.js';
import type { MotorOp } from '../execution/ActionExecution.js';

/**
 * The continuous record of what the body did (continue contracts, 8): the start of each hand of an act, and every effective motor operation, from the
 * start to the end, apart from the black box's ring (which is 90 seconds and is not written for an act that succeeded). The end-to-end benches judge
 * "no operation after the death by an old command" and "the next hand begins where the last stopped" from this, not from the ring. Production uses
 * the same entrance (the ring is for the failure; this is for the measurement).
 *
 * One JSON line each: `{ kind: 'hand_start', ...HandStart }` or `{ kind: 'op', at, command, hand, pass, life, op, detail, by }` (the contract's form; `at` is ISO). The file is rotated by size
 * (OPLOG_MAX_BYTES, a few files kept): the same thought as the decision records, a limit that never stops the body. The limit is a first value; the benches
 * measure the size and the load of a 45-minute run (contract 13).
 */
export const OPLOG_MAX_BYTES = 24 * 1024 * 1024;
export const OPLOG_KEEP: number = 4;

export interface OpScope { command: string; item?: string; hand: number; pass: number; life: number }

export class OpLog {
  private fd: number | null = null;
  private bytes = 0;
  private scope: OpScope | null = null;
  private failed = false;
  constructor(private readonly dir: string, private readonly name = `oplog-${process.pid}`, private readonly maxBytes = OPLOG_MAX_BYTES) {}

  get file(): string { return path.join(this.dir, `${this.name}.jsonl`); }
  /** Where the operations that follow belong (the hand of the act that is running); null when no act is. */
  setScope(scope: OpScope | null): void { this.scope = scope; }
  get currentScope(): OpScope | null { return this.scope; }

  handStart(record: HandStart): void { this.append({ kind: 'hand_start', ...record }); }
  op(op: MotorOp): void {
    this.append({ kind: 'op', at: new Date(op.at).toISOString(), ...(this.scope ? { command: this.scope.command, hand: this.scope.hand, pass: this.scope.pass, life: this.scope.life } : {}),
      op: op.op, ...(op.detail ? { detail: op.detail } : {}), by: op.capability, action: op.actionId });
  }
  /** Any other thing the judge reads with the operations (a forced move, a block update that corrected a count). */
  /** The line's own fields (kind, at: the ISO time, the scope) are never overwritten by the data: a field of the data with one of those names is dropped. */
  note(kind: string, data: Record<string, unknown>): void {
    const { kind: _kind, at: _at, ...rest } = data;
    this.append({ ...rest, kind, at: new Date().toISOString(), ...(this.scope ? { command: this.scope.command, hand: this.scope.hand, life: this.scope.life } : {}) });
  }

  /**
   * The state of the body's motor port at one point (the head's judge reads `{ kind: 'motor_state', at, command, point, shield, deactivateItem }`): the command is the data's own
   * (the handover's command, which is not the scope's yet), `at` is the ISO time of the writing.
   */
  motorState(data: Record<string, unknown>): void {
    const { kind: _kind, at: _at, ...rest } = data;
    this.append({ ...rest, kind: 'motor_state', at: new Date().toISOString() });
  }

  private open(): void {
    if (this.fd !== null || this.failed) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.fd = fs.openSync(this.file, 'a');
      this.bytes = fs.fstatSync(this.fd).size;
    } catch { this.failed = true; }
  }
  private rotate(): void {
    try {
      if (this.fd !== null) fs.closeSync(this.fd);
      this.fd = null;
      for (let index = OPLOG_KEEP - 1; index >= 1; index--) {
        const from = index === 1 ? this.file : `${this.file}.${index - 1}`, to = `${this.file}.${index}`;
        try { fs.renameSync(from, to); } catch { /* none yet */ }
      }
      if (OPLOG_KEEP === 1) fs.rmSync(this.file, { force: true });
    } catch { /* the record never stops the body */ }
  }
  private append(entry: Record<string, unknown>): void {
    try {
      this.open();
      if (this.fd === null) return;
      const line = `${JSON.stringify(entry)}\n`;
      if (this.bytes + line.length > this.maxBytes) { this.rotate(); this.open(); if (this.fd === null) return; this.bytes = 0; }
      fs.writeSync(this.fd, line);
      this.bytes += line.length;
    } catch { /* a full disk does not stop the body */ }
  }
  close(): void { try { if (this.fd !== null) fs.closeSync(this.fd); } catch { /* closed */ } this.fd = null; }
}

const logs = new WeakMap<object, OpLog>();
export function opLogOf(bot: object): OpLog | null { return logs.get(bot) ?? null; }
export function installOpLog(bot: object, log: OpLog): OpLog { logs.set(bot, log); return log; }
export function opLogDirectory(): string { return path.resolve(process.env.MINEBOT_OPLOG_DIR ?? 'saves/minecraft/oplog'); }

/** `bread×4,cobbled_deepslate×63`: the pack by name, summed, in name order (the hand start's inventory line). */
export function packSummary(bot: { inventory?: { items?(): Array<{ name: string; count: number }> } }): string {
  const counts = new Map<string, number>();
  for (const item of bot.inventory?.items?.() ?? []) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([name, count]) => `${name}×${count}`).join(',');
}
