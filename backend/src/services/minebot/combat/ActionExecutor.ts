/**
 * ActionExecutor — スコアリング結果の行動を実行
 *
 * Mineflayer API を直接叩く。pathfinder は最小限。
 */

import { createLogger } from '../../../utils/logger.js';
import type { CustomBot } from '../types/CustomBot.js';
import type { ScoredAction, CombatConfig } from './types.js';
import { DEFAULT_COMBAT_CONFIG } from './types.js';
import type { Entity } from 'prismarine-entity';

const log = createLogger('Minebot:Combat:Executor');

export class ActionExecutor {
    private strafeDirection = 1; // 1 or -1
    private lastAction: string = 'hold';

    constructor(
        private bot: CustomBot,
        private config: CombatConfig = DEFAULT_COMBAT_CONFIG,
    ) {}

    async execute(action: ScoredAction): Promise<{ attacked: boolean }> {
        let attacked = false;
        this.lastAction = action.type;

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
                this.bot.clearControlStates();
                break;
        }

        return { attacked };
    }

    // ─── 行動実装 ───

    private async meleeAttack(target: Entity): Promise<boolean> {
        try {
            await this.bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true);
            await this.bot.attack(target);
            return true;
        } catch {
            return false;
        }
    }

    private async jumpAttack(target: Entity): Promise<boolean> {
        try {
            // ジャンプ → 落下中に攻撃 = クリティカルヒット (1.5倍ダメージ)
            this.bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 100));
            this.bot.setControlState('jump', false);
            await this.bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true);
            await this.bot.attack(target);
            return true;
        } catch {
            return false;
        }
    }

    private async retreatAttack(target: Entity): Promise<boolean> {
        try {
            // 殴って即後退
            await this.bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true);
            await this.bot.attack(target);
            // 後退
            this.bot.setControlState('back', true);
            this.bot.setControlState('sprint', true);
            setTimeout(() => {
                this.bot.setControlState('back', false);
                this.bot.setControlState('sprint', false);
            }, 500);
            return true;
        } catch {
            return false;
        }
    }

    private async shieldBlock(): Promise<void> {
        try {
            // 盾がオフハンドにあるか確認
            const offHand = this.bot.inventory.slots[this.bot.getEquipmentDestSlot('off-hand')];
            if (offHand?.name === 'shield') {
                this.bot.activateItem(true); // offhand
            } else {
                // メインハンドの盾
                const shield = this.bot.inventory.items().find(i => i.name === 'shield');
                if (shield) {
                    await this.bot.equip(shield, 'off-hand');
                    this.bot.activateItem(true);
                }
            }
        } catch { /* ignore */ }
    }

    private async shieldRelease(): Promise<void> {
        try {
            this.bot.deactivateItem();
        } catch { /* ignore */ }
    }

    private async shootBow(target: Entity): Promise<void> {
        try {
            const bow = this.bot.inventory.items().find(i => i.name === 'bow' || i.name === 'crossbow');
            if (!bow) return;
            await this.bot.equip(bow, 'hand');
            await this.bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true);
            this.bot.activateItem(false);
            await new Promise(r => setTimeout(r, 800)); // 弓チャージ
            this.bot.deactivateItem();
        } catch { /* ignore */ }
    }

    private async flee(): Promise<void> {
        try {
            const hostiles = Object.values(this.bot.entities)
                .filter(e => e && e.position && e.type === 'hostile');
            if (hostiles.length > 0) {
                await this.bot.utils.runFromEntities(this.bot, hostiles, 24);
            } else {
                this.bot.setControlState('forward', true);
                this.bot.setControlState('sprint', true);
                setTimeout(() => {
                    this.bot.setControlState('forward', false);
                    this.bot.setControlState('sprint', false);
                }, 1000);
            }
        } catch { /* ignore */ }
    }

    private async strafe(): Promise<void> {
        try {
            // 左右に交互に横移動
            this.strafeDirection *= -1;
            const dir = this.strafeDirection > 0 ? 'left' : 'right';
            this.bot.setControlState(dir, true);
            setTimeout(() => {
                this.bot.setControlState(dir, false);
            }, 300);
        } catch { /* ignore */ }
    }

    private async tower(): Promise<void> {
        try {
            // 足元にブロックを積む (1ブロック = ゾンビが登れない)
            const blocks = this.bot.inventory.items().find(i =>
                i.name.includes('cobblestone') || i.name.includes('dirt') || i.name.includes('planks')
            );
            if (!blocks) return;
            await this.bot.equip(blocks, 'hand');
            this.bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 200));
            // 足元に設置
            const pos = this.bot.entity.position;
            const below = this.bot.blockAt(pos.offset(0, -0.5, 0));
            if (below) {
                try {
                    await this.bot.placeBlock(below, { x: 0, y: 1, z: 0 } as any);
                } catch { /* 設置失敗は無視 */ }
            }
            this.bot.setControlState('jump', false);
        } catch { /* ignore */ }
    }

    private async approach(target: Entity): Promise<void> {
        try {
            await this.bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true);
            this.bot.setControlState('forward', true);
            this.bot.setControlState('sprint', true);
            setTimeout(() => {
                this.bot.setControlState('forward', false);
                this.bot.setControlState('sprint', false);
            }, 400);
        } catch { /* ignore */ }
    }

    private async eat(): Promise<void> {
        try {
            const food = this.bot.inventory.items().find(i =>
                ['bread', 'cooked_beef', 'steak', 'cooked_porkchop', 'cooked_mutton',
                 'cooked_chicken', 'golden_apple', 'golden_carrot', 'apple',
                 'baked_potato', 'cooked_cod', 'cooked_salmon'].includes(i.name)
            );
            if (food) {
                await this.bot.equip(food, 'hand');
                this.bot.activateItem(false);
                await new Promise(r => setTimeout(r, 1600)); // 食事時間
                this.bot.deactivateItem();
            }
        } catch { /* ignore */ }
    }

    /** 全制御状態をクリア */
    cleanup(): void {
        try {
            this.bot.clearControlStates();
            this.bot.deactivateItem();
            this.bot.pathfinder?.stop();
        } catch { /* ignore */ }
    }
}
