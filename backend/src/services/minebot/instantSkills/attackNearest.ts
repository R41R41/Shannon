import { CustomBot, InstantSkill } from '../types.js';
import { shouldRefuseAggressiveCombat } from '../utils/minebotToolPolicy.js';

/**
 * 原子的スキル: 最も近いエンティティに1回攻撃
 */
class AttackNearest extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'attack-nearest';
    this.description =
      '最も近いエンティティに1回近接攻撃します（射程約4.5ブロック）。entityNameで対象を指定可能。省略時は敵対的Mobのみ。' +
      '遠距離の対象にはshoot-bowを使ってください。';
    this.params = [
      {
        name: 'entityName',
        type: 'string',
        description: '攻撃対象のエンティティ名（例: pig, cow, zombie）。省略時は敵対的Mobのみ',
        default: '',
      },
      {
        name: 'maxDistance',
        type: 'number',
        description: '攻撃可能な最大距離（デフォルト: 4.5ブロック）',
        default: 4.5,
      },
    ];
  }

  async runImpl(entityName: string = '', maxDistance: number = 4.5) {
    try {
      const refuse = shouldRefuseAggressiveCombat(this.bot);
      if (refuse) {
        return { success: false, result: refuse };
      }
      // 敵対的なMobのリスト
      const hostileMobs = [
        'zombie',
        'husk',           // ゾンビ亜種
        'drowned',        // 水中ゾンビ
        'skeleton',
        'stray',          // スケルトン亜種
        'creeper',
        'spider',
        'enderman',
        'witch',
        'slime',
        'magma_cube',
        'phantom',
        'blaze',
        'ghast',
        'zombified_piglin',
        'piglin',
        'piglin_brute',
        'hoglin',
        'zoglin',
        'wither_skeleton',
        'wither',
        'cave_spider',
        'silverfish',
        'endermite',
        'guardian',
        'elder_guardian',
        'shulker',
        'vindicator',
        'evoker',
        'vex',
        'pillager',
        'ravager',
        'warden',
      ];

      const targetEntityName = entityName.toLowerCase().trim();

      // 最も近い対象を探す
      const target = this.bot.nearestEntity((entity) => {
        if (!entity || !entity.position) return false;

        const distance = entity.position.distanceTo(this.bot.entity.position);
        if (distance > maxDistance) return false;

        const name = entity.name?.toLowerCase() || '';

        // エンティティ名が指定されている場合はそれにマッチするものを探す
        if (targetEntityName) {
          return name.includes(targetEntityName);
        }

        // 指定がない場合は敵対的なMobのみ
        return hostileMobs.some((mob) => name.includes(mob));
      });

      if (!target) {
        const targetDesc = targetEntityName || '敵対的Mob';
        return {
          success: false,
          result: `${maxDistance}ブロック以内に攻撃可能な${targetDesc}が見つかりません`,
        };
      }

      const distance = target.position.distanceTo(this.bot.entity.position);

      // 距離が遠すぎる場合
      if (distance > 4.5) {
        return {
          success: false,
          result: `${target.name}が遠すぎます（距離: ${distance.toFixed(1)}m）`,
        };
      }

      // 対象を見る
      await this.bot.lookAt(target.position.offset(0, target.height * 0.8, 0));

      // 攻撃
      await this.bot.attack(target);

      return {
        success: true,
        result: `${target.name}を攻撃しました（距離: ${distance.toFixed(1)}m）`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `攻撃エラー: ${error.message}`,
      };
    }
  }
}

export default AttackNearest;
