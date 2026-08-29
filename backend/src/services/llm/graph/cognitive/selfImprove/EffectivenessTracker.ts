/**
 * EffectivenessTracker — 効果測定
 *
 * 改善適用後のタスク成功率を追跡し、
 * 悪化した場合は Tier 1 を自動ロールバック、Tier 2 にフラグを立てる。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getBackendRoot } from '../../../../../utils/backendRoot.js';
import { createLogger } from '../../../../../utils/logger.js';
import type { TaskEpisode } from '../TaskEpisodeMemory.js';
import type {
    ImprovementRecord,
    EffectivenessMetrics,
    SelfImprovementRulesFile,
} from './types.js';
import { SELF_IMPROVE_CONSTANTS as C } from './types.js';

const log = createLogger('SelfImprove:Tracker');

interface TrackingEntry {
    record: ImprovementRecord;
    taskResults: Array<{ success: boolean; timestamp: number }>;
    startedAt: number;
}

export class EffectivenessTracker {
    private trackingEntries: TrackingEntry[] = [];

    /**
     * 改善の効果測定を開始する。
     */
    startTracking(record: ImprovementRecord): void {
        this.trackingEntries.push({
            record,
            taskResults: [],
            startedAt: Date.now(),
        });

        log.info(
            `📊 効果測定開始: [Tier ${record.proposal.tier}] ${record.proposal.description.substring(0, 50)}`,
        );
    }

    /**
     * タスク完了時に全 tracking entry を更新する。
     */
    onTaskCompleted(episode: TaskEpisode): void {
        for (const entry of this.trackingEntries) {
            entry.taskResults.push({
                success: episode.success,
                timestamp: Date.now(),
            });

            // 効果測定の対象タスク数に到達したら評価
            if (entry.taskResults.length >= C.EFFECTIVENESS_TASK_COUNT) {
                this.evaluate(entry).catch(err => {
                    log.error('効果測定エラー', err);
                });
            }
        }

        // 評価済み（十分なタスク数に到達した）エントリを除外
        this.trackingEntries = this.trackingEntries.filter(
            e => e.taskResults.length < C.EFFECTIVENESS_TASK_COUNT,
        );
    }

    /**
     * 効果を評価し、悪化していればロールバック。
     */
    private async evaluate(entry: TrackingEntry): Promise<void> {
        const results = entry.taskResults;
        const successCount = results.filter(r => r.success).length;
        const afterFailureRate = 1 - (successCount / results.length);

        // 改善前の失敗率は失敗クラスタの発生頻度から推定
        const cluster = entry.record.proposal.sourceCluster;
        const beforeFailureRate = Math.min(1, cluster.occurrenceCount / C.EFFECTIVENESS_TASK_COUNT);

        const metrics: EffectivenessMetrics = {
            tasksSinceApplied: results.length,
            sameFailureCount: results.filter(r => !r.success).length,
            beforeFailureRate,
            afterFailureRate,
            measuredAt: Date.now(),
        };

        entry.record.effectiveness = metrics;

        const improved = afterFailureRate < beforeFailureRate;
        const worsened = afterFailureRate > beforeFailureRate * 1.5; // 50% 以上悪化

        if (improved) {
            log.info(
                `✅ 改善効果確認: 失敗率 ${(beforeFailureRate * 100).toFixed(0)}% → ${(afterFailureRate * 100).toFixed(0)}%`,
            );
        } else if (worsened) {
            log.warn(
                `⚠️ 改善が逆効果: 失敗率 ${(beforeFailureRate * 100).toFixed(0)}% → ${(afterFailureRate * 100).toFixed(0)}%`,
            );

            // Tier 1 は自動ロールバック
            if (entry.record.proposal.tier === 1) {
                await this.rollbackTier1(entry.record);
            } else {
                // Tier 2 はフラグのみ
                log.warn(`🚩 Tier 2 改善のロールバックが推奨されます: ${entry.record.proposal.description}`);
            }
        } else {
            log.info(
                `📊 効果測定: 失敗率に大きな変化なし (${(beforeFailureRate * 100).toFixed(0)}% → ${(afterFailureRate * 100).toFixed(0)}%)`,
            );
        }
    }

    /**
     * 生成スキルの使用を追跡する。
     * タスク完了時に strategyUsed に生成スキル名が含まれていれば記録。
     */
    async trackGeneratedSkillUsage(episode: TaskEpisode): Promise<void> {
        try {
            const { SkillHotLoader } = await import('../../../../minebot/skills/SkillHotLoader.js');
            const { getSkillRegistrar } = await import('../../../../minebot/skills/SkillRegistrar.js');
            const hotLoader = new SkillHotLoader(getSkillRegistrar());
            const manifest = await hotLoader.loadManifest();

            const generatedNames = new Set(
                manifest.skills.filter(s => s.enabled).map(s => s.name),
            );
            if (generatedNames.size === 0) return;

            // strategyUsed にスキル名が含まれているか確認
            for (const strategy of episode.strategyUsed) {
                for (const name of generatedNames) {
                    if (strategy.includes(name)) {
                        await hotLoader.recordUsage(name);
                    }
                }
            }

            // 未使用スキルの自動無効化チェック
            await this.checkUnusedGeneratedSkills(hotLoader, manifest);
        } catch {
            // non-critical
        }
    }

    /**
     * 未使用の生成スキルを無効化する。
     * 生成後 EFFECTIVENESS_TASK_COUNT タスク経過し使用回数 0 のスキルが対象。
     */
    private async checkUnusedGeneratedSkills(
        hotLoader: import('../../../../minebot/skills/SkillHotLoader.js').SkillHotLoader,
        manifest: { skills: Array<{ name: string; enabled: boolean; usageCount: number; createdAt: number }> },
    ): Promise<void> {
        const now = Date.now();
        // 作成から1時間以上経過 & 使用回数0 のスキルを無効化候補に
        const unusedCutoff = 3600_000; // 1時間

        // SelfImprovementDaemon から bot 参照を取得
        let bot: import('../../../../minebot/types.js').CustomBot | null = null;
        try {
            const { SelfImprovementDaemon } = await import('./SelfImprovementDaemon.js');
            bot = SelfImprovementDaemon.getInstance().getBot();
        } catch {
            return;
        }
        if (!bot) return;

        for (const entry of manifest.skills) {
            if (!entry.enabled) continue;
            if (entry.usageCount > 0) continue;
            if (now - entry.createdAt < unusedCutoff) continue;

            try {
                await hotLoader.disableSkill(entry.name, bot);
                log.info(`🗑️ 未使用スキル無効化: ${entry.name} (使用回数: 0)`);
            } catch {
                // non-critical
            }
        }
    }

    /**
     * Tier 1 ルールをロールバック（enabled=false にする）。
     */
    private async rollbackTier1(record: ImprovementRecord): Promise<void> {
        try {
            const filePath = resolve(getBackendRoot(), C.RULES_FILE_PATH);
            const content = await readFile(filePath, 'utf-8');
            const rulesFile: SelfImprovementRulesFile = JSON.parse(content);

            const ruleToDisable = rulesFile.rules.find(
                r => r.rule === record.proposal.content && r.enabled,
            );

            if (ruleToDisable) {
                ruleToDisable.enabled = false;
                rulesFile.version++;
                rulesFile.lastUpdated = Date.now();
                await writeFile(filePath, JSON.stringify(rulesFile, null, 2), 'utf-8');

                record.status = 'rolled_back';
                log.info(`🔙 ロールバック完了: ${record.proposal.content.substring(0, 60)}`);
            }
        } catch (err) {
            log.error('ロールバックエラー', err);
        }
    }
}
