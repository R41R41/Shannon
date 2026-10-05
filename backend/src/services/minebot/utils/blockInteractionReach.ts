import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

const { goals } = pathfinder;

// Mineflayer's dig precondition measures the block centre from the player's
// eyes, not the distance from the player's feet to the block's lower corner.
export const DIG_REACH = 5.1;
const EYE_HEIGHT = 1.65;
type PathNodePosition = Pick<Vec3, 'x' | 'y' | 'z'>;
// Java survival block-use reach is shorter than mining reach. Leave a small
// margin for server-side position updates before opening a workstation.
export const BLOCK_USE_REACH = 4.25;

/** Whether the block centre is close enough to use from the player's eyes. */
export function blockCenterWithinUseReach(
  feet: { x: number; y: number; z: number },
  block: { x: number; y: number; z: number },
  reach = BLOCK_USE_REACH,
): boolean {
  return (feet.x - block.x - 0.5) ** 2
    + (feet.y + EYE_HEIGHT - block.y - 0.5) ** 2
    + (feet.z - block.z - 0.5) ** 2 <= reach ** 2;
}

export function blockCenterWithinDigReach(
  feet: { x: number; y: number; z: number },
  block: { x: number; y: number; z: number },
  reach = DIG_REACH,
): boolean {
  return (feet.x - block.x - 0.5) ** 2
    + (feet.y + EYE_HEIGHT - block.y - 0.5) ** 2
    + (feet.z - block.z - 0.5) ** 2 <= reach ** 2;
}

export function canDigFromHere(
  bot: { entity: { position: Vec3 }; canDigBlock?: (block: any) => boolean },
  block: { position?: Vec3; diggable?: boolean },
  targetPosition?: Vec3,
): boolean {
  if (block.diggable === false) return false;
  if (typeof bot.canDigBlock === 'function' && block.position) return bot.canDigBlock(block);
  const position = block.position ?? targetPosition;
  return position ? blockCenterWithinDigReach(bot.entity.position, position) : false;
}

/** A pathfinder goal for a safe walking node within actual digging reach. */
export class GoalReachBlock extends goals.Goal {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly range: number;

  constructor(x: number, y: number, z: number, range = DIG_REACH) {
    super();
    this.x = Math.floor(x);
    this.y = Math.floor(y);
    this.z = Math.floor(z);
    // Pathfinder evaluates the centre of a walking node, while Mineflayer
    // checks the bot's actual position (anywhere within that node). Leave the
    // node's half-diagonal as margin so a reported arrival is truly diggable.
    this.range = Math.max(0.5, Math.min(range, DIG_REACH) - Math.SQRT1_2 - 0.02);
  }

  heuristic(node: PathNodePosition): number {
    const dx = node.x + 0.5 - (this.x + 0.5);
    const dy = node.y + EYE_HEIGHT - (this.y + 0.5);
    const dz = node.z + 0.5 - (this.z + 0.5);
    return Math.max(0, Math.hypot(dx, dy, dz) - this.range);
  }

  isEnd(node: PathNodePosition): boolean {
    return blockCenterWithinDigReach(
      { x: node.x + 0.5, y: node.y, z: node.z + 0.5 },
      this, this.range,
    );
  }
}
