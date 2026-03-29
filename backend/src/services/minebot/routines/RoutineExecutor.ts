/**
 * RoutineExecutor — JSON ルーチン定義を LLM 呼び出しなしで実行
 *
 * InstantSkill を直接呼び出し、変数テンプレートを解決しながら
 * ステップを順次実行する。失敗時は即座に呼び出し元 (FCA) に返す。
 *
 * 安全策:
 *  - AbortSignal で緊急割込みに即座に反応
 *  - bot.executingSkill を実行中 true にして ConstantSkill の干渉を防止
 */

import { createLogger } from '../../../utils/logger.js';
import type { InstantSkills } from '../types/collections.js';
import type { CustomBot } from '../types/CustomBot.js';
import type { SkillResult } from '../types/skillParams.js';
import type {
    RoutineDefinition,
    RoutineStepDef,
    RoutineSkillStep,
    RoutineLoopStep,
    RoutineExecutionResult,
    RoutineStepResult,
} from './types.js';
import { isSkillStep, isLoopStep } from './types.js';

const log = createLogger('Minebot:RoutineExecutor');

/** RoutineStep 失敗時に throw される */
class RoutineStepError extends Error {
    constructor(
        public readonly stepSkill: string,
        public readonly stepResult: string,
        public readonly recoverable: boolean,
    ) {
        super(`Step "${stepSkill}" failed: ${stepResult}`);
        this.name = 'RoutineStepError';
    }
}

/** AbortSignal による中断時に throw される */
class RoutineAbortedError extends Error {
    constructor(public readonly stepSkill: string) {
        super(`Routine aborted (emergency or timeout) during step "${stepSkill}"`);
        this.name = 'RoutineAbortedError';
    }
}

export interface RoutineExecuteOptions {
    /** 緊急割込み・タイムアウトで中断するための AbortSignal */
    abortSignal?: AbortSignal;
}

export class RoutineExecutor {
    constructor(
        private instantSkills: InstantSkills,
        private bot: CustomBot,
    ) {}

    async execute(
        routine: RoutineDefinition,
        params: Record<string, unknown>,
        options: RoutineExecuteOptions = {},
    ): Promise<RoutineExecutionResult> {
        const startTime = Date.now();
        const vars: Record<string, unknown> = { ...params };
        const stepResults: RoutineStepResult[] = [];
        const totalSteps = this.countSteps(routine.steps);
        const { abortSignal } = options;

        log.info(`▶ Routine "${routine.name}" start (${totalSteps} steps)`, 'cyan');

        // ルーチン実行中は bot.executingSkill = true にして
        // containMovement な ConstantSkill の干渉を防ぐ。
        // ただし各 InstantSkill.run() が内部で再設定するため、
        // ステップ間の隙間を埋めるのが主な目的。
        const previousExecutingSkill = this.bot.executingSkill;
        this.bot.executingSkill = true;

        try {
            await this.executeSteps(routine.steps, vars, stepResults, abortSignal);

            const durationMs = Date.now() - startTime;
            const summary = this.buildSummary(routine.name, stepResults, durationMs);
            log.success(`✔ Routine "${routine.name}" completed in ${durationMs}ms`);

            return {
                success: true,
                summary,
                stepsCompleted: stepResults.length,
                stepsTotal: totalSteps,
                durationMs,
                stepResults,
            };
        } catch (e) {
            const durationMs = Date.now() - startTime;
            const isAborted = e instanceof RoutineAbortedError;
            const failedStep =
                e instanceof RoutineStepError
                    ? e.stepSkill
                    : e instanceof RoutineAbortedError
                      ? e.stepSkill
                      : 'unknown';
            const error = e instanceof Error ? e.message : String(e);

            if (isAborted) {
                log.warn(`⚠ Routine "${routine.name}" aborted at "${failedStep}"`);
            } else {
                log.error(`✖ Routine "${routine.name}" failed at "${failedStep}"`, e);
            }

            return {
                success: false,
                summary: `Routine "${routine.name}" ${isAborted ? 'aborted' : 'failed'} at step "${failedStep}": ${error}`,
                stepsCompleted: stepResults.length,
                stepsTotal: totalSteps,
                failedStep,
                error,
                durationMs,
                stepResults,
            };
        } finally {
            // executingSkill を元に戻す
            this.bot.executingSkill = previousExecutingSkill;
        }
    }

    // ─── ステップ実行 ───

    private async executeSteps(
        steps: RoutineStepDef[],
        vars: Record<string, unknown>,
        results: RoutineStepResult[],
        abortSignal?: AbortSignal,
    ): Promise<void> {
        for (const step of steps) {
            // 各ステップ前に中断チェック
            this.checkAbort(abortSignal, isSkillStep(step) ? step.skill : 'loop');

            if (isLoopStep(step)) {
                await this.executeLoopStep(step, vars, results, abortSignal);
            } else if (isSkillStep(step)) {
                await this.executeSkillStep(step, vars, results, abortSignal);
            }
        }
    }

    private async executeSkillStep(
        step: RoutineSkillStep,
        vars: Record<string, unknown>,
        results: RoutineStepResult[],
        abortSignal?: AbortSignal,
    ): Promise<void> {
        const skill = this.instantSkills.getSkill(step.skill);
        if (!skill) {
            throw new RoutineStepError(step.skill, `Skill "${step.skill}" not found`, false);
        }

        const resolvedArgs = this.resolveArgs(step.args, vars);
        const repeatCount = step.repeat
            ? Number(this.resolveValue(step.repeat, vars)) || 1
            : 1;

        for (let i = 0; i < repeatCount; i++) {
            // repeat ループ内でも中断チェック
            this.checkAbort(abortSignal, step.skill);

            const positionalArgs = this.toPositionalArgs(skill.params, resolvedArgs);
            const stepStart = Date.now();

            let skillResult: SkillResult;
            try {
                skillResult = await skill.run(...positionalArgs);
            } catch (e) {
                const errorMsg = e instanceof Error ? e.message : String(e);
                skillResult = { success: false, result: errorMsg };
            }

            // スキル実行後も中断チェック（スキルが interruptExecution で中断された場合）
            if (this.bot.interruptExecution) {
                throw new RoutineAbortedError(step.skill);
            }

            const stepResult: RoutineStepResult = {
                skill: step.skill,
                args: resolvedArgs,
                success: skillResult.success,
                result: skillResult.result,
                durationMs: Date.now() - stepStart,
            };
            results.push(stepResult);

            // 変数に結果を格納
            if (step.outputVar) {
                vars[step.outputVar] = skillResult.result;
            }

            // 失敗処理
            if (!skillResult.success) {
                const onFailure = step.onFailure ?? 'abort';
                if (onFailure === 'abort') {
                    throw new RoutineStepError(
                        step.skill,
                        skillResult.result,
                        skillResult.recoverable ?? true,
                    );
                }
                if (onFailure === 'skip') break; // repeat ループを抜ける
                // 'continue' — 次の repeat へ
            }
        }
    }

    private async executeLoopStep(
        step: RoutineLoopStep,
        vars: Record<string, unknown>,
        results: RoutineStepResult[],
        abortSignal?: AbortSignal,
    ): Promise<void> {
        const times = Number(this.resolveValue(step.loop.times, vars)) || 0;

        for (let i = 0; i < times; i++) {
            this.checkAbort(abortSignal, 'loop');
            vars['loop_index'] = i;
            try {
                await this.executeSteps(step.loop.steps, vars, results, abortSignal);
            } catch (e) {
                if (e instanceof RoutineAbortedError) throw e; // 中断は常に伝搬
                const onFailure = step.onFailure ?? 'abort';
                if (onFailure === 'abort') throw e;
                if (onFailure === 'skip') break;
                // 'continue' — 次のイテレーション
            }
        }
        delete vars['loop_index'];
    }

    // ─── 中断チェック ───

    private checkAbort(abortSignal: AbortSignal | undefined, currentStep: string): void {
        if (abortSignal?.aborted) {
            throw new RoutineAbortedError(currentStep);
        }
        if (this.bot.interruptExecution) {
            throw new RoutineAbortedError(currentStep);
        }
    }

    // ─── テンプレート解決 ───

    private resolveArgs(
        args: Record<string, unknown>,
        vars: Record<string, unknown>,
    ): Record<string, unknown> {
        const resolved: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(args)) {
            resolved[key] = this.resolveValue(value, vars);
        }
        return resolved;
    }

    private resolveValue(value: unknown, vars: Record<string, unknown>): unknown {
        if (typeof value !== 'string') return value;

        // 完全テンプレート: "${count}" → 型を保持して直接置換
        const fullMatch = value.match(/^\$\{(\w+)\}$/);
        if (fullMatch) {
            const varName = fullMatch[1];
            return vars[varName] !== undefined ? vars[varName] : value;
        }

        // 部分テンプレート: "item_${type}" → 文字列補間
        if (value.includes('${')) {
            return value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
                const v = vars[name];
                return v !== undefined ? String(v) : `\${${name}}`;
            });
        }

        return value;
    }

    // ─── ユーティリティ ───

    /** SkillParam[] 定義順に named args → positional args 変換 */
    private toPositionalArgs(
        params: Array<{ name: string; type: string; default?: unknown }>,
        namedArgs: Record<string, unknown>,
    ): unknown[] {
        return params.map((p) => {
            const val = namedArgs[p.name];
            if (val !== undefined) return this.coerceType(val, p.type);
            if (p.default !== undefined) return p.default;
            return undefined;
        });
    }

    private coerceType(value: unknown, type: string): unknown {
        switch (type) {
            case 'number':
                return typeof value === 'number' ? value : Number(value);
            case 'boolean':
                return typeof value === 'boolean' ? value : value === 'true';
            case 'string':
                return String(value);
            default:
                return value;
        }
    }

    /** ステップ総数のカウント（ループ内は展開しない） */
    private countSteps(steps: RoutineStepDef[]): number {
        let count = 0;
        for (const step of steps) {
            if (isLoopStep(step)) {
                count += this.countSteps(step.loop.steps);
            } else {
                count += 1;
            }
        }
        return count;
    }

    private buildSummary(
        routineName: string,
        results: RoutineStepResult[],
        durationMs: number,
    ): string {
        const succeeded = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;

        const lines = [
            `Routine "${routineName}" completed: ${succeeded} succeeded, ${failed} failed (${durationMs}ms)`,
        ];

        // 最後の数ステップの結果を要約
        const recent = results.slice(-3);
        for (const r of recent) {
            const icon = r.success ? '✔' : '✖';
            const truncated =
                r.result.length > 100 ? r.result.slice(0, 100) + '...' : r.result;
            lines.push(`  ${icon} ${r.skill}: ${truncated}`);
        }

        return lines.join('\n');
    }
}
