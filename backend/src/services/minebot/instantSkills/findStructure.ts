import minecraftData from 'minecraft-data';
import { detectVillage } from '../utils/landmarks.js';
import { scanLoadedBlocks } from '../utils/loadedBlockScan.js';
import { CustomBot, InstantSkill } from '../types.js';

/**
 * 原子的スキル: 特定の構造物を探す
 */
class FindStructure extends InstantSkill {
  private mcData: any;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'find-structure';
    this.description = '指定した構造物（要塞、村、ネザー要塞など）を、読み込み済みの範囲から探します。村は観測のlandmarksにも自動で出ます。';
    this.mcData = minecraftData(this.bot.version);
    this.params = [
      {
        name: 'structureType',
        type: 'string',
        description:
          '構造物の種類（fortress=ネザー要塞, village=村, stronghold=要塞など）',
        required: true,
      },
    ];
  }

  async runImpl(structureType: string) {
    try {
      // 構造物の種類を正規化
      const normalizedType = structureType.toLowerCase();

      // サポートされている構造物
      const supportedStructures = [
        'fortress', // ネザー要塞
        'village', // 村
        'stronghold', // エンドポータル要塞
        'monument', // 海底神殿
        'mansion', // 森の洋館
        'temple', // ジャングル/砂漠の寺院
        'mineshaft', // 廃坑
        'bastion', // 砦の遺跡（ネザー）
      ];

      if (!supportedStructures.includes(normalizedType)) {
        return {
          success: false,
          result: `サポートされていない構造物です。対応: ${supportedStructures.join(
            ', '
          )}`,
        };
      }

      // 構造物に特徴的なブロックを探す
      let searchBlocks: string[] = [];
      let searchDistance = 128;

      switch (normalizedType) {
        case 'fortress':
          searchBlocks = ['nether_bricks', 'nether_brick_fence'];
          searchDistance = 256;
          break;
        case 'bastion':
          searchBlocks = ['blackstone', 'polished_blackstone_bricks'];
          searchDistance = 256;
          break;
        case 'village':
          searchBlocks = ['bell', 'hay_block'];
          searchDistance = 128;
          break;
        case 'stronghold':
          searchBlocks = ['stone_bricks', 'mossy_stone_bricks'];
          searchDistance = 64;
          break;
        default:
          return {
            success: false,
            result: `${structureType}の検索方法が未実装です`,
          };
      }

      // Only what the server has sent can be read: the loaded chunks around the body.
      if (normalizedType === 'village') {
        const reach = scanLoadedBlocks(this.bot as any, ['bell']).reachMetres;
        const village = detectVillage(this.bot as any);
        return { success: true, result: village
          ? `村を発見: ${village.direction}へ約${village.distance}m、座標(${village.position.x}, ${village.position.y}, ${village.position.z})。根拠: ${village.evidence}`
          : `読み込み済みの範囲（約${reach}m）に村の目印（鐘、干し草、職業ブロック、ベッドの集まり、村人）はありません。別の方向へ移動すると新しい範囲が読み込まれます` };
      }
      const scan = scanLoadedBlocks(this.bot as any, searchBlocks, { maxHits: 10, maxDistance: searchDistance });
      if (scan.hits.length === 0) {
        // Not in sight now: what was seen before, and which way has not been looked at yet.
        let known = '';
        try {
          const memory = (this.bot as any).placeMemory;
          const remembered = memory?.recall(normalizedType, 1)?.[0];
          known = remembered
            ? `以前に見た場所を覚えています: (${remembered.position.x}, ${remembered.position.y}, ${remembered.position.z}) ${remembered.distance}m ${remembered.direction}。`
            : memory ? `まだ見ていない方角: ${memory.unseen()}。` : '';
        } catch { known = ''; }
        return {
          success: true,
          result: `読み込み済みの範囲（約${Math.min(scan.reachMetres, searchDistance)}m）に${structureType}の痕跡が見つかりませんでした。${known}移動してから再度探索してください`,
        };
      }
      const nearest = scan.hits[0];
      // Found once, known from then on (also after the body has died and come back).
      try { (this.bot as any).placeMemory?.remember(normalizedType, nearest.position, { note: nearest.name }); } catch { /* memory is optional */ }
      return {
        success: true,
        result: `${structureType}の痕跡（${nearest.name}）を発見: 座標(${nearest.position.x}, ${nearest.position.y}, ${nearest.position.z}), 距離${Math.floor(nearest.distance)}m`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `構造物探索エラー: ${error.message}`,
      };
    }
  }
}

export default FindStructure;
