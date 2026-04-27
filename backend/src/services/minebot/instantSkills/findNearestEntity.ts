import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:Skill:findEntity');

/**
 * 原子的スキル: 最も近いエンティティを検索
 */
class FindNearestEntity extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'find-nearest-entity';
    this.description =
      '指定したタイプの最も近いエンティティを検索します（座標と距離を返す）。' +
      'end_crystal、mob、プレイヤーなどの位置を正確に知りたいときに使用。' +
      'ブロックの検索にはfind-blocksを使ってください。';
    this.params = [
      {
        name: 'entityType',
        type: 'string',
        description:
          'エンティティタイプ（例: player, zombie, cow）。nullの場合は全エンティティから検索',
        default: null,
      },
      {
        name: 'maxDistance',
        type: 'number',
        description: '検索範囲（デフォルト: 64ブロック）',
        default: 64,
      },
    ];
  }

  async runImpl(entityType: string | null = null, maxDistance: number = 64) {
    try {
      if (entityType?.toLowerCase() === 'player') {
        return this.findNearestPlayer(maxDistance);
      }

      const entity = this.bot.nearestEntity((e) => {
        if (e.position.distanceTo(this.bot.entity.position) > maxDistance) {
          return false;
        }
        if (entityType) {
          const lower = entityType.toLowerCase();
          return e.name?.toLowerCase() === lower || e.type?.toLowerCase() === lower;
        }
        return e !== this.bot.entity;
      });

      if (!entity) {
        const typeStr = entityType ? `${entityType}タイプの` : '';
        return {
          success: true,
          result: `${maxDistance}ブロック以内に${typeStr}エンティティは見つかりませんでした`,
        };
      }

      const distance =
        Math.floor(entity.position.distanceTo(this.bot.entity.position) * 10) /
        10;
      const pos = entity.position;

      return {
        success: true,
        result: `${entity.name || entity.type}を発見: 座標(${Math.floor(
          pos.x
        )}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}), 距離${distance}m`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `検索エラー: ${error.message}`,
      };
    }
  }

  private findNearestPlayer(maxDistance: number) {
    const botPos = this.bot.entity.position;
    let nearest: { username: string; distance: number; pos: any } | null = null;

    // 1) bot.players API
    const playerNames = Object.keys(this.bot.players);
    log.debug(`bot.players: ${playerNames.length}人 [${playerNames.join(', ')}]`);

    for (const player of Object.values(this.bot.players)) {
      if (player.username === this.bot.username) continue;
      if (!player.entity) {
        log.debug(`  ${player.username}: entity=null (tab listのみ)`);
        continue;
      }
      const dist = player.entity.position.distanceTo(botPos);
      log.debug(`  ${player.username}: entity有, dist=${dist.toFixed(1)}`);
      if (dist > maxDistance) continue;
      if (!nearest || dist < nearest.distance) {
        nearest = {
          username: player.username,
          distance: Math.floor(dist * 10) / 10,
          pos: player.entity.position,
        };
      }
    }

    // 2) bot.players で見つからなかった場合、bot.entities から player タイプを探す
    if (!nearest) {
      log.debug('bot.players にエンティティなし → bot.entities をフォールバック検索');
      const allEntities = Object.values(this.bot.entities);
      log.debug(`bot.entities: ${allEntities.length}個`);

      for (const e of allEntities) {
        if (e === this.bot.entity) continue;
        if (e.type !== 'player') continue;
        const dist = e.position.distanceTo(botPos);
        log.debug(`  entity player "${e.username ?? e.name}": dist=${dist.toFixed(1)}`);
        if (dist > maxDistance) continue;
        if (!nearest || dist < nearest.distance) {
          nearest = {
            username: (e as any).username || e.name || 'unknown',
            distance: Math.floor(dist * 10) / 10,
            pos: e.position,
          };
        }
      }
    }

    if (!nearest) {
      log.warn(`${maxDistance}ブロック以内にプレイヤー未検出`);
      return {
        success: true,
        result: `${maxDistance}ブロック以内にplayerタイプのエンティティは見つかりませんでした`,
      };
    }

    return {
      success: true,
      result: `${nearest.username}を発見: 座標(${Math.floor(nearest.pos.x)}, ${Math.floor(nearest.pos.y)}, ${Math.floor(nearest.pos.z)}), 距離${nearest.distance}m`,
    };
  }
}

export default FindNearestEntity;
