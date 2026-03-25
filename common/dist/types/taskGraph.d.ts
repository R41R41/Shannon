export interface TaskInput {
    waitSeconds?: number | null;
    date?: Date | null;
}
export type TaskStatus = "pending" | "in_progress" | "completed" | "error";
/**
 * 階層的サブタスク構造（タスクの全体像・表示用）
 *
 * 例:
 * ├── 石のツルハシを作る
 * │   ├── 丸石を3つ集める
 * │   │   ├── 丸石を探す ✓
 * │   │   ├── 丸石に移動する ✓
 * │   │   └── 丸石を掘る ↻
 * │   ├── 棒を2本用意する □
 * │   └── クラフトする □
 */
export interface HierarchicalSubTask {
    id: string;
    goal: string;
    status: TaskStatus;
    result?: string | null;
    failureReason?: string | null;
    parentId?: string | null;
    children?: HierarchicalSubTask[] | null;
    depth?: number;
}
export interface ActionItem {
    toolName: string;
    args: Record<string, unknown>;
    expectedResult: string;
}
export interface TaskTreeState {
    goal: string;
    strategy: string;
    status: TaskStatus;
    error?: string | null;
    currentThinking?: string | null;
    recoveryStatus?: 'idle' | 'retrying' | 'awaiting_user' | 'failed_terminal' | null;
    lastFailureType?: string | null;
    recoveryAttempts?: number | null;
    retryBudget?: number | null;
    hierarchicalSubTasks?: HierarchicalSubTask[] | null;
    currentSubTaskId?: string | null;
    nextActionSequence?: ActionItem[] | null;
    actionSequence?: ActionItem[] | null;
    subTasks?: {
        subTaskGoal: string;
        subTaskStrategy: string;
        subTaskStatus: TaskStatus;
        subTaskResult?: string | null;
    }[] | null;
}
export interface EmotionType {
    emotion: string;
    parameters: {
        joy: number;
        trust: number;
        fear: number;
        surprise: number;
        sadness: number;
        disgust: number;
        anger: number;
        anticipation: number;
    };
}
export type TaskEventType = "task:stop" | "task:start";
