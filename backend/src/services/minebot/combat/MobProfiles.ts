/**
 * Minecraft 敵モブのプロファイル
 *
 * 各モブのダメージ、速度、攻撃タイプを定義。
 * CombatController の脅威度評価とスコアリングに使用。
 */

import type { MobProfile } from './types.js';

export const MOB_PROFILES: Record<string, MobProfile> = {
    // ─── アンデッド (近接) ───
    zombie:            { damage: 3,  speed: 0.23, isRanged: false, canBurn: true },
    husk:              { damage: 3,  speed: 0.23, isRanged: false, canBurn: false },
    drowned:           { damage: 3,  speed: 0.23, isRanged: false },
    zombie_villager:   { damage: 3,  speed: 0.23, isRanged: false, canBurn: true },

    // ─── アンデッド (遠距離) ───
    skeleton:          { damage: 4,  speed: 0.25, isRanged: true, projectileSpeed: 1.6 },
    stray:             { damage: 4,  speed: 0.25, isRanged: true, projectileSpeed: 1.6 },
    wither_skeleton:   { damage: 10, speed: 0.25, isRanged: false },

    // ─── クリーパー (爆発) ───
    creeper:           { damage: 22, speed: 0.25, isRanged: false, explodeRadius: 3 },

    // ─── 節足動物 ───
    spider:            { damage: 2,  speed: 0.3,  isRanged: false, canClimb: true },
    cave_spider:       { damage: 2,  speed: 0.3,  isRanged: false, canClimb: true },

    // ─── ネザー ───
    blaze:             { damage: 5,  speed: 0.23, isRanged: true, projectileSpeed: 1.0 },
    ghast:             { damage: 6,  speed: 0.1,  isRanged: true, projectileSpeed: 1.0 },
    magma_cube:        { damage: 3,  speed: 0.2,  isRanged: false },
    hoglin:            { damage: 6,  speed: 0.3,  isRanged: false },
    zoglin:            { damage: 8,  speed: 0.3,  isRanged: false },
    piglin_brute:      { damage: 13, speed: 0.35, isRanged: false },
    piglin:            { damage: 5,  speed: 0.35, isRanged: true },
    zombified_piglin:  { damage: 5,  speed: 0.23, isRanged: false },

    // ─── エンド ───
    enderman:          { damage: 7,  speed: 0.3,  isRanged: false, teleports: true },
    endermite:         { damage: 2,  speed: 0.25, isRanged: false },
    shulker:           { damage: 4,  speed: 0,    isRanged: true, projectileSpeed: 0.5 },

    // ─── 襲撃 ───
    pillager:          { damage: 4,  speed: 0.35, isRanged: true, projectileSpeed: 1.6 },
    vindicator:        { damage: 13, speed: 0.35, isRanged: false },
    evoker:            { damage: 6,  speed: 0.5,  isRanged: true },
    vex:               { damage: 9,  speed: 0.7,  isRanged: false },
    ravager:           { damage: 12, speed: 0.3,  isRanged: false },

    // ─── その他 ───
    witch:             { damage: 0,  speed: 0.25, isRanged: true, heals: true },
    slime:             { damage: 2,  speed: 0.3,  isRanged: false },
    phantom:           { damage: 2,  speed: 0.5,  isRanged: false },
    silverfish:        { damage: 1,  speed: 0.25, isRanged: false },
    guardian:           { damage: 6,  speed: 0.5,  isRanged: true },
    elder_guardian:     { damage: 8,  speed: 0.3,  isRanged: true },

    // ─── ボス ───
    warden:            { damage: 30, speed: 0.31, isRanged: false, oneShot: true },
    wither:            { damage: 8,  speed: 0.6,  isRanged: true, projectileSpeed: 1.0 },
    ender_dragon:      { damage: 10, speed: 0.5,  isRanged: false },
};

export const DEFAULT_PROFILE: MobProfile = {
    damage: 3,
    speed: 0.25,
    isRanged: false,
};

export function getMobProfile(name: string): MobProfile {
    return MOB_PROFILES[name.toLowerCase()] ?? DEFAULT_PROFILE;
}

/** 敵対的モブかどうか */
export function isHostileMob(name: string): boolean {
    return name.toLowerCase() in MOB_PROFILES;
}
