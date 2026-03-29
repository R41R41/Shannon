/**
 * RoutineRecorder — ツール呼出パターンを記録し、自動的にルーチンを生成する
 *
 * 人間の学習と同じ経路:
 *   初回: System 2 (LLM) が個別スキルで試行錯誤
 *   → パターン検知 (RoutineRecorder)
 *   → ルーチン自動生成 (LLM structured output)
 *   → 次回: System 1 (RoutineExecutor) が即座に実行
 *
 * SkillIdeator のパターン検知インフラを再利用。
 */

import { StructuredTool } from '@langchain/core/tools';
import { createLogger } from '../../../utils/logger.js';
import { config } from '../../../config/env.js';
import type { RoutineManager } from './RoutineManager.js';
import type { RoutineDefinition } from './types.js';
import { RoutineWrapperTool } from './RoutineWrapperTool.js';
import type { RoutineExecutor } from './RoutineExecutor.js';

const log = createLogger('Minebot:RoutineRecorder');

/** ToolSequencePattern と同じ構造（selfImprove/types.ts 互換） */
interface SequencePattern {
    key: string;
    count: number;
    exampleGoals: string[];
    exampleArgs: Array<Record<string, unknown>[]>;
    lastSeen: number;
}

interface TaskEpisodeLike {
    goal: string;
    strategyUsed: string[];
    success: boolean;
    platform?: string;
}

const TOOL_NAME_REGEX = /\b([a-z]+-[a-z]+(?:-[a-z]+)*)\b/;

export class RoutineRecorder {
    private static instance: RoutineRecorder | null = null;

    private sequenceBuffer: Map<string, SequencePattern> = new Map();
    private lastGenerateAt = 0;
    private onRoutineCreated: ((tool: StructuredTool) => void) | null = null;

    private constructor(
        private routineManager: RoutineManager,
        private routineExecutor: RoutineExecutor,
    ) {}

    static init(manager: RoutineManager, executor: RoutineExecutor): RoutineRecorder {
        if (!RoutineRecorder.instance) {
            RoutineRecorder.instance = new RoutineRecorder(manager, executor);
        }
        return RoutineRecorder.instance;
    }

    static getInstance(): RoutineRecorder | null {
        return RoutineRecorder.instance;
    }

    setOnRoutineCreated(cb: (tool: StructuredTool) => void): void {
        this.onRoutineCreated = cb;
    }

    // ─── メイン: エピソード完了時に呼ばれる ───

    async onEpisodeCompleted(episode: TaskEpisodeLike): Promise<void> {
        if (!config.routines.autoGenerateEnabled) return;
        if (!episode.success) return;
        if (episode.platform !== 'minecraft' && episode.platform !== 'minebot') return;
        if (episode.strategyUsed.length < 2) return;

        // ツール名シーケンスを抽出
        const toolNames = episode.strategyUsed
            .map(s => this.extractToolName(s))
            .filter(Boolean) as string[];

        if (toolNames.length < 2) return;

        // routine: ツール呼出は除外（既にルーチン化されたパターン）
        const filtered = toolNames.filter(n => !n.startsWith('routine'));
        if (filtered.length < 2) return;

        // スライディングウィンドウで部分列を生成（長さ 2-5）
        for (let len = 2; len <= Math.min(5, filtered.length); len++) {
            for (let i = 0; i <= filtered.length - len; i++) {
                const subseq = filtered.slice(i, i + len);
                const key = subseq.join('->');

                const existing = this.sequenceBuffer.get(key);
                if (existing) {
                    existing.count++;
                    existing.lastSeen = Date.now();
                    if (existing.exampleGoals.length < 3 && !existing.exampleGoals.includes(episode.goal)) {
                        existing.exampleGoals.push(episode.goal);
                    }
                } else {
                    this.sequenceBuffer.set(key, {
                        key,
                        count: 1,
                        exampleGoals: [episode.goal],
                        exampleArgs: [],
                        lastSeen: Date.now(),
                    });
                }
            }
        }

        // 古いパターンを削除（24時間）
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        for (const [k, v] of this.sequenceBuffer) {
            if (v.lastSeen < cutoff) this.sequenceBuffer.delete(k);
        }

        // 自動生成の判定
        if (this.shouldGenerateRoutine()) {
            await this.generateRoutineFromTopPattern();
        }
    }

    // ─── パターン検知 ───

    private shouldGenerateRoutine(): boolean {
        const { minOccurrences, cooldownMs } = config.routines;

        // 十分な頻度のパターンがあるか
        const candidates = this.getCandidatePatterns();
        if (candidates.length === 0) return false;

        // クールダウン
        if (Date.now() - this.lastGenerateAt < cooldownMs) return false;

        return true;
    }

    private getCandidatePatterns(): SequencePattern[] {
        const { minOccurrences } = config.routines;
        const existingRoutineSkills = new Set(
            this.routineManager.getAll().flatMap(r =>
                r.steps
                    .filter(s => 'skill' in s)
                    .map(s => (s as { skill: string }).skill),
            ),
        );

        return Array.from(this.sequenceBuffer.values())
            .filter(p => {
                if (p.count < minOccurrences) return false;
                // 既にルーチン化済みのパターンはスキップ
                const skills = p.key.split('->');
                const alreadyCovered = skills.every(s => existingRoutineSkills.has(s));
                return !alreadyCovered;
            })
            .sort((a, b) => b.count - a.count);
    }

    // ─── ルーチン自動生成 ───

    private async generateRoutineFromTopPattern(): Promise<void> {
        const candidates = this.getCandidatePatterns();
        if (candidates.length === 0) return;

        const pattern = candidates[0];
        this.lastGenerateAt = Date.now();

        log.info(`🧠 RoutineRecorder: generating routine from pattern "${pattern.key}" (seen ${pattern.count}x)`, 'cyan');

        try {
            const def = await this.patternToRoutineDefinition(pattern);
            if (!def) {
                log.warn(`⚠ Failed to generate routine definition for "${pattern.key}"`);
                return;
            }

            // 既に同名ルーチンがあればスキップ
            if (this.routineManager.has(def.name)) {
                log.info(`⏭ Routine "${def.name}" already exists, skipping`, 'yellow');
                return;
            }

            await this.routineManager.create(def);

            // FCA にツール登録
            if (this.onRoutineCreated) {
                const wrapperTool = new RoutineWrapperTool(
                    def.name,
                    this.routineManager,
                    this.routineExecutor,
                );
                this.onRoutineCreated(wrapperTool);
            }

            log.success(`✔ Auto-generated routine "${def.name}" from pattern "${pattern.key}"`);

            // 生成に使ったパターンをバッファから削除
            this.sequenceBuffer.delete(pattern.key);
        } catch (e) {
            log.error(`✖ Failed to auto-generate routine`, e);
        }
    }

    /**
     * パターンを RoutineDefinition に変換。
     * LLM を使わず、パターンキーから直接 JSON を構築する（高速・コストゼロ）。
     * 複雑な引数推論が必要な場合は将来 LLM 呼出に拡張可能。
     */
    private async patternToRoutineDefinition(
        pattern: SequencePattern,
    ): Promise<RoutineDefinition | null> {
        const skills = pattern.key.split('->');
        if (skills.length < 2) return null;

        // ルーチン名: スキル名から生成
        const name = `auto-${skills.slice(0, 3).join('-then-')}`.slice(0, 40);

        // ゴール例から description を生成
        const description =
            pattern.exampleGoals.length > 0
                ? `自動生成: "${pattern.exampleGoals[0]}" 等のパターン (${pattern.count}回検出)`
                : `自動生成: ${pattern.key} パターン`;

        // 各スキルをステップに変換（引数はプレースホルダー）
        const steps = skills.map(skill => ({
            skill,
            args: {} as Record<string, unknown>,
            onFailure: 'abort' as const,
        }));

        return {
            name,
            description,
            params: [],
            steps,
            failureEscalation: 'system2',
            source: 'recorded',
            stats: { runs: 0, successes: 0, failures: 0, avgDurationMs: 0 },
        };
    }

    // ─── ユーティリティ ───

    private extractToolName(strategyEntry: string): string | null {
        const match = strategyEntry.match(TOOL_NAME_REGEX);
        return match?.[1] ?? null;
    }

    /** デバッグ用: バッファ統計 */
    getStats(): { total: number; candidates: number } {
        return {
            total: this.sequenceBuffer.size,
            candidates: this.getCandidatePatterns().length,
        };
    }
}
