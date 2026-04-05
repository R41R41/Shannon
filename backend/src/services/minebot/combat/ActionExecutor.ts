/**
 * ActionExecutor — スコアリング結果の行動を実行
 */

import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import type { CustomBot } from '../types/CustomBot.js';
import type { ScoredAction, CombatConfig } from './types.js';
import { DEFAULT_COMBAT_CONFIG } from './types.js';
import type { Entity } from 'prismarine-entity';
import { pickSaferFleeYaw } from '../utils/fleeGroundSafety.js';

const log = createLogger('Minebot:Combat:Executor');

export class ActionExecutor {
    private strafeDirection = 1;

    constructor(
        private bot: CustomBot,
        private config: CombatConfig = DEFAULT_COMBAT_CONFIG,
    ) {}

    async execute(action: ScoredAction): Promise<{ attacked: boolean }> {
        let attacked = false;

        try {
            switch (action.type) {
                case 'attack':
                    attacked = await this.meleeAttack(action.target!);
                    break;
                case 'jump-attack':
                    attacked = await this.jumpAttack(action.target!);
                    break;
                case 'retreat-attack':
                    attacked = await this.retreatAttack(action.target!);
                    break;
                case 'shield-block':
                    await this.shieldBlock();
                    break;
                case 'shield-release':
                    await this.shieldRelease();
                    break;
                case 'shoot-bow':
                    await this.shootBow(action.target!);
                    break;
                case 'flee':
                    await this.flee();
                    break;
                case 'strafe':
                    await this.strafe();
                    break;
                case 'tower':
                    await this.tower();
                    break;
                case 'approach':
                    await this.approach(action.target!);
                    break;
                case 'eat':
                    await this.eat();
                    break;
                case 'hold':
                    // 何もしない
                    break;
            }
        } catch (e) {
            // #29 fix: エラーログ
            log.warn(`⚠ ${action.type} 失敗: ${e instanceof Error ? e.message : e}`);
        }

        return { attacked };
    }

    private async meleeAttack(target: Entity): Promise<boolean> {
        try {
            // #13 fix: 攻撃前に距離再チェック
            const dist = this.bot.entity.position.distanceTo(target.position);
            if (dist > this.config.meleeRange + 0.5) return false;

            await this.bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true);
            await this.bot.attack(target);
            return true;
        } catch (e) {
            log.warn(`⚠ meleeAttack: ${e instanceof Error ? e.message : e}`);
            return false;
        }
    }

    private async jumpAttack(target: Entity): Promise<boolean> {
        try {
            const dist = this.bot.entity.position.distanceTo(target.position);
            if (dist > this.config.meleeRange + 0.5) return false;

            // #8 fix: ジャンプして落下中 (velocity.y < 0) に攻撃 = クリティカル
            this.bot.setControlState('jump', true);
            // ジャンプの頂点を待つ (約 200ms)
            await new Promise(r => setTimeout(r, 200));
            this.bot.setControlState('jump', false);
            // 落下開始を待つ
            await new Promise(r => setTimeout(r, 50));

            await this.bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true);
            await this.bot.attack(target);
            return true;
        } catch (e) {
            log.warn(`⚠ jumpAttack: ${e instanceof Error ? e.message : e}`);
            return false;
        }
    }

    private async retreatAttack(target: Entity): Promise<boolean> {
        try {
            const dist = this.bot.entity.position.distanceTo(target.position);
            if (dist > this.config.meleeRange + 0.5) return false;

            await this.bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true);
            await this.bot.attack(target);

            // #4 fix: setTimeout ではなく await で後退。次の tick とレースしない
            this.bot.setControlState('back', true);
            this.bot.setControlState('sprint', true);
            // #14 fix: クリーパー対策で 700ms 後退 (約4ブロック)
            await new Promise(r => setTimeout(r, 700));
            this.bot.setControlState('back', false);
            this.bot.setControlState('sprint', false);
            return true;
        } catch (e) {
            log.warn(`⚠ retreatAttack: ${e instanceof Error ? e.message : e}`);
            return false;
        }
    }

    private async shieldBlock(): Promise<void> {
        try {
            const offHand = this.bot.inventory.slots[this.bot.getEquipmentDestSlot('off-hand')];
            if (offHand?.name === 'shield') {
                this.bot.activateItem(true);
            } else {
                const shield = this.bot.inventory.items().find(i => i.name === 'shield');
                if (shield) {
                    await this.bot.equip(shield, 'off-hand');
                    this.bot.activateItem(true);
                }
            }
        } catch (e) {
            log.warn(`⚠ shieldBlock: ${e instanceof Error ? e.message : e}`);
        }
    }

    private async shieldRelease(): Promise<void> {
        try {
            this.bot.deactivateItem();
        } catch {}
    }

    private async shootBow(target: Entity): Promise<void> {
        try {
            const bow = this.bot.inventory.items().find(i => i.name === 'bow' || i.name === 'crossbow');
            if (!bow) return;
            await this.bot.equip(bow, 'hand');
            await this.bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true);
            this.bot.activateItem(false);
            // #10 fix: フルチャージ 1200ms (弓), 1250ms (クロスボウ)
            const chargeMs = bow.name === 'crossbow' ? 1250 : 1200;
            await new Promise(r => setTimeout(r, chargeMs));
            this.bot.deactivateItem();
        } catch (e) {
            log.warn(`⚠ shootBow: ${e instanceof Error ? e.message : e}`);
        }
    }

    private async flee(): Promise<void> {
        try {
            const hostiles = Object.values(this.bot.entities)
                .filter(e => e && e.position && e.type === 'hostile');

            if (hostiles.length > 0) {
                // #11 fix: まず簡易ベクトル逃走 (即座に動く)
                const avgX = hostiles.reduce((s, e) => s + e.position.x, 0) / hostiles.length;
                const avgZ = hostiles.reduce((s, e) => s + e.position.z, 0) / hostiles.length;
                const botPos = this.bot.entity.position;
                const dx = botPos.x - avgX;
                const dz = botPos.z - avgZ;
                const len = Math.sqrt(dx * dx + dz * dz) || 1;
                const idealYaw = Math.atan2(-dx / len, -dz / len);
                const fleeYaw = pickSaferFleeYaw(this.bot, idealYaw);
                await this.bot.look(fleeYaw, 0, true);
                this.bot.setControlState('forward', true);
                this.bot.setControlState('sprint', true);
                // 2秒間全力で逃走（足元安全な向きに矯正済み）
                await new Promise(r => setTimeout(r, 2000));
                this.bot.setControlState('forward', false);
                this.bot.setControlState('sprint', false);
            }
        } catch (e) {
            log.warn(`⚠ flee: ${e instanceof Error ? e.message : e}`);
        }
    }

    private async strafe(): Promise<void> {
        try {
            // #5 fix: await で完了を待つ
            this.strafeDirection *= -1;
            const dir = this.strafeDirection > 0 ? 'left' : 'right';
            this.bot.setControlState(dir as any, true);
            await new Promise(r => setTimeout(r, 300));
            this.bot.setControlState(dir as any, false);
        } catch (e) {
            log.warn(`⚠ strafe: ${e instanceof Error ? e.message : e}`);
        }
    }

    private async tower(): Promise<void> {
        try {
            const blocks = this.bot.inventory.items().find(i =>
                ['cobblestone', 'dirt', 'oak_planks', 'spruce_planks', 'birch_planks',
                 'stone', 'deepslate', 'netherrack', 'sandstone', 'andesite',
                 'diorite', 'granite', 'tuff'].includes(i.name)
            );
            if (!blocks) return;

            await this.bot.equip(blocks, 'hand');

            // 足元のブロックを先に取得（ジャンプ前）
            const below = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
            if (!below) return;

            // ジャンプ開始
            this.bot.setControlState('jump', true);

            // 上昇中にブロック設置を試みる（50msごとにリトライ）
            let placed = false;
            for (let i = 0; i < 8 && !placed; i++) {
                await new Promise(r => setTimeout(r, 50));
                // velocity.y > 0 の間（上昇中）に設置
                if (this.bot.entity.velocity.y > 0.1) {
                    try {
                        await this.bot.placeBlock(below, new Vec3(0, 1, 0));
                        placed = true;
                    } catch { /* retry */ }
                }
            }
            this.bot.setControlState('jump', false);

            if (!placed) {
                // フォールバック: 着地後に再試行
                await new Promise(r => setTimeout(r, 200));
                const belowNow = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
                if (belowNow) {
                    try { await this.bot.placeBlock(belowNow, new Vec3(0, 1, 0)); } catch { /* ignore */ }
                }
            }
        } catch (e) {
            log.warn(`⚠ tower: ${e instanceof Error ? e.message : e}`);
        }
    }

    private async approach(target: Entity): Promise<void> {
        try {
            await this.bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true);
            this.bot.setControlState('forward', true);
            this.bot.setControlState('sprint', true);
            await new Promise(r => setTimeout(r, 400));
            this.bot.setControlState('forward', false);
            this.bot.setControlState('sprint', false);
        } catch (e) {
            log.warn(`⚠ approach: ${e instanceof Error ? e.message : e}`);
        }
    }

    private async eat(): Promise<void> {
        try {
            // #26 fix: 満腹度チェック
            if (this.bot.food >= 18) return;

            const food = this.bot.inventory.items().find(i =>
                ['bread', 'cooked_beef', 'steak', 'cooked_porkchop', 'cooked_mutton',
                 'cooked_chicken', 'golden_apple', 'golden_carrot', 'apple',
                 'baked_potato', 'cooked_cod', 'cooked_salmon'].includes(i.name)
            );
            if (food) {
                await this.bot.equip(food, 'hand');
                this.bot.activateItem(false);
                // #6 fix: 中断可能な食事ループ
                const eatStart = Date.now();
                while (Date.now() - eatStart < 1650) {
                    if (this.bot.interruptExecution) {
                        this.bot.deactivateItem();
                        return;
                    }
                    await new Promise(r => setTimeout(r, 50));
                }
                this.bot.deactivateItem();
            }
        } catch (e) {
            log.warn(`⚠ eat: ${e instanceof Error ? e.message : e}`);
        }
    }

    cleanup(): void {
        try {
            this.bot.clearControlStates();
            this.bot.deactivateItem();
            this.bot.pathfinder?.stop();
        } catch {}
    }
}
