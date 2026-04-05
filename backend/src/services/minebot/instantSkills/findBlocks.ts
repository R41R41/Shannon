import minecraftData from 'minecraft-data';
import { CustomBot, InstantSkill } from '../types.js';

const INITIAL_RADIUS = 16;
const RADIUS_STEP = 16;

/** ラージチェストは2ブロック分あるため、count が小さいと取りこぼす */
const CHEST_LIKE = new Set(['chest', 'trapped_chest', 'ender_chest', 'barrel']);
const MIN_COUNT_STORAGE_SEARCH = 48;

function isStorageBlockSearch(blockNames: string[]): boolean {
  return blockNames.length > 0 && blockNames.every((n) => CHEST_LIKE.has(n));
}

/**
 * 原子的スキル: 周囲のブロックを検索
 * 近距離から段階的に範囲を広げて検索する。
 */
class FindBlocks extends InstantSkill {
  private mcData: any;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'find-blocks';
    this.description =
      '指定したブロックを周囲から検索して座標リストを返します。チェスト・樽はラージチェストが2ブロック分あるため、すべて列挙したいときは count を 48 以上にする（省略時は内部で底上げされる）。';
    this.mcData = minecraftData(this.bot.version);
    this.params = [
      {
        name: 'blockName',
        type: 'string',
        description: '検索するブロック名（例: stone, diamond_ore, oak_log）。カンマ区切りで複数指定可（例: oak_log,acacia_log,birch_log）',
        required: true,
      },
      {
        name: 'maxDistance',
        type: 'number',
        description: '検索範囲（デフォルト: 64ブロック）',
        default: 64,
      },
      {
        name: 'count',
        type: 'number',
        description:
          '検索する最大数（デフォルト: 10個）。chest / barrel 等の収納ブロックはラージ対で2座標になるため、基地内の全チェストを洗うときは 48 以上を推奨（未指定でも収納単体検索時は最低48まで引き上げ）',
        default: 10,
      },
    ];
  }

  async runImpl(
    blockName: string,
    maxDistance: number = 64,
    count: number = 10
  ) {
    try {
      // カンマ区切りで複数ブロック名をサポート
      const blockNames = blockName.split(',').map(n => n.trim()).filter(Boolean);
      const matchingIds: number[] = [];
      const invalidNames: string[] = [];

      for (const name of blockNames) {
        const bt = this.mcData.blocksByName[name];
        if (bt) {
          matchingIds.push(bt.id);
        } else {
          invalidNames.push(name);
        }
      }

      if (matchingIds.length === 0) {
        return {
          success: false,
          result: `ブロック${blockName}が見つかりません`,
        };
      }

      const displayName = blockNames.filter(n => !invalidNames.includes(n)).join(', ');

      const storageSearch = isStorageBlockSearch(blockNames.filter((n) => !invalidNames.includes(n)));
      const effectiveCount = storageSearch ? Math.max(count, MIN_COUNT_STORAGE_SEARCH) : count;

      let blocks: any[] = [];
      // maxDistance まで必ず広げる（count が小さいとき近距離だけで打ち切られチェスト取りこぼしが起きるのを防ぐ）
      for (let radius = INITIAL_RADIUS; radius <= maxDistance; radius += RADIUS_STEP) {
        blocks = this.bot.findBlocks({
          matching: matchingIds.length === 1 ? matchingIds[0] : matchingIds,
          maxDistance: radius,
          count: effectiveCount,
        });
      }

      if (blocks.length === 0) {
        const invalidNote = invalidNames.length > 0 ? `（不明なブロック: ${invalidNames.join(', ')}）` : '';
        return {
          success: true,
          result: `${maxDistance}ブロック以内に${displayName}は見つかりませんでした${invalidNote}`,
        };
      }

      const botPos = this.bot.entity.position;
      const isFarmland = blockNames.includes('farmland');
      const sortedBlocks = blocks
        .map((pos) => {
          const block = this.bot.blockAt(pos);
          const blockData: any = {
            x: pos.x,
            y: pos.y,
            z: pos.z,
            distance:
              Math.floor(botPos.distanceTo(pos) * 10) / 10,
            blockName: block?.name ?? 'unknown',
          };

          if (isFarmland) {
            const aboveBlock = this.bot.blockAt(pos.offset(0, 1, 0));
            if (aboveBlock && aboveBlock.name !== 'air') {
              blockData.above = aboveBlock.name;
            }
          }

          return blockData;
        })
        .sort((a, b) => a.distance - b.distance);

      if (isFarmland) {
        const emptyFarmland = sortedBlocks.filter((b) => !b.above);
        const occupiedFarmland = sortedBlocks.filter((b) => b.above);

        const emptyList = emptyFarmland
          .slice(0, 5)
          .map((b) => `(${b.x}, ${b.y}, ${b.z})`)
          .join(', ');

        const occupiedCount = occupiedFarmland.length;
        const emptyCount = emptyFarmland.length;

        let result = `farmlandを${blocks.length}個発見。`;
        if (emptyCount > 0) {
          result += `空き${emptyCount}個: ${emptyList}${emptyCount > 5 ? '...' : ''}`;
        } else {
          result += '空きなし';
        }
        if (occupiedCount > 0) {
          result += `、使用中${occupiedCount}個`;
        }

        return { success: true, result };
      }

      // 複数ブロック名検索の場合、各ブロックの実名を表示
      const showBlockName = blockNames.length > 1;
      const listCap = storageSearch ? 32 : 5;
      const blockList = sortedBlocks
        .slice(0, listCap)
        .map((b) => showBlockName
          ? `${b.blockName}(${b.x}, ${b.y}, ${b.z}) 距離${b.distance}m`
          : `(${b.x}, ${b.y}, ${b.z}) 距離${b.distance}m`)
        .join(', ');

      const truncated = sortedBlocks.length > listCap;
      return {
        success: true,
        result: `${displayName}を${sortedBlocks.length}個発見: ${blockList}${truncated ? '...' : ''}`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `検索エラー: ${error.message}`,
      };
    }
  }
}

export default FindBlocks;
