import { EmotionType } from '@shannon/common';
import { logger } from '../../../../utils/logger.js';
import { EmotionNode } from '../nodes/EmotionNode.js';
import { CognitiveBlackboard } from './CognitiveBlackboard.js';
import type { ExecutionResult } from '../types.js';

/**
 * EmotionLoop — 扁桃体 (Amygdala) に相当する非同期感情プロセス。
 *
 * CognitiveBlackboard のタスク状態とメタ認知状態を読み取り、
 * 感情をリアルタイムに更新する。
 *
 * トリガー:
 *   - task:updated (debounced, 最低10秒間隔)
 *   - meta:updated (即座に)
 *   - 停止: blackboard.completed
 */

const MIN_INTERVAL_MS = 10_000;

export class EmotionLoop {
    private blackboard: CognitiveBlackboard;
    private emotionNode: EmotionNode;
    private lastTickTime = 0;
    private pending = false;
    private stopped = false;

    constructor(blackboard: CognitiveBlackboard, emotionNode: EmotionNode) {
        this.blackboard = blackboard;
        this.emotionNode = emotionNode;
    }

    /**
     * ループを開始する。blackboard.complete() が呼ばれるまで動作する。
     */
    async run(): Promise<void> {
        this.stopped = false;

        // 初回 tick を即座に実行 (emotion ノード廃止に伴い、ここで初期感情を設定する)
        await this.tick();

        // イベントリスナーを登録
        const onTaskUpdated = () => this.scheduleTick();
        const onMetaUpdated = () => this.scheduleTick();
        const onCompleted = () => { this.stopped = true; };

        this.blackboard.on('task:updated', onTaskUpdated);
        this.blackboard.on('meta:updated', onMetaUpdated);
        this.blackboard.on('completed', onCompleted);

        // 完了まで待機
        await new Promise<void>(resolve => {
            if (this.stopped) return resolve();
            this.blackboard.once('completed', resolve);
        });

        // クリーンアップ
        this.blackboard.off('task:updated', onTaskUpdated);
        this.blackboard.off('meta:updated', onMetaUpdated);
        this.blackboard.off('completed', onCompleted);
    }

    private scheduleTick(): void {
        if (this.stopped || this.pending) return;

        const elapsed = Date.now() - this.lastTickTime;
        if (elapsed >= MIN_INTERVAL_MS) {
            void this.tick();
        } else {
            this.pending = true;
            setTimeout(() => {
                this.pending = false;
                if (!this.stopped) void this.tick();
            }, MIN_INTERVAL_MS - elapsed);
        }
    }

    private async tick(): Promise<void> {
        if (this.stopped) return;
        this.lastTickTime = Date.now();

        try {
            const snapshot = this.blackboard.snapshot();

            const recentResults = snapshot.taskState.recentToolCalls.slice(-5);
            const currentEmotion = snapshot.emotionState;

            const newEmotion = await this.emotionNode.evaluateAsync(
                this.blackboard.messages,
                recentResults.length > 0 ? recentResults : null,
                currentEmotion,
            );

            if (!this.stopped) {
                this.blackboard.updateEmotion(newEmotion);
            }
        } catch (error) {
            logger.error('[EmotionLoop] tick error:', error);
        }
    }
}
