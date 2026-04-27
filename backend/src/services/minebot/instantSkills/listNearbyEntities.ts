import { CustomBot, InstantSkill } from '../types.js';

/**
 * エンティティのカスタム名を取得するヘルパー
 */
function getCustomName(entity: any): string | null {
  try {
    const meta = entity.metadata;
    if (!meta) return null;
    const customName = meta[2];
    if (!customName) return null;
    if (typeof customName === 'object') {
      if (customName.text) return customName.text;
      if (customName.translate) return customName.translate;
      return JSON.stringify(customName);
    }
    if (typeof customName === 'string') {
      try {
        const parsed = JSON.parse(customName);
        if (parsed.text) return parsed.text;
        return customName;
      } catch {
        return customName;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 原子的スキル: 周囲のエンティティをリスト表示
 */
class ListNearbyEntities extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'list-nearby-entities';
    this.description =
      '周囲のエンティティ（mob・プレイヤー・end_crystal・ドロップアイテム等）をリスト表示します。' +
      'カスタム名付きエンティティ（Mysterious Traderなど）も表示されます。';
    this.params = [
      {
        name: 'maxDistance',
        type: 'number',
        description: '検索範囲（デフォルト: 64ブロック）。エンドクリスタル等の遠方エンティティには大きめの値を推奨',
        default: 64,
      },
      {
        name: 'maxCount',
        type: 'number',
        description: '最大表示数（デフォルト: 15個）',
        default: 15,
      },
    ];
  }

  async runImpl(maxDistance: number = 64, maxCount: number = 15) {
    try {
      // プレイヤーエンティティを取得
      const players = Object.values(this.bot.players)
        .filter((p) => p.entity && p.username !== this.bot.username)
        .map((p) => ({
          name: p.username,
          type: 'player',
          distance:
            Math.floor(
              p.entity!.position.distanceTo(this.bot.entity.position) * 10
            ) / 10,
          position: p.entity!.position,
        }))
        .filter((p) => p.distance <= maxDistance);

      // その他のエンティティを取得
      const otherEntities = Object.values(this.bot.entities)
        .filter((e) => {
          // 自分自身は除外
          if (e === this.bot.entity) return false;
          const distance = e.position.distanceTo(this.bot.entity.position);
          return distance <= maxDistance;
        })
        .map((e) => {
          const customName = getCustomName(e);
          const displayName = customName
            ? `${customName}(${e.name || e.type})`
            : (e.name || e.type);
          return {
            id: e.id,
            name: displayName,
            type: e.type,
            distance:
              Math.floor(e.position.distanceTo(this.bot.entity.position) * 10) /
              10,
            position: e.position,
          };
        });

      // プレイヤーとその他のエンティティをマージ
      const allEntities = [...players, ...otherEntities]
        .sort((a, b) => a.distance - b.distance)
        .slice(0, maxCount);

      if (allEntities.length === 0) {
        return {
          success: true,
          result: `${maxDistance}ブロック以内にエンティティはいません`,
        };
      }

      const entityList = allEntities
        .map((e: any) => `${e.name}(${e.type})${e.id ? ` ID:${e.id}` : ''} 距離${e.distance}m`)
        .join(', ');

      return {
        success: true,
        result: `周囲のエンティティ(${allEntities.length}個): ${entityList}`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `取得エラー: ${error.message}`,
      };
    }
  }
}

export default ListNearbyEntities;
