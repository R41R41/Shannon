import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { shouldRefuseAggressiveCombat } from '../utils/minebotToolPolicy.js';
import { setMovements } from '../utils/setMovements.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:combat');

/**
 * 戦闘スキル: 敵を追いかけながら倒すまで攻撃
 * - 適切な距離を保ちながら追跡
 * - 武器がなければ戦わない
 * - 敵を倒すか、タイムアウトまで継続
 */
class Combat extends InstantSkill {
    constructor(bot: CustomBot) {
        super(bot);
        this.skillName = 'combat';
        this.description = '指定した敵を追いかけながら倒すまで攻撃します。武器が必要です。';
        this.params = [
            {
                name: 'target',
                type: 'string',
                description: '攻撃対象のエンティティ名（例: "zombie", "husk"）。省略時は最も近い敵',
            },
            {
                name: 'timeout',
                type: 'number',
                description: 'タイムアウト時間（秒、デフォルト: 30秒）',
                default: 30,
            },
        ];
    }

    /**
     * 武器を持っているかチェック
     */
    private hasWeapon(): { hasWeapon: boolean; weaponName: string | null } {
        const weapons = [
            'netherite_sword', 'diamond_sword', 'iron_sword', 'golden_sword', 'stone_sword', 'wooden_sword',
            'netherite_axe', 'diamond_axe', 'iron_axe', 'golden_axe', 'stone_axe', 'wooden_axe',
            'trident',
        ];

        const heldItem = this.bot.heldItem;
        if (heldItem && weapons.some(w => heldItem.name.includes(w))) {
            return { hasWeapon: true, weaponName: heldItem.name };
        }

        return { hasWeapon: false, weaponName: null };
    }

    /**
     * インベントリから武器を探して装備
     */
    private async equipWeapon(): Promise<{ success: boolean; weaponName: string | null }> {
        const weapons = [
            'netherite_sword', 'diamond_sword', 'iron_sword', 'golden_sword', 'stone_sword', 'wooden_sword',
            'netherite_axe', 'diamond_axe', 'iron_axe', 'golden_axe', 'stone_axe', 'wooden_axe',
        ];

        for (const weaponName of weapons) {
            const weapon = this.bot.inventory.items().find(item => item.name === weaponName);
            if (weapon) {
                try {
                    await this.bot.equip(weapon, 'hand');
                    return { success: true, weaponName: weapon.name };
                } catch (e) {
                    continue;
                }
            }
        }

        return { success: false, weaponName: null };
    }

    /**
     * インベントリから最良の防具を装備する
     */
    private async equipBestArmor(): Promise<string[]> {
        const equipped: string[] = [];
        const ARMOR_TIERS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather'];

        const ARMOR_SLOTS: Array<{ slot: 'head' | 'torso' | 'legs' | 'feet'; suffix: string }> = [
            { slot: 'head', suffix: '_helmet' },
            { slot: 'torso', suffix: '_chestplate' },
            { slot: 'legs', suffix: '_leggings' },
            { slot: 'feet', suffix: '_boots' },
        ];

        for (const { slot, suffix } of ARMOR_SLOTS) {
            const currentSlotItem = this.bot.inventory.slots[this.bot.getEquipmentDestSlot(slot)];

            for (const tier of ARMOR_TIERS) {
                const armorName = tier + suffix;
                // 既に同等以上の防具を装備中ならスキップ
                if (currentSlotItem?.name === armorName) break;

                const item = this.bot.inventory.items().find(i => i.name === armorName);
                if (item) {
                    try {
                        await this.bot.equip(item, slot);
                        equipped.push(armorName);
                    } catch { /* skip */ }
                    break;
                }
            }
        }

        // 盾を off-hand に装備
        const shield = this.bot.inventory.items().find(i => i.name === 'shield');
        const offHandSlot = this.bot.inventory.slots[this.bot.getEquipmentDestSlot('off-hand')];
        if (shield && offHandSlot?.name !== 'shield') {
            try {
                await this.bot.equip(shield, 'off-hand');
                equipped.push('shield');
            } catch { /* skip */ }
        }

        return equipped;
    }

    /**
     * 敵対的なMobかチェック
     */
    private isHostile(entityName: string): boolean {
        const hostileMobs = [
            'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'creeper', 'spider',
            'enderman', 'witch', 'slime', 'magma_cube', 'phantom', 'blaze', 'ghast',
            'zombified_piglin', 'piglin', 'piglin_brute', 'hoglin', 'zoglin',
            'wither_skeleton', 'wither', 'cave_spider', 'silverfish', 'endermite',
            'guardian', 'elder_guardian', 'shulker', 'vindicator', 'evoker', 'vex',
            'pillager', 'ravager', 'warden',
        ];
        return hostileMobs.some(mob => entityName.toLowerCase().includes(mob));
    }

    private scanRemainingEntities(targetFilter: string | undefined, maxDistance: number): string | null {
        try {
            const remaining: Array<{ name: string; dist: number; x: number; y: number; z: number }> = [];
            for (const entity of Object.values(this.bot.entities)) {
                if (!entity || !entity.position || !entity.isValid) continue;
                if (entity === this.bot.entity) continue;
                const name = entity.name?.toLowerCase() || '';
                if (!name) continue;
                const d = entity.position.distanceTo(this.bot.entity.position);
                if (d > maxDistance) continue;

                const match = targetFilter
                    ? name.includes(targetFilter.toLowerCase())
                    : this.isHostile(name);
                if (!match) continue;

                remaining.push({
                    name: entity.name || name,
                    dist: Math.round(d * 10) / 10,
                    x: Math.floor(entity.position.x),
                    y: Math.floor(entity.position.y),
                    z: Math.floor(entity.position.z),
                });
            }

            if (remaining.length === 0) return null;

            remaining.sort((a, b) => a.dist - b.dist);
            const shown = remaining.slice(0, 5);
            const list = shown.map(e => `${e.name}(${e.x},${e.y},${e.z}) ${e.dist}m`).join(', ');
            const more = remaining.length > 5 ? `ほか${remaining.length - 5}体` : '';
            return `周囲にまだ${remaining.length}体: ${list}${more ? ', ' + more : ''}`;
        } catch {
            return null;
        }
    }

    async runImpl(target?: string, timeout: number = 30) {
        try {
            const refuse = shouldRefuseAggressiveCombat(this.bot);
            if (refuse) {
                return { success: false, result: refuse };
            }
            // 武器チェック
            let { hasWeapon, weaponName } = this.hasWeapon();
            if (!hasWeapon) {
                // 武器を装備しようとする
                const equipResult = await this.equipWeapon();
                if (!equipResult.success) {
                    return {
                        success: false,
                        result: '武器がありません。戦闘には武器が必要です。',
                    };
                }
                weaponName = equipResult.weaponName;
                log.success(`🗡️ ${weaponName}を装備しました`);
            }

            // 防具を自動装備
            const armorEquipped = await this.equipBestArmor();
            if (armorEquipped.length > 0) {
                log.success(`🛡️ 防具装備: ${armorEquipped.join(', ')}`);
            }

            // ターゲットを探す
            const findEnemy = () => {
                return this.bot.nearestEntity((entity) => {
                    if (!entity || !entity.position || !entity.isValid) return false;

                    const entityName = entity.name?.toLowerCase() || '';

                    // 特定のターゲットが指定されている場合
                    if (target) {
                        return entityName.includes(target.toLowerCase());
                    }

                    // 指定がなければ敵対的なMobを探す
                    return this.isHostile(entityName);
                });
            };

            let enemy = findEnemy();
            if (!enemy) {
                return {
                    success: false,
                    result: target
                        ? `${target}が見つかりません`
                        : '周囲に敵対的なモブがいません',
                };
            }

            const enemyName = enemy.name || 'unknown';
            log.warn(`⚔️ ${enemyName}との戦闘開始！（${weaponName}使用）`);

            // pathfinderの移動設定（戦闘用）
            setMovements(
                this.bot,
                false, // allow1by1towers
                true,  // allowSprinting
                true,  // allowParkour
                true,  // canOpenDoors
                false, // canDig
                true,  // dontMineUnderFallingBlock
                100,   // digCost
                false  // allowFreeMotion
            );

            const startTime = Date.now();
            const timeoutMs = timeout * 1000;
            let attackCount = 0;
            const ATTACK_RANGE = 3.5;
            const CHASE_RANGE = 2.5;

            while (Date.now() - startTime < timeoutMs) {
                // 敵を再検索（死んだ場合など）
                enemy = findEnemy();
                if (!enemy || !enemy.isValid) {
                    log.success(`✅ ${enemyName}を倒しました！`);
                    this.bot.pathfinder.stop();
                    const remaining = this.scanRemainingEntities(target, 16);
                    const baseMsg = `${enemyName}を${weaponName}で${attackCount}回攻撃して倒しました`;
                    return {
                        success: true,
                        result: remaining ? `${baseMsg}。${remaining}` : baseMsg,
                    };
                }

                const distance = enemy.position.distanceTo(this.bot.entity.position);

                if (distance <= ATTACK_RANGE) {
                    // 攻撃範囲内
                    // pathfinderを停止
                    this.bot.pathfinder.stop();

                    // 敵を見る
                    await this.bot.lookAt(enemy.position.offset(0, enemy.height * 0.8, 0));

                    // 攻撃
                    try {
                        await this.bot.attack(enemy);
                        attackCount++;
                    } catch (e) {
                        // 攻撃失敗は無視
                    }

                    // 攻撃クールダウン
                    await new Promise(resolve => setTimeout(resolve, 500));
                } else {
                    // 追いかける
                    const goal = new goals.GoalFollow(enemy, CHASE_RANGE);

                    try {
                        this.bot.pathfinder.setGoal(goal, true); // dynamic = true
                    } catch (e) {
                        // pathfinder エラーは無視
                    }

                    // 少し待つ
                    await new Promise(resolve => setTimeout(resolve, 200));
                }

                // HPが危険な場合は撤退
                if (this.bot.health < 6) {
                    this.bot.pathfinder.stop();
                    log.warn('⚠️ HP危険！戦闘中断');
                    return {
                        success: false,
                        result: `HP危険（${this.bot.health.toFixed(1)}/20）のため戦闘中断。${enemyName}を${attackCount}回攻撃しました。`,
                    };
                }
            }

            // タイムアウト
            this.bot.pathfinder.stop();
            const remaining = this.scanRemainingEntities(target, 16);
            const baseMsg = `タイムアウト。${enemyName}を${attackCount}回攻撃しましたが、まだ生きています。`;
            return {
                success: true,
                result: remaining ? `${baseMsg} ${remaining}` : baseMsg,
            };

        } catch (error: any) {
            try {
                this.bot.pathfinder.stop();
            } catch (e) {
                // ignore
            }
            return {
                success: false,
                result: `戦闘エラー: ${error.message}`,
            };
        }
    }
}

export default Combat;

