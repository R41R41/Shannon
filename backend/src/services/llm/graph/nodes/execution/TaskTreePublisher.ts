import { DiscordPlanningInput, TaskTreeState } from '@shannon/common';
import { logger } from '../../../../../utils/logger.js';
import { EventBus } from '../../../../eventBus/eventBus.js';
import { CONFIG as MINEBOT_CONFIG } from '../../../../minebot/config/MinebotConfig.js';

/**
 * タスクツリーの状態をEventBus経由でUI（Web / Discord / MinebotUI）に配信する
 */
export class TaskTreePublisher {
    private eventBus: EventBus;

    constructor(eventBus: EventBus) {
        this.eventBus = eventBus;
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

        this.eventBus.publish({
            type: 'web:planning',
            memoryZone: 'web',
            data: taskTree,
            targetMemoryZones: ['web'],
        });

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

    async postTaskTreeToMinebotUi(taskTree: TaskTreeState): Promise<void> {
        try {
            const response = await fetch(`${MINEBOT_CONFIG.UI_MOD_BASE_URL}/task`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify(taskTree),
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
