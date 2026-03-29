/**
 * Routine System — System 1 (手続き記憶) 層
 *
 * LLM (System 2) と InstantSkill の間に位置し、
 * 定型手順を LLM 呼び出しなしで高速実行する。
 */

// ─── Routine 定義 ───

export interface RoutineParam {
    name: string;
    type: 'string' | 'number' | 'boolean';
    description: string;
    required?: boolean;
    default?: string | number | boolean;
}

/** スキル呼び出しステップ */
export interface RoutineSkillStep {
    skill: string;
    args: Record<string, unknown>;
    /** 結果を変数に格納（後続ステップで ${varName} 参照可） */
    outputVar?: string;
    /** 同一ステップを繰り返す回数（${param} テンプレート可） */
    repeat?: number | string;
    /** 失敗時の挙動 (default: 'abort') */
    onFailure?: 'abort' | 'skip' | 'continue';
}

/** ループステップ */
export interface RoutineLoopStep {
    loop: {
        /** ループ回数（${param} テンプレート可） */
        times: number | string;
        steps: RoutineStepDef[];
    };
    onFailure?: 'abort' | 'skip' | 'continue';
}

export type RoutineStepDef = RoutineSkillStep | RoutineLoopStep;

export interface RoutineStats {
    runs: number;
    successes: number;
    failures: number;
    avgDurationMs: number;
}

export interface RoutineDefinition {
    name: string;
    description: string;
    params: RoutineParam[];
    steps: RoutineStepDef[];
    /** 失敗時の挙動: system2 = FCA に返す (default) */
    failureEscalation: 'system2' | 'retry';
    /** 作成元 */
    source: 'manual' | 'self-improve' | 'recorded' | 'shannon';
    stats: RoutineStats;
}

// ─── 実行結果 ───

export interface RoutineStepResult {
    skill: string;
    args: Record<string, unknown>;
    success: boolean;
    result: string;
    durationMs: number;
}

export interface RoutineExecutionResult {
    success: boolean;
    summary: string;
    stepsCompleted: number;
    stepsTotal: number;
    failedStep?: string;
    error?: string;
    durationMs: number;
    stepResults: RoutineStepResult[];
}

// ─── 型ガード ───

export function isSkillStep(step: RoutineStepDef): step is RoutineSkillStep {
    return 'skill' in step;
}

export function isLoopStep(step: RoutineStepDef): step is RoutineLoopStep {
    return 'loop' in step;
}
