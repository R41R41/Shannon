import { logger } from '../../../../../utils/logger.js';
import { ExecutionResult } from '../../types.js';

/**
 * Cerebellum (小脳) — 行動予測 / エラー事前検出。
 *
 * ツール実行前に「この呼び出しは失敗しそうか」を軽量にチェックする。
 * LLM を使わないルールベースの予測で、明らかな失敗を事前に防ぐ。
 * 過去の失敗パターンから動的にルールを学習する。
 */

export interface Prediction {
    shouldBlock: boolean;
    reason: string | null;
    suggestion: string | null;
    /** 同一パターンが連続ブロックされた回数 */
    consecutiveBlocks: number;
}

interface FailurePattern {
    toolName: string;
    conditionKey: string;
    failureMessage: string;
    suggestion: string;
    occurrences: number;
}

const CONSECUTIVE_BLOCK_LIMIT = 3;

export class ForwardModel {
    private learnedPatterns: Map<string, FailurePattern> = new Map();
    private recentResults: ExecutionResult[] = [];
    /** tool+args パターン → 連続ブロック回数 */
    private consecutiveBlockTracker: Map<string, number> = new Map();
    private lastBlockedKey: string | null = null;

    reset(): void {
        this.learnedPatterns.clear();
        this.recentResults = [];
        this.consecutiveBlockTracker.clear();
        this.lastBlockedKey = null;
    }

    /** 連続ブロック上限に達しているか */
    get hasRepeatedBlockFailure(): boolean {
        for (const count of this.consecutiveBlockTracker.values()) {
            if (count >= CONSECUTIVE_BLOCK_LIMIT) return true;
        }
        return false;
    }

    /** 連続ブロック上限に達しているキーのリスト */
    get repeatedBlockKeys(): string[] {
        const keys: string[] = [];
        for (const [key, count] of this.consecutiveBlockTracker) {
            if (count >= CONSECUTIVE_BLOCK_LIMIT) keys.push(key);
        }
        return keys;
    }

    /** ツールが実際に実行された時にブロックカウンタをリセット */
    onToolExecuted(toolName: string, args: Record<string, unknown>): void {
        const key = `${toolName}:${this.extractArgsCondition(toolName, args) ?? ''}`;
        this.consecutiveBlockTracker.delete(key);
    }

    /**
     * ツール実行結果を学習する。
     * 同一の失敗パターンが繰り返されると、次回から事前にブロックする。
     */
    learn(results: ExecutionResult[]): void {
        for (const result of results) {
            this.recentResults.push(result);
            if (this.recentResults.length > 50) this.recentResults.shift();

            // 成功時: 同ツールの学習済み失敗パターンをクリア（状態が変化した可能性があるため）
            if (result.success) {
                for (const [key, pattern] of this.learnedPatterns) {
                    if (pattern.toolName === result.toolName) {
                        this.learnedPatterns.delete(key);
                    }
                }
                // move-to 成功時: 距離関連の失敗パターンもクリア
                // （start-smelting/withdraw-from-furnace の distance_too_far は移動後に解決される）
                if (result.toolName === 'move-to') {
                    for (const [key, pattern] of this.learnedPatterns) {
                        if (pattern.failureMessage.includes('遠すぎ') || pattern.failureMessage.includes('distance_too_far')) {
                            this.learnedPatterns.delete(key);
                        }
                    }
                }
            }

            if (!result.success && result.error) {
                const key = this.extractPatternKey(result);
                if (!key) continue;

                const existing = this.learnedPatterns.get(key);
                if (existing) {
                    existing.occurrences++;
                } else {
                    const suggestion = this.extractSuggestion(result);
                    this.learnedPatterns.set(key, {
                        toolName: result.toolName,
                        conditionKey: key,
                        failureMessage: result.error,
                        suggestion: suggestion || '別のアプローチを試してください',
                        occurrences: 1,
                    });
                }
            }
        }
    }

    /**
     * ツール実行前に失敗を予測する。
     * 過去の学習済みパターンとルールベースチェックを組み合わせる。
     */
    predict(
        toolName: string,
        args: Record<string, unknown>,
        context: { recentResults: ExecutionResult[]; freeSlots?: number | null },
    ): Prediction {
        // Check 1: 学習済みパターンに一致するか
        const patternPrediction = this.checkLearnedPatterns(toolName, args);
        if (patternPrediction.shouldBlock) {
            this.trackBlock(toolName, args);
            patternPrediction.consecutiveBlocks = this.getBlockCount(toolName, args);
            return patternPrediction;
        }

        // Check 2: ルールベースチェック
        const rulePrediction = this.checkRules(toolName, args, context);
        if (rulePrediction.shouldBlock) {
            this.trackBlock(toolName, args);
            rulePrediction.consecutiveBlocks = this.getBlockCount(toolName, args);
            return rulePrediction;
        }

        return { shouldBlock: false, reason: null, suggestion: null, consecutiveBlocks: 0 };
    }

    private trackBlock(toolName: string, args: Record<string, unknown>): void {
        const key = `${toolName}:${this.extractArgsCondition(toolName, args) ?? ''}`;
        const current = this.consecutiveBlockTracker.get(key) ?? 0;
        this.consecutiveBlockTracker.set(key, current + 1);
    }

    private getBlockCount(toolName: string, args: Record<string, unknown>): number {
        const key = `${toolName}:${this.extractArgsCondition(toolName, args) ?? ''}`;
        return this.consecutiveBlockTracker.get(key) ?? 0;
    }

    private checkLearnedPatterns(
        toolName: string,
        args: Record<string, unknown>,
    ): Prediction {
        // craft-one は専用ルール (checkRules) で判定するため、学習パターンをスキップ。
        // 理由: craft-one の成否は外部状態 (crafting_table の有無・インベントリ) に依存し、
        //       同一 args でも状態変化後に成功する。learned pattern では検知できない。
        if (toolName === 'craft-one') {
            return { shouldBlock: false, reason: null, suggestion: null, consecutiveBlocks: 0 };
        }

        for (const [, pattern] of this.learnedPatterns) {
            if (pattern.toolName !== toolName) continue;
            if (pattern.occurrences < 2) continue;

            const key = `${toolName}:${this.extractArgsCondition(toolName, args)}`;
            if (key === pattern.conditionKey) {
                logger.info(
                    `[ForwardModel] 🧠 予測: ${toolName} は失敗する可能性が高い (${pattern.occurrences}回の過去の失敗)`,
                    'yellow',
                );
                return {
                    shouldBlock: true,
                    reason: `過去 ${pattern.occurrences} 回同じ条件で失敗: ${pattern.failureMessage.substring(0, 100)}`,
                    suggestion: pattern.suggestion,
                    consecutiveBlocks: 0,
                };
            }
        }

        return { shouldBlock: false, reason: null, suggestion: null, consecutiveBlocks: 0 };
    }

    private checkRules(
        toolName: string,
        args: Record<string, unknown>,
        context: { recentResults: ExecutionResult[]; freeSlots?: number | null },
    ): Prediction {
        const recent = context.recentResults;

        // Rule: インベントリ満杯時の採掘/拾得系ツールをブロック
        if (context.freeSlots != null && context.freeSlots <= 0) {
            const pickupMineTools = ['mine-block', 'stair-mine', 'dig-block-at', 'pickup-nearest-item'];
            if (pickupMineTools.includes(toolName)) {
                return {
                    shouldBlock: true,
                    reason: 'インベントリが満杯です（空きスロット: 0）',
                    suggestion: 'インベントリを整理してください。不要なアイテムを捨てる(drop-item)か、チェストに格納(deposit-to-container)してから作業を続けてください',
                    consecutiveBlocks: 0,
                };
            }
        }

        // Rule: activate-block が距離エラーで失敗した直後に同じブロックを activate しようとしている
        if (toolName === 'activate-block') {
            const lastActivateFailure = recent
                .filter(r => r.toolName === 'activate-block' && !r.success)
                .pop();
            if (lastActivateFailure?.failureType === 'distance_too_far') {
                const lastMoveSuccess = recent
                    .filter(r => r.toolName === 'move-to' && r.success)
                    .pop();
                if (!lastMoveSuccess || recent.indexOf(lastMoveSuccess) < recent.indexOf(lastActivateFailure)) {
                    return {
                        shouldBlock: true,
                        reason: '前回 activate-block が距離エラーで失敗し、その後 move-to で近づいていない',
                        suggestion: 'まず move-to でブロックの近くに移動してから activate-block を試してください',
                        consecutiveBlocks: 0,
                    };
                }
            }
        }

        // Rule: start-smelting / withdraw-from-furnace が距離エラーで失敗した直後
        if (toolName === 'start-smelting' || toolName === 'withdraw-from-furnace') {
            const lastFailure = recent
                .filter(r => r.toolName === toolName && !r.success)
                .pop();
            if (lastFailure?.failureType === 'distance_too_far') {
                const lastMoveSuccess = recent
                    .filter(r => r.toolName === 'move-to' && r.success)
                    .pop();
                if (!lastMoveSuccess || recent.indexOf(lastMoveSuccess) < recent.indexOf(lastFailure)) {
                    return {
                        shouldBlock: true,
                        reason: `前回 ${toolName} が距離エラーで失敗し、その後 move-to で近づいていない`,
                        suggestion: 'まず move-to でかまどの近くに移動してください',
                        consecutiveBlocks: 0,
                    };
                }
            }
        }

        // Rule: craft-one が crafting_table 不足で失敗した直後に同じアイテムを craft しようとしている
        // ※ crafting_table 自体は 2x2 レシピなので作業台不要 → 失敗したアイテムと同じ場合のみブロック
        if (toolName === 'craft-one') {
            const lastCraftFailure = recent
                .filter(r => r.toolName === 'craft-one' && !r.success)
                .pop();
            if (lastCraftFailure?.error?.includes('クラフトテーブルが必要')) {
                const failedItem = lastCraftFailure.args?.itemName;
                if (failedItem && failedItem === args.itemName) {
                    const lastTableAction = recent
                        .filter(r =>
                            (r.toolName === 'activate-block' && r.success) ||
                            (r.toolName === 'place-block-at' && r.success && r.args?.blockName === 'crafting_table'),
                        )
                        .pop();
                    if (!lastTableAction || recent.indexOf(lastTableAction) < recent.indexOf(lastCraftFailure)) {
                        return {
                            shouldBlock: true,
                            reason: `${failedItem}のクラフトにはクラフトテーブルが必要だが、まだ利用可能になっていない`,
                            suggestion: 'まず crafting_table をインベントリから設置(place-block-at)するか、近くの crafting_table を activate-block してからクラフトしてください。crafting_table がなければ木材(planks)4個でクラフトしてください。',
                            consecutiveBlocks: 0,
                        };
                    }
                }
            }
        }

        // Rule: move-to がスタックで失敗した直後に同じ座標に move-to しようとしている
        if (toolName === 'move-to') {
            const lastMoveFailure = recent
                .filter(r => r.toolName === 'move-to' && !r.success && r.failureType === 'stuck')
                .pop();
            if (lastMoveFailure) {
                const targetX = args.x as number | undefined;
                const targetZ = args.z as number | undefined;
                const failedX = lastMoveFailure.args?.x as number | undefined;
                const failedZ = lastMoveFailure.args?.z as number | undefined;
                if (
                    targetX !== undefined && failedX !== undefined &&
                    targetZ !== undefined && failedZ !== undefined &&
                    Math.abs(targetX - failedX) < 3 && Math.abs(targetZ - failedZ) < 3
                ) {
                    return {
                        shouldBlock: true,
                        reason: '前回同じ付近の座標に move-to してスタックしている',
                        suggestion: '別のルート（迂回）を試すか、dig-block で障害物を除去してから移動してください',
                        consecutiveBlocks: 0,
                    };
                }
            }
        }

        return { shouldBlock: false, reason: null, suggestion: null, consecutiveBlocks: 0 };
    }

    private extractPatternKey(result: ExecutionResult): string | null {
        const condition = this.extractArgsCondition(result.toolName, result.args);
        if (!condition) return null;
        return `${result.toolName}:${condition}`;
    }

    private extractArgsCondition(toolName: string, args: Record<string, unknown>): string | null {
        switch (toolName) {
            case 'craft-one':
                return `item=${args.itemName ?? 'unknown'},count=${args.count ?? 1}`;
            case 'move-to':
                return `target=${Math.round(args.x as number ?? 0)},${Math.round(args.z as number ?? 0)}`;
            case 'activate-block':
                return `block=${args.blockName ?? 'unknown'},pos=${Math.round(args.x as number ?? 0)},${Math.round(args.y as number ?? 0)},${Math.round(args.z as number ?? 0)}`;
            case 'place-block-at':
                return `block=${args.blockName ?? 'unknown'},pos=${Math.round(args.x as number ?? 0)},${Math.round(args.y as number ?? 0)},${Math.round(args.z as number ?? 0)}`;
            case 'find-blocks':
                return `block=${args.blockName ?? 'unknown'}`;
            case 'start-smelting':
                return `pos=${Math.round(args.x as number ?? 0)},${Math.round(args.y as number ?? 0)},${Math.round(args.z as number ?? 0)},input=${args.inputItem ?? 'unknown'},fuel=${args.fuelItem ?? 'unknown'}`;
            case 'withdraw-from-furnace':
                return `pos=${Math.round(args.x as number ?? 0)},${Math.round(args.y as number ?? 0)},${Math.round(args.z as number ?? 0)}`;
            case 'check-furnace':
                return `pos=${args.x},${args.y},${args.z}`;
            default:
                return JSON.stringify(args).substring(0, 50);
        }
    }

    private extractSuggestion(result: ExecutionResult): string | null {
        const error = result.error ?? result.message;
        if (!error) return null;

        if (error.includes('クラフトテーブルが必要')) {
            return 'crafting_table を先に設置または activate してからクラフトしてください';
        }
        if (error.includes('遠すぎ') || error.includes('distance_too_far')) {
            return 'まず move-to で近づいてから操作してください';
        }
        if (error.includes('スタック') || error.includes('stuck')) {
            return '別のルートを使うか、dig-block で道を作ってから移動してください';
        }
        if (error.includes('インベントリにありません') || error.includes('missing_item')) {
            return '必要なアイテムを先に入手してください';
        }
        if (error.includes('タイムアウト') || error.includes('timeout')) {
            return '別のアプローチを試してください。対象が遠すぎるか到達不能の可能性があります';
        }

        return null;
    }
}
