/**
 * RoutineManager — ルーチン JSON ファイルの CRUD + インメモリインデックス
 */

import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../../../utils/logger.js';
import type { RoutineDefinition } from './types.js';

const log = createLogger('Minebot:RoutineManager');

const ROUTINE_FILE_SUFFIX = '.routine.json';

export class RoutineManager {
    private routines: Map<string, RoutineDefinition> = new Map();

    constructor(private routinesDir: string) {}

    // ─── ライフサイクル ───

    async loadAll(): Promise<void> {
        try {
            await fs.mkdir(this.routinesDir, { recursive: true });
        } catch {
            // already exists
        }

        const files = await fs.readdir(this.routinesDir);
        const routineFiles = files.filter((f) => f.endsWith(ROUTINE_FILE_SUFFIX));

        for (const file of routineFiles) {
            try {
                const content = await fs.readFile(
                    path.join(this.routinesDir, file),
                    'utf-8',
                );
                const def: RoutineDefinition = JSON.parse(content);
                this.validateDefinition(def);
                this.routines.set(def.name, def);
            } catch (e) {
                log.warn(`Failed to load routine "${file}": ${e}`);
            }
        }

        log.info(
            `Loaded ${this.routines.size} routines: [${[...this.routines.keys()].join(', ')}]`,
            'cyan',
        );
    }

    // ─── 読み取り ───

    get(name: string): RoutineDefinition | undefined {
        return this.routines.get(name);
    }

    getAll(): RoutineDefinition[] {
        return Array.from(this.routines.values());
    }

    has(name: string): boolean {
        return this.routines.has(name);
    }

    // ─── CRUD ───

    async create(def: RoutineDefinition): Promise<void> {
        this.validateDefinition(def);

        if (this.routines.has(def.name)) {
            throw new Error(`Routine "${def.name}" already exists. Use update instead.`);
        }

        // デフォルト stats
        if (!def.stats) {
            def.stats = { runs: 0, successes: 0, failures: 0, avgDurationMs: 0 };
        }
        if (!def.failureEscalation) {
            def.failureEscalation = 'system2';
        }

        await this.saveToFile(def);
        this.routines.set(def.name, def);
        log.info(`Created routine "${def.name}" (${def.steps.length} steps)`, 'green');
    }

    async update(name: string, updates: Partial<RoutineDefinition>): Promise<void> {
        const existing = this.routines.get(name);
        if (!existing) {
            throw new Error(`Routine "${name}" not found`);
        }

        const updated: RoutineDefinition = { ...existing, ...updates, name };
        this.validateDefinition(updated);

        await this.saveToFile(updated);
        this.routines.set(name, updated);
        log.info(`Updated routine "${name}"`, 'green');
    }

    async delete(name: string): Promise<boolean> {
        if (!this.routines.has(name)) return false;

        const filePath = path.join(this.routinesDir, `${name}${ROUTINE_FILE_SUFFIX}`);
        try {
            await fs.unlink(filePath);
        } catch {
            // file may not exist
        }

        this.routines.delete(name);
        log.info(`Deleted routine "${name}"`, 'yellow');
        return true;
    }

    // ─── 統計更新 ───

    async updateStats(
        name: string,
        success: boolean,
        durationMs: number,
    ): Promise<void> {
        const def = this.routines.get(name);
        if (!def) return;

        def.stats.runs += 1;
        if (success) {
            def.stats.successes += 1;
        } else {
            def.stats.failures += 1;
        }
        // 移動平均
        const prev = def.stats.avgDurationMs;
        def.stats.avgDurationMs =
            prev === 0 ? durationMs : Math.round(prev * 0.8 + durationMs * 0.2);

        // 統計は非同期で保存（失敗しても無視）
        this.saveToFile(def).catch(() => {});
    }

    // ─── バリデーション ───

    private validateDefinition(def: RoutineDefinition): void {
        if (!def.name || typeof def.name !== 'string') {
            throw new Error('Routine name is required');
        }
        if (!/^[a-z0-9-]+$/.test(def.name)) {
            throw new Error(
                `Routine name "${def.name}" must be lowercase alphanumeric with hyphens`,
            );
        }
        if (!def.description || typeof def.description !== 'string') {
            throw new Error('Routine description is required');
        }
        if (!Array.isArray(def.steps) || def.steps.length === 0) {
            throw new Error('Routine must have at least one step');
        }
        if (!Array.isArray(def.params)) {
            throw new Error('Routine params must be an array');
        }
    }

    // ─── ファイル I/O ───

    private async saveToFile(def: RoutineDefinition): Promise<void> {
        const filePath = path.join(
            this.routinesDir,
            `${def.name}${ROUTINE_FILE_SUFFIX}`,
        );
        await fs.writeFile(filePath, JSON.stringify(def, null, 2), 'utf-8');
    }
}
