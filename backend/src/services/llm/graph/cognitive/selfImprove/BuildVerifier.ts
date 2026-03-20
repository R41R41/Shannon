/**
 * BuildVerifier — tsc / vitest を実行して結果を構造化する。
 *
 * CodeAgentLoop のツールとして呼び出される。
 */

import { createLogger } from '../../../../../utils/logger.js';
import { getBackendRoot } from '../../../../../utils/backendRoot.js';

const log = createLogger('SelfImprove:BuildVerifier');

const TSC_TIMEOUT_MS = 120_000;
const VITEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 12_000;

function truncate(s: string, max = MAX_OUTPUT_CHARS): string {
    return s.length > max ? s.slice(0, max) + '\n...(truncated)' : s;
}

export interface TscResult {
    success: boolean;
    errorCount: number;
    errors: string[];
    rawOutput: string;
}

export interface VitestResult {
    success: boolean;
    summary: string;
    rawOutput: string;
}

/**
 * バックエンド全体の `tsc --noEmit --pretty` を実行。
 * 型エラーを構造化して返す。
 */
export async function runTscCheck(): Promise<TscResult> {
    const root = getBackendRoot();
    try {
        const { execSync } = await import('node:child_process');
        const cmd = 'npx tsc --noEmit --pretty --skipLibCheck 2>&1 || true';
        const raw = execSync(cmd, {
            cwd: root,
            encoding: 'utf-8',
            timeout: TSC_TIMEOUT_MS,
            maxBuffer: 4_000_000,
            env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=12288' },
        });
        const errorLines = raw.split('\n').filter(l => /error TS\d+/.test(l));
        return {
            success: errorLines.length === 0,
            errorCount: errorLines.length,
            errors: errorLines.slice(0, 40),
            rawOutput: truncate(raw),
        };
    } catch (err: any) {
        return {
            success: false,
            errorCount: -1,
            errors: [err.message],
            rawOutput: truncate(err.stdout ?? err.message),
        };
    }
}

/**
 * vitest を限定パターンで実行する。
 * @param testPattern vitest の --testPathPattern（省略時は全テスト）
 */
export async function runVitestSubset(testPattern?: string): Promise<VitestResult> {
    const root = getBackendRoot();
    try {
        const { execSync } = await import('node:child_process');
        const patternArg = testPattern ? ` -- ${testPattern}` : '';
        const cmd = `npx vitest run --reporter=verbose${patternArg} 2>&1 || true`;
        const raw = execSync(cmd, {
            cwd: root,
            encoding: 'utf-8',
            timeout: VITEST_TIMEOUT_MS,
            maxBuffer: 4_000_000,
        });

        const passMatch = raw.match(/Tests\s+(\d+)\s+passed/);
        const failMatch = raw.match(/Tests\s+(\d+)\s+failed/);
        const passed = passMatch ? parseInt(passMatch[1]) : 0;
        const failed = failMatch ? parseInt(failMatch[1]) : 0;
        const success = failed === 0;

        return {
            success,
            summary: `passed=${passed}, failed=${failed}`,
            rawOutput: truncate(raw),
        };
    } catch (err: any) {
        return {
            success: false,
            summary: `error: ${err.message}`,
            rawOutput: truncate(err.stdout ?? err.message),
        };
    }
}

// ── bindTools 用のツール定義 ──

export const BUILD_TOOL_DEFS = [
    {
        type: 'function' as const,
        function: {
            name: 'run_tsc',
            description: 'バックエンド全体の TypeScript 型チェック（tsc --noEmit）を実行し、エラーを返す。重いので必要なときだけ呼ぶこと。',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'run_vitest',
            description: 'vitest テストを実行する。testPattern で対象を絞れる（省略時は全テスト）。',
            parameters: {
                type: 'object',
                properties: {
                    testPattern: { type: 'string', description: 'vitest の --testPathPattern（例: "selfImprove"）' },
                },
                required: [],
            },
        },
    },
] as const;

export async function executeBuildTool(
    name: string,
    args: Record<string, unknown>,
): Promise<string> {
    if (name === 'run_tsc') {
        log.info('🔨 tsc --noEmit を実行中...');
        const r = await runTscCheck();
        return r.success
            ? '✅ tsc: エラーなし'
            : `❌ tsc: ${r.errorCount}件のエラー\n${r.errors.join('\n')}\n\n${r.rawOutput}`;
    }
    if (name === 'run_vitest') {
        const pattern = args.testPattern as string | undefined;
        log.info(`🧪 vitest 実行中${pattern ? ` (${pattern})` : ''}...`);
        const r = await runVitestSubset(pattern);
        return r.success
            ? `✅ vitest: ${r.summary}`
            : `❌ vitest: ${r.summary}\n\n${r.rawOutput}`;
    }
    return `Unknown build tool: ${name}`;
}
