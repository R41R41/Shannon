import type { RequestEnvelope, TaskTreeState } from '@shannon/common';
import { logger } from '../../../../../utils/logger.js';
import { CONFIG as MINEBOT_CONFIG } from '../../../../minebot/config/MinebotConfig.js';
import { canPostMinebotUiFromEnvelope } from '../../../../minebot/runtime/minebotUiPost.js';
import { createRequestDiscordConversation } from '../../../../common/discordConversationPort.js';
import { createRequestWebConversation } from '../../../../common/webConversationPort.js';

/** タスクツリーを request-bound port 経由で UI（Web / Discord / MinebotUI）に配信する */
export class TaskTreePublisher {
    publishTaskTree(
        taskTree: TaskTreeState,
        delivery: {
            platform: string | null;
            channelId: string | null;
            taskId: string | null;
            envelope?: RequestEnvelope;
            signal?: AbortSignal;
            onTaskTreeUpdate?: (taskTree: TaskTreeState) => void;
        },
    ): void {
        const { platform, taskId, envelope, signal, onTaskTreeUpdate } = delivery;
        if (platform === 'minecraft' || platform === 'minebot') {
            if (canPostMinebotUiFromEnvelope(envelope)) {
                void this.postTaskTreeToMinebotUi(taskTree);
            }
        }
        if (onTaskTreeUpdate) {
            try { onTaskTreeUpdate(taskTree); } catch { /* fire-and-forget */ }
        }
        if (envelope?.channel === 'web') {
            void createRequestWebConversation(envelope, signal).publishPlanning({
                planning: taskTree,
                taskId: taskId || envelope.requestId,
            });
        }
        if (envelope?.channel === 'discord') {
            void createRequestDiscordConversation(envelope, signal).publishPlanning({
                planning: taskTree,
                taskId: taskId || envelope.requestId,
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

    async postDetailedLogToMinebotUi(
        goal: string,
        phase: string,
        level: string,
        source: string,
        content: string,
        metadata?: Record<string, unknown>,
        envelope?: RequestEnvelope,
    ): Promise<void> {
        if (!canPostMinebotUiFromEnvelope(envelope)) return;
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
