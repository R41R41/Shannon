import { timeOfDayPart } from './CompanionBodyClient.js';
import type { BridgeExpression } from './expressionBridge.js';

/**
 * What happens to her Minecraft body, as closed game events for her mind (shannon-ios docs/minecraft-body-contract.md, phase 2; owner
 * 2026-10-26: 「出来事はコードで」「行動には感情を使わない」). Read from the bot's own state about once a second, beside everything else:
 * nothing here moves her, plans or waits, and nothing comes back. Her mind turns each event into a feeling; the body only shows a short
 * reflex face at once (`reflex`), then her mind's face again.
 *
 * - `game.hurt`: a hit of one heart or more (`strength`: the share of her health lost at once); small hits at most every 20 s.
 * - `game.danger`: in lava, burning, drowning (air low under water), falling fast, a creeper close, or three hostiles around her; each
 *   kind at most once a minute.
 * - `game.milestone`: the first iron, diamond and blaze rod since she came into the world (what she already carried does not count),
 *   the first entry to the Nether and the End, a Nether fortress in sight, the dragon's death. Each once per connection.
 * - `game.night_survived`: a night in the Overworld lived through (night turned to dawn while she was alive in it).
 * - `game.owner_near`: the owner came within a few blocks after being away from her for five minutes or more.
 */
export type GameMomentType = 'game.hurt' | 'game.danger' | 'game.milestone' | 'game.night_survived' | 'game.owner_near';
export interface GameMomentDetail { cause?: string; strength?: number }

interface MomentEntity {
  name?: string;
  type?: string;
  position?: { x: number; y: number; z: number; distanceTo?(other: unknown): number };
  velocity?: { y?: number };
  isInLava?: boolean;
  isInWater?: boolean;
  metadata?: unknown[];
}
export interface GameMomentBot {
  username?: string;
  health?: number;
  oxygenLevel?: number;
  entity?: MomentEntity | null;
  entities?: Record<string, MomentEntity> | null;
  players?: Record<string, { entity?: MomentEntity | null } | undefined> | null;
  game?: { dimension?: unknown } | null;
  time?: { timeOfDay?: unknown } | null;
  inventory?: { items(): Array<{ name: string; count: number }> };
  registry?: { blocksByName?: Record<string, { id: number } | undefined> };
  findBlock?(options: { matching: number; maxDistance: number }): unknown;
  on(event: 'health' | 'death' | 'spawn', listener: () => void): unknown;
  on(event: 'entityDead', listener: (entity: MomentEntity) => void): unknown;
  removeListener(event: 'health' | 'death' | 'spawn', listener: () => void): unknown;
  removeListener(event: 'entityDead', listener: (entity: MomentEntity) => void): unknown;
}

export const GAME_MOMENT_LIMITS = Object.freeze({
  everyMilliseconds: 1000,
  /** A hit below this many health points is not told; at or above `badHit` it is told at once. */
  smallHit: 2,
  badHit: 6,
  smallHitEveryMilliseconds: 20_000,
  badHitEveryMilliseconds: 5_000,
  dangerEveryMilliseconds: 60_000,
  /** Air (0..20) at or below this, under water, is drowning. */
  lowAir: 6,
  /** Falling faster than this (blocks per tick) is a fall that hurts. */
  fallSpeed: 0.9,
  creeperMeters: 3,
  hostileMeters: 6,
  hostiles: 3,
  ownerNearMeters: 6,
  ownerAwayMilliseconds: 5 * 60_000,
  /** How often a fortress is looked for in the Nether, and how far. */
  fortressEveryMilliseconds: 5_000,
  fortressMeters: 24,
});

/** The face her body shows at once for a moment, before her mind's face comes back. */
const REFLEX: Readonly<Partial<Record<GameMomentType, { expression: BridgeExpression; milliseconds: number }>>> = Object.freeze({
  'game.hurt': { expression: 'surprised', milliseconds: 1200 },
  'game.danger': { expression: 'surprised', milliseconds: 2000 },
});

const FIRST_ITEMS: ReadonlyArray<[string, readonly string[]]> = [
  ['first_iron', ['iron_ingot', 'raw_iron']], ['first_diamond', ['diamond']], ['blaze_rod', ['blaze_rod']],
];
const dimensionOf = (bot: GameMomentBot) => String(bot.game?.dimension ?? '').replace(/^minecraft:/u, '');
const distance = (a: MomentEntity['position'], b: MomentEntity['position']) =>
  a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Number.POSITIVE_INFINITY;
const burning = (entity: MomentEntity | null | undefined) => typeof entity?.metadata?.[0] === 'number' && ((entity.metadata[0] as number) & 0x01) === 1;

export function watchGameMoments(bot: GameMomentBot, options: {
  send(type: GameMomentType, detail?: GameMomentDetail): void;
  /** The body's reflex face for a moment (ExpressionMod); absent, none. */
  reflex?(expression: BridgeExpression, milliseconds: number): void;
  /** The owner's player name in this world (`Rai1241`), or undefined when unknown (then `game.owner_near` is never sent). */
  ownerName(): string | undefined;
  now?: () => number;
  setTimer?: (work: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (timer: ReturnType<typeof setInterval>) => void;
}): { dispose(): void; check(): void } {
  const now = options.now ?? (() => Date.now());
  let health = typeof bot.health === 'number' ? bot.health : undefined;
  const last = new Map<string, number>();
  const told = new Set<string>();
  // What she carried when she came in is not a first.
  let carried: Set<string> | null = null;
  let dimension = dimensionOf(bot);
  let nightAlive = false;
  let lastPart: string | undefined;
  let ownerLastNear = Number.NEGATIVE_INFINITY;
  let ownerWasNear = false;
  let started = now();
  let fortressAt = Number.NEGATIVE_INFINITY;

  const send = (type: GameMomentType, detail?: GameMomentDetail) => {
    try {
      const reflex = REFLEX[type];
      if (reflex) options.reflex?.(reflex.expression, reflex.milliseconds);
      options.send(type, detail);
    } catch { /* her feeling never stops her body */ }
  };
  const due = (key: string, every: number) => {
    const at = now();
    if (at - (last.get(key) ?? Number.NEGATIVE_INFINITY) < every) return false;
    last.set(key, at);
    return true;
  };
  const milestone = (kind: string) => {
    if (told.has(kind)) return;
    told.add(kind);
    send('game.milestone', { cause: `milestone:${kind}` });
  };

  const onHealth = () => {
    const now_ = typeof bot.health === 'number' ? bot.health : undefined;
    if (now_ === undefined) return;
    const lost = health === undefined ? 0 : health - now_;
    health = now_;
    if (now_ <= 0 || lost < GAME_MOMENT_LIMITS.smallHit) return;
    const bad = lost >= GAME_MOMENT_LIMITS.badHit;
    if (!due(bad ? 'hurt:bad' : 'hurt', bad ? GAME_MOMENT_LIMITS.badHitEveryMilliseconds : GAME_MOMENT_LIMITS.smallHitEveryMilliseconds)) return;
    send('game.hurt', { strength: Math.round(Math.min(1, lost / 20) * 100) / 100 });
  };
  const onDeath = () => { nightAlive = false; health = undefined; };
  const onSpawn = () => { health = typeof bot.health === 'number' ? bot.health : undefined; };
  const onEntityDead = (entity: MomentEntity) => { if (entity?.name === 'ender_dragon') milestone('dragon_killed'); };

  const danger = (kind: string) => { if (due(`danger:${kind}`, GAME_MOMENT_LIMITS.dangerEveryMilliseconds)) send('game.danger', { cause: `danger:${kind}` }); };

  const check = () => {
    try {
      const self = bot.entity;
      if (!self?.position || (bot.health ?? 0) <= 0) return;
      // Dangers, by what her body is in now.
      if (self.isInLava) danger('lava');
      else if (burning(self)) danger('fire');
      if (self.isInWater && typeof bot.oxygenLevel === 'number' && bot.oxygenLevel <= GAME_MOMENT_LIMITS.lowAir) danger('drown');
      if (typeof self.velocity?.y === 'number' && self.velocity.y < -GAME_MOMENT_LIMITS.fallSpeed) danger('fall');
      const around = Object.values(bot.entities ?? {}).filter(entity => entity !== self && entity?.position);
      if (around.some(entity => entity.name === 'creeper' && distance(entity.position, self.position) <= GAME_MOMENT_LIMITS.creeperMeters)) danger('explosion');
      if (around.filter(entity => entity.type === 'hostile' && distance(entity.position, self.position) <= GAME_MOMENT_LIMITS.hostileMeters).length
        >= GAME_MOMENT_LIMITS.hostiles) danger('mob');

      // Firsts: things she did not carry when she came in, a new dimension, a fortress in sight.
      const names = new Set((bot.inventory?.items() ?? []).map(item => item.name));
      if (!carried) carried = names;
      else for (const [kind, items] of FIRST_ITEMS) if (items.some(item => names.has(item) && !carried!.has(item))) milestone(kind);
      const where = dimensionOf(bot);
      if (where !== dimension) {
        if (where === 'the_nether') milestone('nether_entered');
        if (where === 'the_end') milestone('end_entered');
        dimension = where;
      }
      if (where === 'the_nether' && !told.has('fortress_found') && now() - fortressAt >= GAME_MOMENT_LIMITS.fortressEveryMilliseconds) {
        fortressAt = now();
        const bricks = bot.registry?.blocksByName?.nether_bricks?.id;
        if (bricks !== undefined && bot.findBlock?.({ matching: bricks, maxDistance: GAME_MOMENT_LIMITS.fortressMeters })) milestone('fortress_found');
      }

      // A night lived through in the Overworld.
      const ticks = bot.time?.timeOfDay;
      const part = typeof ticks === 'number' ? timeOfDayPart(ticks) : undefined;
      if (where === 'overworld' && part === 'night') nightAlive = true;
      if (nightAlive && lastPart === 'night' && part === 'dawn') { nightAlive = false; send('game.night_survived'); }
      if (where !== 'overworld') nightAlive = false;
      lastPart = part;

      // The owner come near after being away from her.
      const owner = options.ownerName();
      const near = !!owner && distance(bot.players?.[owner]?.entity?.position, self.position) <= GAME_MOMENT_LIMITS.ownerNearMeters;
      const at = now();
      if (near && !ownerWasNear && at - Math.max(ownerLastNear, started) >= GAME_MOMENT_LIMITS.ownerAwayMilliseconds) send('game.owner_near');
      if (near) ownerLastNear = at;
      ownerWasNear = near;
    } catch { /* a read that fails is skipped; the next second reads again */ }
  };

  bot.on('health', onHealth);
  bot.on('death', onDeath);
  bot.on('spawn', onSpawn);
  bot.on('entityDead', onEntityDead);
  const timer = (options.setTimer ?? ((work, ms) => setInterval(work, ms)))(check, GAME_MOMENT_LIMITS.everyMilliseconds);
  (timer as { unref?: () => void }).unref?.();
  started = now();
  return {
    check,
    dispose: () => {
      (options.clearTimer ?? (value => clearInterval(value)))(timer);
      bot.removeListener('health', onHealth);
      bot.removeListener('death', onDeath);
      bot.removeListener('spawn', onSpawn);
      bot.removeListener('entityDead', onEntityDead);
    },
  };
}
