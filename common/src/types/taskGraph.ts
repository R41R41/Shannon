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
  goal: string;                    // やること（自然言語）
  status: TaskStatus;              // ステータス: pending | in_progress | completed | error
  result?: string | null;          // 結果（完了時）
  failureReason?: string | null;   // エラー理由（失敗時）

  // フラット構造で親子関係を表現（再帰スキーマ回避）
  parentId?: string | null;        // 親サブタスクID（トップレベルはnull）
  children?: HierarchicalSubTask[] | null;  // 後方互換用（非推奨）
  depth?: number;                  // 階層の深さ（0が最上位）- optional for backward compat
}

// 次に実行するアクション（実行用・引数は完全に指定）
export interface ActionItem {
  toolName: string;
  args: Record<string, unknown>;    // 引数は必須（nullは不可）
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

  // === 表示用: タスクの全体像 ===
  hierarchicalSubTasks?: HierarchicalSubTask[] | null;
  currentSubTaskId?: string | null;  // 現在実行中のサブタスクID

  // === 実行用: 次に実行するスキル ===
  nextActionSequence?: ActionItem[] | null;  // 引数が完全に指定されたスキルのみ

  // === 後方互換性 ===
  actionSequence?: ActionItem[] | null;  // 旧名（nextActionSequenceと同じ）
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
