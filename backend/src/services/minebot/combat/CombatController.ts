/**
 * CombatController — 汎用戦闘AI (System 1.5)
 *
 * 200ms 周期で状況をスキャンし、最善の行動をスコアリングして実行する。
 * LLM を使わず、ルールベースで瞬時に判断。
 */

import { createLogger } from '../../../utils/logger.js';
import type { CustomBot } from '../types/CustomBot.js';
import { SituationScanner } from './SituationScanner.js';
import { ActionScorer } from './ActionScorer.js';
import { ActionExecutor } from './ActionExecutor.js';
import type { CombatConfig } from './types.js';
import { DEFAULT_COMBAT_CONFIG } from './types.js';
import { executeAction, actionSignal, assertActionActive } from '../execution/ActionExecution.js';

const log = createLogger('Minebot:CombatController');

export interface CombatResult {
    success: boolean;
    reason: string;
    kills: number;
    damageTaken: number;
    durationMs: number;
    actionsExecuted: number;
}

export class CombatController {
    private scanner: SituationScanner;
    private scorer: ActionScorer;
    private executor: ActionExecutor;
    private config: CombatConfig;

    private running = false;
    private lastAttackTime = 0;
    private isBlocking = false;
    private kills = 0;
    private actionsExecuted = 0;
    private startHp = 0;
    private died = false;

    constructor(
        private bot: CustomBot,
        config?: Partial<CombatConfig>,
    ) {
        this.config = { ...DEFAULT_COMBAT_CONFIG, ...config };
        this.scanner = new SituationScanner(bot, this.config);
        this.scorer = new ActionScorer(this.config);
        this.executor = new ActionExecutor(bot, this.config);
    }

    async engage(targetName?: string): Promise<CombatResult> {
        if (this.running) {
            return { success: false, reason: '既に戦闘中', kills: 0, damageTaken: 0, durationMs: 0, actionsExecuted: 0 };
        }

        this.running = true;
        this.kills = 0;
        this.actionsExecuted = 0;
        this.startHp = this.bot.health;
        this.lastAttackTime = 0;
        this.isBlocking = false;
        this.died = false;

        const startTime = Date.now();
        let lastAction: string | undefined;

        // #2 fix: entityDead イベントで正確に kill 数を追跡
        const onEntityDead = (entity: any) => {
            if (entity && entity.type === 'hostile') {
                this.kills++;
                log.info(`💀 ${entity.name ?? 'unknown'} を倒した (累計: ${this.kills})`);
            }
        };
        (this.bot as any).on('entityDead', onEntityDead);
        const onDeath = () => { this.died = true; this.executor.cleanup(); };
        this.bot.on('death', onDeath);

        log.warn(`⚔️ 戦闘開始${targetName ? ` (target: ${targetName})` : ''}`);

        // 既存の移動を停止（flee-from や move-to との競合防止）
        try {
            this.bot.pathfinder?.stop();
            this.bot.clearControlStates();
        } catch { /* ignore */ }

        await this.equipBestWeapon();

        try {
            while (this.running && (Date.now() - startTime) < this.config.maxDurationMs) {
                const tickStart = Date.now();

                // Mineflayer respawns automatically. A new full-health player
                // and an empty entity cache must never turn death into victory.
                if (this.died || this.bot.health <= 0) return this.buildResult(false, '死亡', startTime);

                if (this.bot.interruptExecution) {
                    log.info('⚡ 戦闘中断: interruptExecution');
                    break;
                }

                // 1. 状況スキャン
                const situation = this.scanner.scan(this.lastAttackTime, this.isBlocking);

                // 敵がいない → 戦闘終了
                if (situation.hostiles.length === 0) {
                    const escaped = lastAction === 'flee';
                    const reason = escaped ? '逃走成功（敵撃破ではない）'
                        : this.kills > 0 ? '周囲の敵なし（撃破を確認）' : '周囲の敵を見失った';
                    log.info(`戦闘終了: ${reason} (${this.kills} kills)`);
                    this.executor.cleanup();
                    return this.buildResult(escaped || this.kills > 0, reason, startTime);
                }

                // 2. スコアリング
                // Shield use persists across ticks, but its original facing does
                // not follow moving enemies. Rotate without reactivating/resetting
                // the shield's warm-up or changing the scorer's safety decisions.
                if (this.isBlocking && situation.nearestHostile) {
                    await this.executor.faceThreat(situation.nearestHostile.entity);
                }
                const actions = this.scorer.score(situation);
                const best = actions[0];
                lastAction = best.type;
                log.debug(`decision=${best.type} score=${best.score.toFixed(2)} hp=${situation.hp.toFixed(1)} armor=${situation.armorPoints} threat=${situation.totalThreat.toFixed(1)} nearest=${situation.nearestHostile?.name ?? 'none'} distance=${situation.nearestHostile?.distance.toFixed(2) ?? '-'} ready=${situation.attackCooldownReady} blocking=${situation.isBlocking}`);

                // 3. 実行 (tower 等の長いアクションを考慮して 4秒)
                let attacked = false;
                try {
                    const result = await executeAction(this.bot, 'combat-action', 4000, async () => {
                        const action = await this.executor.execute(best);
                        assertActionActive(this.bot);
                        return { success: true, result: '', attacked: action.attacked };
                    });
                    attacked = result.success && Boolean((result as unknown as { attacked?: boolean }).attacked);
                    if (!result.success) this.executor.cleanup();
                } catch {
                    log.warn(`⚠ アクション "${best.type}" がタイムアウト`);
                    this.executor.cleanup();
                }
                this.actionsExecuted++;

                if (actionSignal(this.bot)?.aborted) break;
                if (attacked) this.lastAttackTime = Date.now();

                // ブロッキング状態追跡
                if (best.type === 'shield-block') this.isBlocking = true;
                if (best.type === 'shield-release' || best.type === 'attack' || best.type === 'jump-attack' || best.type === 'retreat-attack') {
                    this.isBlocking = false;
                }

                // 逃走成功判定
                if (best.type === 'flee' && situation.nearestHostile &&
                    situation.nearestHostile.distance > 32) {
                    log.info(`🏃 逃走成功 (${situation.nearestHostile.distance.toFixed(1)}m)`);
                    this.executor.cleanup();
                    return this.buildResult(true, '逃走成功', startTime);
                }

                // #1 fix: tick タイミング補正 — 実行時間を差し引く
                const elapsed = Date.now() - tickStart;
                const sleepMs = Math.max(0, this.config.tickIntervalMs - elapsed);
                if (sleepMs > 0) {
                    await new Promise(r => setTimeout(r, sleepMs));
                }
            }

            log.warn(`⏰ 戦闘タイムアウト (${this.config.maxDurationMs / 1000}秒)`);
            this.executor.cleanup();
            return this.buildResult(false, 'タイムアウト', startTime);

        } finally {
            this.running = false;
            (this.bot as any).removeListener('entityDead', onEntityDead);
            this.bot.removeListener('death', onDeath);
            this.executor.cleanup();
        }
    }

    disengage(): void {
        this.running = false;
    }

    get isRunning(): boolean {
        return this.running;
    }

    private async equipBestWeapon(): Promise<void> {
        const weapons = [
            'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
            'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe',
        ];
        for (const name of weapons) {
            const item = this.bot.inventory.items().find(i => i.name === name);
            if (item) {
                try {
                    await this.bot.equip(item, 'hand');
                    log.info(`🗡️ ${name} を装備`);
                    return;
                } catch { continue; }
            }
        }
    }

    private buildResult(success: boolean, reason: string, startTime: number): CombatResult {
        return {
            success: success && !this.died,
            reason: this.died ? '死亡' : reason,
            kills: this.kills,
            damageTaken: this.died ? this.startHp : Math.max(0, this.startHp - this.bot.health),
            durationMs: Date.now() - startTime,
            actionsExecuted: this.actionsExecuted,
        };
    }
}
