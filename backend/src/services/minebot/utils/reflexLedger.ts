import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:ReflexLedger');

/**
 * What the body's own reflexes did, kept for whoever decides next (P8, 2026-10-17). A reflex acts on the physics tick without a
 * model; before this the planner saw nothing of it: a command cut off by a meal came back as a bare `interrupted`, and a shield
 * raised or a creeper stepped away from left no trace in the observation. The ledger is the body's own memory of it: a ring of
 * the last 16, shown as `state.world.reflexes` (at most 500 characters) and as a note on the receipt of the command it touched.
 *
 * It only reports. It never starts a reflex and never issues a command.
 */
/** budget: not a reflex but the floor saying it has stopped trying for a while (the allowance is used up, or a reflex keeps failing). */
/**
 * cover (r7): a hand that cut a shooter's line while burning (floorReflexes `coverChoice`); cover_none: burning in the line with no such hand
 * to make (a fact only: it does not stop an act, which may be what takes the body out).
 */
/**
 * melee (r8): a hand toward a melee enemy near (a step off a drop's rim, a block between, a step away: floorReflexes `meleeChoice`);
 * melee_none: such an enemy near with no hand to make, or the episode's hands used up (a fact only: it does not stop an act).
 * r9: on a floor the same kind also says a blow back ("打ち返した 2 回（iron_sword）・当たった 2・相手の残り体力 4") and two blocks up ("2段積んで上がった").
 */
export type ReflexKind = 'retreat' | 'eat' | 'armor' | 'flee' | 'pickup' | 'budget' | 'shield' | 'fireball' | 'knock' | 'lava' | 'breath' | 'cover' | 'cover_none' | 'melee' | 'melee_none' | 'wall';
export type ReflexOutcome = 'done' | 'cut' | 'failed';
export interface ReflexEntry {
  seq: number; at: number; kind: ReflexKind; detail: string; outcome: ReflexOutcome;
  /** How many times in a row it was merged into this entry (counter-driven reflexes such as the shield). */
  n: number;
  hp?: [number, number]; food?: [number, number];
}
export interface PreemptRecord { seq: number; at: number; by: string; aborted: string[]; ids: string[] }
export interface ReflexHandle { seq: number; kind: ReflexKind; detail: string; hp: number | null; food: number | null }

export const LEDGER_SIZE = 16;
export const RECENT_WINDOW_MS = 180_000;
export const RECENT_MAX = 5;
export const SUMMARY_MAX_CHARS = 500;
export const NOTE_MAX_CHARS = 200;
const MERGE_WINDOW_MS = 3000;
const DETAIL_MAX = 40;

interface LedgerBot {
  health?: number; food?: number;
  on?(event: string, listener: () => void): unknown;
  shieldBlock?: { raised?: number };
  fireballDeflect?: { strikes?: number };
  knockBrace?: { braced?: number };
  lavaReflex?: { engagements?: number };
  breathingReflex?: { engagements?: number };
  reflexLedger?: ReflexLedger;
}

/** The resident plugins keep counters; the ledger watches them rise and writes one entry for a rise, never for a level. */
const COUNTERS: Array<{ kind: ReflexKind; detail: string; read: (bot: LedgerBot) => unknown }> = [
  { kind: 'shield', detail: '盾を構えた', read: bot => bot.shieldBlock?.raised },
  { kind: 'fireball', detail: '火の玉を打ち返した', read: bot => bot.fireballDeflect?.strikes },
  { kind: 'knock', detail: '押された先で踏ん張った', read: bot => bot.knockBrace?.braced },
  { kind: 'lava', detail: '溶岩から脱出した', read: bot => bot.lavaReflex?.engagements },
  { kind: 'breath', detail: '呼吸を確保した', read: bot => bot.breathingReflex?.engagements },
];

const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export class ReflexLedger {
  private seq = 0;
  private readonly entries: ReflexEntry[] = [];
  private readonly preempts: PreemptRecord[] = [];
  private readonly totals: Partial<Record<ReflexKind, number>> = {};
  private readonly seen = new Map<string, number>();

  constructor(private readonly bot: LedgerBot, private readonly now: () => number = Date.now) {
    // Counters that were already up when the ledger came are history, not news.
    for (const counter of COUNTERS) this.seen.set(counter.kind, number(counter.read(bot)) ?? 0);
  }

  /** Position in the ledger: what a command started now can later ask about (`since`). */
  mark(): number { return this.seq; }

  /** `maxChars` lets a reflex that says where and at what health (the last stand) keep more than the usual DETAIL_MAX. */
  begin(kind: ReflexKind, detail: string, maxChars = DETAIL_MAX): ReflexHandle {
    return { seq: ++this.seq, kind, detail: clip(detail, maxChars), hp: number(this.bot.health), food: number(this.bot.food) };
  }

  end(handle: ReflexHandle, outcome: ReflexOutcome): ReflexEntry {
    const hp = number(this.bot.health), food = number(this.bot.food);
    const entry: ReflexEntry = { seq: handle.seq, at: this.now(), kind: handle.kind, detail: handle.detail, outcome, n: 1,
      ...(handle.hp !== null && hp !== null && handle.hp !== hp ? { hp: [handle.hp, hp] as [number, number] } : {}),
      ...(handle.food !== null && food !== null && handle.food !== food ? { food: [handle.food, food] as [number, number] } : {}) };
    this.push(entry);
    log.info(`🧾 反射: ${entry.kind} ${entry.detail}${entry.hp ? ` 体力${entry.hp[0]}→${entry.hp[1]}` : ''}${entry.food ? ` 満腹度${entry.food[0]}→${entry.food[1]}` : ''} ${outcome}`);
    return entry;
  }

  /** A reflex that is over the moment it happens. */
  note(kind: ReflexKind, detail: string, outcome: ReflexOutcome = 'done'): ReflexEntry {
    return this.end(this.begin(kind, detail), outcome);
  }

  /** A reflex took the body and cut these actions off (`preemptLowerPriorityActions`, only when it cut at least one). */
  preempted(by: string, aborted: string[], ids: string[] = []): void {
    if (!aborted.length) return;
    this.preempts.push({ seq: ++this.seq, at: this.now(), by, aborted: aborted.slice(0, 8), ids: ids.slice(0, 8) });
    if (this.preempts.length > LEDGER_SIZE) this.preempts.shift();
  }

  /** Reads the resident plugins' counters; called once per physics tick, and a rise is one entry however many ticks it spans. */
  sample(): void {
    const at = this.now();
    for (const counter of COUNTERS) {
      const value = number(counter.read(this.bot));
      if (value === null) continue;
      const before = this.seen.get(counter.kind) ?? 0;
      this.seen.set(counter.kind, value);
      if (value <= before) continue;
      const last = this.entries[this.entries.length - 1];
      if (last && last.kind === counter.kind && at - last.at < MERGE_WINDOW_MS) {
        last.n += value - before; last.at = at; this.totals[counter.kind] = (this.totals[counter.kind] ?? 0) + (value - before);
        continue;
      }
      this.note(counter.kind, counter.detail);
      if (value - before > 1) { const merged = this.entries[this.entries.length - 1]; merged.n += value - before - 1; this.totals[counter.kind] = (this.totals[counter.kind] ?? 0) + (value - before - 1); }
    }
  }

  entriesSince(mark: number): ReflexEntry[] { return this.entries.filter(entry => entry.seq > mark); }
  preemptsSince(mark: number): PreemptRecord[] { return this.preempts.filter(record => record.seq > mark); }

  /**
   * Whether a reflex cut this action off after `mark`: the only evidence for `interrupted_by_reflex`. By the action's own id when
   * it is known (another action of the same name is not this one), else by capability name.
   */
  cutOff(mark: number, capability: string, actionId?: string): PreemptRecord | undefined {
    return this.preemptsSince(mark).find(record => actionId !== undefined && record.ids.length ? record.ids.includes(actionId) : record.aborted.includes(capability));
  }

  /** The note for a receipt: what reflexes did while the command ran, or null. */
  noteSince(mark: number): string | null {
    const entries = this.entriesSince(mark);
    if (!entries.length) return null;
    const parts = entries.map(entry => `${entry.detail}${entry.n > 1 ? `×${entry.n}` : ''}${entry.hp ? ` 体力${entry.hp[0]}→${entry.hp[1]}` : ''}`
      + `${entry.food ? ` 満腹度${entry.food[0]}→${entry.food[1]}` : ''}${entry.outcome === 'done' ? '' : entry.outcome === 'cut' ? '（途中で中断）' : '（失敗）'}`);
    let text = `［体の反射: ${parts.join(' / ')}］`;
    while (text.length > NOTE_MAX_CHARS && parts.length > 1) { parts.shift(); text = `［体の反射: …${parts.join(' / ')}］`; }
    return clip(text, NOTE_MAX_CHARS);
  }

  /** `state.world.reflexes`: undefined when there is nothing to say, and never more than 500 characters. */
  summary(): { recent: Array<{ ageSec: number; kind: ReflexKind; detail: string }>; counts: Partial<Record<ReflexKind, number>> } | undefined {
    const at = this.now();
    const recent = this.entries.filter(entry => at - entry.at <= RECENT_WINDOW_MS).slice(-RECENT_MAX)
      .map(entry => ({ ageSec: Math.max(0, Math.round((at - entry.at) / 1000)), kind: entry.kind,
        detail: entry.n > 1 ? `${entry.detail}×${entry.n}` : entry.detail }));
    if (!recent.length) return undefined;
    const counts = { ...this.totals };
    const build = () => ({ recent: [...recent].reverse(), counts });
    while (JSON.stringify(build()).length > SUMMARY_MAX_CHARS && recent.length > 1) recent.shift();
    let shown = build();
    if (JSON.stringify(shown).length > SUMMARY_MAX_CHARS) shown = { recent: shown.recent.map(item => ({ ...item, detail: clip(item.detail, 12) })), counts: {} };
    return shown;
  }

  private push(entry: ReflexEntry): void {
    this.entries.push(entry);
    this.entries.sort((a, b) => a.seq - b.seq);
    if (this.entries.length > LEDGER_SIZE) this.entries.shift();
    this.totals[entry.kind] = (this.totals[entry.kind] ?? 0) + 1;
  }
}

/** One ledger per body, counting the resident plugins from the moment it is installed. */
export function ensureReflexLedger(bot: LedgerBot, now?: () => number): ReflexLedger {
  if (bot.reflexLedger) return bot.reflexLedger;
  const ledger = bot.reflexLedger = new ReflexLedger(bot, now);
  bot.on?.('physicsTick', () => { try { ledger.sample(); } catch { /* a report must not break the tick */ } });
  return ledger;
}

/** mineflayer plugin form. */
export function reflexLedgerPlugin(bot: unknown): void { ensureReflexLedger(bot as LedgerBot); }
