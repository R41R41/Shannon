/**
 * The floor's budget (P8 design R1, review M3, 2026-10-19). The floor's reflexes take the body from the mind for a moment, and while
 * one holds it (`facts.floorActive`) the API's fast judgment is silent. Each is short, but nothing bounded how often they came back:
 * arrows at a skeleton's rate (a one-second step aside, half a second's rest, again) or a meal that fails at 6 health (tried again
 * every three seconds) could keep the body in reflex for good, and the mind never got a turn.
 *
 *   cooldown   after an arrow step-aside ends, two seconds before the next (one second at 6 health or less)
 *   backoff    after a meal or an armour change that failed: 3 s, 6 s, 12 s ... up to 30 s; after one that was only cut off: 3 s
 *   allowance  15 s of reflex time in any 60 s for the arrow step-aside, the meal and the armour change; past it they are silent
 *              until the window has room again (health 6 or less is exempt: that is when they matter most)
 *   latch      three failures of the same reflex in a row stop it for a minute (then two, then four; a success clears it)
 *
 * Never limited here: a lit creeper's retreat (it ends by itself in an explosion), the low-health flee (it has its own two in
 * twenty seconds), lava and breath (not the floor's). Whatever the budget silences it SAYS: one ledger note when the allowance
 * runs out or a latch closes (shown to the mind in `state.world.reflexes`), and `facts.floorSilenced` while it holds.
 */
export type BudgetKind = 'arrow' | 'eat' | 'armor';
export type BudgetOutcome = 'done' | 'cut' | 'failed';

export const BUDGET_WINDOW_MS = 60_000;
export const BUDGET_ALLOWANCE_MS = 15_000;
export const ARROW_GAP_MS = 2_000;
export const ARROW_GAP_LOW_HEALTH_MS = 1_000;
export const RETRY_BASE_MS = 3_000;
export const RETRY_MAX_MS = 30_000;
export const LATCH_AFTER = 3;
export const LATCH_MS = 60_000;
export const LATCH_MAX_MS = 240_000;
/** At or below this health the allowance does not apply (the API's own `lowHealth`). */
export const BUDGET_EXEMPT_HEALTH = 6;

const LABEL: Record<BudgetKind, string> = { arrow: '矢のよけ', eat: '食事', armor: '防具の装着' };

interface Track { until: number; failures: number; latchedUntil: number; latches: number }

export class FloorBudget {
  private spans: Array<{ at: number; ms: number }> = [];
  private readonly tracks: Record<BudgetKind, Track> = { arrow: fresh(), eat: fresh(), armor: fresh() };
  private exhausted = false;
  private lowHealth = false;

  constructor(private readonly now: () => number = Date.now, private readonly report: (detail: string) => void = () => undefined) {}

  /** Reflex time spent in the window, in ms. */
  spent(at = this.now()): number {
    this.spans = this.spans.filter(span => at - span.at < BUDGET_WINDOW_MS);
    return this.spans.reduce((sum, span) => sum + span.ms, 0);
  }

  /** Whether this reflex may start now. */
  allow(kind: BudgetKind, health: number): boolean {
    const at = this.now(), track = this.tracks[kind];
    this.lowHealth = health <= BUDGET_EXEMPT_HEALTH;
    if (at < track.latchedUntil || at < track.until) return false;
    if (this.lowHealth) return true;
    if (this.spent(at) >= BUDGET_ALLOWANCE_MS) {
      if (!this.exhausted) {
        this.exhausted = true;
        this.report(`床の反射が60秒に${BUDGET_ALLOWANCE_MS / 1000}秒を使い切った: 矢のよけ・食事・防具を少し止める`);
      }
      return false;
    }
    this.exhausted = false;
    return true;
  }

  /** A reflex that began at `startedAt` is over. */
  end(kind: BudgetKind, startedAt: number, outcome: BudgetOutcome): void {
    const at = this.now(), track = this.tracks[kind];
    this.spans.push({ at, ms: Math.max(0, at - startedAt) });
    if (kind === 'arrow') { track.until = at + (this.lowHealth ? ARROW_GAP_LOW_HEALTH_MS : ARROW_GAP_MS); return; }
    if (outcome === 'done') { track.failures = 0; track.latches = 0; track.until = 0; return; }
    if (outcome === 'cut') { track.until = at + RETRY_BASE_MS; return; }
    track.failures++;
    track.until = at + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (track.failures - 1));
    if (track.failures >= LATCH_AFTER) {
      const duration = Math.min(LATCH_MAX_MS, LATCH_MS * 2 ** track.latches);
      track.latches++; track.latchedUntil = at + duration; track.failures = LATCH_AFTER - 1;
      this.report(`${LABEL[kind]}が${LATCH_AFTER}回続けて失敗した: ${Math.round(duration / 1000)}秒は試さない（API の判断に任せる）`);
    }
  }

  /** What the budget is holding back right now (a latch, or the allowance), for the observation; empty when nothing. */
  silenced(): string[] {
    const at = this.now(), held: string[] = [];
    for (const kind of ['arrow', 'eat', 'armor'] as const) if (at < this.tracks[kind].latchedUntil) held.push(kind);
    if (this.exhausted && this.spent(at) >= BUDGET_ALLOWANCE_MS) held.push('budget');
    return held;
  }
}

function fresh(): Track { return { until: 0, failures: 0, latchedUntil: 0, latches: 0 }; }
