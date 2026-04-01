import { createLogger } from '../../../utils/logger.js';
import { ConstantSkill, CustomBot } from '../types.js';

const log = createLogger('Minebot:Skill:autoShield');

/**
 * 盾自動使用 ConstantSkill
 *
 * 敵が近くにいる時、盾をオフハンドに装備して防御姿勢を取る。
 * 盾がなければスキップ。
 */
class AutoShield extends ConstantSkill {
    private readonly SHIELD_RANGE = 6;
    private shieldEquipped = false;

    private readonly HOSTILE_MOBS = new Set([
        'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'creeper', 'spider',
        'cave_spider', 'pillager', 'vindicator', 'piglin_brute',
    ]);

    constructor(bot: CustomBot) {
        super(bot);
        this.skillName = 'auto-shield';
        this.description = '敵が近くにいる時に自動で盾を装備する';
        this.interval = 1000;
        this.priority = 8;
        this.status = false; // デフォルト無効（盾を持っていない場合が多い）
        this.containMovement = false;
        this.isCritical = false;
    }

    async runImpl() {
        // 盾がインベントリにあるか
        const shield = this.bot.inventory.items().find(i => i.name === 'shield');
        const offHand = this.bot.inventory.slots[this.bot.getEquipmentDestSlot('off-hand')];
        const hasShieldEquipped = offHand?.name === 'shield';

        // 近くの敵を検知
        const nearbyHostiles = Object.values(this.bot.entities).filter(entity => {
            if (!entity || !entity.position || !entity.isValid) return false;
            const name = entity.name?.toLowerCase() ?? '';
            if (!this.HOSTILE_MOBS.has(name)) return false;
            return this.bot.entity.position.distanceTo(entity.position) <= this.SHIELD_RANGE;
        });

        if (nearbyHostiles.length > 0 && !hasShieldEquipped && shield) {
            // 盾を装備
            try {
                await this.bot.equip(shield, 'off-hand');
                this.shieldEquipped = true;
                log.info(`🛡️ 盾を自動装備 (敵${nearbyHostiles.length}体検知)`);
            } catch {
                // 装備失敗は無視
            }
        }
    }
}

export default AutoShield;
