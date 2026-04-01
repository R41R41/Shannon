/**
 * ActionScorer — 全行動候補にスコアをつける
 */

import type { SituationVector, ScoredAction, CombatConfig } from './types.js';
import { DEFAULT_COMBAT_CONFIG } from './types.js';

export class ActionScorer {
    constructor(private config: CombatConfig = DEFAULT_COMBAT_CONFIG) {}

    score(sit: SituationVector): ScoredAction[] {
        const actions: ScoredAction[] = [];
        const nearest = sit.nearestHostile;

        // ─── 逃走 ───
        {
            let score = 0;
            const armorFactor = 1 + sit.armorPoints / 20;
            const survivalPower = sit.hp * armorFactor;

            // #12 fix: HP が低い場合は常に逃走を高スコアに
            // HP <= fleeThreshold は問答無用で逃走
            if (sit.hp <= this.config.fleeHealthThreshold) score = 2.5;
            // oneShot 敵 → 即逃走
            else if (nearest?.profile.oneShot) score = 3.0;
            // 脅威度が生存力の 40% を超えたら逃走
            else if (sit.totalThreat > survivalPower * 0.4) score = 2.0;
            // 武器なし + 敵近い
            else if (!sit.hasWeapon && nearest && nearest.distance < 6) score = 1.8;

            actions.push({ type: 'flee', score });
        }

        // ─── 通常攻撃 ───
        if (nearest && nearest.distance <= this.config.meleeRange && sit.attackCooldownReady) {
            let score = 1.0;
            score *= sit.weaponDamage / 7;
            if (sit.hasHighGround) score *= 1.3;
            if (nearest.profile.explodeRadius) score *= 0.3;
            actions.push({ type: 'attack', score, target: nearest.entity });
        }

        // ─── ジャンプ攻撃 (クリティカル) ───
        if (nearest && nearest.distance <= this.config.meleeRange && sit.attackCooldownReady && !sit.isBlocking) {
            let score = 1.2;
            score *= sit.weaponDamage / 7;
            if (nearest.profile.explodeRadius) score *= 0.2;
            actions.push({ type: 'jump-attack', score, target: nearest.entity });
        }

        // ─── 殴って後退 (クリーパー対策) ───
        if (nearest && nearest.distance <= this.config.meleeRange && sit.attackCooldownReady) {
            let score = 0.5;
            // #14: クリーパーには retreat-attack が最適
            if (nearest.profile.explodeRadius) score = 1.8;
            actions.push({ type: 'retreat-attack', score, target: nearest.entity });
        }

        // ─── 盾で防御 ───
        if (sit.hasShield && !sit.isBlocking) {
            let score = 0.3;
            if (sit.hasRangedEnemy) score = 1.4;
            if (!sit.attackCooldownReady) score = Math.max(score, 0.8);
            actions.push({ type: 'shield-block', score });
        }

        // ─── 盾解除 (攻撃のため) ───
        if (sit.isBlocking && sit.attackCooldownReady && nearest && nearest.distance <= this.config.meleeRange) {
            actions.push({ type: 'shield-release', score: 1.1 });
        }

        // ─── 弓で射撃 ───
        if (sit.hasBow && sit.arrowCount > 0 && nearest) {
            let score = 0.5;
            if (nearest.distance > this.config.meleeRange && nearest.distance < 32) score = 1.2;
            if (nearest.profile.isRanged && nearest.distance > 8) score = 1.5;
            actions.push({ type: 'shoot-bow', score, target: nearest.entity });
        }

        // ─── 横移動 (遠距離攻撃回避) ───
        if (sit.hasRangedEnemy && nearest && nearest.distance > this.config.meleeRange) {
            actions.push({ type: 'strafe', score: 0.9 });
        }

        // ─── 足元ブロック積み (高所確保) ───
        if (sit.blockCount > 0 && sit.hostiles.length >= 2 && !sit.hasHighGround) {
            actions.push({ type: 'tower', score: 1.4 });
        }

        // ─── 接近 ───
        if (nearest && nearest.distance > this.config.meleeRange && nearest.distance < 16) {
            let score = 0.6;
            if (nearest.profile.explodeRadius) score = 0.1;
            actions.push({ type: 'approach', score, target: nearest.entity });
        }

        // ─── 食事 ───
        // #26 fix: 満腹度も考慮
        if (sit.hp < 14 && sit.food < 18 && (!nearest || nearest.distance > 8)) {
            actions.push({ type: 'eat', score: 0.7 });
        }

        // ─── 待機 ───
        actions.push({ type: 'hold', score: 0.01 });

        actions.sort((a, b) => b.score - a.score);
        return actions;
    }
}
