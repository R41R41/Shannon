/**
 * ImprovementApplier — 改善の適用
 *
 * Tier 1: self_improvement_rules.json にルールを追加（ホットリロード）
 * Tier 2: mutableCodePolicy で許可されたパスのみ。検証後、
 *   config.selfImprove.autoApplyTier2 が true なら書き込み、false なら pending_review。
 *   delete は SELF_IMPROVE_ALLOW_DELETE=true のときのみ。
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { config } from '../../../../../config/env.js';
import { getBackendRoot } from '../../../../../utils/backendRoot.js';
import { createLogger } from '../../../../../utils/logger.js';
import { randomUUID } from 'node:crypto';
import { CodeValidator } from './CodeValidator.js';
import type {
    ImprovementProposal,
    ImprovementRecord,
    SelfImprovementRulesFile,
    DynamicRule,
} from './types.js';
import { SELF_IMPROVE_CONSTANTS as C } from './types.js';
import {
    isDeniedMutablePath,
    isMutableRelativePath,
    sanitizeMutableRelativePath,
} from './mutableCodePolicy.js';

const log = createLogger('SelfImprove:Applier');

/** プロジェクトルートからの相対パスを解決 */
function resolveProjectPath(relativePath: string): string {
    // backend/saves/... → プロジェクトルートからの相対パス
    return resolve(getBackendRoot(), relativePath);
}

export class ImprovementApplier {
    private validator = new CodeValidator();

    /**
     * 改善案を適用する。
     */
    async apply(proposal: ImprovementProposal): Promise<ImprovementRecord> {
        if (proposal.tier === 1) {
            return this.applyTier1(proposal);
        } else {
            return this.applyTier2(proposal);
        }
    }

    /**
     * CodeAgentLoop を使って自律的に修正する Tier 2 上位互換。
     * 全文置換ではなく差分適用 + 探索 + tsc 検証をエージェントが自律的に行う。
     */
    async applyWithAgent(proposal: ImprovementProposal): Promise<ImprovementRecord> {
        if (proposal.tier === 1) return this.applyTier1(proposal);

        const { runCodeAgentLoop } = await import('./CodeAgentLoop.js');
        const result = await runCodeAgentLoop({
            description: proposal.description,
            targetFile: proposal.targetFile ?? undefined,
            context: `失敗クラスタ: ${proposal.sourceCluster.summary}\nスコープ: ${proposal.scope}`,
            maxIterations: 20,
        });

        await this.appendToHistory(proposal, result.success ? 'applied' : 'rejected');

        return {
            proposal,
            status: result.success ? 'applied' : 'rejected',
            appliedAt: result.success ? Date.now() : null,
            validationErrors: result.success ? [] : [result.summary],
            effectiveness: null,
            gitBranch: null,
        };
    }

    // ── Tier 1: JSON ルール追加 ──

    private async applyTier1(proposal: ImprovementProposal): Promise<ImprovementRecord> {
        try {
            const rulesFile = await this.loadRulesFile();

            // 重複チェック
            const isDuplicate = rulesFile.rules.some(
                r => r.enabled && r.rule === proposal.content,
            );
            if (isDuplicate) {
                return {
                    proposal,
                    status: 'rejected',
                    appliedAt: null,
                    validationErrors: ['同一ルールが既に存在します'],
                    effectiveness: null,
                    gitBranch: null,
                };
            }

            const target = proposal.scope === 'prompt_rule' ? 'prompt' : 'forward_model';

            const newRule: DynamicRule = {
                id: randomUUID(),
                target,
                rule: proposal.content,
                sourceFailure: proposal.sourceCluster.summary,
                addedAt: Date.now(),
                enabled: true,
            };

            rulesFile.rules.push(newRule);
            rulesFile.version++;
            rulesFile.lastUpdated = Date.now();

            await this.saveRulesFile(rulesFile);

            log.info(`✅ Tier 1 ルール追加: [${target}] ${proposal.content.substring(0, 60)}`);

            return {
                proposal,
                status: 'applied',
                appliedAt: Date.now(),
                validationErrors: [],
                effectiveness: null,
                gitBranch: null,
            };
        } catch (err) {
            log.error('Tier 1 適用エラー', err);
            return {
                proposal,
                status: 'rejected',
                appliedAt: null,
                validationErrors: [`適用エラー: ${(err as Error).message}`],
                effectiveness: null,
                gitBranch: null,
            };
        }
    }

    // ── Tier 2: コード置換 / 削除（ポリシー + 環境フラグ） ──

    private async applyTier2(proposal: ImprovementProposal): Promise<ImprovementRecord> {
        const raw = proposal.targetFile;
        if (!raw) {
            return {
                proposal,
                status: 'rejected',
                appliedAt: null,
                validationErrors: ['targetFile が空です'],
                effectiveness: null,
                gitBranch: null,
            };
        }

        const target = sanitizeMutableRelativePath(raw);
        if (!target || !isMutableRelativePath(raw) || isDeniedMutablePath(target)) {
            return {
                proposal,
                status: 'rejected',
                appliedAt: null,
                validationErrors: [`変更不可・不正なパス: ${raw}`],
                effectiveness: null,
                gitBranch: null,
            };
        }

        const action = proposal.tier2Action ?? 'replace';

        if (action === 'delete') {
            if (!config.selfImprove.allowTier2Delete) {
                return {
                    proposal,
                    status: 'rejected',
                    appliedAt: null,
                    validationErrors: ['削除は SELF_IMPROVE_ALLOW_DELETE=true のときのみ有効'],
                    effectiveness: null,
                    gitBranch: null,
                };
            }
            try {
                await unlink(resolveProjectPath(target));
                log.warn(`🗑️ Tier 2 削除適用: ${target}`);
                await this.appendToHistory(proposal, 'applied');
                return {
                    proposal,
                    status: 'applied',
                    appliedAt: Date.now(),
                    validationErrors: [],
                    effectiveness: null,
                    gitBranch: null,
                };
            } catch (err: any) {
                return {
                    proposal,
                    status: 'rejected',
                    appliedAt: null,
                    validationErrors: [`削除失敗: ${err.message}`],
                    effectiveness: null,
                    gitBranch: null,
                };
            }
        }

        let original = '';
        try {
            original = await readFile(resolveProjectPath(target), 'utf-8');
        } catch {
            /* 新規ファイル */
        }

        const validation = this.validator.validateMutableFile(proposal.content, target, original || undefined);
        if (!validation.valid) {
            return {
                proposal,
                status: 'rejected',
                appliedAt: null,
                validationErrors: validation.errors,
                effectiveness: null,
                gitBranch: null,
            };
        }

        if (!config.selfImprove.autoApplyTier2) {
            log.info(`👀 Tier 2 レビュー待ち（SELF_IMPROVE_AUTO_APPLY_TIER2 オフ）: ${target}`);
            await this.appendToHistory(proposal, 'pending_review');
            return {
                proposal,
                status: 'pending_review',
                appliedAt: null,
                validationErrors: [],
                effectiveness: null,
                gitBranch: null,
            };
        }

        try {
            const abs = resolveProjectPath(target);
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, proposal.content, 'utf-8');
            log.info(`✅ Tier 2 適用: ${target} (${proposal.description.substring(0, 60)})`);
            await this.appendToHistory(proposal, 'applied');
            return {
                proposal,
                status: 'applied',
                appliedAt: Date.now(),
                validationErrors: [],
                effectiveness: null,
                gitBranch: null,
            };
        } catch (err: any) {
            log.error('Tier 2 書き込みエラー', err);
            return {
                proposal,
                status: 'rejected',
                appliedAt: null,
                validationErrors: [`書き込み失敗: ${(err as Error).message}`],
                effectiveness: null,
                gitBranch: null,
            };
        }
    }

    // ── ルールファイル I/O ──

    async loadRulesFile(): Promise<SelfImprovementRulesFile> {
        try {
            const filePath = resolveProjectPath(C.RULES_FILE_PATH);
            const content = await readFile(filePath, 'utf-8');
            return JSON.parse(content) as SelfImprovementRulesFile;
        } catch {
            // ファイルが存在しない場合は初期状態を返す
            return {
                version: 0,
                rules: [],
                lastUpdated: Date.now(),
            };
        }
    }

    private async saveRulesFile(data: SelfImprovementRulesFile): Promise<void> {
        const filePath = resolveProjectPath(C.RULES_FILE_PATH);
        await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    }

    private async appendToHistory(
        proposal: ImprovementProposal,
        status: string,
    ): Promise<void> {
        try {
            const filePath = resolveProjectPath(C.HISTORY_FILE_PATH);
            let history: unknown[] = [];
            try {
                const content = await readFile(filePath, 'utf-8');
                history = JSON.parse(content);
            } catch { /* file doesn't exist yet */ }

            history.push({
                proposalId: proposal.id,
                tier: proposal.tier,
                scope: proposal.scope,
                description: proposal.description,
                status,
                timestamp: Date.now(),
            });

            // 最大500件に制限
            if (history.length > 500) {
                history = history.slice(-500);
            }

            await writeFile(filePath, JSON.stringify(history, null, 2), 'utf-8');
        } catch (err) {
            log.error('履歴ファイル書き込みエラー', err);
        }
    }
}
