import { digRefusedAt, noteRefusedDig } from './refusedDigs.js';
import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { isLikelyHostileMobName } from './hostileMobHints.js';
import { exposedByOpening } from './threatExposure.js';

const log = createLogger('Minebot:ExposureGuard');

/** How far a hostile counts when nothing has said otherwise (the emergency layer's own radius, when it has set one). */
const DEFAULT_RADIUS = 16;
/** No more than this many of the nearest shut-out hostiles are looked at for one dig. */
const NEAREST = 4;

interface GuardBody {
  entity?: { position: Vec3; id?: number; isInWater?: boolean };
  entities?: Record<string, any>;
  oxygenLevel?: number;
  blockAt?(position: Vec3, extra?: boolean): any;
  dig?: (block: any, ...rest: any[]) => Promise<unknown>;
  /** Set by the emergency layer: how near a hostile has to be to be a threat (farther for kinds that have hit from afar). */
  hostileThreatRadius?: () => number;
  exposureDigGuard?: { enabled: boolean; refused: number; last?: string };
}

/** A dig refused because it would open a way to the body for a hostile that has none. */
export class ThreatExposedError extends Error {
  readonly failureType = 'threat_exposed';
  constructor(block: { name?: string; position: Vec3 }, readonly threat: { name: string; distance: number }) {
    super(`掘削中止: ${block.name ?? 'ブロック'}(${block.position.x}, ${block.position.y}, ${block.position.z})を開けると、`
      + `いまは届かない${threat.name}（約${threat.distance.toFixed(0)}m）から身体が見える・届くようになります。`
      + '離れるのを待つ（wait-time）か、その敵のいない向きへ掘り進んでから出てください');
    this.name = 'ThreatExposedError';
  }
}

/**
 * The hostile that breaking the block at `target` would let at the body, or
 * null. A body that has shut itself in is safe for as long as the walls
 * stand, and nothing told the rest of the system so: with the emergency over
 * ("nothing can reach the body"), the task it went back to dug the roof off
 * to go on with its work, the mobs that had been shut out were on it within a
 * second, and it shut itself in again, five times over in five minutes (paid
 * run L72; L70 died the same way). Lava behind a block is treated the same:
 * the dig is what lets it in.
 *
 * Not applied to a block the body itself is buried in, or while it is short
 * of air: getting out to breathe comes first.
 */
export function threatExposedBy(bot: GuardBody, target: Vec3): { name: string; distance: number } | null {
  const self = bot.entity?.position;
  if (!self || typeof bot.blockAt !== 'function') return null;
  const feet = self.floored();
  if (target.x === feet.x && target.z === feet.z && (target.y === feet.y || target.y === feet.y + 1)) return null;
  if (bot.entity?.isInWater === true && (bot.oxygenLevel ?? 20) < 20) return null;
  const radius = Math.max(1, bot.hostileThreatRadius?.() ?? DEFAULT_RADIUS);
  const near = Object.values(bot.entities ?? {})
    .filter((entity: any) => entity && entity !== bot.entity && entity.id !== bot.entity?.id && entity.position
      && isLikelyHostileMobName(String(entity.name ?? '')))
    .map((entity: any) => ({ entity, distance: self.distanceTo(entity.position) }))
    .filter(entry => entry.distance <= radius)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, NEAREST);
  if (!near.length) return null;
  const let_in = exposedByOpening(bot as any, near.map(entry => entry.entity), target);
  if (!let_in.length) return null;
  const first = near.find(entry => let_in.includes(entry.entity))!;
  return { name: String(first.entity.name), distance: first.distance };
}

/** Throws when breaking `block` would let a shut-out hostile at the body; counts the refusal on the body. */
export function assertNoThreatExposure(bot: GuardBody, block: { name?: string; position: Vec3 } | null | undefined): void {
  if (!block?.position || bot.exposureDigGuard?.enabled === false) return;
  let threat: { name: string; distance: number } | null = null;
  try { threat = threatExposedBy(bot, block.position); } catch { threat = null; }
  if (!threat) return;
  const error = new ThreatExposedError(block, threat);
  if (bot.exposureDigGuard) { bot.exposureDigGuard.refused++; bot.exposureDigGuard.last = error.message; }
  // The mob moves on: the route planner leaves this block alone for a quarter of a minute, then may ask again.
  const repeated = digRefusedAt(bot, block.position);
  noteRefusedDig(bot, block.position, 15_000);
  if (repeated) throw error; // said once; the same block asked again within the time is refused quietly
  log.warn(`🧱 ${error.message}`);
  throw error;
}

/** Every dig, whoever asks for it, is checked for whom it would let in (see threatExposedBy). */
export function installExposureDigGuard(bot: GuardBody): void {
  const dig = bot.dig?.bind(bot);
  if (!dig || bot.exposureDigGuard) return;
  bot.exposureDigGuard = { enabled: true, refused: 0 };
  bot.dig = async (block: any, ...rest: any[]) => {
    assertNoThreatExposure(bot, block);
    return dig(block, ...rest);
  };
}

export function exposureDigGuardPlugin(bot: unknown): void { installExposureDigGuard(bot as GuardBody); }
