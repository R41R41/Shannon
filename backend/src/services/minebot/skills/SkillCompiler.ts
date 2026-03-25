/**
 * SkillCompiler — 単一 TypeScript ファイルのコンパイル
 *
 * 生成されたスキルの .ts ファイルを .js にコンパイルする。
 * プロジェクトの tsconfig を継承し、単一ファイルのみを対象とする。
 */

import { exec } from 'node:child_process';
import { writeFile, readFile, mkdir, unlink } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { createLogger } from '../../../utils/logger.js';

const execAsync = promisify(exec);
const log = createLogger('Minebot:SkillCompiler');

export interface CompileResult {
    success: boolean;
    jsPath: string | null;
    errors: string[];
}

export class SkillCompiler {
    private projectRoot: string;

    constructor() {
        // backend/ ディレクトリを基準にする
        this.projectRoot = resolve(process.cwd(), 'backend');
        if (!existsSync(join(this.projectRoot, 'tsconfig.json'))) {
            // cwd が既に backend/ の場合
            this.projectRoot = process.cwd();
        }
    }

    /**
     * TypeScript ファイルをコンパイルして .js を出力する。
     *
     * @param tsPath .ts ファイルの絶対パス（src/ 配下）
     * @returns コンパイル結果（.js の絶対パス or エラー）
     */
    async compile(tsPath: string): Promise<CompileResult> {
        try {
            // 一時的な tsconfig を生成（単一ファイルのみ対象）
            const tmpConfigPath = join(this.projectRoot, 'tsconfig.skill-gen.json');
            const tmpConfig = {
                extends: './tsconfig.json',
                compilerOptions: {
                    noEmit: false,
                },
                include: [],
                files: [tsPath],
            };

            await writeFile(tmpConfigPath, JSON.stringify(tmpConfig, null, 2), 'utf-8');

            try {
                // tsc を実行
                const { stdout, stderr } = await execAsync(
                    `npx tsc --project ${tmpConfigPath}`,
                    {
                        cwd: this.projectRoot,
                        timeout: 30_000, // 30秒タイムアウト
                    },
                );

                if (stderr && stderr.includes('error TS')) {
                    return {
                        success: false,
                        jsPath: null,
                        errors: [stderr],
                    };
                }

                // コンパイル結果の .js パスを計算
                // src/services/minebot/instantSkills/generated/foo.ts
                // → dist/services/minebot/instantSkills/generated/foo.js
                const relativeTsPath = tsPath
                    .replace(join(this.projectRoot, 'src'), '')
                    .replace(/^[/\\]/, '');
                const jsRelativePath = relativeTsPath.replace(/\.ts$/, '.js');
                const jsPath = join(this.projectRoot, 'dist', jsRelativePath);

                if (!existsSync(jsPath)) {
                    return {
                        success: false,
                        jsPath: null,
                        errors: [`コンパイル済み .js が見つかりません: ${jsPath}`],
                    };
                }

                log.info(`✅ コンパイル成功: ${basename(tsPath)} → ${jsPath}`);
                return { success: true, jsPath, errors: [] };
            } finally {
                // 一時 tsconfig を削除
                try { await unlink(tmpConfigPath); } catch { /* ignore */ }
            }
        } catch (err: any) {
            const errorMsg = err.stderr || err.message || String(err);
            log.error(`❌ コンパイル失敗: ${basename(tsPath)}`, err);

            // tsc のエラー出力をパース
            const tsErrors = errorMsg
                .split('\n')
                .filter((line: string) => line.includes('error TS'))
                .slice(0, 10);

            return {
                success: false,
                jsPath: null,
                errors: tsErrors.length > 0 ? tsErrors : [errorMsg.substring(0, 500)],
            };
        }
    }

    /**
     * 生成スキル用のディレクトリが存在することを保証する。
     */
    async ensureGeneratedDirs(): Promise<void> {
        const dirs = [
            join(this.projectRoot, 'src/services/minebot/instantSkills/generated'),
            join(this.projectRoot, 'src/services/minebot/constantSkills/generated'),
        ];
        for (const dir of dirs) {
            await mkdir(dir, { recursive: true });
        }
    }
}
