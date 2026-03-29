/**
 * manage-routine — シャノンがルーチン (System 1 手続き記憶) を CRUD するツール
 *
 * list:   登録済みルーチン一覧を返す
 * get:    指定ルーチンの詳細定義を返す
 * create: 新規ルーチンを定義・登録する
 * edit:   既存ルーチンのステップや説明を変更する
 * delete: ルーチンを削除する
 */

import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { createLogger } from '../../../../utils/logger.js';
import type { RoutineManager } from '../../../minebot/routines/RoutineManager.js';
import type { RoutineExecutor } from '../../../minebot/routines/RoutineExecutor.js';
import type { RoutineDefinition } from '../../../minebot/routines/types.js';
import { RoutineWrapperTool } from '../../../minebot/routines/RoutineWrapperTool.js';

const log = createLogger('LLM:ManageRoutineTool');

export class ManageRoutineTool extends StructuredTool {
    name = 'manage-routine';
    description =
        'Manage routines (System 1 procedural memory). Routines execute pre-defined skill sequences without LLM calls — much faster than calling skills individually. Actions: "list" (show all), "get" (show definition), "create" (new routine from JSON), "edit" (modify existing), "delete" (remove). When you notice repeated skill patterns, create a routine to speed up future executions.';

    schema = z.object({
        action: z
            .enum(['list', 'get', 'create', 'edit', 'delete'])
            .describe('Action to perform'),
        name: z
            .string()
            .optional()
            .describe('Routine name (required for get/create/edit/delete)'),
        definition: z
            .string()
            .optional()
            .describe(
                'JSON string of the routine definition (for create: full RoutineDefinition, for edit: partial fields to update)',
            ),
    });

    private onToolRegistered: ((tool: StructuredTool) => void) | null = null;

    constructor(
        private routineManager: RoutineManager,
        private routineExecutor: RoutineExecutor,
    ) {
        super();
    }

    /** FCA にツール登録するコールバックを設定 */
    setOnToolRegistered(cb: (tool: StructuredTool) => void): void {
        this.onToolRegistered = cb;
    }

    async _call(args: {
        action: string;
        name?: string;
        definition?: string;
    }): Promise<string> {
        try {
            switch (args.action) {
                case 'list':
                    return this.handleList();
                case 'get':
                    return this.handleGet(args.name);
                case 'create':
                    return await this.handleCreate(args.name, args.definition);
                case 'edit':
                    return await this.handleEdit(args.name, args.definition);
                case 'delete':
                    return await this.handleDelete(args.name);
                default:
                    return `Unknown action: ${args.action}. Use list/get/create/edit/delete.`;
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log.error(`manage-routine ${args.action} failed`, e);
            return `Error: ${msg}`;
        }
    }

    // ─── アクション実装 ───

    private handleList(): string {
        const routines = this.routineManager.getAll();
        if (routines.length === 0) {
            return 'No routines registered. Use action "create" to define a new routine.';
        }

        const lines = routines.map((r) => {
            const rate =
                r.stats.runs > 0
                    ? `${Math.round((r.stats.successes / r.stats.runs) * 100)}%`
                    : 'N/A';
            return `- routine:${r.name} — ${r.description} [${r.steps.length} steps, ${r.stats.runs} runs, ${rate} success, source: ${r.source}]`;
        });

        return `Registered routines (${routines.length}):\n${lines.join('\n')}`;
    }

    private handleGet(name?: string): string {
        if (!name) return 'Error: "name" is required for get action.';

        const def = this.routineManager.get(name);
        if (!def) return `Routine "${name}" not found.`;

        return JSON.stringify(def, null, 2);
    }

    private async handleCreate(
        name?: string,
        definitionJson?: string,
    ): Promise<string> {
        if (!definitionJson) {
            return 'Error: "definition" (JSON string) is required for create action.';
        }

        let def: RoutineDefinition;
        try {
            def = JSON.parse(definitionJson);
        } catch {
            return 'Error: "definition" is not valid JSON.';
        }

        // name パラメータがあれば上書き
        if (name) def.name = name;

        // デフォルト値設定
        if (!def.source) def.source = 'shannon';
        if (!def.stats) {
            def.stats = { runs: 0, successes: 0, failures: 0, avgDurationMs: 0 };
        }
        if (!def.failureEscalation) def.failureEscalation = 'system2';
        if (!def.params) def.params = [];

        await this.routineManager.create(def);

        // FCA にラッパーツールを登録
        if (this.onToolRegistered) {
            const wrapperTool = new RoutineWrapperTool(
                def.name,
                this.routineManager,
                this.routineExecutor,
            );
            this.onToolRegistered(wrapperTool);
            log.info(`Registered routine tool "routine:${def.name}" in FCA`, 'green');
        }

        return `Routine "${def.name}" created successfully with ${def.steps.length} steps. You can now call it as "routine:${def.name}".`;
    }

    private async handleEdit(
        name?: string,
        definitionJson?: string,
    ): Promise<string> {
        if (!name) return 'Error: "name" is required for edit action.';
        if (!definitionJson) {
            return 'Error: "definition" (JSON string with fields to update) is required for edit action.';
        }

        let updates: Partial<RoutineDefinition>;
        try {
            updates = JSON.parse(definitionJson);
        } catch {
            return 'Error: "definition" is not valid JSON.';
        }

        await this.routineManager.update(name, updates);

        return `Routine "${name}" updated successfully.`;
    }

    private async handleDelete(name?: string): Promise<string> {
        if (!name) return 'Error: "name" is required for delete action.';

        const deleted = await this.routineManager.delete(name);
        if (!deleted) return `Routine "${name}" not found.`;

        return `Routine "${name}" deleted. The tool "routine:${name}" will no longer be available.`;
    }
}

export default ManageRoutineTool;
