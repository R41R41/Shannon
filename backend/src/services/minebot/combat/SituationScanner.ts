/**
 * SituationScanner — 戦闘状況を数値化
 *
 * 200ms 周期で呼ばれ、SituationVector を返す。
 * 全ての判断はこの数値ベクトルに基づいて行われる。
 */

import type { CustomBot } from '../types/CustomBot.js';
import { getMobProfile, isHostileMob } from './MobProfiles.js';
import type { SituationVector, HostileInfo, CombatConfig } from './types.js';
import { DEFAULT_COMBAT_CONFIG } from './types.js';

// 武器のダメージテーブル
const WEAPON_DAMAGE: Record<string, number> = {
    netherite_sword: 8, diamond_sword: 7, iron_sword: 6, stone_sword: 5, golden_sword: 4, wooden_sword: 4,
    netherite_axe: 10, diamond_axe: 9, iron_axe: 9, stone_axe: 9, golden_axe: 7, wooden_axe: 7,
    trident: 9,
};

const WEAPON_NAMES = new Set(Object.keys(WEAPON_DAMAGE));

export class SituationScanner {
    constructor(
        private bot: CustomBot,
        private config: CombatConfig = DEFAULT_COMBAT_CONFIG,
    ) {}

    scan(lastAttackTime: number, isBlocking: boolean): SituationVector {
        const hostiles = this.scanHostiles();
        const nearest = hostiles.length > 0 ? hostiles[0] : null;
        const totalThreat = hostiles.reduce((sum, h) => sum + h.threat, 0);

        // 自分の装備
        const heldItem = this.bot.heldItem;
        const hasWeapon = heldItem ? WEAPON_NAMES.has(heldItem.name) : false;
        const weaponDamage = heldItem ? (WEAPON_DAMAGE[heldItem.name] ?? 1) : 1;

        // 盾
        const offHand = this.bot.inventory.slots[this.bot.getEquipmentDestSlot('off-hand')];
        const hasShield = offHand?.name === 'shield'
            || this.bot.inventory.items().some(i => i.name === 'shield');

        // 弓・矢
        const hasBow = this.bot.inventory.items().some(i => i.name === 'bow' || i.name === 'crossbow');
        const arrowCount = this.bot.inventory.items()
            .filter(i => i.name === 'arrow' || i.name === 'spectral_arrow' || i.name === 'tipped_arrow')
            .reduce((sum, i) => sum + i.count, 0);

        // ブロック数 (足元に積める)
        const blockCount = this.bot.inventory.items()
            .filter(i => i.name.includes('cobblestone') || i.name.includes('dirt') || i.name.includes('planks') || i.name.includes('stone'))
            .reduce((sum, i) => sum + i.count, 0);

        // 防御力 (簡易計算)
        const armorPoints = this.calcArmorPoints();

        // 地形
        const pos = this.bot.entity.position;
        const blockBelow = this.bot.blockAt(pos.offset(0, -1, 0));
        const hasHighGround = hostiles.some(h =>
            h.entity.position.y < pos.y - 0.5
        );
        const inWater = this.bot.entity.isInWater;

        // 攻撃クールダウン
        const now = Date.now();
        const attackCooldownReady = (now - lastAttackTime) >= this.config.attackCooldownMs;

        return {
            hp: this.bot.health,
            food: this.bot.food,
            armorPoints,
            hasShield,
            hasWeapon,
            weaponDamage,
            hasBow,
            arrowCount,
            blockCount,
            hostiles,
            nearestHostile: nearest,
            totalThreat,
            hasRangedEnemy: hostiles.some(h => h.profile.isRanged),
            hasHighGround,
            inWater,
            attackCooldownReady,
            isBlocking,
            lastAttackTime,
        };
    }

    private scanHostiles(): HostileInfo[] {
        const hostiles: HostileInfo[] = [];

        for (const entity of Object.values(this.bot.entities)) {
            if (!entity || !entity.position || !entity.isValid) continue;
            const name = entity.name?.toLowerCase() ?? '';
            if (!isHostileMob(name)) continue;

            const distance = this.bot.entity.position.distanceTo(entity.position);
            if (distance > this.config.scanRadius) continue;

            const profile = getMobProfile(name);
            const threat = this.calcThreat(profile, distance);

            hostiles.push({ entity, name, distance, profile, threat });
        }

        // 距離順にソート
        hostiles.sort((a, b) => a.distance - b.distance);
        return hostiles;
    }

    private calcThreat(profile: MobProfile, distance: number): number {
        // 脅威度 = ダメージ × (1 / 距離の影響) × 特殊係数
        const distFactor = Math.max(0.1, 1 - distance / this.config.scanRadius);
        let threat = profile.damage * distFactor;

        if (profile.oneShot) threat *= 5;
        if (profile.explodeRadius) threat *= 2;
        if (profile.isRanged) threat *= 1.3;
        if (profile.teleports) threat *= 1.5;

        return threat;
    }

    private calcArmorPoints(): number {
        // 簡易: 装備スロットの名前からポイントを推定
        let points = 0;
        const slots = ['head', 'torso', 'legs', 'feet'] as const;
        const slotIndices = slots.map(s => this.bot.getEquipmentDestSlot(s));

        for (const idx of slotIndices) {
            const item = this.bot.inventory.slots[idx];
            if (!item) continue;
            const name = item.name;
            if (name.includes('netherite')) points += 4;
            else if (name.includes('diamond')) points += 3.5;
            else if (name.includes('iron')) points += 2.5;
            else if (name.includes('chainmail')) points += 2;
            else if (name.includes('golden')) points += 1.5;
            else if (name.includes('leather')) points += 1;
        }
        return Math.min(20, points);
    }
}
