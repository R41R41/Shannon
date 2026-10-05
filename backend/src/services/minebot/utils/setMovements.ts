import minecraftData from 'minecraft-data';
import { Bot } from 'mineflayer';
import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { serverRefusalStepCost } from './serverRefusals.js';
import { refusedDigBreakCost } from './refusedDigs.js';
import { lavaBesideStepCost } from './lavaClearance.js';
import { CustomBot } from '../types.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';
const { Movements } = pathfinder;

/** What one block dug without a pickaxe may cost the route planner at most (see setMovements). */
const HAND_DIG_LABOUR_CAP = 30;

/**
 * mineflayer-pathfinder's parkour jumps a 1-3 block gap after checking only
 * the landing block, never how deep the gap is. A jump that falls short
 * (server lag, a low ceiling) then drops the bot into whatever is below: a
 * paid run fell 26 blocks through a gap in a one-block cave floor. Keep only
 * jumps whose gap would be a survivable drop, the same bound the planner
 * already applies to deliberate drops (maxDropDown); water below breaks a fall.
 */
/** Blocks with no body to them that hurt whoever stands in them. */
export const HARMFUL_TO_STAND_IN = ['fire', 'soul_fire', 'sweet_berry_bush', 'wither_rose', 'powder_snow'];

export function installSafeParkour(movements: any, maxDrop: number): void {
  const original = movements.getMoveParkourForward?.bind(movements);
  if (!original || movements.__safeParkour) return;
  movements.__safeParkour = true;
  movements.getMoveParkourForward = (node: any, dir: { x: number; z: number }, neighbors: any[]) => {
    const candidates: any[] = [];
    original(node, dir, candidates);
    for (const move of candidates) {
      const distance = Math.max(Math.abs(move.x - node.x), Math.abs(move.z - node.z));
      let survivable = true;
      for (let d = 1; d < distance && survivable; d++) survivable = gapDrop(movements, node, dir.x * d, dir.z * d, maxDrop) <= maxDrop;
      if (survivable) neighbors.push(move);
    }
  };
}

const CARDINALS = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];

/**
 * A body floating at the surface climbs onto a bank level with the water:
 * swimming up against it gives the push out of the liquid. The navigator
 * does not know this. It measures a jump from the block under the feet, which
 * over deep water is more water one block further down, so the bank counts as
 * two blocks high and "too high to jump"; and a block that touches water may
 * not be dug. From deep water there was therefore no route onto any shore at
 * all: a 32-block swim to an open bank came back unreachable after three
 * seconds of search (lab), and in paid run L32 the body went east and west
 * along partial routes for ninety seconds beside a lake it could have left.
 * This adds the one move the body has and the model lacked.
 */
export function installSwimOut(movements: any): void {
  const original = movements.getNeighbors?.bind(movements);
  if (!original || movements.__swimOut) return;
  movements.__swimOut = true;
  movements.getNeighbors = (node: any) => {
    const neighbors: any[] = original(node);
    // Floating at the surface over water: feet in liquid, air overhead, no floor to jump from.
    if (!movements.getBlock(node, 0, 0, 0).liquid || movements.getBlock(node, 0, -1, 0).physical) return neighbors;
    const overhead = movements.getBlock(node, 0, 1, 0);
    if (overhead.liquid || !overhead.safe || !movements.getBlock(node, 0, 2, 0).safe) return neighbors;
    for (const dir of CARDINALS) {
      const bank = movements.getBlock(node, dir.x, 0, dir.z);
      if (!bank.physical || bank.height - node.y > 1) continue;
      if (!movements.getBlock(node, dir.x, 1, dir.z).safe || !movements.getBlock(node, dir.x, 2, dir.z).safe) continue;
      const x = node.x + dir.x, y = node.y + 1, z = node.z + dir.z;
      if (neighbors.some(move => move.x === x && move.y === y && move.z === z && move.toPlace.length === 0 && move.toBreak.length === 0)) continue;
      neighbors.push(Object.assign(new Vec3(x, y, z), { remainingBlocks: node.remainingBlocks, cost: 2 + (movements.liquidCost ?? 1),
        toBreak: [], toPlace: [], parkour: false, hash: `${x},${y},${z}` }));
    }
    return neighbors;
  };
}

/**
 * Blocks a bot would fall through below a gap cell before landing: water at
 * any depth breaks the fall (0), a solid landing counts its height, and lava,
 * the void or a landing past the bound is Infinity.
 */
function gapDrop(movements: any, node: any, dx: number, dz: number, bound: number): number {
  for (let depth = 1; depth <= 64; depth++) {
    const block = movements.getBlock(node, dx, -depth, dz);
    if (!block) return Infinity;
    if (block.liquid) return block.safe ? 0 : Infinity;
    if (block.physical) return depth - 1 <= bound ? depth - 1 : Infinity;
  }
  return Infinity;
}

export function setMovements(
  bot: CustomBot,
  allow1by1towers = false,
  allowSprinting = true,
  allowParkour = true,
  canOpenDoors = true,
  canDig = true,
  dontMineUnderFallingBlock = true,
  digCost = 1,
  allowFreeMotion = false,
  canSwim = true,
  /** pathfinder の落下許容（大きいと崖を「降りる」経路を取りやすい）。逃走系は 1〜2 推奨 */
  maxDropDown = 4,
  /** 液体ブロックを通る経路のコスト。高いほど水を避ける。デフォルト10で陸上を強く優先 */
  liquidCost = 10,
  /**
   * Whether a route may stop to lay blocks (a bridge over a gap or water, a step up a bank). Laying a bridge
   * block the path executor crouches and backs to the edge: about a block a second. An escape with a pursuer
   * near is not to do that: in paid run L110 it did, over four seconds, and a creeper closed to the body.
   */
  canPlace = true
) {
  const mcData = minecraftData(bot.version);
  const defaultMove = new Movements(bot as Bot);
  defaultMove.allow1by1towers = allow1by1towers;
  // Ordinary travel keeps the pace the planner chose (set-movement-pace);
  // an emergency escape or fight always sprints.
  const calm = !String((bot as { minebotControlState?: string }).minebotControlState ?? '').startsWith('emergency');
  defaultMove.allowSprinting = allowSprinting && !(calm && (bot as { movementPace?: string }).movementPace === 'walk');
  defaultMove.allowParkour = allowParkour;
  defaultMove.canOpenDoors = canOpenDoors;
  defaultMove.canDig = canDig;
  defaultMove.dontMineUnderFallingBlock = dontMineUnderFallingBlock;
  defaultMove.digCost = digCost;
  defaultMove.allowFreeMotion = allowFreeMotion;
  (defaultMove as any).liquidCost = liquidCost;

  const cantBreak = new Set<number>(defaultMove.blocksCantBreak);
  // 保護対象ブロック（チェスト・かまど・作業台・ベッド等）を壊さない
  for (const name of PROTECTED_UTILITY_BLOCKS) {
    const block = mcData.blocksByName[name];
    if (block) cantBreak.add(block.id);
  }
  // A route or item pickup must not dismantle a functioning farm. Explicit
  // harvest/dig skills remain available; this only restricts incidental digs.
  for (const name of ['farmland', 'wheat', 'carrots', 'potatoes', 'beetroots',
    'nether_wart', 'cocoa', 'sweet_berry_bush', 'melon_stem', 'pumpkin_stem',
    'attached_melon_stem', 'attached_pumpkin_stem']) {
    const block = mcData.blocksByName[name];
    if (block) cantBreak.add(block.id);
  }
  // Nor a spawner: what the body may have come for (a blaze spawner is where rods come from) and no way through
  // anything. Fetching a rod from inside the cage built beside one, the route's first dig was the spawner
  // (paid run L77aa; only a blaze on the far side stopped it). An explicit dig-block-at can still take it.
  const spawner = mcData.blocksByName.spawner;
  if (spawner) cantBreak.add(spawner.id);
  // ドアを壊さない
  for (const doorName of ['oak_door', 'birch_door', 'spruce_door', 'jungle_door', 'acacia_door', 'dark_oak_door']) {
    const block = mcData.blocksByName[doorName];
    if (block) cantBreak.add(block.id);
  }

  // Without a pickaxe, stone and the like are still dug, by hand: slowly, and with nothing to show for it.
  // The route planner prices a dig by the time it takes with what the body holds (about 24 steps' worth for
  // a block of stone dug bare-handed), so it goes round when there is a way round. Such blocks used to be
  // closed to it outright, and a body in a stone pit with no pickaxe then had no route to anywhere: every
  // move ended at once where it stood, for five minutes and thirty calls (paid run L73). A person punches
  // their way out. (The planner also drops any step costing over 100, and a hand-dug block of stone at the
  // dig cost travel uses is 235: without a pickaxe the labour of one block is capped at 30, so that a step
  // through two or three such blocks is still a step.)
  if (canDig && !bot.inventory.items().some((item) => item.name.includes('pickaxe'))) (defaultMove as any).maxLaborCost = HAND_DIG_LABOUR_CAP;
  defaultMove.blocksCantBreak = cantBreak;
  if (!canPlace) defaultMove.scafoldingBlocks = [];
  (defaultMove as any).canSwim = canSwim;
  defaultMove.maxDropDown = maxDropDown;
  // The planner otherwise drops any height onto the first water block below,
  // whatever is under that water: a paid run rode falling water down a cave
  // into lava. A drop into water gets the same bound as any other drop.
  (defaultMove as any).infiniteLiquidDropdownDistance = false;
  installSafeParkour(defaultMove, maxDropDown);
  // Leaving water is not a preference: a body already afloat has to be able to get out whatever the caller
  // thinks of water as a route. The escape skills ask for routes that avoid water (canSwim=false), and with
  // that the one move that climbs a bank from deep water was left out too, so an escape begun afloat had no
  // route at all: the body sank in place with a zombie on it (paid run L53). Avoiding water is the liquid cost.
  installSwimOut(defaultMove);
  // Cells the server has kept refusing the body are closed to every route (see serverRefusals).
  (defaultMove as any).exclusionAreasStep.push(serverRefusalStepCost(bot));
  // Blocks a dig rule has just refused (lava behind, a hostile shut out) are not dug through by a route.
  (defaultMove as any).exclusionAreasBreak.push(refusedDigBreakCost(bot));
  // Lava is given room: a step with lava in the next cell costs a detour of eight (see lavaClearance).
  (defaultMove as any).exclusionAreasStep.push(lavaBesideStepCost(bot as any));
  // Things the body must not stand in, beyond what the pathfinder knows of (fire, cobweb, lava). Soul fire was
  // not among them: it was a cell to walk through, and the reflex that takes the body out of fire walked it
  // back out, so the two held it in a one-block pocket for nine minutes with every move timing out (lab
  // continuation L77n; soul sand burns for ever). A cell of these is not walked into; in the way, it is struck
  // out like any block in the way (a fire is put out by a blow).
  for (const name of HARMFUL_TO_STAND_IN) {
    const id = (bot as any).registry?.blocksByName?.[name]?.id;
    if (typeof id === 'number') (defaultMove as any).blocksToAvoid.add(id);
  }

  // ドアを openable に追加（pathfinderデフォルトではgateのみ）
  // 注意: pathfinderにバグがあり、blockAt()がnullを返すとエラーになる
  // patch-packageで修正後に有効化する
  if (canOpenDoors) {
    const mcData = minecraftData(bot.version);
    const openable = (defaultMove as any).openable as Set<number>;

    Object.keys(mcData.blocksByName).forEach(name => {
      // 木製ドアのみ（鉄ドアは右クリックで開かない）
      if (name.includes('door') && !name.includes('iron')) {
        const block = mcData.blocksByName[name];
        if (block) {
          openable.add(block.id);
        }
      }
    });
  }

  bot.pathfinder.setMovements(defaultMove);
}
