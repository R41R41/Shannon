import { lifeOf } from './life.js';

/**
 * The blows the body took, as the server named them (amendment A-4): the observation's `state.combat.recentHits`, one entry per `damage_event` aimed at the body,
 * `{ at, attackerId, attackerType, damage, life }`, the last 10 seconds, 20 at most. The head used to estimate the fight from the fall of health and counted two
 * blows in one frame as one. `damage` is the fall of health that the next health update brought, shared among the blows that were waiting for it (0 when
 * nothing fell: armour, a shield); the server's own packet carries no amount.
 */
export const HIT_WINDOW_MS = 10_000;
export const HIT_MAX = 20;
/** A blow whose health update never came is closed with 0 after this long. */
const SETTLE_MS = 1_500;

export interface RecentHit { at: string; attackerId: number | null; attackerType: string; damage: number; life: number }
interface Pending { hit: RecentHit; at: number }
interface HitBot {
  entity?: { id?: number };
  entities?: Record<string, { name?: string | null; type?: string | null } | undefined>;
  health?: number;
  _client?: { on?(event: string, listener: (packet: any) => void): unknown };
  on?(event: string, listener: (...args: any[]) => void): unknown;
}
export class HitRecord {
  private hits: Array<{ hit: RecentHit; at: number }> = [];
  private pending: Pending[] = [];
  private lastHealth: number | null;
  constructor(private readonly bot: HitBot, private readonly now: () => number = Date.now) {
    this.lastHealth = typeof bot.health === 'number' ? bot.health : null;
    try { bot._client?.on?.('damage_event', (packet: any) => this.onDamage(packet)); } catch { /* a body without the packet */ }
    try { bot.on?.('health', () => this.onHealth()); } catch { /* the same */ }
  }
  private onDamage(packet: { entityId?: number; sourceCauseId?: number; sourceDirectId?: number }): void {
    if (!this.bot.entity || packet?.entityId !== this.bot.entity.id) return;
    const cause = Number(packet.sourceCauseId ?? 0), direct = Number(packet.sourceDirectId ?? 0);
    const id = cause > 0 ? cause - 1 : direct > 0 ? direct - 1 : null;
    const t = this.now();
    const entity = id === null ? undefined : this.bot.entities?.[id];
    const hit: RecentHit = { at: new Date(t).toISOString(), attackerId: id, attackerType: String(entity?.name ?? entity?.type ?? 'unknown'), damage: 0, life: lifeOf(this.bot)?.number ?? 0 };
    this.hits.push({ hit, at: t });
    this.pending.push({ hit, at: t });
    this.trim(t);
  }
  private onHealth(): void {
    const health = this.bot.health;
    if (typeof health !== 'number') return;
    const drop = this.lastHealth === null ? 0 : this.lastHealth - health;
    this.lastHealth = health;
    if (drop > 0 && this.pending.length) {
      const share = Math.round((drop / this.pending.length) * 10) / 10;
      for (const entry of this.pending) entry.hit.damage = share;
      this.pending = [];
    }
  }
  private trim(t: number): void {
    this.hits = this.hits.filter(entry => t - entry.at <= HIT_WINDOW_MS).slice(-HIT_MAX);
    this.pending = this.pending.filter(entry => t - entry.at <= SETTLE_MS);
  }
  recent(): RecentHit[] {
    this.trim(this.now());
    return this.hits.map(entry => ({ ...entry.hit }));
  }
}
const records = new WeakMap<object, HitRecord>();
export function installHitRecord(bot: HitBot, now?: () => number): HitRecord {
  const existing = records.get(bot);
  if (existing) return existing;
  const made = new HitRecord(bot, now);
  records.set(bot, made);
  return made;
}
export function recentHitsOf(bot: object): RecentHit[] { return records.get(bot)?.recent() ?? []; }
