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

// 武器のダメージ + クールダウンテーブル
const WEAPON_STATS: Record<string, { damage: number; cooldownMs: number }> = {
    netherite_sword: { damage: 8, cooldownMs: 625 },
    diamond_sword:   { damage: 7, cooldownMs: 625 },
    iron_sword:      { damage: 6, cooldownMs: 625 },
    stone_sword:     { damage: 5, cooldownMs: 625 },
    golden_sword:    { damage: 4, cooldownMs: 625 },
    wooden_sword:    { damage: 4, cooldownMs: 625 },
    // #23 fix: 斧は攻撃力が高いがクールダウンが長い
    netherite_axe:   { damage: 10, cooldownMs: 1000 },
    diamond_axe:     { damage: 9,  cooldownMs: 1000 },
    iron_axe:        { damage: 9,  cooldownMs: 1100 },
    stone_axe:       { damage: 9,  cooldownMs: 1250 },
    golden_axe:      { damage: 7,  cooldownMs: 1000 },
    wooden_axe:      { damage: 7,  cooldownMs: 1250 },
    trident:         { damage: 9,  cooldownMs: 1100 },
    // ツルハシ等 (緊急時に使うかもしれない)
    netherite_pickaxe: { damage: 6, cooldownMs: 1200 },
    diamond_pickaxe:   { damage: 5, cooldownMs: 1200 },
    iron_pickaxe:      { damage: 4, cooldownMs: 1200 },
    stone_pickaxe:     { damage: 3, cooldownMs: 1200 },
};

const WEAPON_NAMES = new Set(Object.keys(WEAPON_STATS));

// #17 fix: 実際に足元に積めるブロック名
const PLACEABLE_BLOCKS = new Set([
    'cobblestone', 'dirt', 'stone', 'deepslate', 'netherrack',
    'sandstone', 'andesite', 'diorite', 'granite', 'tuff',
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
    'acacia_planks', 'dark_oak_planks', 'cherry_planks', 'mangrove_planks',
    'cobbled_deepslate', 'end_stone', 'sand', 'gravel',
]);

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
        const weaponStats = heldItem ? WEAPON_STATS[heldItem.name] : null;
        const weaponDamage = weaponStats?.damage ?? 1;

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
            .filter(i => PLACEABLE_BLOCKS.has(i.name))
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

        // #23 fix: 武器種別でクールダウンを変える
        const now = Date.now();
        const cooldownMs = weaponStats?.cooldownMs ?? this.config.attackCooldownMs;
        const attackCooldownReady = (now - lastAttackTime) >= cooldownMs;

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
