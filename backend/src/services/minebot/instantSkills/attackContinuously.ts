import { CustomBot, InstantSkill } from '../types.js';
import { shouldRefuseAggressiveCombat } from '../utils/minebotToolPolicy.js';

/**
 * 原子的スキル: エンティティを追跡しながら連続攻撃
 *
 * 武器を自動装備し、対象が逃げても追いかけて攻撃し続ける。
 */
class AttackContinuously extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'attack-continuously';
    this.description = '対象を追跡しながら連続攻撃。武器自動装備。entityNameで対象を指定可能。省略時は敵対的Mobのみ。';
    this.params = [
      {
        name: 'entityName',
        type: 'string',
        description: '攻撃対象のエンティティ名（例: pig, cow, zombie）。省略時は敵対的Mobのみ',
        default: '',
      },
      {
        name: 'maxAttacks',
        type: 'number',
        description: '最大攻撃回数（デフォルト: 10回）',
        default: 10,
      },
      {
        name: 'maxDistance',
        type: 'number',
        description: '探索範囲（デフォルト: 16ブロック）。この範囲内の対象を追跡して攻撃する',
        default: 16,
      },
    ];
  }

  async runImpl(entityName: string = '', maxAttacks: number = 10, maxDistance: number = 16) {
    try {
      const refuse = shouldRefuseAggressiveCombat(this.bot);
      if (refuse) {
        return { success: false, result: refuse };
      }
      if (maxAttacks < 1 || maxAttacks > 100) {
        return { success: false, result: '攻撃回数は1～100の範囲で指定してください' };
      }

      const hostileMobs = [
        'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'creeper', 'spider',
        'enderman', 'witch', 'slime', 'magma_cube', 'phantom', 'blaze', 'ghast',
        'zombified_piglin', 'piglin', 'piglin_brute', 'hoglin', 'zoglin',
        'wither_skeleton', 'wither', 'cave_spider', 'silverfish', 'endermite',
        'guardian', 'elder_guardian', 'shulker', 'vindicator', 'evoker', 'vex',
        'pillager', 'ravager', 'warden',
      ];

      const targetEntityName = entityName.toLowerCase().trim();

      // ── 武器を装備 ──
      const weaponEquipped = await this.equipBestWeapon();

      // ── 対象を検索 (広い範囲) ──
      const findTarget = () => this.bot.nearestEntity((entity) => {
        if (!entity || !entity.position) return false;
        const d = entity.position.distanceTo(this.bot.entity.position);
        if (d > maxDistance) return false;
        const name = entity.name?.toLowerCase() || '';
        if (targetEntityName) return name.includes(targetEntityName);
        return hostileMobs.some((mob) => name.includes(mob));
      });

      let target = findTarget();
      if (!target) {
        const targetDesc = targetEntityName || '敵対的Mob';
        return {
          success: false,
          result: `${maxDistance}ブロック以内に${targetDesc}が見つかりません`,
          failureType: 'target_not_found',
          recoverable: true,
        };
      }

      let attackCount = 0;
      let lastTargetName = target.name || 'unknown';
      const startTime = Date.now();
      const TIMEOUT = 30000; // 30秒タイムアウト

      for (let i = 0; i < maxAttacks; i++) {
        if (this.shouldInterrupt()) {
          this.stopMovement();
          return {
            success: attackCount > 0,
            result: attackCount > 0
              ? `中断。${lastTargetName}を${attackCount}回攻撃しました（${weaponEquipped}使用）`
              : '中断されました',
          };
        }

        if (Date.now() - startTime > TIMEOUT) {
          this.stopMovement();
          return {
            success: attackCount > 0,
            result: `タイムアウト。${lastTargetName}を${attackCount}回攻撃しました（${weaponEquipped}使用）`,
          };
        }

        // 対象が死んだか消えた → 再検索
        if (!target.isValid) {
          target = findTarget();
          if (!target) break;
          lastTargetName = target.name || 'unknown';
        }

        const distance = target.position.distanceTo(this.bot.entity.position);

        if (distance > maxDistance) {
          // 範囲外に逃げた → 再検索
          target = findTarget();
          if (!target) break;
          lastTargetName = target.name || 'unknown';
          continue;
        }

        // ── 追跡: 遠ければ走って近づく ──
        if (distance > 3.5) {
          await this.bot.lookAt(target.position.offset(0, target.height * 0.5, 0));
          this.bot.setControlState('forward', true);
          this.bot.setControlState('sprint', true);
          // 近づくまで待つ (最大3秒)
          const chaseStart = Date.now();
          while (Date.now() - chaseStart < 3000) {
            if (this.shouldInterrupt()) break;
            if (!target.isValid) break;
            const d = target.position.distanceTo(this.bot.entity.position);
            if (d <= 3.5) break;
            await this.bot.lookAt(target.position.offset(0, target.height * 0.5, 0));
            await new Promise(r => setTimeout(r, 50));
          }
          this.stopMovement();
          if (!target.isValid) continue;
        }

        // ── 攻撃 ──
        const attackDist = target.position.distanceTo(this.bot.entity.position);
        if (attackDist <= 4.5 && target.isValid) {
          await this.bot.lookAt(target.position.offset(0, target.height * 0.8, 0));
          await this.bot.attack(target);
          attackCount++;

          // クールダウン（剣:625ms, 斧:1000ms, 素手:250ms）
          const cooldown = weaponEquipped.includes('axe') ? 900 : weaponEquipped.includes('sword') ? 550 : 200;
          await new Promise(r => setTimeout(r, cooldown));
        } else {
          // まだ遠い → 次のループで再追跡
          await new Promise(r => setTimeout(r, 100));
        }

        if (!target.isValid) break;
      }

      this.stopMovement();

      if (attackCount === 0) {
        return {
          success: false,
          result: `${lastTargetName}に攻撃できませんでした`,
          failureType: 'target_not_found',
          recoverable: true,
        };
      }

      const killed = !target?.isValid;
      return {
        success: true,
        result: killed
          ? `${lastTargetName}を${attackCount}回攻撃して倒しました（${weaponEquipped}使用）`
          : `${lastTargetName}を${attackCount}回攻撃しました（${weaponEquipped}使用、最大回数到達）`,
      };
    } catch (error: any) {
      this.stopMovement();
      return { success: false, result: `連続攻撃エラー: ${error.message}` };
    }
  }

  /** 最強の武器を装備。装備した武器名を返す */
  private async equipBestWeapon(): Promise<string> {
    const weaponPriority = [
      'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
      'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe',
    ];

    for (const weaponName of weaponPriority) {
      const item = this.bot.inventory.items().find(i => i.name === weaponName);
      if (item) {
        try {
          await this.bot.equip(item, 'hand');
          return weaponName;
        } catch { /* continue */ }
      }
    }
    return '素手';
  }

  private stopMovement() {
    try {
      this.bot.setControlState('forward', false);
      this.bot.setControlState('sprint', false);
    } catch { /* ignore */ }
  }
}

export default AttackContinuously;
