/**
 * TaskEpisodeMemory — 海馬（Hippocampus）
 *
 * タスク実行エピソードの保存と想起を行い、
 * FCA が過去の成功/失敗パターンから学習できるようにする。
 *
 * - 保存: タスク完了時に goal・結果・使用した戦略・失敗パターン・教訓を記録
 * - 想起: 新規タスク開始時に類似ゴールのエピソードを検索してプロンプトに注入
 *
 * 永続化は ShannonMemoryService (category='knowledge', tags=['task_episode', ...]) を利用。
 */

import { ShannonMemoryService } from '../../../memory/shannonMemoryService.js';
import { ShannonMemory, IShannonMemory } from '../../../../models/ShannonMemory.js';
import { logger } from '../../../../utils/logger.js';
import type { TaskTreeState } from '@shannon/common';

export interface TaskEpisode {
    goal: string;
    platform: string;
    success: boolean;
    iterationCount: number;
    durationMs: number;
    strategyUsed: string[];
    failurePatterns: string[];
    lesson: string;
    timestamp: Date;
}

const EPISODE_TAG = 'task_episode';
const MAX_RECALL_RESULTS = 5;

export class TaskEpisodeMemory {
    private static instance: TaskEpisodeMemory;
    private memoryService: ShannonMemoryService;

    private constructor() {
        this.memoryService = ShannonMemoryService.getInstance();
    }

    static getInstance(): TaskEpisodeMemory {
        if (!TaskEpisodeMemory.instance) {
            TaskEpisodeMemory.instance = new TaskEpisodeMemory();
        }
        return TaskEpisodeMemory.instance;
    }

    /**
     * タスク完了後にエピソードを保存する。
     */
    async saveEpisode(episode: TaskEpisode): Promise<void> {
        try {
            const tags = [
                EPISODE_TAG,
                episode.platform,
                episode.success ? 'success' : 'failure',
                ...this.extractGoalKeywords(episode.goal),
            ];

            const content = this.formatEpisodeContent(episode);

            await this.memoryService.saveWithDedup({
                category: 'knowledge',
                content,
                source: 'task_episode_memory',
                importance: episode.success ? 5 : 7, // failures are more important to remember
                tags,
            });

            logger.info(
                `🧠 TaskEpisodeMemory: エピソード保存 [${episode.success ? '成功' : '失敗'}] "${episode.goal.substring(0, 50)}"`,
                'cyan',
            );
        } catch (err) {
            logger.error('TaskEpisodeMemory: 保存エラー', err);
        }
    }

    /**
     * 新タスクに関連する過去のエピソードを検索して返す。
     */
    async recallRelevantEpisodes(
        goal: string,
        platform: string,
    ): Promise<TaskEpisode[]> {
        try {
            const keywords = this.extractGoalKeywords(goal);
            if (keywords.length === 0) return [];

            const query: Record<string, unknown> = {
                category: 'knowledge',
                tags: { $all: [EPISODE_TAG], $in: keywords },
            };
            if (platform) {
                (query.tags as Record<string, unknown>).$all = [EPISODE_TAG, platform];
            }

            const memories = await ShannonMemory.find(query)
                .sort({ createdAt: -1 })
                .limit(MAX_RECALL_RESULTS)
                .lean();

            return (memories as IShannonMemory[])
                .map(m => this.parseEpisodeContent(m.content, m.createdAt))
                .filter((e): e is TaskEpisode => e !== null);
        } catch (err) {
            logger.error('TaskEpisodeMemory: 検索エラー', err);
            return [];
        }
    }

    /**
     * 過去のエピソードを FCA プロンプト用テキストにフォーマットする。
     */
    formatForPrompt(episodes: TaskEpisode[]): string | null {
        if (episodes.length === 0) return null;

        const lines: string[] = ['## 過去の類似タスクの経験'];

        for (const ep of episodes) {
            const dateStr = ep.timestamp.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
            const status = ep.success ? '✅成功' : '❌失敗';
            lines.push(`\n### [${dateStr}] ${ep.goal.substring(0, 60)} — ${status}`);

            if (ep.strategyUsed.length > 0) {
                lines.push(`- 戦略: ${ep.strategyUsed.join(' → ')}`);
            }
            if (ep.failurePatterns.length > 0) {
                lines.push(`- 失敗パターン: ${ep.failurePatterns.join(', ')}`);
            }
            if (ep.lesson) {
                lines.push(`- 教訓: ${ep.lesson}`);
            }
        }

        return lines.join('\n');
    }

    /**
     * FCA の実行結果から TaskEpisode を構築するヘルパー。
     */
    static buildEpisodeFromResult(
        goal: string,
        platform: string,
        taskTree: TaskTreeState | undefined,
        startTime: number,
        iterationCount: number,
    ): TaskEpisode {
        const success = taskTree?.status === 'completed';
        const strategyUsed: string[] = [];
        const failurePatterns: string[] = [];

        if (taskTree?.hierarchicalSubTasks) {
            for (const step of taskTree.hierarchicalSubTasks) {
                if (step.status === 'completed') {
                    strategyUsed.push(step.goal);
                } else if (step.status === 'error') {
                    failurePatterns.push(`${step.goal}: ${step.failureReason || 'unknown'}`);
                }
            }
        }

        let lesson = '';
        if (!success && failurePatterns.length > 0) {
            lesson = `${failurePatterns[failurePatterns.length - 1]} で失敗。別の手段を試す必要がある。`;
        } else if (success && strategyUsed.length > 0) {
            const uniqueTools = [...new Set(strategyUsed)];
            lesson = `${uniqueTools.join(' → ')} の順序で成功。`;
        }

        if (taskTree?.recoveryStatus === 'failed_terminal') {
            lesson += ` 回復不能な失敗（${taskTree.lastFailureType || 'unknown'}）。`;
        }

        return {
            goal,
            platform,
            success,
            iterationCount,
            durationMs: Date.now() - startTime,
            strategyUsed: [...new Set(strategyUsed)],
            failurePatterns: [...new Set(failurePatterns)],
            lesson,
            timestamp: new Date(),
        };
    }

    // ── private helpers ──

    private extractGoalKeywords(goal: string): string[] {
        const snakeCaseItems = goal.match(/[a-z][a-z0-9_]+(?:_[a-z0-9]+)+/g) || [];

        const actionKeywords = ['craft', 'mine', 'build', 'smelt', 'cook', 'farm', 'explore', 'fight', 'move'];
        const foundActions = actionKeywords.filter(k => goal.toLowerCase().includes(k));

        const jpKeywords: string[] = [];
        const jpPatterns = [
            /作[っるれろ]/,
            /掘[っるれろ]/,
            /精錬/,
            /焼[くいけ]/,
            /探[すし]/,
            /戦[うい]/,
            /建[てつ]/,
        ];
        const jpKeywordMap: Record<number, string> = {
            0: 'craft', 1: 'mine', 2: 'smelt', 3: 'cook',
            4: 'explore', 5: 'fight', 6: 'build',
        };
        jpPatterns.forEach((pattern, i) => {
            if (pattern.test(goal)) {
                jpKeywords.push(jpKeywordMap[i]);
            }
        });

        return [...new Set([...snakeCaseItems, ...foundActions, ...jpKeywords])];
    }

    private formatEpisodeContent(episode: TaskEpisode): string {
        const parts = [
            `[EPISODE]`,
            `goal: ${episode.goal}`,
            `platform: ${episode.platform}`,
            `success: ${episode.success}`,
            `iterations: ${episode.iterationCount}`,
            `duration_ms: ${episode.durationMs}`,
            `strategy: ${episode.strategyUsed.join(',')}`,
            `failures: ${episode.failurePatterns.join(',')}`,
            `lesson: ${episode.lesson}`,
        ];
        return parts.join('\n');
    }

    private parseEpisodeContent(content: string, createdAt: Date): TaskEpisode | null {
        if (!content.startsWith('[EPISODE]')) return null;

        const getField = (field: string): string => {
            const match = content.match(new RegExp(`^${field}: (.*)$`, 'm'));
            return match?.[1] ?? '';
        };

        return {
            goal: getField('goal'),
            platform: getField('platform'),
            success: getField('success') === 'true',
            iterationCount: parseInt(getField('iterations')) || 0,
            durationMs: parseInt(getField('duration_ms')) || 0,
            strategyUsed: getField('strategy').split(',').filter(Boolean),
            failurePatterns: getField('failures').split(',').filter(Boolean),
            lesson: getField('lesson'),
            timestamp: createdAt,
        };
    }
}
