import { BaseMessage } from '@langchain/core/messages';
import { EventReactionSystem } from '../eventReaction/EventReactionSystem.js';
import { MinebotTaskRuntime } from '../runtime/MinebotTaskRuntime.js';
import { CustomBot } from '../types.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:Event');

/**
 * BotEventHandler
 * Minecraftボットのイベント処理を担当
 */
export class BotEventHandler {
    private bot: CustomBot;
    private taskRuntime: MinebotTaskRuntime;
    private recentMessages: BaseMessage[];
    private lastHealth: number = 20;
    private lastOxygen: number = 20;  // 酸素の最大値は20
    private consecutiveDamageCount: number = 0;
    private lastDamageTime: number = 0;
    private lastDeathMessage: string = '';  // Minecraftの死亡メッセージ
    private eventReactionSystem: EventReactionSystem | null = null;

    constructor(bot: CustomBot, taskRuntime: MinebotTaskRuntime, recentMessages: BaseMessage[]) {
        this.bot = bot;
        this.taskRuntime = taskRuntime;
        this.recentMessages = recentMessages;
        this.lastHealth = bot.health || 20;
    }

    /**
     * EventReactionSystemを設定
     */
    public setEventReactionSystem(system: EventReactionSystem): void {
        this.eventReactionSystem = system;
    }

    /**
     * 全てのイベントハンドラを登録
     */
    registerAll(): void {
        this.registerEntitySpawn();
        this.registerEntityHurt();
        this.registerHealth();
        this.registerBlockUpdate();
        this.registerEntityMove();
        this.registerBossbar();
        this.registerDeathMessage();
        this.registerDeath();
        this.registerRespawn();
        this.registerEntityEffects();
        log.success('✅ All bot event handlers registered');
    }

    /**
     * entitySpawnイベント - アイテム自動収集
     */
    private registerEntitySpawn(): void {
        this.bot.on('entitySpawn', async (entity) => {
            const autoPickUpItem = this.bot.constantSkills.getSkill('auto-pick-up-item');
            if (!autoPickUpItem) {
                log.warn('autoPickUpItem not found');
                return;
            }
            if (!autoPickUpItem.status) return;

            try {
                await autoPickUpItem.run(entity);
            } catch (error) {
                log.error('autoPickUpItem エラー', error);
            }
        });
    }

    /**
     * entityHurtイベント - ダメージ通知
     */
    private registerEntityHurt(): void {
        this.bot.on('entityHurt', async (entity) => {
            if (entity === this.bot.entity) {
                this.bot.chat(`ダメージを受けました: ${this.bot.health.toFixed(1)}/20`);
            }
        });
    }

    /**
     * healthイベント - 自動食事 & 緊急反応
     */
    private registerHealth(): void {
        this.bot.on('health', async () => {
            const currentHealth = this.bot.health || 0;
            const currentTime = Date.now();

            // ダメージ検知
            if (currentHealth < this.lastHealth) {
                const damage = this.lastHealth - currentHealth;
                const damagePercent = (damage / 20) * 100;

                // 連続ダメージ判定（3秒以内のダメージはカウント）
                if (currentTime - this.lastDamageTime < 3000) {
                    this.consecutiveDamageCount++;
                } else {
                    this.consecutiveDamageCount = 1; // 新しいダメージ系列の開始
                }

                log.warn(`⚠️ ダメージ検知 -${damage.toFixed(1)}HP (残${currentHealth.toFixed(1)}/20, ${damagePercent.toFixed(0)}%) 連続:${this.consecutiveDamageCount}`);

                // 緊急対応が必要かの判定
                // 以下の場合のみEventReactionSystemに通知（緊急タスク生成）:
                //   1. HPが危険域（10以下 = 50%以下）
                //   2. 連続ダメージ3回以上（何かに攻撃されている可能性）
                //   3. 一撃で大ダメージ（40%以上 = 8HP以上）
                // それ以外（HP 15/20で落下ダメージ等）は autoEat に任せる
                const isCriticalHP = currentHealth <= 10;
                const isUnderAttack = this.consecutiveDamageCount >= 3;
                const isMassiveDamage = damagePercent >= 40;

                if (this.eventReactionSystem && (isCriticalHP || isUnderAttack || isMassiveDamage)) {
                    const reason = isCriticalHP ? 'HP危険域' : isUnderAttack ? '連続攻撃' : '大ダメージ';
                    log.error(`🚨 緊急対応トリガー: ${reason}`);

                    await this.eventReactionSystem.handleDamage({
                        damage,
                        damagePercent,
                        currentHealth,
                        consecutiveCount: this.consecutiveDamageCount,
                    });
                } else {
                    // 軽微なダメージ → autoEat に任せる（このメソッドの後半で呼ばれる）
                    log.debug(`ℹ️ 軽微ダメージ - autoEatに委任 (HP=${currentHealth.toFixed(1)}/20)`);
                }

                this.lastDamageTime = currentTime;
            } else if (currentHealth > this.lastHealth) {
                // 回復したら連続カウントをリセット
                this.consecutiveDamageCount = 0;
            }

            // 窒息検知（水中または埋まっている状態でHPが減っている）
            const entity = this.bot.entity as any;
            if (entity?.isInWater || entity?.isCollidedVertically) {
                const oxygen = this.bot.oxygenLevel || 20;
                // 酸素が大きく減った（3以上）または、酸素が半分以下でHPが減っている
                if (oxygen < this.lastOxygen - 3 || (oxygen < 10 && currentHealth < this.lastHealth)) {
                    log.error(`⚠️ 窒息検知 (酸素: ${oxygen}/20, HP: ${currentHealth}/20)`);

                    if (this.eventReactionSystem) {
                        await this.eventReactionSystem.handleSuffocation({
                            oxygen,
                            health: currentHealth,
                            isInWater: entity?.isInWater || false,
                        });
                    }
                }
                this.lastOxygen = oxygen;
            }

            this.lastHealth = currentHealth;

            // 自動食事（既存機能）
            const autoEat = this.bot.constantSkills.getSkill('auto-eat');
            if (!autoEat) {
                return;
            }
            if (!autoEat.status) return;

            try {
                await autoEat.run();
            } catch (error) {
                log.error('autoEat エラー', error);
            }
        });
    }

    /**
     * blockUpdateイベント - ブロック更新時の自動視線移動
     */
    private registerBlockUpdate(): void {
        this.bot.on('blockUpdate', async (block) => {
            if (!block) return;

            const distance = this.bot.entity.position.distanceTo(block.position);
            if (distance > 4) return;

            const autoFaceUpdatedBlock = this.bot.constantSkills.getSkill(
                'auto-face-updated-block'
            );
            if (!autoFaceUpdatedBlock) {
                return;
            }
            if (!autoFaceUpdatedBlock.status) return;
            if (autoFaceUpdatedBlock.isLocked) return;

            try {
                await autoFaceUpdatedBlock.run(block);
            } catch (error) {
                log.error('autoFaceUpdatedBlock エラー', error);
            }
        });
    }

    /**
     * entityMoveイベント - エンティティ移動時の自動視線移動
     */
    private registerEntityMove(): void {
        this.bot.on('entityMoved', async (entity) => {
            const distance = this.bot.entity.position.distanceTo(entity.position);
            if (distance > 4) return;

            const autoFaceMovedEntity = this.bot.constantSkills.getSkill(
                'auto-face-moved-entity'
            );
            if (!autoFaceMovedEntity) {
                return;
            }
            if (!autoFaceMovedEntity.status) return;
            if (autoFaceMovedEntity.isLocked) return;

            try {
                await autoFaceMovedEntity.run(entity);
            } catch (error) {
                log.error('autoFaceMovedEntity エラー', error);
            }
        });
    }

    /**
     * bossbarイベント - ボスバー情報の管理
     */
    private registerBossbar(): void {
        this.bot.on('bossBarCreated', async (bossbar) => {
            this.bot.environmentState.bossbar = JSON.stringify({
                title: bossbar.title.translate,
                health: Math.round(bossbar.health * 100),
                color: bossbar.color,
                isDragonBar: Number(bossbar.isDragonBar) === 2,
            });
        });

        this.bot.on('bossBarUpdated', async (bossbar) => {
            const bossbarInfo = {
                title: bossbar.title.translate,
                health: Math.round(bossbar.health * 100),
                color: bossbar.color,
                isDragonBar: Number(bossbar.isDragonBar) === 2,
            };
            this.bot.environmentState.bossbar = JSON.stringify(bossbarInfo);
        });

        this.bot.on('bossBarDeleted', async (bossbar) => {
            this.bot.environmentState.bossbar = null;
        });
    }

    /**
     * 死亡メッセージをキャプチャ（Minecraftのチャットから）
     */
    private registerDeathMessage(): void {
        this.bot.on('messagestr', (message: string) => {
            const botName = this.bot.username;

            // ボットの名前が含まれる死亡メッセージをチェック
            // 日本語と英語両方に対応
            const deathPatterns = [
                // 日本語パターン
                new RegExp(`${botName}は.*に.*された`),
                new RegExp(`${botName}は.*で死んだ`),
                new RegExp(`${botName}は.*した`),
                new RegExp(`${botName}が.*死`),
                // 英語パターン
                new RegExp(`${botName} was slain by`),
                new RegExp(`${botName} was killed by`),
                new RegExp(`${botName} was shot by`),
                new RegExp(`${botName} drowned`),
                new RegExp(`${botName} fell`),
                new RegExp(`${botName} hit the ground`),
                new RegExp(`${botName} burned`),
                new RegExp(`${botName} went up in flames`),
                new RegExp(`${botName} suffocated`),
                new RegExp(`${botName} died`),
                new RegExp(`${botName} was blown up`),
                new RegExp(`${botName} was pricked`),
                new RegExp(`${botName} starved`),
                new RegExp(`${botName} withered away`),
            ];

            for (const pattern of deathPatterns) {
                if (pattern.test(message)) {
                    this.lastDeathMessage = message;
                    log.error(`💀 死亡メッセージ検出: ${message}`);
                    return;
                }
            }
        });
    }

    /**
     * deathイベント - 死亡時の処理
     * 即座にタスクを失敗させ、emergencyModeをリセットする
     */
    private registerDeath(): void {
        this.bot.on('death', async () => {
            if (!this.lastDeathMessage) {
                try {
                    const nearbyHostile = this.bot.nearestEntity((entity) => {
                        if (!entity || !entity.position) return false;
                        const distance = entity.position.distanceTo(this.bot.entity.position);
                        if (distance > 10) return false;
                        const hostileMobs = ['zombie', 'husk', 'skeleton', 'creeper', 'spider', 'drowned', 'stray'];
                        const entityName = entity.name?.toLowerCase() || '';
                        return hostileMobs.some(mob => entityName.includes(mob));
                    });

                    if (nearbyHostile) {
                        this.lastDeathMessage = `${nearbyHostile.name}に倒された可能性`;
                    } else {
                        this.lastDeathMessage = '不明な原因で死亡';
                    }
                } catch {
                    this.lastDeathMessage = '不明な原因で死亡';
                }
            }

            log.error(`💀 ボット死亡: ${this.lastDeathMessage}`);

            // 即座にタスクを失敗させてemergencyModeをリセット（pathfinder等も停止）
            if (this.taskRuntime.isRunning()) {
                this.taskRuntime.failCurrentTaskDueToDeath(this.lastDeathMessage);
            }
        });
    }

    /**
     * spawnイベント - リスポーン時の処理
     */
    private registerRespawn(): void {
        this.bot.on('spawn', async () => {
            log.success('🔄 Bot has respawned');

            // deathイベントで処理済みだが、フォールバックとして残す
            if (this.taskRuntime.isRunning()) {
                const deathReason = this.lastDeathMessage || '死亡によりタスク失敗';
                this.taskRuntime.failCurrentTaskDueToDeath(deathReason);
            }

            // 状態をリセット
            this.lastHealth = 20;
            this.lastOxygen = 20;
            this.consecutiveDamageCount = 0;
            this.lastDeathMessage = '';
        });
    }

    // ── ステータスエフェクト ──

    /** エフェクトID→名前のマッピング */
    private static readonly EFFECT_NAMES: Record<number, string> = {
        1: 'speed', 2: 'slowness', 3: 'haste', 4: 'mining_fatigue',
        5: 'strength', 6: 'instant_health', 7: 'instant_damage',
        8: 'jump_boost', 9: 'nausea', 10: 'regeneration',
        11: 'resistance', 12: 'fire_resistance', 13: 'water_breathing',
        14: 'invisibility', 15: 'blindness', 16: 'night_vision',
        17: 'hunger', 18: 'weakness', 19: 'poison', 20: 'wither',
        21: 'health_boost', 22: 'absorption', 23: 'saturation',
        24: 'glowing', 25: 'levitation', 26: 'luck', 27: 'unluck',
        28: 'slow_falling', 29: 'conduit_power', 30: 'dolphins_grace',
        31: 'bad_omen', 32: 'hero_of_the_village', 33: 'darkness',
    };

    private static getEffectName(id: number): string {
        return BotEventHandler.EFFECT_NAMES[id] || `effect_${id}`;
    }

    /**
     * entityEffect / entityEffectEnd イベント — ステータスエフェクト追跡
     */
    private registerEntityEffects(): void {
        if (!(this.bot as any).activeEffects) {
            (this.bot as any).activeEffects = [];
        }

        (this.bot as any).on('entityEffect', (entity: any, effect: any) => {
            if (entity !== this.bot.entity) return;

            const effectEntry = {
                id: effect.id as number,
                name: BotEventHandler.getEffectName(effect.id),
                amplifier: (effect.amplifier ?? 0) as number,
                duration: (effect.duration ?? 0) as number,
            };

            const effects: Array<typeof effectEntry> = (this.bot as any).activeEffects;
            const existingIdx = effects.findIndex(e => e.id === effectEntry.id);
            if (existingIdx >= 0) {
                effects[existingIdx] = effectEntry;
            } else {
                effects.push(effectEntry);
            }

            log.info(`✨ 効果付与: ${effectEntry.name} (Lv${effectEntry.amplifier + 1})`);

            // 危険エフェクト + 低HP → 緊急通知
            const dangerousEffects = ['poison', 'wither', 'instant_damage'];
            if (dangerousEffects.includes(effectEntry.name)) {
                const currentHealth = this.bot.health ?? 20;
                if (currentHealth <= 10 && this.eventReactionSystem) {
                    log.error(`🚨 危険エフェクト: ${effectEntry.name} (HP=${currentHealth})`);
                    this.eventReactionSystem.handleDamage({
                        damage: 0,
                        damagePercent: 0,
                        currentHealth,
                        consecutiveCount: 0,
                    }).catch(() => {});
                }
            }
        });

        (this.bot as any).on('entityEffectEnd', (entity: any, effect: any) => {
            if (entity !== this.bot.entity) return;
            const effects: Array<{ id: number }> = (this.bot as any).activeEffects;
            const idx = effects.findIndex(e => e.id === effect.id);
            if (idx >= 0) effects.splice(idx, 1);
            log.info(`✨ 効果消失: ${BotEventHandler.getEffectName(effect.id)}`);
        });
    }
}

