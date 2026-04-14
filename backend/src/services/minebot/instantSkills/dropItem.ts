import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:Skill:dropItem');

const AIR = new Set(['air', 'cave_air', 'void_air']);

/** 捨てたあとに退く距離（ブロック）— 自動ピックアップ半径から外す */
const RETREAT_AFTER_TOSS_BLOCKS = 6;
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

/** 1本の柱で、上から下へ連続する空気の区間のうち MIN_PIT_DEPTH 以上のものを1つ返す（最上段の y と深さ） */
function findAirColumnRun(
  bot: CustomBot,
  px: number,
  pz: number,
  yFrom: number,
  yTo: number,
): { topY: number; depth: number } | null {
  let run = 0;
  let runTop: number | null = null;
  let best: { topY: number; depth: number } | null = null;

  const flush = () => {
    if (runTop !== null && run >= MIN_PIT_DEPTH) {
      if (!best || run > best.depth) best = { topY: runTop, depth: run };
    }
    run = 0;
    runTop = null;
  };

  for (let y = yFrom; y >= yTo; y--) {
    const b = bot.blockAt(new Vec3(px, y, pz));
    if (isAirBlock(b)) {
      if (runTop === null) runTop = y;
      run++;
    } else {
      flush();
    }
  }
  flush();
  return best;
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

      const col = findAirColumnRun(bot, px, pz, by + 2, by - 14);
      if (!col) continue;

      const bottomY = col.topY - col.depth + 1;
      // 足元より上だけの空気柱（天井付近だけ）を捨て先にしない
      if (bottomY > by) continue;

      const { topY } = col;

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
      'インベントリから指定アイテムを指定数ドロップします。足元に落とすと自動で拾い直すため、近くの穴の縁へ移動して下へ捨てるか、捨てた直後に離れます。**満杯や空き確保のためには使わない**（必ず deposit-to-container で**地上の**チェスト等に預ける）。ユーザーが明示的に捨てる・ドロップすると指示したときのみ使う。';
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

  private async retreatFrom(bot: CustomBot, fromX: number, fromZ: number): Promise<void> {
    const moveTo = bot.instantSkills?.getSkill('move-to');
    if (!moveTo) return;

    const cardinals = [
      [RETREAT_AFTER_TOSS_BLOCKS, 0],
      [-RETREAT_AFTER_TOSS_BLOCKS, 0],
      [0, RETREAT_AFTER_TOSS_BLOCKS],
      [0, -RETREAT_AFTER_TOSS_BLOCKS],
    ] as const;
    const baseY = Math.floor(bot.entity.position.y);

    for (const [dx, dz] of cardinals) {
      const tx = Math.floor(fromX) + dx;
      const tz = Math.floor(fromZ) + dz;
      if (!canStandAt(bot, tx, baseY, tz)) continue;
      try {
        bot.pathfinder?.stop();
        const r = await moveTo.run(tx, baseY, tz, 1, 'near');
        if (r.success) return;
      } catch {
        /* ignore */
      }
    }
    log.info('退避用の move-to がすべて不成立でした');
  }

  async runImpl(itemName: string, count: number = 1) {
    try {
      const item = this.bot.inventory
        .items()
        .find((i) => i.name === itemName);

      if (!item) {
        return {
          success: false,
          result: `インベントリに${itemName}がありません`,
        };
      }

      const dropCount = Math.min(count, item.count);
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
            await new Promise(r => setTimeout(r, 120));
            mode = 'pit';
          }
        } catch (e: any) {
          log.warn(`穴縁への移動に失敗: ${e.message}`);
        }
      }

      await this.bot.toss(item.type, null, dropCount);
      await new Promise(r => setTimeout(r, 80));

      if (mode === 'pit') {
        await this.retreatFrom(this.bot, this.bot.entity.position.x, this.bot.entity.position.z);
        return {
          success: true,
          result:
            `${itemName}を${dropCount}個、近くの穴側へ捨てました（下向き）。その後少し離れて拾い直しを避けました。`,
        };
      }

      await this.retreatFrom(this.bot, tossX, tossZ);
      return {
        success: true,
        result:
          `${itemName}を${dropCount}個ドロップしました。適切な穴が近くになかったため捨て位置から離れました。拾い直した場合は別方向へ移動してから再度 drop-item してください。`,
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
