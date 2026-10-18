import { CONTACT_DISTANCE, shootsAtBody } from '../../../modules/minecraftLearning/index.js';
import { EncounterMemory } from '../learning/EncounterMemory.js';
import { isHostileEntity, noteAttackedBy } from './hostileMobHints.js';
import { emergencyClearanceRadius, type NamedHit } from './threatRadius.js';

/**
 * What the body knows of what hurts it, for the parts that read it (P8, 2026-10-17): the observation's `margin.hitsLeft` (how many
 * more hits of the hardest hitter it can take), the shield reflex (which kinds shoot at it), the dig guard's threat radius.
 * The legacy EventReactionSystem set these up in `initialize()` together with its whole emergency machinery; the common-FCA body
 * does not start that, so they were never there. This is only the part that reads: it records and answers, it never decides, and
 * it imports neither the task runtime nor the event reaction system (a test holds that).
 *
 * Not set here, on purpose: `fightFavoured` (the legacy emergency mode's refusal check; the API chooses to fight) and
 * `recentInterruptions` (the reflex ledger's `reflexes` says what happened, and two reports would say it twice).
 * Observations start from the human priors and are not kept across a restart.
 *
 * The dig guard's threat radius is the legacy emergency clearance radius, rule for rule (`threatRadius.ts`): 16 by default, and
 * farther for a kind measured to hit from afar, a hostile on its way, or the hit that has just landed.
 *
 * A mob the server names as the cause of a hit becomes hostile to the body for five minutes, listed or not (`noteAttackedBy`),
 * exactly as the legacy system did in its own `entityHurt` handler: a wolf, a bee, a golem or a piglin that has hit the body is
 * counted among `nearbyThreats`, the dig guard's hostiles and the goal checks until the memory fades. That memory is module-wide, so
 * it is one more thing `MINEBOT_FCA_REFLEX_OFF=combat` removes together with the providers.
 */
const CONTACT_SAMPLE_MS = 500;
const ATTRIBUTION_WINDOW_MS = 500;

interface KnowledgeEntity { id?: number; name?: string; type?: string; position?: { distanceTo(other: unknown): number }; metadata?: unknown[] }
export interface KnowledgeBot {
  entity?: KnowledgeEntity & { position: { distanceTo(other: unknown): number } };
  entities?: Record<string, KnowledgeEntity | undefined>;
  health?: number;
  registry?: unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once?(event: string, listener: (...args: any[]) => void): unknown;
  _client?: { on?(event: string, listener: (packet: any) => void): unknown };
  combatStats?: () => unknown;
  shotAtBy?: (kind: string) => void;
  shootsAtBody?: (kind: string) => boolean;
  hostileThreatRadius?: () => number;
}

export function installCombatKnowledge(bot: KnowledgeBot, options: { memory?: EncounterMemory; now?: () => number } = {}): EncounterMemory | null {
  if (bot.combatStats) return null;
  const memory = options.memory ?? new EncounterMemory();
  const now = options.now ?? Date.now;
  let lastHurt: { at: number; source: string | null; from?: number } | null = null;
  let lastNamedHit: NamedHit | null = null;
  let lastBlow: { at: number; cause: string } | null = null;
  let lastHealth: number | null = typeof bot.health === 'number' ? bot.health : null;

  bot.combatStats = () => memory.stats();
  bot.hostileThreatRadius = () => { try { return emergencyClearanceRadius(bot as any, memory.stats(), lastNamedHit, now()); } catch { return 16; } };
  bot.shotAtBy = kind => { try { memory.recordShot(String(kind).toLowerCase()); } catch { /* a count */ } };
  bot.shootsAtBody = kind => { try { return shootsAtBody(memory.stats(), String(kind).toLowerCase()); } catch { return false; } };

  const hostilesAround = (radius: number) => {
    const self = bot.entity; if (!self) return [];
    return Object.values(bot.entities ?? {})
      .filter((entity): entity is KnowledgeEntity => !!entity && entity !== self && entity.id !== self.id && !!entity.position
        && entity.type !== 'player' && isHostileEntity(entity as any, bot as any))
      .map(entity => ({ name: String(entity.name).toLowerCase(), distance: self.position.distanceTo(entity.position) }))
      .filter(entry => entry.distance <= radius)
      .sort((a, b) => a.distance - b.distance);
  };
  const likelyAttacker = () => {
    const near = hostilesAround(24);
    return (near.find(entry => entry.distance <= CONTACT_DISTANCE + 0.5) ?? near[0])?.name ?? null;
  };

  // The second argument (the damage source) is newer than the event's typing.
  bot.on('entityHurt', (entity: KnowledgeEntity | undefined, source: KnowledgeEntity | undefined) => {
    if (!entity || entity.id !== bot.entity?.id) return;
    let from: number | undefined;
    try { if (source?.position && bot.entity) from = bot.entity.position.distanceTo(source.position); } catch { from = undefined; }
    // A player's blow is not a mob's: it is never counted as what a kind of mob does (and so never guessed at either).
    lastHurt = { at: now(), source: source?.name && source.type !== 'player' ? String(source.name).toLowerCase() : null, from };
    lastNamedHit = { at: now(), source: source?.name ? String(source.name).toLowerCase() : null, from };
    // A mob the server names as the cause of a hit is hostile to the body for a while, listed or not.
    if (source?.name && source.type !== 'player' && source.type !== 'projectile' && source.type !== 'object') noteAttackedBy(String(source.name));
  });
  bot._client?.on?.('damage_event', (packet: any) => {
    if (packet?.entityId !== bot.entity?.id) return;
    const cause = bot.entities?.[packet.sourceCauseId - 1], direct = bot.entities?.[packet.sourceDirectId - 1];
    if (cause?.name && cause.type !== 'player' && direct === cause) lastBlow = { at: now(), cause: String(cause.name).toLowerCase() };
  });
  // A hit with no named cause (a fall, drowning) belongs to no mob: the nearest hostile is guessed only when nothing was named.
  bot.on('health', () => {
    const health = bot.health ?? 20, previous = lastHealth;
    lastHealth = health;
    if (previous === null || health >= previous || health <= 0) return;
    const at = now(), hurt = lastHurt && at - lastHurt.at < ATTRIBUTION_WINDOW_MS ? lastHurt : null;
    const attacker = hurt ? hurt.source : likelyAttacker();
    if (!attacker) return;
    const ownBlow = !!lastBlow && at - lastBlow.at < ATTRIBUTION_WINDOW_MS && lastBlow.cause === attacker;
    memory.recordHit(attacker, previous - health, hurt?.source === attacker ? hurt.from : undefined, ownBlow);
  });
  const sampler = setInterval(() => {
    try { for (const entry of hostilesAround(CONTACT_DISTANCE)) memory.recordContact(entry.name, CONTACT_SAMPLE_MS); } catch { /* a count */ }
  }, CONTACT_SAMPLE_MS);
  sampler.unref?.();
  bot.once?.('end', () => { clearInterval(sampler); memory.dispose(); });
  return memory;
}

/** mineflayer plugin form. */
export function combatKnowledgePlugin(bot: unknown): void { installCombatKnowledge(bot as KnowledgeBot); }
