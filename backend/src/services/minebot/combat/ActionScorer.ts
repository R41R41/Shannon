/**
 * ActionScorer — 全行動候補にスコアをつける
 *
 * SituationVector を入力とし、各行動のスコアを算出。
 * 最高スコアの行動が実行される。
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

            // 脅威度が生存力を超えたら逃走
            if (sit.totalThreat > survivalPower * 0.4) score = 2.0;
            // HP 低下
            if (sit.hp <= this.config.fleeHealthThreshold) score = Math.max(score, 2.5);
            // 武器なし + 敵近い
            if (!sit.hasWeapon && nearest && nearest.distance < 6) score = Math.max(score, 1.8);
            // ワンショットキル敵
            if (nearest?.profile.oneShot) score = 3.0;

            actions.push({ type: 'flee', score });
        }

        // ─── 通常攻撃 ───
        if (nearest && nearest.distance <= this.config.meleeRange && sit.attackCooldownReady) {
            let score = 1.0;
            score *= sit.weaponDamage / 7; // 武器ダメージ正規化
            if (sit.hasHighGround) score *= 1.3;
            // クリーパーには使わない（爆発距離に入る）
            if (nearest.profile.explodeRadius) score *= 0.3;
            actions.push({ type: 'attack', score, target: nearest.entity });
        }

        // ─── ジャンプ攻撃 (クリティカル) ───
        if (nearest && nearest.distance <= this.config.meleeRange && sit.attackCooldownReady && !sit.isBlocking) {
            let score = 1.2;
            score *= sit.weaponDamage / 7;
            if (nearest.profile.explodeRadius) score *= 0.2; // クリーパーには不向き
            actions.push({ type: 'jump-attack', score, target: nearest.entity });
        }

        // ─── 殴って後退 (クリーパー対策) ───
        if (nearest && nearest.distance <= this.config.meleeRange && sit.attackCooldownReady) {
            let score = 0.5;
            if (nearest.profile.explodeRadius) score = 1.8; // クリーパーには最適
            actions.push({ type: 'retreat-attack', score, target: nearest.entity });
        }

        // ─── 盾で防御 ───
        if (sit.hasShield && !sit.isBlocking) {
            let score = 0.3;
            // 遠距離敵がいる → 盾優先
            if (sit.hasRangedEnemy) score = 1.4;
            // クールダウン中 → 盾を構えるべき
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
            // 遠距離で近接できない場合
            if (nearest.distance > this.config.meleeRange && nearest.distance < 32) score = 1.2;
            // ブレイズ等には弓が有効
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
            // クリーパーには近づきたくない
            if (nearest.profile.explodeRadius) score = 0.1;
            actions.push({ type: 'approach', score, target: nearest.entity });
        }

        // ─── 食事 ───
        if (sit.hp < 14 && sit.food > 0 && (!nearest || nearest.distance > 8)) {
            actions.push({ type: 'eat', score: 0.7 });
        }

        // ─── 待機 (クールダウン待ち) ───
        actions.push({ type: 'hold', score: 0.01 });

        // スコア降順でソート
        actions.sort((a, b) => b.score - a.score);
        return actions;
    }
}
