/**
 * CodeAgentTools — Cursor エージェント同等のツール群。
 *
 * ファイル操作: read_file, edit_file, create_file, delete_file
 * 検索: search_code(-A/-B/-C), glob_files, semantic_search
 * Web: web_search, web_fetch
 * 実行: shell_exec, read_lints
 * タスク管理: task_plan, task_update
 */

import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, relative, resolve, dirname } from 'node:path';
import { getBackendRoot } from '../../../../../utils/backendRoot.js';
import { createLogger } from '../../../../../utils/logger.js';
import { isMutableRelativePath } from './mutableCodePolicy.js';

const log = createLogger('SelfImprove:AgentTools');

const MAX_READ_CHARS = 50_000;
const MAX_SEARCH_RESULTS = 60;
const MAX_GLOB_RESULTS = 200;
const MAX_SHELL_OUTPUT = 30_000;
const SHELL_TIMEOUT_MS = 60_000;

function backendRoot(): string { return getBackendRoot(); }
function toBackendRel(absOrRel: string): string {
    const root = backendRoot();
    return relative(root, resolve(root, absOrRel)).replace(/\\/g, '/');
}
function toAbs(relPath: string): string {
    return resolve(backendRoot(), relPath);
}
function truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max) + '\n...(truncated)' : s;
}

// ── ファイル操作 ──

async function execReadFile(args: { path: string; startLine?: number; endLine?: number }): Promise<string> {
    const rel = toBackendRel(args.path);
    try {
        const content = await readFile(toAbs(rel), 'utf-8');
        const lines = content.split('\n');
        const start = Math.max(0, (args.startLine ?? 1) - 1);
        const end = Math.min(lines.length, args.endLine ?? lines.length);
        const numbered = lines.slice(start, end).map((l, i) => `${start + i + 1}|${l}`);
        return truncate(numbered.join('\n'), MAX_READ_CHARS);
    } catch (err: any) {
        return `Error reading ${rel}: ${err.message}`;
    }
}

async function execEditFile(args: {
    path: string;
    edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }>;
}): Promise<string> {
    const rel = toBackendRel(args.path);
    if (!isMutableRelativePath(rel)) return `Error: ${rel} は変更不可パスです`;
    let content: string;
    try { content = await readFile(toAbs(rel), 'utf-8'); } catch { return `Error: ファイルが見つかりません: ${rel}`; }

    const results: string[] = [];
    for (const edit of args.edits) {
        if (edit.replace_all) {
            const count = content.split(edit.old_string).length - 1;
            if (count === 0) {
                results.push(`❌ old_string が見つかりません（先頭30文字: "${edit.old_string.slice(0, 30)}"）`);
                continue;
            }
            content = content.split(edit.old_string).join(edit.new_string);
            results.push(`✅ 全置換: ${count}箇所`);
        } else {
            const idx = content.indexOf(edit.old_string);
            if (idx === -1) {
                results.push(`❌ old_string が見つかりません（先頭30文字: "${edit.old_string.slice(0, 30)}"）`);
                continue;
            }
            if (content.indexOf(edit.old_string, idx + 1) !== -1) {
                results.push(`❌ old_string が複数箇所にマッチ。replace_all: true を使うか、より長い文脈を含めてください`);
                continue;
            }
            content = content.slice(0, idx) + edit.new_string + content.slice(idx + edit.old_string.length);
            results.push(`✅ 置換成功（${edit.old_string.split('\n').length}→${edit.new_string.split('\n').length}行）`);
        }
    }
    await writeFile(toAbs(rel), content, 'utf-8');
    return results.join('\n');
}

async function execCreateFile(args: { path: string; content: string }): Promise<string> {
    const rel = toBackendRel(args.path);
    if (!isMutableRelativePath(rel)) return `Error: ${rel} は変更不可パスです`;
    try {
        await mkdir(dirname(toAbs(rel)), { recursive: true });
        await writeFile(toAbs(rel), args.content, 'utf-8');
        return `✅ ファイル作成: ${rel} (${args.content.split('\n').length}行)`;
    } catch (err: any) { return `Error creating ${rel}: ${err.message}`; }
}

async function execDeleteFile(args: { path: string }): Promise<string> {
    const rel = toBackendRel(args.path);
    if (!isMutableRelativePath(rel)) return `Error: ${rel} は変更不可パスです`;
    try { await unlink(toAbs(rel)); return `✅ 削除: ${rel}`; }
    catch (err: any) { return `Error deleting ${rel}: ${err.message}`; }
}

// ── 検索 ──

async function execSearchCode(args: {
    pattern: string; path?: string; glob?: string;
    contextBefore?: number; contextAfter?: number;
}): Promise<string> {
    const root = backendRoot();
    const searchDir = args.path ? toAbs(toBackendRel(args.path)) : join(root, 'src');
    try {
        const { execSync } = await import('node:child_process');
        const globArg = args.glob ? `--glob ${JSON.stringify(args.glob)}` : '--type ts';
        const ctxB = args.contextBefore != null && args.contextBefore > 0 ? `-B ${args.contextBefore}` : '';
        const ctxA = args.contextAfter != null && args.contextAfter > 0 ? `-A ${args.contextAfter}` : '';
        const cmd = [
            'rg', '--no-heading', '--line-number',
            '--max-count', String(MAX_SEARCH_RESULTS),
            ctxB, ctxA, globArg,
            '--', JSON.stringify(args.pattern), JSON.stringify(searchDir),
            '2>/dev/null || true',
        ].filter(Boolean).join(' ');
        const out = execSync(cmd, { encoding: 'utf-8', timeout: 15_000, maxBuffer: 2_000_000 });
        if (!out.trim()) return 'No matches found.';
        return truncate(out.replace(new RegExp(root + '/', 'g'), ''), MAX_SHELL_OUTPUT);
    } catch (err: any) {
        return `Search error: ${err.message}`;
    }
}

async function execGlobFiles(args: { pattern: string; path?: string }): Promise<string> {
    const root = backendRoot();
    const searchDir = args.path ? toAbs(toBackendRel(args.path)) : root;
    try {
        const { execSync } = await import('node:child_process');
        const cmd = `find ${JSON.stringify(searchDir)} -path '*/node_modules' -prune -o -path '*/dist' -prune -o -path '*/.git' -prune -o -name ${JSON.stringify(args.pattern)} -print 2>/dev/null | head -${MAX_GLOB_RESULTS}`;
        const out = execSync(cmd, { encoding: 'utf-8', timeout: 10_000, maxBuffer: 1_000_000 });
        if (!out.trim()) return 'No files found.';
        return out.replace(new RegExp(root + '/', 'g'), '').trim();
    } catch (err: any) {
        return `Glob error: ${err.message}`;
    }
}

async function execSemanticSearch(args: { query: string; topK?: number }): Promise<string> {
    try {
        const { semanticSearchCode } = await import('./CodeSemanticIndex.js');
        const results = await semanticSearchCode(args.query, args.topK ?? 10);
        if (results.length === 0) return 'No relevant code found.';
        return results
            .map((r, i) => `${i + 1}. [${(r.similarity * 100).toFixed(1)}%] ${r.path}\n   ${r.preview.slice(0, 150)}`)
            .join('\n\n');
    } catch (err: any) {
        return `SemanticSearch error: ${err.message}`;
    }
}

// ── Web ──

async function execWebSearch(args: { query: string; num?: number }): Promise<string> {
    try {
        const { config } = await import('../../../../../config/env.js');
        if (!config.google.apiKey || !config.google.searchEngineId) {
            return 'Google検索は利用不可（API keyまたはSearch Engine IDが未設定）';
        }
        const fetch = (await import('node-fetch')).default;
        const num = Math.min(args.num ?? 5, 10);
        const url = `https://www.googleapis.com/customsearch/v1?key=${config.google.apiKey}&cx=${config.google.searchEngineId}&q=${encodeURIComponent(args.query)}&num=${num}`;
        const resp = await fetch(url);
        const data = await resp.json() as {
            error?: { code: number; message: string };
            items?: Array<{ title?: string; snippet?: string; link?: string }>;
        };
        if (data.error) return `Google API error: ${data.error.message}`;
        if (!data.items?.length) return `"${args.query}" の検索結果なし`;
        return data.items.map((item, i) =>
            `${i + 1}. ${item.title ?? 'No title'}\n   ${item.snippet ?? ''}\n   ${item.link ?? ''}`,
        ).join('\n\n');
    } catch (err: any) {
        return `WebSearch error: ${err.message}`;
    }
}

async function execWebFetch(args: { url: string; mode?: string }): Promise<string> {
    try {
        const axios = (await import('axios')).default;
        const cheerio = await import('cheerio');
        const resp = await axios.get(args.url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; ShannonBot/1.0)',
                'Accept': 'text/html,application/json,*/*',
            },
            maxContentLength: 1_000_000,
            timeout: 10_000,
        });

        if (args.mode === 'json' && typeof resp.data === 'object') {
            return truncate(JSON.stringify(resp.data, null, 2), 8_000);
        }

        if (typeof resp.data === 'string' && resp.data.includes('<')) {
            const $ = cheerio.load(resp.data);
            $('script, style, noscript, iframe, img, svg').remove();
            const title = $('title').text();
            const body = $('body').text().replace(/\s+/g, ' ').trim();
            return truncate(`Title: ${title}\n\n${body}`, 8_000);
        }

        return truncate(String(resp.data), 8_000);
    } catch (err: any) {
        return `WebFetch error: ${err.message}`;
    }
}

// ── シェル ──

async function execShell(args: { command: string; cwd?: string }): Promise<string> {
    const BLOCKED = [/\brm\s+-rf\s+\/(?!\w)/, /\bmkfs\b/, /\bdd\s+if=/, /\bshutdown\b/, /\breboot\b/];
    for (const p of BLOCKED) {
        if (p.test(args.command)) return `⛔ 危険なコマンドがブロックされました: ${p.source}`;
    }
    const root = backendRoot();
    const cwd = args.cwd ? resolve(root, args.cwd) : root;
    try {
        const { execSync } = await import('node:child_process');
        const out = execSync(args.command, {
            cwd, encoding: 'utf-8', timeout: SHELL_TIMEOUT_MS,
            maxBuffer: 4_000_000,
            env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=12288' },
        });
        return truncate(out, MAX_SHELL_OUTPUT) || '(no output)';
    } catch (err: any) {
        const stdout = err.stdout ?? '';
        const stderr = err.stderr ?? '';
        return truncate(`exit_code: ${err.status ?? 'unknown'}\n${stdout}\n${stderr}`.trim(), MAX_SHELL_OUTPUT);
    }
}

async function execReadLints(args: { path?: string }): Promise<string> {
    const root = backendRoot();
    const target = args.path ? toAbs(toBackendRel(args.path)) : join(root, 'src');
    try {
        const { execSync } = await import('node:child_process');
        const cmd = `npx eslint --format compact ${JSON.stringify(target)} 2>&1 || true`;
        const out = execSync(cmd, { cwd: root, encoding: 'utf-8', timeout: 30_000, maxBuffer: 2_000_000 });
        if (!out.trim() || out.includes('0 problems')) return '✅ lint エラーなし';
        return truncate(out, MAX_SHELL_OUTPUT);
    } catch (err: any) {
        return `Lint error: ${err.message}`;
    }
}

// ── タスク管理 ──

export interface TaskItem {
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

let currentTaskPlan: TaskItem[] = [];

function execTaskPlan(args: { tasks: Array<{ id: string; content: string; status?: string }> }): string {
    currentTaskPlan = args.tasks.map(t => ({
        id: t.id,
        content: t.content,
        status: (t.status as TaskItem['status']) ?? 'pending',
    }));
    return `✅ タスクプラン作成 (${currentTaskPlan.length}件)\n` +
        currentTaskPlan.map(t => `  [${t.status}] ${t.id}: ${t.content}`).join('\n');
}

function execTaskUpdate(args: { id: string; status: string }): string {
    const task = currentTaskPlan.find(t => t.id === args.id);
    if (!task) return `❌ タスク "${args.id}" が見つかりません`;
    task.status = args.status as TaskItem['status'];
    const summary = currentTaskPlan.map(t => `  [${t.status}] ${t.id}: ${t.content}`).join('\n');
    return `✅ ${task.id} → ${task.status}\n${summary}`;
}

export function getTaskPlan(): TaskItem[] { return currentTaskPlan; }
export function resetTaskPlan(): void { currentTaskPlan = []; }

// ── ツール定義 ──

export const CODE_AGENT_TOOL_DEFS = [
    {
        type: 'function' as const,
        function: {
            name: 'read_file',
            description: 'ファイルを読む（行番号付き）。startLine/endLine で範囲指定可能。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'backend ルートからの相対パス' },
                    startLine: { type: 'number', description: '開始行（1-indexed）' },
                    endLine: { type: 'number', description: '終了行' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'search_code',
            description: 'コード検索（正規表現）。contextBefore/contextAfter で前後の行も取得可能。',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: '検索する正規表現パターン' },
                    path: { type: 'string', description: '検索対象ディレクトリ（省略時は src/）' },
                    glob: { type: 'string', description: 'ファイルパターン（例: "*.ts"）' },
                    contextBefore: { type: 'number', description: 'マッチ行の前に表示する行数' },
                    contextAfter: { type: 'number', description: 'マッチ行の後に表示する行数' },
                },
                required: ['pattern'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'glob_files',
            description: 'ファイル名パターンで再帰検索（node_modules/dist/.git 除外）。',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'ファイル名パターン（例: "*.test.ts"）' },
                    path: { type: 'string', description: '検索開始ディレクトリ' },
                },
                required: ['pattern'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'semantic_search',
            description: '意味ベースのコード検索。「認証の処理」「エラーハンドリング」のような自然言語クエリで関連コードを探す。キーワードが分からない場合に有効。',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '検索クエリ（自然言語で OK）' },
                    topK: { type: 'number', description: '返す件数（デフォルト10）' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'edit_file',
            description: 'ファイルの一部を精密に置換。replace_all: true で全箇所一括置換。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'backend ルートからの相対パス' },
                    edits: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                old_string: { type: 'string', description: '置換対象の既存テキスト' },
                                new_string: { type: 'string', description: '置換後のテキスト' },
                                replace_all: { type: 'boolean', description: 'true で全箇所一括置換' },
                            },
                            required: ['old_string', 'new_string'],
                        },
                    },
                },
                required: ['path', 'edits'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'create_file',
            description: '新規ファイルを作成（ディレクトリも自動作成）',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'backend ルートからの相対パス' },
                    content: { type: 'string', description: 'ファイル内容' },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'delete_file',
            description: 'ファイルを削除',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'backend ルートからの相対パス' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'shell_exec',
            description: '任意のシェルコマンドを実行（git, npm, tsc, vitest, curl 等）。',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: '実行するコマンド' },
                    cwd: { type: 'string', description: '作業ディレクトリ（backend ルート相対）' },
                },
                required: ['command'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'read_lints',
            description: 'ESLint のエラーを取得。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '対象ファイルまたはディレクトリ' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'web_search',
            description: 'Google 検索でライブラリドキュメントや API リファレンスを調べる。',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '検索クエリ' },
                    num: { type: 'number', description: '結果件数（最大10）' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'web_fetch',
            description: 'URL からコンテンツを取得（HTML→テキスト変換）。ドキュメントや API リファレンスの閲覧に。',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: '取得する URL' },
                    mode: { type: 'string', description: '"text"（デフォルト）または "json"', enum: ['text', 'json'] },
                },
                required: ['url'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'task_plan',
            description: '構造化されたタスクプランを作成。複雑なタスクを分解して管理する。',
            parameters: {
                type: 'object',
                properties: {
                    tasks: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string', description: 'タスク ID（例: "t1"）' },
                                content: { type: 'string', description: 'タスク内容' },
                                status: { type: 'string', description: 'pending / in_progress / completed / cancelled' },
                            },
                            required: ['id', 'content'],
                        },
                    },
                },
                required: ['tasks'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'task_update',
            description: 'タスクのステータスを更新。',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'タスク ID' },
                    status: { type: 'string', description: '新しいステータス', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
                },
                required: ['id', 'status'],
            },
        },
    },
] as const;

export type ToolName = typeof CODE_AGENT_TOOL_DEFS[number]['function']['name'];

// ── ディスパッチ ──

export async function executeToolCall(
    name: string,
    args: Record<string, unknown>,
): Promise<string> {
    switch (name) {
        case 'read_file':        return execReadFile(args as any);
        case 'search_code':      return execSearchCode(args as any);
        case 'glob_files':       return execGlobFiles(args as any);
        case 'semantic_search':  return execSemanticSearch(args as any);
        case 'edit_file':        return execEditFile(args as any);
        case 'create_file':      return execCreateFile(args as any);
        case 'delete_file':      return execDeleteFile(args as any);
        case 'shell_exec':       return execShell(args as any);
        case 'read_lints':       return execReadLints(args as any);
        case 'web_search':       return execWebSearch(args as any);
        case 'web_fetch':        return execWebFetch(args as any);
        case 'task_plan':        return execTaskPlan(args as any);
        case 'task_update':      return execTaskUpdate(args as any);
        default:                 return `Unknown tool: ${name}`;
    }
}
