import { createHash } from 'node:crypto';
import { logger } from '../../../../../utils/logger.js';
import { ExecutionResult } from '../../types.js';

/**
 * Anterior Cingulate Cortex (ACC) — 葛藤/エラー検出器。
 *
 * FCA メインループ内でツール呼び出し履歴を監視し、
 * 同一アクションの繰り返し失敗（ループ）を検出する。
 * 検出時はツールのブロックと LLM への警告プロンプト注入を行う。
 */

export interface LoopDetection {
    detected: boolean;
    /** ブロックすべきツール名のセット */
    blockedTools: Set<string>;
    /** LLM に注入する警告プロンプト（detected=true のときのみ） */
    breakingPrompt: string | null;
    /** escalation が必要か（高い失敗率が続く場合） */
    needsEscalation: boolean;
    /** 人間向けのサマリー（ログ用） */
    summary: string | null;
}

interface ToolCallRecord {
    toolName: string;
    argsHash: string;
    success: boolean;
    errorMessage?: string;
    timestamp: number;
}

const SAME_CALL_THRESHOLD = 3;
const SAME_TOOL_THRESHOLD = 5;
const FAILURE_RATE_WINDOW = 10;
const FAILURE_RATE_THRESHOLD = 0.7;
/** 同一 (tool, args) が連続成功しても進捗がないと判定する閾値 */
const SAME_SUCCESS_LOOP_THRESHOLD = 5;

export class LoopDetector {
    private history: ToolCallRecord[] = [];
    private blockedTools = new Set<string>();
    private blockedCallSignatures = new Set<string>();
    /** sig → ブロック時の history.length（状態変化検出用） */
    private blockTimestamps = new Map<string, number>();
    /**
     * key → history index: isCallBlocked で状態変化によりブロック解除された場合、
     * そのインデックス以前の失敗をストリーク計算に含めないようにする。
     */
    private pardonedAfterIndex = new Map<string, number>();

    reset(): void {
        this.history = [];
        this.blockedTools.clear();
        this.blockedCallSignatures.clear();
        this.blockTimestamps.clear();
        this.pardonedAfterIndex.clear();
    }

    /**
     * ツール実行結果を記録し、ループ検出を行う。
     * 1イテレーション分の全ツール呼び出し結果をまとめて渡す。
     */
    recordAndCheck(
        toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
        results: ExecutionResult[],
    ): LoopDetection {
        for (let i = 0; i < results.length; i++) {
            const call = toolCalls[i];
            const result = results[i];
            if (!call || !result) continue;
            if (call.name === 'task-complete' || call.name === 'update-plan') continue;

            this.history.push({
                toolName: result.toolName,
                argsHash: LoopDetector.hashArgs(call.args),
                success: result.success,
                errorMessage: result.error,
                timestamp: Date.now(),
            });
        }

        return this.detect();
    }

    /**
     * 指定ツールが現在ブロックされているか
     */
    isBlocked(toolName: string): boolean {
        return this.blockedTools.has(toolName);
    }

    /**
     * 指定ツール+引数の組み合わせがブロックされているか。
     * ブロック後に「関連する状態変化」（他ツールの成功）があった場合はブロックを解除する。
     */
    isCallBlocked(toolName: string, args: Record<string, unknown>): boolean {
        const sig = `${toolName}:${LoopDetector.hashArgs(args)}`;
        const sigBlocked = this.blockedCallSignatures.has(sig);
        const toolBlocked = this.blockedTools.has(toolName);
        if (!sigBlocked && !toolBlocked) return false;

        // ブロック後に状態変化（=別ツールが成功）があったらブロック解除
        const blockedAt = this.blockTimestamps.get(sigBlocked ? sig : toolName) ?? 0;
        const hasStateChange = this.history
            .slice(blockedAt)
            .some(r => r.success && r.toolName !== toolName);

        if (hasStateChange) {
            this.blockedCallSignatures.delete(sig);
            this.blockedTools.delete(toolName);
            this.blockTimestamps.delete(sigBlocked ? sig : toolName);
            // pardon: 過去の失敗ストリークを無視するようマーク
            const pardonKey = sigBlocked ? sig : toolName;
            this.pardonedAfterIndex.set(pardonKey, this.history.length);
            // tool レベルでもブロック解除した場合、sig レベルの pardon も設定
            if (toolBlocked) {
                this.pardonedAfterIndex.set(toolName, this.history.length);
            }
            logger.info(
                `[LoopDetector] 🔓 ブロック解除: ${toolName} (状態変化を検出)`,
            );
            return false;
        }

        return true;
    }

    private detect(): LoopDetection {
        const newBlockedTools = new Set<string>();
        const newBlockedSigs = new Set<string>();
        const reasons: string[] = [];
        let needsEscalation = false;

        // Rule 1: 同一 (tool, args) が N 回連続失敗
        const sameCallStreaks = this.getConsecutiveFailureStreaks('call');
        for (const [sig, streak] of sameCallStreaks) {
            if (streak.count >= SAME_CALL_THRESHOLD) {
                // 既にブロック解除済み（pardoned）の場合は再ブロックしない
                if (this.blockedCallSignatures.has(sig)) continue;
                newBlockedSigs.add(sig);
                const toolName = streak.toolName;
                const lastError = streak.lastError || '不明';
                reasons.push(
                    `${toolName} が同一引数で ${streak.count} 回連続失敗 (理由: ${lastError})`,
                );
                logger.warn(
                    `[LoopDetector] 🔴 ブロック: ${toolName} (同一呼び出し ${streak.count}回連続失敗)`,
                );
            }
        }

        // Rule 2: 同一 tool（引数違い含む）が N 回連続失敗
        const sameToolStreaks = this.getConsecutiveFailureStreaks('tool');
        for (const [toolName, streak] of sameToolStreaks) {
            if (streak.count >= SAME_TOOL_THRESHOLD) {
                if (this.blockedTools.has(toolName)) continue;
                newBlockedTools.add(toolName);
                reasons.push(
                    `${toolName} が ${streak.count} 回連続失敗（引数を変えても失敗し続けている）`,
                );
                logger.warn(
                    `[LoopDetector] 🔴 ブロック: ${toolName} (ツール全体 ${streak.count}回連続失敗)`,
                );
            }
        }

        // Rule 4: 同一 (tool, args) が N 回連続成功（進捗なしループ）
        const successStreaks = this.getConsecutiveSuccessStreaks();
        for (const [sig, streak] of successStreaks) {
            if (streak.count >= SAME_SUCCESS_LOOP_THRESHOLD) {
                if (this.blockedCallSignatures.has(sig)) continue;
                newBlockedSigs.add(sig);
                reasons.push(
                    `${streak.toolName} が同一引数で ${streak.count} 回連続成功しているが進捗なし（無限ループの可能性）`,
                );
                logger.warn(
                    `[LoopDetector] 🔴 ブロック: ${streak.toolName} (同一成功 ${streak.count}回 — 進捗なしループ)`,
                );
            }
        }

        // Rule 3: 直近 N 回の全体失敗率チェック
        const recentWindow = this.history.slice(-FAILURE_RATE_WINDOW);
        if (recentWindow.length >= FAILURE_RATE_WINDOW) {
            const failureRate = recentWindow.filter(r => !r.success).length / recentWindow.length;
            if (failureRate >= FAILURE_RATE_THRESHOLD) {
                needsEscalation = true;
                reasons.push(
                    `直近 ${FAILURE_RATE_WINDOW} 回のツール呼び出しのうち ${Math.round(failureRate * 100)}% が失敗`,
                );
                logger.warn(
                    `[LoopDetector] ⚠️ 高失敗率: ${Math.round(failureRate * 100)}% → エスカレーション推奨`,
                );
            }
        }

        // ブロック状態を更新（タイムスタンプも記録）
        for (const sig of newBlockedSigs) {
            this.blockedCallSignatures.add(sig);
            this.blockTimestamps.set(sig, this.history.length);
        }
        for (const tool of newBlockedTools) {
            this.blockedTools.add(tool);
            this.blockTimestamps.set(tool, this.history.length);
        }

        const detected = reasons.length > 0;

        return {
            detected,
            blockedTools: new Set([...this.blockedTools]),
            breakingPrompt: detected ? this.buildBreakingPrompt(reasons) : null,
            needsEscalation,
            summary: detected ? reasons.join('; ') : null,
        };
    }

    private buildBreakingPrompt(reasons: string[]): string {
        const blockedList = [...this.blockedTools, ...this.blockedCallSignatures]
            .map(s => `  - ${s}`)
            .join('\n');

        return [
            '⚠️ [LoopDetector] 繰り返し失敗が検出されました:',
            ...reasons.map(r => `  • ${r}`),
            '',
            blockedList ? `以下のツール/呼び出しは一時的にブロックされました:\n${blockedList}` : '',
            '',
            '別のアプローチを取ってください。具体的には:',
            '1. 失敗の根本原因を分析し、前提条件（必要なアイテム、距離、位置）を確認する',
            '2. 別のツールや手順で目標を達成する方法を考える',
            '3. 前提条件を満たすためのサブタスクを先に実行する',
            '4. どうしても解決できない場合は task-complete で理由を説明して終了する',
        ].filter(Boolean).join('\n');
    }

    /**
     * 連続失敗ストリークを計算する。
     * mode='call': (toolName, argsHash) の組み合わせ単位
     * mode='tool': toolName 単位
     *
     * 履歴を末尾から逆順にスキャンし、各キーについて：
     * - 成功レコードに到達 → そのキーのストリーク確定（それ以前は数えない）
     * - pardonedAfterIndex 以前のレコード → そのキーのストリーク確定
     */
    private getConsecutiveFailureStreaks(
        mode: 'call' | 'tool',
    ): Map<string, { count: number; toolName: string; lastError?: string }> {
        const streaks = new Map<string, { count: number; toolName: string; lastError?: string }>();
        const settled = new Set<string>();

        for (let i = this.history.length - 1; i >= 0; i--) {
            const record = this.history[i];
            const key = mode === 'call'
                ? `${record.toolName}:${record.argsHash}`
                : record.toolName;

            if (settled.has(key)) continue;

            // pardon 境界チェック: この index が pardon 以前なら、このキーは確定
            const pardonIdx = this.pardonedAfterIndex.get(key) ?? -1;
            if (i < pardonIdx) {
                settled.add(key);
                continue;
            }

            // 成功レコード → このキーのストリーク確定（成功で途切れた）
            if (record.success) {
                settled.add(key);
                continue;
            }

            // 失敗をカウント
            const existing = streaks.get(key);
            if (existing) {
                existing.count++;
            } else {
                streaks.set(key, {
                    count: 1,
                    toolName: record.toolName,
                    lastError: record.errorMessage,
                });
            }
        }

        return streaks;
    }

    /**
     * 同一 (toolName, argsHash) の連続成功ストリークを計算する。
     * 成功ループ（activate-block を何度も呼ぶなど）を検出する。
     */
    private getConsecutiveSuccessStreaks(): Map<string, { count: number; toolName: string }> {
        const streaks = new Map<string, { count: number; toolName: string }>();
        const settled = new Set<string>();

        for (let i = this.history.length - 1; i >= 0; i--) {
            const record = this.history[i];
            const sig = `${record.toolName}:${record.argsHash}`;

            if (settled.has(sig)) continue;

            // 失敗 or 別ツール → このシグネチャのストリーク確定
            if (!record.success) {
                settled.add(sig);
                continue;
            }

            const existing = streaks.get(sig);
            if (existing) {
                existing.count++;
            } else {
                streaks.set(sig, { count: 1, toolName: record.toolName });
            }
        }

        return streaks;
    }

    static hashArgs(args: Record<string, unknown>): string {
        const sorted = JSON.stringify(args, Object.keys(args).sort());
        return createHash('md5').update(sorted).digest('hex').substring(0, 12);
    }
}
