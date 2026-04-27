/**
 * RoutineWrapperTool — ルーチンを LangChain StructuredTool としてラップ
 *
 * FCA の toolMap に登録され、LLM から通常のツールと同様に呼び出される。
 * 内部では RoutineExecutor が InstantSkill を直接実行する（LLM 呼び出しなし）。
 */

import { StructuredTool } from '@langchain/core/tools';
import { z, ZodObject } from 'zod';
import type { RoutineManager } from './RoutineManager.js';
import type { RoutineExecutor } from './RoutineExecutor.js';
import type { RoutineDefinition, RoutineParam } from './types.js';

export class RoutineWrapperTool extends StructuredTool {
    name: string;
    description: string;
    schema: ZodObject<any>;

    constructor(
        private routineName: string,
        private routineManager: RoutineManager,
        private executor: RoutineExecutor,
    ) {
        super();
        const def = routineManager.get(routineName)!;
        this.name = `routine:${def.name}`;
        this.description = this.buildDescription(def);
        this.schema = this.buildSchema(def.params);
    }

    async _call(args: Record<string, unknown>): Promise<string> {
        const def = this.routineManager.get(this.routineName);
        if (!def) {
            return `Routine "${this.routineName}" not found (may have been deleted). Use individual skills instead.`;
        }

        const result = await this.executor.execute(def, args);

        // 統計更新（fire-and-forget）
        this.routineManager
            .updateStats(this.routineName, result.success, result.durationMs)
            .catch(() => {});

        return result.summary;
    }

    // ─── スキーマ構築 ───

    private buildDescription(def: RoutineDefinition): string {
        const stats = def.stats ?? { runs: 0, successes: 0, failures: 0, avgDurationMs: 0 };
        const reliability =
            stats.runs > 0
                ? ` (${stats.runs} runs, ${Math.round((stats.successes / stats.runs) * 100)}% success)`
                : '';
        return `[Routine] ${def.description}${reliability}. Executes a pre-defined sequence of skills without LLM calls — faster and more reliable than individual skill calls for this task.`;
    }

    private buildSchema(params: RoutineParam[]): ZodObject<any> {
        if (params.length === 0) {
            return z.object({});
        }

        const shape: Record<string, z.ZodTypeAny> = {};
        for (const param of params) {
            let zodType = this.getZodType(param.type);

            if (param.description) {
                zodType = zodType.describe(param.description);
            }
            if (!param.required && param.default !== undefined) {
                zodType = zodType.default(param.default);
            }
            if (!param.required) {
                zodType = zodType.optional();
            }

            shape[param.name] = zodType;
        }

        return z.object(shape);
    }

    private getZodType(type: string): z.ZodTypeAny {
        switch (type) {
            case 'number':
                return z.number();
            case 'boolean':
                return z.boolean();
            case 'string':
            default:
                return z.string();
        }
    }
}
