import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { getWaterLevel } from '../utils/waterLevel.js';
import { createLogger } from '../../../utils/logger.js';
import { estimateBlockApproachCost } from '../utils/blockApproachCost.js';

import { findLoadedBlocks } from '../utils/loadedBlockScan.js';
const log = createLogger('Minebot:Skill:findBlocks');

const INITIAL_RADIUS = 16;

/** ラージチェストは2ブロック分あるため、count が小さいと取りこぼす */
const CHEST_LIKE = new Set(['chest', 'trapped_chest', 'ender_chest', 'barrel']);
const MIN_COUNT_STORAGE_SEARCH = 48;

/** 水源・溶岩源は level=0 のみバケツで汲める */
const LIQUID_BLOCKS = new Set(['water', 'lava']);

function isStorageBlockSearch(blockNames: string[]): boolean {
  return blockNames.length > 0 && blockNames.every((n) => CHEST_LIKE.has(n));
}

function isLiquidSearch(blockNames: string[]): boolean {
  return blockNames.some((n) => LIQUID_BLOCKS.has(n));
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
      '指定したブロックをロード済みチャンクからプログラムで検索して座標リストを返します。未ロード領域は探索できないため、見つからなければ安全な新しい地点へ移動して再検索してください。' +
      '特定ブロックの位置を知りたいときは必ずこのスキルを使うこと。' +
      'water/lava検索時は水源・溶岩源（level=0, バケツで汲める）を自動判別し優先表示する。' +
      '粉雪（powder_snow）もバケツで回収可能。' +
      'チェスト・樽はラージチェストが2ブロック分あるため count を 48 以上に。';
    this.mcData = minecraftData(this.bot.version);
    this.params = [
      {
        name: 'blockName',
        type: 'string',
        description: '検索するブロック名（例: water, stone, diamond_ore, oak_log, chest, furnace, crafting_table, lava）。カンマ区切りで複数指定可（例: oak_log,acacia_log,birch_log）。水源を探すなら "water" を指定',
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
      const liquidSearch_ = isLiquidSearch(blockNames.filter((n) => !invalidNames.includes(n)));
      const effectiveCount = storageSearch ? Math.max(count, MIN_COUNT_STORAGE_SEARCH) : count;

      const matching = matchingIds.length === 1 ? matchingIds[0] : matchingIds;

      let blocks: any[] = [];
      const startRadius = Math.min(INITIAL_RADIUS, maxDistance);
      if (!Number.isFinite(maxDistance) || maxDistance <= 0 || !Number.isFinite(effectiveCount) || effectiveCount <= 0) {
        return { success: false, result: '検索半径と件数は正の有限値が必要です', failureType: 'invalid_input', recoverable: true };
      }
      // By name, over what the server has sent: about a millisecond. The native
      // search took seconds when it found nothing (2.2s at 96 blocks, 9.9s at
      // 256, measured) and stopped the body meanwhile. Liquids keep the native
      // search: water is everywhere, and its level must be read per block.
      if (!liquidSearch_ && typeof (this.bot.world as any)?.getColumns === 'function') {
        blocks = findLoadedBlocks(this.bot as any, blockNames.filter(n => !invalidNames.includes(n)), maxDistance, effectiveCount);
      } else for (let radius = startRadius; ; radius = Math.min(radius * 2, maxDistance)) {
        // Native search is synchronous. Yield between radii so accumulated scans
        // cannot starve keepalive, health updates, or action cancellation.
        await new Promise<void>(resolve => setImmediate(resolve));
        if (this.shouldInterrupt()) return { success: false, result: '検索を中断しました', failureType: 'interrupted', recoverable: true };
        blocks = this.bot.findBlocks({ matching, maxDistance: radius, count: effectiveCount,
          ...(liquidSearch_ ? { useExtraInfo: (block: any) => getWaterLevel(block) === 0 } : {}) });
        // Once count nearest results are found, a wider sphere cannot add a
        // nearer result. Otherwise still search the ENTIRE requested distance,
        // including a non-multiple final radius (e.g. 24, formerly skipped).
        if (blocks.length >= effectiveCount || radius >= maxDistance) break;
      }

      if (blocks.length === 0) {
        const invalidNote = invalidNames.length > 0 ? `（不明なブロック: ${invalidNames.join(', ')}）` : '';
        // Not in what is loaded now; the body may have seen it earlier, further off.
        const remembered = blockNames.flatMap(name => {
          try { return ((this.bot as any).placeMemory?.recall(name.replace(/^deepslate_/, ''), 3) ?? []) as Array<{ kind: string; position: { x: number; y: number; z: number }; distance: number; direction: string }>; }
          catch { return []; }
        }).sort((a, b) => a.distance - b.distance).slice(0, 3);
        if (remembered.length) {
          return {
            success: true,
            result: `いま読み込まれている範囲（${maxDistance}ブロック以内）に${displayName}はありませんが、以前に見た場所を覚えています: `
              + remembered.map(place => `${place.kind}(${place.position.x}, ${place.position.y}, ${place.position.z}) ${place.distance}m ${place.direction}`).join('、')
              + `${invalidNote}。そこへ移動すれば使えます（離れている間に変わっていることがあります）`,
          };
        }
        if (liquidSearch_) {
          return {
            success: true,
            result: `ロード済みチャンクの${maxDistance}ブロック以内に${displayName}の水源ブロック（level=0）は見つかりませんでした。未ロード領域は未探索です。` +
              '水流がある場合その上流に水源があるはず。安全に新しい地点へ移動してチャンクをロードし、再検索してください。' +
              '無限水源を作るにもまず既存の水源からバケツで水を汲む必要があります。',
          };
        }
        return {
          success: true,
          result: `ロード済みチャンクの${maxDistance}ブロック以内に${displayName}は見つかりませんでした${invalidNote}。未ロード領域は未探索です。安全に新しい地点へ移動してチャンクをロードし、再検索してください。`,
        };
      }

      const botPos = this.bot.entity.position;
      const isFarmland = blockNames.includes('farmland');
      const isOreSearch = blockNames.every(name => name.endsWith('_ore'));
      const sortedBlocks = blocks
        .map((pos) => {
          const block = this.bot.blockAt(pos);
          const blockData: any = {
            x: pos.x,
            y: pos.y,
            z: pos.z,
            distance:
              Math.floor(botPos.distanceTo(pos) * 10) / 10,
            verticalDelta: pos.y - Math.floor(botPos.y),
            blockName: block?.name ?? 'unknown',
          };

          if (isOreSearch) {
            const exposed = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0),
              new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
              .some(offset => ['air', 'cave_air', 'void_air'].includes(this.bot.blockAt(pos.offset(offset.x, offset.y, offset.z))?.name ?? ''));
            blockData.approachCost = estimateBlockApproachCost(botPos, pos, exposed);
            blockData.exposed = exposed;
          }

          if (isFarmland) {
            const aboveBlock = this.bot.blockAt(pos.offset(0, 1, 0));
            if (aboveBlock && aboveBlock.name !== 'air') {
              blockData.above = aboveBlock.name;
            }
          }

          if (liquidSearch_ && block && LIQUID_BLOCKS.has(block.name)) {
            blockData.level = getWaterLevel(block);
          }

          return blockData;
        })
        .sort((a, b) => (isOreSearch ? a.approachCost - b.approachCost : a.distance - b.distance)
          || a.distance - b.distance);

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

      // --- 液体検索: useExtraInfo で水源のみ検索済み ---
      if (liquidSearch_) {
        const listCap = Math.min(24, Math.max(5, count));

        log.info(
          `🔍 水源検索: ${sortedBlocks.length}個の水源ブロック発見` +
          (sortedBlocks.length > 0
            ? ` サンプル: ${sortedBlocks.slice(0, 5).map(b => `${b.blockName}(${b.x},${b.y},${b.z}) level=${b.level}`).join(', ')}`
            : ''),
        );

        const sourceList = sortedBlocks
          .slice(0, listCap)
          .map((b) => `(${b.x},${b.y},${b.z}) 距離${b.distance}m`)
          .join(', ');
        const truncated = sortedBlocks.length > listCap;
        const nearest = sortedBlocks[0];
        return {
          success: true,
          result: `${displayName}の水源ブロック（level=0, バケツで汲める）を${sortedBlocks.length}個発見: ${sourceList}${truncated ? '...' : ''}。` +
            `最も近い水源は(${nearest.x},${nearest.y},${nearest.z})で距離${nearest.distance}m。` +
            '遠くに行く必要はなく、最寄りの水源に向かってそこでバケツを使ってください（use-item-on-blockは5m以内なら使用可能）。',
        };
      }

      // 複数ブロック名検索の場合、各ブロックの実名を表示
      const showBlockName = blockNames.length > 1;
      const listCap = storageSearch ? 32 : Math.min(24, Math.max(5, effectiveCount));
      const blockList = sortedBlocks
        .slice(0, listCap)
        .map((b) => showBlockName
          ? `${b.blockName}(${b.x}, ${b.y}, ${b.z}) 距離${b.distance}m 高低差${b.verticalDelta >= 0 ? '+' : ''}${b.verticalDelta}m${isOreSearch ? ` 到達概算${b.approachCost.toFixed(1)}${b.exposed ? ' 露出' : ' 埋没'}` : ''}`
          : `(${b.x}, ${b.y}, ${b.z}) 距離${b.distance}m 高低差${b.verticalDelta >= 0 ? '+' : ''}${b.verticalDelta}m${isOreSearch ? ` 到達概算${b.approachCost.toFixed(1)}${b.exposed ? ' 露出' : ' 埋没'}` : ''}`)
        .join(', ');

      const truncated = sortedBlocks.length > listCap;
      const inaccessibleDepthWarning = sortedBlocks.every((b) => b.verticalDelta < -32)
        ? ' 全候補が現在地より32m以上地下です。地表から直通できるとは限りません。地表資源を探しているなら探索地点を変えて再検索してください。'
        : '';
      return {
        success: true,
        result: `${displayName}を${sortedBlocks.length}個発見: ${blockList}${truncated ? '...' : ''}${isOreSearch ? ' 鉱石候補は高低差・露出を加味した到達概算順です（実経路の保証ではありません）。' : ''}${inaccessibleDepthWarning}`,
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
