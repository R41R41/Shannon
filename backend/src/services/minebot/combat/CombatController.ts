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

        // #2 fix: entityDead イベントで正確に kill 数を追跡
        const onEntityDead = (entity: any) => {
            if (entity && entity.type === 'hostile') {
                this.kills++;
                log.info(`💀 ${entity.name ?? 'unknown'} を倒した (累計: ${this.kills})`);
            }
        };
        (this.bot as any).on('entityDead', onEntityDead);

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

                if (this.bot.interruptExecution) {
                    log.info('⚡ 戦闘中断: interruptExecution');
                    break;
                }

                // 1. 状況スキャン
                const situation = this.scanner.scan(this.lastAttackTime, this.isBlocking);

                // 敵がいない → 戦闘終了
                if (situation.hostiles.length === 0) {
                    log.success(`✅ 戦闘終了: 敵全滅 (${this.kills} kills)`);
                    this.executor.cleanup();
                    return this.buildResult(true, '敵全滅', startTime);
                }

                // 2. スコアリング
                const actions = this.scorer.score(situation);
                const best = actions[0];

                // 3. 実行 (tower 等の長いアクションを考慮して 4秒)
                let attacked = false;
                try {
                    const result = await Promise.race([
                        this.executor.execute(best),
                        new Promise<{ attacked: boolean }>((_, reject) =>
                            setTimeout(() => reject(new Error('action timeout')), 4000)
                        ),
                    ]);
                    attacked = result.attacked;
                } catch {
                    log.warn(`⚠ アクション "${best.type}" がタイムアウト`);
                    this.executor.cleanup();
                }
                this.actionsExecuted++;

                if (attacked) this.lastAttackTime = Date.now();

                // ブロッキング状態追跡
                if (best.type === 'shield-block') this.isBlocking = true;
                if (best.type === 'shield-release' || best.type === 'attack' || best.type === 'jump-attack') {
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
            success,
            reason,
            kills: this.kills,
            damageTaken: Math.max(0, this.startHp - this.bot.health),
            durationMs: Date.now() - startTime,
            actionsExecuted: this.actionsExecuted,
        };
    }
}
