import { createLogger } from '../../../utils/logger.js';
import { ConstantSkill, CustomBot } from '../types.js';

const log = createLogger('Minebot:Skill:autoEquipWeapon');

/**
 * 武器自動装備 ConstantSkill
 *
 * 敵が近づいてきた時、インベントリから最強の武器を自動装備。
 * 優先順: netherite > diamond > iron > stone > golden > wooden (剣 > 斧)
 */
class AutoEquipWeapon extends ConstantSkill {
    private readonly EQUIP_RANGE = 10;

    private readonly HOSTILE_MOBS = new Set([
        'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'creeper', 'spider',
        'cave_spider', 'enderman', 'witch', 'phantom', 'pillager',
        'vindicator', 'piglin_brute', 'warden',
    ]);

    // 優先順位順（先頭が最強）
    private readonly WEAPON_PRIORITY = [
        'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
        'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe',
    ];

    constructor(bot: CustomBot) {
        super(bot);
        this.skillName = 'auto-equip-weapon';
        this.description = '敵が近づいてきた時に自動で最強の武器を装備する';
        this.interval = 1000;
        this.priority = 8;
        this.status = true;
        this.containMovement = false;
        this.isCritical = false;
    }

    async runImpl() {
        // 近くの敵を検知
        const nearbyHostiles = Object.values(this.bot.entities).filter(entity => {
            if (!entity || !entity.position || !entity.isValid) return false;
            const name = entity.name?.toLowerCase() ?? '';
            if (!this.HOSTILE_MOBS.has(name)) return false;
            return this.bot.entity.position.distanceTo(entity.position) <= this.EQUIP_RANGE;
        });

        if (nearbyHostiles.length === 0) return;

        // 現在の手持ちアイテムが既に武器か
        const heldItem = this.bot.heldItem;
        if (heldItem) {
            const heldIndex = this.WEAPON_PRIORITY.indexOf(heldItem.name);
            if (heldIndex === 0) return; // 既に最強武器を装備中
        }

        // インベントリから最強武器を検索
        for (const weaponName of this.WEAPON_PRIORITY) {
            const weapon = this.bot.inventory.items().find(item => item.name === weaponName);
            if (weapon) {
                // 既に装備中ならスキップ
                if (heldItem?.name === weaponName) return;

                try {
                    await this.bot.equip(weapon, 'hand');
                    log.info(`🗡️ ${weaponName}を自動装備 (敵${nearbyHostiles.length}体, 最寄り${nearbyHostiles[0].name})`);
                    return;
                } catch {
                    // 装備失敗は次の武器を試す
                    continue;
                }
            }
        }
    }
}

export default AutoEquipWeapon;
