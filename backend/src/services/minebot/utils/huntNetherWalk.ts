import { Vec3 } from 'vec3';

/**
 * What the route planner knows of the Nether's ground beyond lava (S2, 2026-11-02; lava is given room by utils/lavaClearance).
 *
 * Soul sand slows the body to 40% of its pace (the game's speed factor of the block under the feet; soul soil does not slow it). A planner that prices a
 * step on soul sand like any other crosses a soul sand valley as if it were flat ground, and the valley is where skeletons and ghasts shoot at a body that
 * takes two and a half times as long to cross it. A step onto it costs what the time costs (1.5 more than a plain step: 2.5 times a block of time), so a way
 * round is taken when it is not much longer, and the valley is crossed when it is the only way. A cost, not a ban.
 */
export const SOUL_SAND_SLOWNESS = 0.4;
export const SOUL_SAND_COST = 1 / SOUL_SAND_SLOWNESS - 1;

interface SoulBot {
  registry?: { blocksByName?: Record<string, { minStateId?: number; maxStateId?: number } | undefined> };
  world?: { getBlockStateId?(position: Vec3): number };
}

/** For the navigator: the cost of a step whose destination cell (the feet) has soul sand under it. */
export function soulSandStepCost(bot: SoulBot): (block: { position?: { x: number; y: number; z: number } }) => number {
  const sand = bot.registry?.blocksByName?.soul_sand;
  const read = bot.world?.getBlockStateId;
  if (sand?.minStateId === undefined || sand.maxStateId === undefined || typeof read !== 'function') return () => 0;
  const at = new Vec3(0, 0, 0);
  return block => {
    const p = block?.position;
    if (!p) return 0;
    at.x = p.x; at.y = p.y - 1; at.z = p.z;
    let state = -1;
    try { state = read.call(bot.world, at); } catch { state = -1; }
    return state >= sand.minStateId! && state <= sand.maxStateId! ? SOUL_SAND_COST : 0;
  };
}
