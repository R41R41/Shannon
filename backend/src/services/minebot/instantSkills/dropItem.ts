import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { actionDelay } from '../execution/observedWait.js';

const log = createLogger('Minebot:Skill:dropItem');

const AIR = new Set(['air', 'cave_air', 'void_air']);

/** 捨てたあとに退く距離（ブロック）— 自動ピックアップ半径から外す */
const RETREAT_AFTER_TOSS_BLOCKS = 6;
/** A dropped item is picked up from within a block of the body, and not for its first two seconds on the ground. */
const PICKUP_CLEARANCE_BLOCKS = 2.5;
const PICKUP_DELAY_MS = 2000;
const PIT_SEARCH_RADIUS = 10;
const MIN_PIT_DEPTH = 3;

function isAirBlock(block: { name: string } | null): boolean {
  return !!block && AIR.has(block.name);
}

function canStandAt(bot: CustomBot, sx: number, sy: number, sz: number): boolean {
  const feet = bot.blockAt(new Vec3(sx, sy, sz));
  const head = bot.blockAt(new Vec3(sx, sy + 1, sz));
  const below = bot.blockAt(new Vec3(sx, sy - 1, sz));
  if (!feet || !head || !below) return false;
  if (!isAirBlock(feet) || !isAirBlock(head)) return false;
  return !isAirBlock(below);
}

interface PitDropPlan {
  standX: number;
  standY: number;
  standZ: number;
  lookX: number;
  lookY: number;
  lookZ: number;
  distSq: number;
}

/**
 * 横に隣接した縦穴（連続する空気が MIN_PIT_DEPTH 以上）を探し、縁に立って下を覗く捨て先を返す。
 */
function findAdjacentPitDropPlan(bot: CustomBot): PitDropPlan | null {
  const bp = bot.entity.position;
  const bx = Math.floor(bp.x);
  const by = Math.floor(bp.y);
  const bz = Math.floor(bp.z);

  let best: PitDropPlan | null = null;
  let bestDist = Infinity;

  for (let dx = -PIT_SEARCH_RADIUS; dx <= PIT_SEARCH_RADIUS; dx++) {
    for (let dz = -PIT_SEARCH_RADIUS; dz <= PIT_SEARCH_RADIUS; dz++) {
      if (dx * dx + dz * dz > PIT_SEARCH_RADIUS * PIT_SEARCH_RADIUS) continue;
      const px = bx + dx;
      const pz = bz + dz;

      // A pit is open at the level of the feet and goes down from there. The open air over ordinary ground
      // beside the body (feet, head and one more cell) is three cells of air too, and so is a cave under a
      // solid floor; both were taken for pits. The item was "dropped into a pit" onto the ground one block
      // away and walked back into the pack two seconds later (paid run L64).
      if (!isAirBlock(bot.blockAt(new Vec3(px, by + 1, pz)))) continue;
      let depth = 0;
      while (depth < 14 && isAirBlock(bot.blockAt(new Vec3(px, by - depth, pz)))) depth++;
      // `depth` counts the feet-level cell and those under it: the item comes to rest depth-1 below the feet.
      if (depth - 1 < MIN_PIT_DEPTH) continue;
      const topY = by;

      const adj = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const;
      for (const [ox, oz] of adj) {
        const sx = px + ox;
        const sz = pz + oz;
        if (!canStandAt(bot, sx, by, sz)) continue;

        const cx = sx + 0.5;
        const cz = sz + 0.5;
        const distSq = (bp.x - cx) ** 2 + (bp.z - cz) ** 2;
        if (distSq < bestDist) {
          bestDist = distSq;
          best = {
            standX: sx,
            standY: by,
            standZ: sz,
            lookX: px + 0.5,
            lookY: topY - 1.2,
            lookZ: pz + 0.5,
            distSq,
          };
        }
      }
    }
  }
  return best;
}

/**
 * 原子的スキル: インベントリ内のアイテムをドロップ
 * 足元ですぐ拾い直さないよう、近くの穴の縁へ移動して下向きに捨てるか、捨てた直後に離れる。
 */
class DropItem extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'drop-item';
    this.description =
      'インベントリから指定アイテムを指定数捨てます（複数スタックにまたがってもよい）。近くに穴があればそこへ、無ければ開けた向きへ投げてから反対側へ離れ、拾い直していないことを確かめて結果を返します。捨てた物は数分で消えます。残したい物は deposit-to-container でチェストに預けてください。';
    this.params = [
      {
        name: 'itemName',
        type: 'string',
        description: 'ドロップするアイテム名',
        required: true,
      },
      {
        name: 'count',
        type: 'number',
        description: 'ドロップする数量（デフォルト: 1）',
        default: 1,
      },
    ];
  }

  /** Places a few blocks off where the body can stand, nearer first, on its level or a step or two off it: ground is seldom flat. */
  private retreatSpots(bot: CustomBot): Array<[number, number, number]> {
    const from = bot.entity.position;
    const baseY = Math.floor(from.y);
    const spots: Array<[number, number, number]> = [];
    for (const distance of [RETREAT_AFTER_TOSS_BLOCKS, RETREAT_AFTER_TOSS_BLOCKS - 2]) {
      for (const [ux, uz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        const scale = ux && uz ? Math.SQRT1_2 : 1;
        const tx = Math.floor(from.x + ux * distance * scale), tz = Math.floor(from.z + uz * distance * scale);
        for (const dy of [0, 1, -1, 2, -2]) if (canStandAt(bot, tx, baseY + dy, tz)) { spots.push([tx, baseY + dy, tz]); break; }
      }
    }
    return spots;
  }

  /** Walks to one of the spots, away from where the item was thrown. True when it got clear of the place it threw from. */
  private async retreatTo(bot: CustomBot, spots: Array<[number, number, number]>, fromX: number, fromZ: number): Promise<boolean> {
    const moveTo = bot.instantSkills?.getSkill('move-to');
    const clear = () => Math.hypot(bot.entity.position.x - fromX, bot.entity.position.z - fromZ) >= PICKUP_CLEARANCE_BLOCKS;
    if (!moveTo) return clear();
    for (const [tx, ty, tz] of spots.slice(0, 5)) {
      try {
        bot.pathfinder?.stop();
        await moveTo.run(tx, ty, tz, 1, 'near');
      } catch {
        /* the next one */
      }
      if (clear()) return true;
      if (this.shouldInterrupt()) return false;
    }
    log.info('退避用の move-to がすべて不成立でした');
    return clear();
  }

  async runImpl(itemName: string, count: number = 1) {
    try {
      const stacks = this.bot.inventory.items().filter((i) => i.name === itemName);
      const item = stacks[0];

      if (!item) {
        return {
          success: false,
          result: `インベントリに${itemName}がありません`,
        };
      }

      // As many as asked for, over as many stacks as it takes (it used to stop at the first stack: asked to drop
      // 74 granite, it dropped the 10 of one stack).
      const dropCount = Math.min(count, stacks.reduce((sum, i) => sum + i.count, 0));
      const moveTo = this.bot.instantSkills?.getSkill('move-to');
      const tossX = this.bot.entity.position.x;
      const tossZ = this.bot.entity.position.z;

      await this.bot.equip(item, 'hand').catch(() => {});

      const pit = findAdjacentPitDropPlan(this.bot);
      let mode: 'pit' | 'retreat' = 'retreat';

      if (pit && moveTo) {
        try {
          this.bot.pathfinder?.stop();
          const near = await moveTo.run(pit.standX, pit.standY, pit.standZ, 1, 'near');
          if (near.success) {
            await this.bot.lookAt(new Vec3(pit.lookX, pit.lookY, pit.lookZ));
            await actionDelay(this.bot, 120);
            mode = 'pit';
          }
        } catch (e: any) {
          // A cancelled action must not fall through to toss (not motor-fenced).
          if (this.shouldInterrupt()) throw e;
          log.warn(`穴縁への移動に失敗: ${e.message}`);
        }
      }

      const held = () => this.bot.inventory.items().filter((i) => i.name === itemName).reduce((sum, i) => sum + i.count, 0);
      const before = held();
      // With no pit: the item is thrown one way and the body walks the other. The way to walk is chosen first
      // (somewhere it can stand), the throw is level and straight away from it, and the walk keeps to that side.
      let spots: Array<[number, number, number]> = [];
      if (mode === 'retreat') {
        spots = this.retreatSpots(this.bot);
        if (spots.length) {
          const here = this.bot.entity.position;
          const [sx, , sz] = spots[0];
          const wayX = sx + 0.5 - here.x, wayZ = sz + 0.5 - here.z, length = Math.hypot(wayX, wayZ) || 1;
          await this.bot.lookAt(new Vec3(here.x - (wayX / length) * 4, here.y + 1.62, here.z - (wayZ / length) * 4), true);
          spots = spots.filter(([x, , z]) => (x + 0.5 - here.x) * wayX + (z + 0.5 - here.z) * wayZ > 0);
        } else {
          // Nowhere to walk to: the throw itself has to carry the item out of reach. It goes level along the
          // longest open line there is from the eyes (a thrown item lands three blocks or so off; the body picks
          // up from within one). Thrown wherever the body happened to be looking, it fell at its feet.
          const here = this.bot.entity.position;
          let best: { x: number; z: number; open: number } | null = null;
          for (let index = 0; index < 8; index++) {
            const ux = Math.cos(index * Math.PI / 4), uz = Math.sin(index * Math.PI / 4);
            let open = 0;
            while (open < 5 && isAirBlock(this.bot.blockAt(new Vec3(Math.floor(here.x + ux * (open + 1)), Math.floor(here.y + 1.62), Math.floor(here.z + uz * (open + 1)))))) open++;
            if (!best || open > best.open) best = { x: ux, z: uz, open };
          }
          if (best) await this.bot.lookAt(new Vec3(here.x + best.x * 4, here.y + 1.62, here.z + best.z * 4), true);
        }
      }
      await this.bot.toss(item.type, null, dropCount);
      await actionDelay(this.bot, 80);

      const tossedAt = Date.now();
      const away = mode === 'pit' ? true : await this.retreatTo(this.bot, spots, tossX, tossZ);
      // A thrown item can be picked up again after two seconds. What the pack holds after that is the result.
      await actionDelay(this.bot, Math.max(0, PICKUP_DELAY_MS + 400 - (Date.now() - tossedAt)));
      const back = Math.max(0, held() - (before - dropCount));
      if (back > 0) {
        return {
          success: false,
          failureType: 'picked_up_again',
          recoverable: true,
          result:
            `${itemName}を${dropCount}個捨てましたが、${back}個を拾い直しました（現在${held()}個）。` +
            (away ? '' : '捨てた場所から離れられませんでした（周りに立てる場所が見つからない）。') +
            '落とし物は1ブロック以内にいると拾います。開けた場所へ出てから捨てるか、チェストに入れてください',
        };
      }
      return {
        success: true,
        result: mode === 'pit'
          ? `${itemName}を${dropCount}個、近くの穴へ捨てました（残り${held()}個）。`
          : `${itemName}を${dropCount}個捨て、その場から離れました（残り${held()}個）。`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `ドロップエラー: ${error.message}`,
      };
    }
  }
}

export default DropItem;
