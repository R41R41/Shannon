/**
 * A creeper fought with a sword, in armour: close in, strike once (the blow throws it back), step back out of its blast, strike again.
 *
 * Run 24: a body in a whole set of iron with an iron sword was cut off from its work three times by "flee from the creeper", and the
 * dig guard turned down every wall the creeper could see through, 111 s on a walk of 76 m. A creeper is not fought hand to hand bare
 * (utils/creeperFuse: closing in is what lights it, and a blast takes most of the health of an unarmoured body); in iron all round, with a
 * sword and the health, one creeper that is not lit is a few blows and a few steps back. The conditions are the mind's as well
 * (`creeperDuelAllowed`): a weapon, three pieces of iron or better, health 14, one creeper in sight and not lit.
 */
import { Vec3 } from 'vec3';
import { creeperLit } from './creeperFuse.js';
import { actionDelay } from '../execution/observedWait.js';

export const DUEL_MIN_HEALTH = 14;
export const DUEL_MIN_PIECES = 3;
/** A blow reaches 3 blocks; the blast of a creeper that lit reaches about 3 and begins at 1.5 s. */
const STRIKE_RANGE = 2.9;
const SWORD_COOLDOWN_MS = 650;
const TICK_MS = 50;
const SEEN_WITHIN = 24;

interface Item { name?: string }
export interface DuelBody {
  entity?: { position: Vec3; height?: number };
  entities?: Record<string, { id?: number; name?: string; position: Vec3; height?: number; metadata?: unknown[] } | undefined>;
  health?: number;
  heldItem?: Item | null;
  inventory?: { items(): Item[]; slots?: Array<Item | null | undefined> };
  attack?(entity: unknown): unknown;
  lookAt?(point: Vec3, force?: boolean): Promise<unknown>;
  look?(yaw: number, pitch: number, force?: boolean): Promise<unknown> | unknown;
  setControlState(control: string, state: boolean): void;
  equip?(item: unknown, destination: string): Promise<unknown>;
  creeperDuel?: boolean;
}

const WEAPON = /_(sword|axe)$/u;
const GOOD_ARMOUR = /^(iron|diamond|netherite)_(helmet|chestplate|leggings|boots)$/u;

/** Pieces of iron or better worn (0 to 4). */
export function goodArmourPieces(bot: DuelBody): number {
  const slots = bot.inventory?.slots;
  if (!Array.isArray(slots)) return 0;
  return [5, 6, 7, 8].filter(index => GOOD_ARMOUR.test(slots[index]?.name ?? '')).length;
}

/** The weapon to strike with: the best sword or axe carried (netherite, diamond, iron, stone...), or null. */
export function duelWeapon(bot: DuelBody): Item | null {
  const rank = (name: string) => ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'].findIndex(material => name.startsWith(`${material}_`));
  const carried = [...(bot.inventory?.items() ?? []), ...(bot.heldItem ? [bot.heldItem] : [])].filter(item => WEAPON.test(item.name ?? ''));
  carried.sort((a, b) => (/_sword$/u.test(b.name ?? '') ? 1 : 0) - (/_sword$/u.test(a.name ?? '') ? 1 : 0) || rank(a.name ?? '') - rank(b.name ?? ''));
  return carried[0] ?? null;
}

/** The creepers in sight within SEEN_WITHIN blocks, nearest first. */
function creepersNear(bot: DuelBody) {
  const at = bot.entity?.position;
  if (!at) return [];
  return Object.values(bot.entities ?? {}).filter((entity): entity is NonNullable<typeof entity> => !!entity && entity.name === 'creeper' && !!entity.position)
    .map(entity => ({ entity, distance: entity.position.distanceTo(at) })).filter(entry => entry.distance <= SEEN_WITHIN).sort((a, b) => a.distance - b.distance);
}

/** Whether a creeper may be fought: why not, in the words of the refusal, or null when it may. */
export function creeperDuelRefusal(bot: DuelBody): string | null {
  if (!duelWeapon(bot)) return '剣か斧を持っていません';
  const pieces = goodArmourPieces(bot);
  if (pieces < DUEL_MIN_PIECES) return `鉄以上の防具が${pieces}つしかありません（${DUEL_MIN_PIECES}つ以上）`;
  if ((bot.health ?? 20) < DUEL_MIN_HEALTH) return `体力が${(bot.health ?? 20).toFixed(0)}しかありません（${DUEL_MIN_HEALTH}以上）`;
  const creepers = creepersNear(bot);
  if (creepers.length === 0) return `${SEEN_WITHIN}m以内にクリーパーが見えません`;
  if (creepers.length > 1) return `クリーパーが${creepers.length}匹います（1匹だけ）`;
  if (creeperLit(creepers[0].entity)) return '点火しています（離れる）';
  return null;
}

export interface DuelOutcome {
  outcome: 'killed' | 'gone' | 'lit' | 'hurt' | 'timeout' | 'interrupted';
  blows: number;
  backOffs: number;
  healthBefore: number;
  healthAfter: number;
}

const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * The fight itself. The body steps away on its own when the fuse is lit (a second from the blast it does not wait for the floor
 * reflex), and ends when the creeper is gone, the health is below 10, or `deadlineMs` is over. While it lasts `bot.creeperDuel` is true: the
 * floor's step back from a lit creeper (utils/floorReflexes) leaves the body to this loop.
 */
export async function duelCreeper(bot: DuelBody, options: { shouldStop?: () => boolean; deadlineMs?: number } = {}): Promise<DuelOutcome> {
  const started = Date.now();
  const deadline = started + (options.deadlineMs ?? 25_000);
  const result: DuelOutcome = { outcome: 'timeout', blows: 0, backOffs: 0, healthBefore: bot.health ?? 20, healthAfter: bot.health ?? 20 };
  let target: { id?: number } | null = null;
  let lastBlowAt = 0;
  const weapon = duelWeapon(bot);
  if (weapon && bot.heldItem?.name !== weapon.name) { try { await bot.equip?.(weapon, 'hand'); } catch { /* struck with what is held */ } }
  bot.creeperDuel = true;
  const release = () => { for (const key of ['forward', 'back', 'sprint', 'left', 'right', 'jump']) bot.setControlState(key, false); };
  try {
    while (Date.now() < deadline) {
      if (options.shouldStop?.()) { result.outcome = 'interrupted'; break; }
      const near = creepersNear(bot);
      const here = bot.entity?.position;
      if (!here) { result.outcome = 'interrupted'; break; }
      const chosen: (typeof near)[number] | undefined = (target && near.find(entry => entry.entity.id === target!.id)) || near[0];
      if (!chosen) { result.outcome = result.blows > 0 ? 'killed' : 'gone'; break; }
      target = chosen.entity;
      if ((bot.health ?? 20) < 10) { result.outcome = 'hurt'; break; }
      const creeper = chosen.entity;
      const distance = horizontal(creeper.position, here);
      const lit = creeperLit(creeper);
      // Face away and run: out of the blast when it is lit (and not at once back in: it is let to cool), or one step back after a blow.
      const stepBack = async (ms: number) => {
        result.backOffs++;
        await bot.look?.(Math.atan2(here.x - creeper.position.x, here.z - creeper.position.z) + Math.PI, 0, true);
        bot.setControlState('back', false); bot.setControlState('forward', true); bot.setControlState('sprint', true);
        await actionDelay(bot as never, ms);
        release();
      };
      if (lit && distance < 6) { await stepBack(450); continue; }
      if (distance > STRIKE_RANGE) {
        await bot.lookAt?.(creeper.position.offset(0, (creeper.height ?? 1.7) * 0.5, 0), true);
        bot.setControlState('forward', true); bot.setControlState('sprint', true);
        await actionDelay(bot as never, TICK_MS * 2);
        continue;
      }
      release();
      await bot.lookAt?.(creeper.position.offset(0, (creeper.height ?? 1.7) * 0.5, 0), true);
      if (Date.now() - lastBlowAt >= SWORD_COOLDOWN_MS) {
        bot.attack?.(creeper);
        result.blows++; lastBlowAt = Date.now();
        // The blow throws it back; the body steps back too, out of the reach of the blast, before the next.
        await actionDelay(bot as never, 120);
        if (creeper.id !== undefined && bot.entities?.[creeper.id]) await stepBack(350);
      } else await actionDelay(bot as never, TICK_MS * 2);
    }
  } finally {
    release();
    bot.creeperDuel = false;
    result.healthAfter = bot.health ?? result.healthBefore;
  }
  return result;
}
