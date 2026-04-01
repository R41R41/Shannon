/**
 * CombatController — 汎用戦闘AI (System 1.5)
 *
 * 200ms 周期で状況をスキャンし、最善の行動をスコアリングして実行する。
 * LLM を使わず、ルールベースで瞬時に判断。
 *
 * 将来的に Haiku による戦略アドバイス (1秒周期) で
 * スコアリング重みを動的に調整する拡張が可能。
 */

import { createLogger } from '../../../utils/logger.js';
import type { CustomBot } from '../types/CustomBot.js';
import { SituationScanner } from './SituationScanner.js';
import { ActionScorer } from './ActionScorer.js';
import { ActionExecutor } from './ActionExecutor.js';
import type { CombatConfig } from './types.js';
import { DEFAULT_COMBAT_CONFIG } from './types.js';

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

    constructor(
        private bot: CustomBot,
        config?: Partial<CombatConfig>,
    ) {
        this.config = { ...DEFAULT_COMBAT_CONFIG, ...config };
        this.scanner = new SituationScanner(bot, this.config);
        this.scorer = new ActionScorer(this.config);
        this.executor = new ActionExecutor(bot, this.config);
    }

    /**
     * 戦闘開始。敵がいなくなるか、HP 危険で逃走成功するか、
     * タイムアウトまで自律制御する。
     */
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

        const startTime = Date.now();
        const knownEntities = new Set<number>();

        log.warn(`⚔️ 戦闘開始${targetName ? ` (target: ${targetName})` : ''}`);

        // 最強武器を自動装備
        await this.equipBestWeapon();

        try {
            while (this.running && (Date.now() - startTime) < this.config.maxDurationMs) {
                // 中断チェック
                if (this.bot.interruptExecution) {
                    log.info('⚡ 戦闘中断: interruptExecution');
                    break;
                }

                // 1. 状況スキャン
                const situation = this.scanner.scan(this.lastAttackTime, this.isBlocking);

                // 敵トラッキング (死亡検知)
                for (const h of situation.hostiles) {
                    knownEntities.add(h.entity.id);
                }
                for (const id of knownEntities) {
                    if (!this.bot.entities[id] || !this.bot.entities[id].isValid) {
                        this.kills++;
                        knownEntities.delete(id);
                    }
                }

                // 敵がいない → 戦闘終了
                if (situation.hostiles.length === 0) {
                    log.success(`✅ 戦闘終了: 敵全滅 (${this.kills} kills)`);
                    this.executor.cleanup();
                    return this.buildResult(true, '敵全滅', startTime);
                }

                // 2. スコアリング
                const actions = this.scorer.score(situation);
                const best = actions[0];

                // 3. 実行
                const { attacked } = await this.executor.execute(best);
                this.actionsExecuted++;

                if (attacked) {
                    this.lastAttackTime = Date.now();
                }

                // ブロッキング状態追跡
                if (best.type === 'shield-block') this.isBlocking = true;
                if (best.type === 'shield-release' || best.type === 'attack' || best.type === 'jump-attack') {
                    this.isBlocking = false;
                }

                // 逃走成功判定
                if (best.type === 'flee' && situation.nearestHostile &&
                    situation.nearestHostile.distance > 16) {
                    log.info(`🏃 逃走成功 (最寄り敵: ${situation.nearestHostile.distance.toFixed(1)}m)`);
                    this.executor.cleanup();
                    return this.buildResult(true, '逃走成功', startTime);
                }

                // tick 間隔
                await new Promise(r => setTimeout(r, this.config.tickIntervalMs));
            }

            // タイムアウト
            log.warn(`⏰ 戦闘タイムアウト (${this.config.maxDurationMs / 1000}秒)`);
            this.executor.cleanup();
            return this.buildResult(false, 'タイムアウト', startTime);

        } finally {
            this.running = false;
            this.executor.cleanup();
        }
    }

    /** 戦闘を外部から停止 */
    disengage(): void {
        this.running = false;
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
            success,
            reason,
            kills: this.kills,
            damageTaken: Math.max(0, this.startHp - this.bot.health),
            durationMs: Date.now() - startTime,
            actionsExecuted: this.actionsExecuted,
        };
    }
}
