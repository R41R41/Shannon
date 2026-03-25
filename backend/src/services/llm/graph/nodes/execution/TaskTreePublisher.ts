import { DiscordPlanningInput, EmotionType, TaskTreeState } from '@shannon/common';
import { logger } from '../../../../../utils/logger.js';
import { EventBus } from '../../../../eventBus/eventBus.js';
import { CONFIG as MINEBOT_CONFIG } from '../../../../minebot/config/MinebotConfig.js';
import { MetaState } from '../../cognitive/CognitiveBlackboard.js';

export interface BlackboardExtras {
    metaState: MetaState | null;
    emotionState: EmotionType | null;
}

/**
 * タスクツリーの状態をEventBus経由でUI（Web / Discord / MinebotUI）に配信する
 */
export class TaskTreePublisher {
    private eventBus: EventBus;
    private blackboardAccessor: (() => BlackboardExtras) | null = null;

    constructor(eventBus: EventBus) {
        this.eventBus = eventBus;
    }

    /**
     * CognitiveBlackboard のスナップショットアクセサを設定する。
     * ParallelExecutor が呼び出し、メタ状態・感情をMinebotUIペイロードに含める。
     */
    setBlackboardAccessor(fn: (() => BlackboardExtras) | null): void {
        this.blackboardAccessor = fn;
    }

    /**
     * タスクツリーをEventBus経由でUI通知
     */
    publishTaskTree(
        taskTree: TaskTreeState,
        platform: string | null,
        channelId: string | null,
        taskId: string | null,
        onTaskTreeUpdate?: (taskTree: TaskTreeState) => void,
    ): void {
        if (platform === 'minecraft' || platform === 'minebot') {
            void this.postTaskTreeToMinebotUi(taskTree);
        }
        if (onTaskTreeUpdate) {
            try {
                onTaskTreeUpdate(taskTree as TaskTreeState);
            } catch {
                // fire-and-forget
            }
        }

        // WebUI に通知
        this.eventBus.publish({
            type: 'web:planning',
            memoryZone: 'web',
            data: taskTree,
            targetMemoryZones: ['web'],
        });

        // Discord に通知（channelIdがある場合）
        if (platform === 'discord' && channelId) {
            this.eventBus.publish({
                type: 'discord:planning',
                memoryZone: 'web',
                data: {
                    planning: taskTree,
                    channelId,
                    taskId: taskId || '',
                } as DiscordPlanningInput,
            });
        }
    }

    /**
     * Minebot UI にタスクツリーを送信（metaState / emotionState を付加）
     */
    async postTaskTreeToMinebotUi(taskTree: TaskTreeState): Promise<void> {
        try {
            const extras = this.blackboardAccessor ? this.blackboardAccessor() : null;
            const payload = extras
                ? { ...taskTree, metaState: extras.metaState, emotionState: extras.emotionState }
                : taskTree;
            const response = await fetch(`${MINEBOT_CONFIG.UI_MOD_BASE_URL}/task`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                logger.warn(`Minebot UI task post failed: ${response.status}`);
            }
        } catch {
            // UI Mod 未接続時は黙って無視
        }
    }

    /**
     * Minebot UI に詳細ログを送信
     */
    async postDetailedLogToMinebotUi(
        goal: string,
        phase: string,
        level: string,
        source: string,
        content: string,
        metadata?: Record<string, unknown>,
    ): Promise<void> {
        try {
            const logEntry: Record<string, unknown> = {
                timestamp: new Date().toISOString(),
                phase,
                level,
                source,
                content,
            };
            if (metadata) logEntry.metadata = metadata;
            await fetch(`${MINEBOT_CONFIG.UI_MOD_BASE_URL}/task_logs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify({ goal, logs: [logEntry] }),
            });
        } catch {
            // UI Mod 未接続時は黙って無視
        }
    }
}
