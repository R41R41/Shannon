/**
 * CombatController 型定義
 */

import type { Entity } from 'prismarine-entity';
import type { Vec3 } from 'vec3';

// ─── 敵情報 ───

export interface MobProfile {
    damage: number;
    speed: number;
    isRanged: boolean;
    projectileSpeed?: number;
    explodeRadius?: number;
    canBurn?: boolean;
    canClimb?: boolean;
    teleports?: boolean;
    heals?: boolean;
    oneShot?: boolean;
}

export interface HostileInfo {
    entity: Entity;
    name: string;
    distance: number;
    profile: MobProfile;
    threat: number;
}

// ─── 状況ベクトル ───

export interface SituationVector {
    // 自分
    hp: number;
    food: number;
    armorPoints: number;
    hasShield: boolean;
    hasWeapon: boolean;
    weaponDamage: number;
    hasBow: boolean;
    arrowCount: number;
    blockCount: number;

    // 敵
    hostiles: HostileInfo[];
    nearestHostile: HostileInfo | null;
    totalThreat: number;
    hasRangedEnemy: boolean;

    // 地形
    hasHighGround: boolean;
    inWater: boolean;

    // 戦闘状態
    attackCooldownReady: boolean;
    isBlocking: boolean;
    lastAttackTime: number;
}

// ─── 行動 ───

export type ActionType =
    | 'attack'
    | 'jump-attack'
    | 'retreat-attack'
    | 'shield-block'
    | 'shield-release'
    | 'shoot-bow'
    | 'flee'
    | 'strafe'
    | 'tower'
    | 'eat'
    | 'approach'
    | 'hold';

export interface ScoredAction {
    type: ActionType;
    score: number;
    target?: Entity;
    direction?: Vec3;
}

// ─── コントローラ設定 ───

export interface CombatConfig {
    tickIntervalMs: number;
    meleeRange: number;
    attackCooldownMs: number;
    fleeHealthThreshold: number;
    maxDurationMs: number;
    scanRadius: number;
}

export const DEFAULT_COMBAT_CONFIG: CombatConfig = {
    tickIntervalMs: 500,
    meleeRange: 3.5,
    attackCooldownMs: 625,   // 剣のクールダウン
    fleeHealthThreshold: 6,
    maxDurationMs: 120_000,  // 2分
    scanRadius: 16,
};
