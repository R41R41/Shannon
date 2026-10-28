import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Dim, LifeView } from '../integration/commonFca/continueContract.js';

/**
 * The life number (contract 5): the body counts its own lives. A commands made in one life never works in the next (run 45, +929: a death, and the
 * attack the planner had decided before it began after it). The number goes up by one at each death and is kept in a file beside the hold file,
 * per world and per body (`life.json`), so a restart of the process does not send it back to 1.
 *
 * - The file is missing (a first world): 1, a new death epoch, deathSeq 0.
 * - The file is there and cannot be read: the number is not sent back to 1. It starts from the time in milliseconds (a number far above any
 *   real one: every old command lapses), `advancedBy: 'file_unreadable'`, a new death epoch counted from 0, and a note in the black box. That
 *   is a lapse and not a death: the head decides a death only from a rise of `deathSeq` inside the same `deathEpoch`.
 * - A change of dimension is not a death: the number stays; `dimension` and `dimensionSince` move (the next command made before it lapses by its
 *   `madeIn.dimSince`, contract 2).
 */
interface Stored { life: number; deathEpoch: string; deathSeq: number }
interface LifeBot {
  username?: string; health?: number;
  game?: { dimension?: unknown };
  on?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
}
export interface LifeOptions {
  /** The file (a map of `key` to the stored numbers). Default: beside the hold file. */
  file?: string;
  /** Names the world and the body in the file. */
  key?: () => string;
  now?: () => number;
  /** Told when the file was there and could not be read (the black box note). */
  note?: (what: string, data: Record<string, unknown>) => void;
}

export function lifeFile(): string {
  return path.resolve(process.env.MINEBOT_LIFE_FILE ?? path.join(path.dirname(process.env.MINEBOT_INCIDENT_HOLD_FILE ?? 'saves/minecraft/incident-hold.json'), 'life.json'));
}
const normalDim = (value: unknown): Dim => {
  const text = String(value ?? '').replace(/^minecraft:/u, '');
  return text === 'the_nether' || text === 'the_end' ? text : 'overworld';
};

export class LifeKeeper {
  private life = 1;
  private deathEpoch = `de-${randomUUID().slice(0, 8)}`;
  private deathSeq = 0;
  private advancedBy: LifeView['advancedBy'];
  private since: string;
  private alive = true;
  private diedAt?: string;
  private deathCause?: string;
  private dimension: Dim;
  private dimensionSince: string;
  private readonly file: string;
  private readonly now: () => number;
  private readonly onDeath = () => this.died();
  private readonly onSpawn = () => { this.alive = (this.bot.health ?? 20) > 0; this.noteDimension(); };
  private readonly onRespawn = () => this.noteDimension();

  constructor(private readonly bot: LifeBot, private readonly options: LifeOptions = {}) {
    this.file = options.file ?? lifeFile();
    this.now = options.now ?? Date.now;
    this.since = new Date(this.now()).toISOString();
    this.dimension = normalDim(bot.game?.dimension);
    this.dimensionSince = this.since;
    this.load();
    bot.on?.('death', this.onDeath); bot.on?.('spawn', this.onSpawn); bot.on?.('respawn', this.onRespawn);
  }

  private key(): string { return this.options.key?.() ?? `${this.bot.username ?? 'body'}`; }

  private load(): void {
    let raw: string | null = null;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return this.unreadable('read_failed');
    }
    if (raw === null) return this.save();
    let table: Record<string, Stored>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('not_a_table');
      table = parsed as Record<string, Stored>;
    } catch { return this.unreadable('corrupt'); }
    const stored = table[this.key()];
    if (stored === undefined) return this.save();
    if (!Number.isSafeInteger(stored?.life) || stored.life < 1 || typeof stored.deathEpoch !== 'string' || !Number.isSafeInteger(stored.deathSeq) || stored.deathSeq < 0) return this.unreadable('bad_entry');
    this.life = stored.life; this.deathEpoch = stored.deathEpoch; this.deathSeq = stored.deathSeq;
  }

  /** The file is there and unusable: a number that no old command can match, and a new epoch (never 1 again, never a death). */
  private unreadable(why: string): void {
    this.life = Math.max(this.now(), this.life + 1);
    this.advancedBy = 'file_unreadable';
    this.deathEpoch = `de-${randomUUID().slice(0, 8)}`; this.deathSeq = 0;
    try { this.options.note?.('life_file_unreadable', { why, life: this.life, file: this.file }); } catch { /* a note is a help */ }
    this.save();
  }

  private save(): void {
    try {
      let table: Record<string, Stored> = {};
      try { const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) table = parsed; } catch { /* a new table (or a damaged one, replaced) */ }
      table[this.key()] = { life: this.life, deathEpoch: this.deathEpoch, deathSeq: this.deathSeq };
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(table));
      fs.renameSync(temp, this.file);
    } catch { /* the number still counts in memory; the next restart may not remember it */ }
  }

  private died(): void {
    const at = this.now();
    this.life += 1; this.deathSeq += 1; this.advancedBy = 'death';
    this.since = new Date(at).toISOString(); this.diedAt = this.since; this.alive = false;
    this.save();
  }

  /** The dimension the body is in now; a new one is a new generation (even a return to the first). */
  private noteDimension(): void {
    const now = normalDim(this.bot.game?.dimension);
    if (now !== this.dimension) { this.dimension = now; this.dimensionSince = new Date(this.now()).toISOString(); }
  }

  /** Records the cause of the last death (the body's own words). */
  noteDeathCause(cause: string): void { this.deathCause = cause; }

  view(): LifeView {
    this.noteDimension();
    const alive = this.alive && !(typeof this.bot.health === 'number' && this.bot.health <= 0);
    return { life: this.life, ...(this.advancedBy ? { advancedBy: this.advancedBy } : {}), deathEpoch: this.deathEpoch, deathSeq: this.deathSeq,
      since: this.since, alive, ...(this.diedAt ? { diedAt: this.diedAt } : {}), ...(this.deathCause ? { deathCause: this.deathCause } : {}),
      dimension: this.dimension, dimensionSince: this.dimensionSince };
  }
  get number(): number { return this.life; }
  dispose(): void {
    this.bot.removeListener?.('death', this.onDeath); this.bot.removeListener?.('spawn', this.onSpawn); this.bot.removeListener?.('respawn', this.onRespawn);
  }
}

const keepers = new WeakMap<object, LifeKeeper>();
export function lifeOf(bot: object): LifeKeeper | null { return keepers.get(bot) ?? null; }
/** The body's life keeper: made once per bot (at the login, or by the control body when it is not there yet). */
export function installLife(bot: any, options: LifeOptions = {}): LifeKeeper {
  const existing = keepers.get(bot);
  if (existing) return existing;
  const made = new LifeKeeper(bot, options);
  keepers.set(bot, made);
  return made;
}
