import {
  emptyCombatStats, mergeCombatStats, PEAK_WINDOW_SECONDS, seedCombatStats, type CombatStatsState,
} from '../../../modules/minecraftLearning/index.js';

export interface CombatStatsPersistence {
  load(): CombatStatsState;
  /** Merge this process's unsaved observations into the shared store. */
  save(delta: CombatStatsState): void;
}

/**
 * Measured combat statistics for the fight-or-flee estimate. Observations go
 * into a local delta that is merged with the shared snapshot on read and
 * flushed periodically; without persistence (learning off) the human priors
 * alone are used and nothing is written.
 */
export class EncounterMemory {
  private base: CombatStatsState;
  private delta = emptyCombatStats();
  private timer: NodeJS.Timeout | null = null;
  private recentHits = new Map<string, Array<{ at: number; damage: number }>>();

  constructor(private readonly persistence?: CombatStatsPersistence, flushIntervalMs = 60_000) {
    this.base = persistence ? persistence.load() : seedCombatStats();
    if (persistence) {
      this.timer = setInterval(() => this.flush(), flushIntervalMs);
      this.timer.unref?.();
    }
  }

  stats(): CombatStatsState { return mergeCombatStats(this.base, this.delta); }

  /** `fromMetres`: how far the attacker stood when the hit landed, when the server named it as the cause. */
  recordHit(mob: string, damage: number, fromMetres?: number, ownBlow = false): void {
    const m = this.delta.mobs[mob] ??= { hits: 0, damage: 0, maxHit: 0, contactMs: 0 };
    m.hits++; m.damage += damage; m.maxHit = Math.max(m.maxHit, damage);
    if (ownBlow) m.blows = (m.blows ?? 0) + 1;
    // The most this kind has taken within three seconds (see incomingDamagePerSecond).
    const now = Date.now();
    const recent = (this.recentHits.get(mob) ?? []).filter(hit => now - hit.at < PEAK_WINDOW_SECONDS * 1000);
    recent.push({ at: now, damage });
    this.recentHits.set(mob, recent);
    m.peak3s = Math.max(m.peak3s ?? 0, Math.round(recent.reduce((sum, hit) => sum + hit.damage, 0) * 10) / 10);
    if (fromMetres !== undefined && Number.isFinite(fromMetres) && fromMetres > 0) m.reach = Math.max(m.reach ?? 0, Math.min(58, Math.round(fromMetres * 10) / 10));
  }

  /** This kind was seen to shoot at the body (whether or not the shot landed). */
  recordShot(mob: string): void {
    const m = this.delta.mobs[mob] ??= { hits: 0, damage: 0, maxHit: 0, contactMs: 0 };
    m.shots = (m.shots ?? 0) + 1;
  }

  recordContact(mob: string, ms: number): void {
    const m = this.delta.mobs[mob] ??= { hits: 0, damage: 0, maxHit: 0, contactMs: 0 };
    m.contactMs += ms;
  }

  recordFight(weapon: string | null, mob: string, outcome: { killed: boolean; elapsedMs: number }): void {
    const w = this.delta.weapons[`${weapon ?? 'hand'}|${mob}`] ??= { fights: 0, kills: 0, killMs: 0 };
    w.fights++;
    if (outcome.killed) { w.kills++; w.killMs += outcome.elapsedMs; }
  }

  flush(): void {
    if (!this.persistence) return;
    const pending = this.delta;
    if (!Object.keys(pending.mobs).length && !Object.keys(pending.weapons).length) return;
    this.delta = emptyCombatStats();
    try {
      this.persistence.save(pending);
      this.base = this.persistence.load();
    } catch (error) {
      // Keep the observations for the next attempt rather than lose them.
      this.delta = mergeCombatStats(pending, this.delta);
      throw error;
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.flush(); } catch { /* best effort at shutdown */ }
  }
}
