import { EventEmitter } from 'node:events';
import { BaseMessage } from '@langchain/core/messages';
import { EmotionType } from '@shannon/common';
import { ExecutionResult } from '../types.js';

/**
 * CognitiveBlackboard — 3並列プロセス間の共有状態。
 *
 * 脳の「ワーキングメモリ」に相当し、感情・メタ認知・タスク実行の
 * 各プロセスがイベント駆動で読み書きする。
 *
 * Events:
 *   'emotion:updated'  — EmotionLoop が感情を更新した
 *   'meta:updated'     — MetaCognitionLoop がメタ状態を更新した
 *   'task:updated'     — TaskExecutionLoop がタスク状態を更新した
 *   'plan:updated'     — PlanState が更新された
 *   'loop:detected'    — LoopDetector がループを検出した
 *   'emotion:shifted'  — 感情が大きく変化した（急変検出）
 *   'completed'        — タスクが完了した（全プロセスに停止シグナル）
 */

// ── Types ──

export type MetaAssessment = 'on_track' | 'struggling' | 'stuck' | 'wrong_approach';

export interface MetaState {
    assessment: MetaAssessment;
    suggestion: string | null;
    modelAction: 'escalate' | 'deescalate' | 'hold';
    shouldStop: boolean;
    timestamp: number;
}

export interface TaskState {
    iteration: number;
    recentToolCalls: ExecutionResult[];
    currentThinking: string | null;
    totalSuccesses: number;
    totalFailures: number;
    timestamp: number;
}

export interface InventoryEntry {
    name: string;
    count: number;
}

// ── SelfState (身体状態の統合) ──

export interface SelfState {
    inventory: InventoryEntry[] | null;
    health: number | null;
    food: number | null;
    /** インベントリの空きスロット数（36枠中）。null = 不明 */
    freeSlots: number | null;
    /** アクティブなステータスエフェクト */
    activeEffects: Array<{ name: string; amplifier: number }>;
    vitalAlerts: string[];
}

// ── PlanState (再帰サブタスク + ローリングサマリー) ──

export interface PlanSubtask {
    id: string;                // "st_1", "st_1.1" (ネスト時)
    goal: string;
    status: 'pending' | 'in_progress' | 'completed' | 'error' | 'skipped';
    result?: string;
    failureReason?: string;
    iterationsSpent: number;
    children: PlanSubtask[];   // 再帰: サブタスクのサブタスク
    createdBy: 'plan_craft' | 'meta_cognition';
    createdAt: number;
    completedAt?: number;
}

export interface PlanState {
    goal: string;
    strategy: string;
    subtasks: PlanSubtask[];
    currentSubtaskId: string | null;
    /** ローリングサマリー: LLM が生成する旅程の圧縮要約 (500字以内) */
    journalSummary: string;
    lastUpdatedBy: 'plan_craft' | 'meta_cognition' | 'fca';
    createdAt: number;
    updatedAt: number;
}

/** サブタスク総数上限 */
const MAX_SUBTASK_COUNT = 20;
/** ネスト深さ上限 */
const MAX_SUBTASK_DEPTH = 3;

// ── Snapshot ──

export interface BlackboardSnapshot {
    goal: string;
    emotionState: EmotionType | null;
    metaState: MetaState | null;
    taskState: TaskState;
    selfState: SelfState;
    plan: PlanState | null;
    isComplete: boolean;
    elapsedMs: number;
}

const EMOTION_SHIFT_THRESHOLD = 30;

// ── Helpers ──

/** 再帰的にサブタスクを探索する */
function findSubtaskRecursive(subtasks: PlanSubtask[], id: string): PlanSubtask | null {
    for (const st of subtasks) {
        if (st.id === id) return st;
        const found = findSubtaskRecursive(st.children, id);
        if (found) return found;
    }
    return null;
}

/** 再帰的にサブタスクの総数を数える */
function countSubtasks(subtasks: PlanSubtask[]): number {
    let count = subtasks.length;
    for (const st of subtasks) {
        count += countSubtasks(st.children);
    }
    return count;
}

/** サブタスクIDのネスト深さを返す (st_1=1, st_1.1=2, st_1.1.1=3) */
function subtaskDepth(id: string): number {
    return id.split('.').length;
}

/** サブタスクをディープコピーする */
function deepCopySubtasks(subtasks: PlanSubtask[]): PlanSubtask[] {
    return subtasks.map(s => ({
        ...s,
        children: deepCopySubtasks(s.children),
    }));
}

/** 親サブタスクのchildrenから対象を削除する (再帰) */
function removeSubtaskRecursive(subtasks: PlanSubtask[], id: string): boolean {
    const idx = subtasks.findIndex(s => s.id === id);
    if (idx !== -1) {
        subtasks.splice(idx, 1);
        return true;
    }
    for (const st of subtasks) {
        if (removeSubtaskRecursive(st.children, id)) return true;
    }
    return false;
}

/** 親を見つけて子リストを返す (トップレベルならnull) */
function findParentChildren(subtasks: PlanSubtask[], childId: string): PlanSubtask[] | null {
    for (const st of subtasks) {
        if (st.children.some(c => c.id === childId)) return st.children;
        const found = findParentChildren(st.children, childId);
        if (found) return found;
    }
    return null;
}

// ── Main Class ──

export class CognitiveBlackboard extends EventEmitter {
    // Emotion (Amygdala)
    private _emotionState: EmotionType | null = null;
    private _previousEmotion: EmotionType | null = null;

    // Meta-cognition (DLPFC)
    private _metaState: MetaState | null = null;

    // Task Execution (Motor Cortex)
    private _taskState: TaskState = {
        iteration: 0,
        recentToolCalls: [],
        currentThinking: null,
        totalSuccesses: 0,
        totalFailures: 0,
        timestamp: Date.now(),
    };

    // Self State (身体状態)
    private _selfState: SelfState = {
        inventory: null,
        health: null,
        food: null,
        freeSlots: null,
        activeEffects: [],
        vitalAlerts: [],
    };

    // Plan (Prefrontal Cortex — 計画管理)
    private _planState: PlanState | null = null;

    // Initial Memory Context (MemoryAgent が execute 開始時に非同期取得)
    private _initialMemoryContext: string | null = null;

    // Coordination
    readonly goal: string;
    private _isComplete = false;
    private _startTime: number;
    private _abortController: AbortController;

    // Messages (shared reference for all processes)
    private _messages: BaseMessage[];

    constructor(goal: string, initialEmotion: EmotionType | null, messages: BaseMessage[]) {
        super();
        this.setMaxListeners(20);
        this.goal = goal;
        this._emotionState = initialEmotion;
        this._messages = messages;
        this._startTime = Date.now();
        this._abortController = new AbortController();
    }

    // ── Getters ──

    get emotionState(): EmotionType | null { return this._emotionState; }
    get metaState(): MetaState | null { return this._metaState; }
    get taskState(): TaskState { return this._taskState; }
    get selfState(): SelfState { return this._selfState; }
    get plan(): PlanState | null { return this._planState; }
    get initialMemoryContext(): string | null { return this._initialMemoryContext; }
    get isComplete(): boolean { return this._isComplete; }
    get signal(): AbortSignal { return this._abortController.signal; }
    get messages(): BaseMessage[] { return this._messages; }
    get elapsedMs(): number { return Date.now() - this._startTime; }

    // 後方互換ゲッター
    get inventory(): InventoryEntry[] | null { return this._selfState.inventory; }
    get health(): number | null { return this._selfState.health; }
    get food(): number | null { return this._selfState.food; }
    get freeSlots(): number | null { return this._selfState.freeSlots; }
    get activeEffects(): Array<{ name: string; amplifier: number }> { return this._selfState.activeEffects; }
    get vitalAlerts(): string[] { return this._selfState.vitalAlerts; }

    snapshot(): BlackboardSnapshot {
        return {
            goal: this.goal,
            emotionState: this._emotionState,
            metaState: this._metaState,
            taskState: { ...this._taskState },
            selfState: {
                inventory: this._selfState.inventory,
                health: this._selfState.health,
                food: this._selfState.food,
                freeSlots: this._selfState.freeSlots,
                activeEffects: [...this._selfState.activeEffects],
                vitalAlerts: [...this._selfState.vitalAlerts],
            },
            plan: this._planState ? {
                ...this._planState,
                subtasks: deepCopySubtasks(this._planState.subtasks),
            } : null,
            isComplete: this._isComplete,
            elapsedMs: this.elapsedMs,
        };
    }

    // ── Emotion ──

    updateEmotion(emotion: EmotionType): void {
        this._previousEmotion = this._emotionState;
        this._emotionState = emotion;
        this.emit('emotion:updated', emotion);

        if (this._previousEmotion && this.detectEmotionShift(this._previousEmotion, emotion)) {
            this.emit('emotion:shifted', emotion, this._previousEmotion);
        }
    }

    // ── Meta-cognition ──

    updateMeta(meta: MetaState): void {
        this._metaState = meta;
        this.emit('meta:updated', meta);
    }

    // ── Task Execution ──

    updateTask(update: Partial<TaskState> & { newResults?: ExecutionResult[] }): void {
        if (update.iteration !== undefined) this._taskState.iteration = update.iteration;
        if (update.currentThinking !== undefined) this._taskState.currentThinking = update.currentThinking;

        if (update.newResults) {
            this._taskState.recentToolCalls = [
                ...this._taskState.recentToolCalls.slice(-15),
                ...update.newResults,
            ];
            for (const r of update.newResults) {
                if (r.success) this._taskState.totalSuccesses++;
                else this._taskState.totalFailures++;
            }
        }

        this._taskState.timestamp = Date.now();
        this.emit('task:updated', this._taskState);
    }

    // ── Self State (身体状態) ──

    updateSelf(patch: Partial<SelfState>): void {
        if (patch.inventory !== undefined) this._selfState.inventory = patch.inventory;
        if (patch.health !== undefined) this._selfState.health = patch.health;
        if (patch.food !== undefined) this._selfState.food = patch.food;
        if (patch.freeSlots !== undefined) this._selfState.freeSlots = patch.freeSlots;
        if (patch.activeEffects !== undefined) this._selfState.activeEffects = patch.activeEffects;
        if (patch.vitalAlerts !== undefined) {
            this._selfState.vitalAlerts = patch.vitalAlerts;
            if (patch.vitalAlerts.length > 0) {
                this.emit('vital:alert', patch.vitalAlerts);
            }
        }
    }

    // ── Plan (計画管理) ──

    updatePlan(plan: PlanState): void {
        this._planState = { ...plan, updatedAt: Date.now() };
        this.emit('plan:updated', this._planState);
    }

    /** ローリングサマリーを更新する */
    updateJournalSummary(summary: string): void {
        if (!this._planState) return;
        this._planState.journalSummary = summary;
        this._planState.updatedAt = Date.now();
    }

    /** サブタスクを再帰的に探索する */
    findSubtask(id: string): PlanSubtask | null {
        if (!this._planState) return null;
        return findSubtaskRecursive(this._planState.subtasks, id);
    }

    /** サブタスクステータスを部分更新する (再帰対応) */
    patchPlanSubtask(subtaskId: string, patch: Partial<PlanSubtask>): void {
        if (!this._planState) return;
        const st = findSubtaskRecursive(this._planState.subtasks, subtaskId);
        if (st) {
            Object.assign(st, patch);
            if (patch.status === 'completed' || patch.status === 'error' || patch.status === 'skipped') {
                st.completedAt = Date.now();
            }
            this._planState.updatedAt = Date.now();
            this._planState.lastUpdatedBy = 'meta_cognition';
            this.emit('plan:updated', this._planState);
        }
    }

    /** 現在の in_progress サブタスクの iterationsSpent をインクリメント (再帰対応) */
    incrementSubtaskIteration(): void {
        if (!this._planState?.currentSubtaskId) return;
        const st = findSubtaskRecursive(this._planState.subtasks, this._planState.currentSubtaskId);
        if (st) st.iterationsSpent++;
    }

    /** 新しいサブタスクを作成する */
    createSubtask(goal: string, parentId?: string, insertAfter?: string): PlanSubtask | null {
        if (!this._planState) return null;

        // 総数チェック
        if (countSubtasks(this._planState.subtasks) >= MAX_SUBTASK_COUNT) return null;

        // 挿入先を決定
        let targetList: PlanSubtask[];
        let newIdPrefix: string;

        if (parentId) {
            const parent = findSubtaskRecursive(this._planState.subtasks, parentId);
            if (!parent) return null;
            // 深さチェック
            if (subtaskDepth(parentId) >= MAX_SUBTASK_DEPTH) return null;
            targetList = parent.children;
            newIdPrefix = parentId;
        } else {
            targetList = this._planState.subtasks;
            newIdPrefix = 'st';
        }

        // ID生成
        const existingIds = targetList.map(s => s.id);
        let nextNum = targetList.length + 1;
        let newId = newIdPrefix === 'st'
            ? `st_${nextNum}`
            : `${newIdPrefix}.${nextNum}`;
        while (existingIds.includes(newId)) {
            nextNum++;
            newId = newIdPrefix === 'st'
                ? `st_${nextNum}`
                : `${newIdPrefix}.${nextNum}`;
        }

        const newSubtask: PlanSubtask = {
            id: newId,
            goal,
            status: 'pending',
            iterationsSpent: 0,
            children: [],
            createdBy: 'meta_cognition',
            createdAt: Date.now(),
        };

        // 挿入位置
        if (insertAfter) {
            const afterIdx = targetList.findIndex(s => s.id === insertAfter);
            if (afterIdx !== -1) {
                targetList.splice(afterIdx + 1, 0, newSubtask);
            } else {
                targetList.push(newSubtask);
            }
        } else {
            targetList.push(newSubtask);
        }

        this._planState.updatedAt = Date.now();
        this._planState.lastUpdatedBy = 'meta_cognition';
        this.emit('plan:updated', this._planState);
        return newSubtask;
    }

    /** サブタスクを削除する (子も含む) */
    deleteSubtask(id: string): boolean {
        if (!this._planState) return false;
        const st = findSubtaskRecursive(this._planState.subtasks, id);
        if (!st || st.status === 'in_progress') return false;

        const removed = removeSubtaskRecursive(this._planState.subtasks, id);
        if (removed) {
            if (this._planState.currentSubtaskId === id) {
                this._planState.currentSubtaskId = null;
            }
            this._planState.updatedAt = Date.now();
            this._planState.lastUpdatedBy = 'meta_cognition';
            this.emit('plan:updated', this._planState);
        }
        return removed;
    }

    /** サブタスクを同一親内で並べ替える */
    reorderSubtask(id: string, position: number): boolean {
        if (!this._planState) return false;

        // トップレベルか親の children かを判定
        let list: PlanSubtask[];
        const topIdx = this._planState.subtasks.findIndex(s => s.id === id);
        if (topIdx !== -1) {
            list = this._planState.subtasks;
        } else {
            const parentList = findParentChildren(this._planState.subtasks, id);
            if (!parentList) return false;
            list = parentList;
        }

        const fromIdx = list.findIndex(s => s.id === id);
        if (fromIdx === -1) return false;

        const [item] = list.splice(fromIdx, 1);
        const clampedPos = Math.max(0, Math.min(position, list.length));
        list.splice(clampedPos, 0, item);

        this._planState.updatedAt = Date.now();
        this._planState.lastUpdatedBy = 'meta_cognition';
        this.emit('plan:updated', this._planState);
        return true;
    }

    /** アクティブなサブタスクを切り替える */
    setActiveSubtask(id: string): boolean {
        if (!this._planState) return false;
        const st = findSubtaskRecursive(this._planState.subtasks, id);
        if (!st) return false;

        // 旧サブタスクを pending に戻す
        if (this._planState.currentSubtaskId && this._planState.currentSubtaskId !== id) {
            const prev = findSubtaskRecursive(this._planState.subtasks, this._planState.currentSubtaskId);
            if (prev && prev.status === 'in_progress') {
                prev.status = 'pending';
            }
        }

        st.status = 'in_progress';
        this._planState.currentSubtaskId = id;
        this._planState.updatedAt = Date.now();
        this._planState.lastUpdatedBy = 'meta_cognition';
        this.emit('plan:updated', this._planState);
        return true;
    }

    /** MemoryAgent からの初期記憶コンテキストを設定する */
    setInitialMemoryContext(context: string): void {
        this._initialMemoryContext = context;
    }

    /** 初期記憶コンテキストを消費する (1回のみ) */
    consumeInitialMemoryContext(): string | null {
        const ctx = this._initialMemoryContext;
        this._initialMemoryContext = null;
        return ctx;
    }

    // ── Loop Detection ──

    notifyLoopDetected(summary: string): void {
        this.emit('loop:detected', summary);
    }

    // ── Completion ──

    complete(): void {
        if (this._isComplete) return;
        this._isComplete = true;
        this._abortController.abort();
        this.emit('completed');
    }

    // ── Private helpers ──

    private detectEmotionShift(prev: EmotionType, next: EmotionType): boolean {
        const keys = ['joy', 'trust', 'fear', 'surprise', 'sadness', 'disgust', 'anger', 'anticipation'] as const;
        let maxDelta = 0;
        for (const key of keys) {
            const delta = Math.abs(
                (next.parameters[key] ?? 0) - (prev.parameters[key] ?? 0),
            );
            if (delta > maxDelta) maxDelta = delta;
        }
        return maxDelta >= EMOTION_SHIFT_THRESHOLD;
    }
}
