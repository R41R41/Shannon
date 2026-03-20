/**
 * CodeAgentLoop — Cursor コーディングエージェント完全同等の自律修正ループ。
 *
 * Anthropic SDK 直接使用（@langchain/anthropic のバージョン不整合を回避）。
 * Claude claude-4.6-opus（親）+ Claude Sonnet（サブ）のハイブリッド構成。
 *
 * ツール一覧（Cursor 対応表）:
 *   read_file / edit_file / create_file / delete_file ← Read / StrReplace / Write / Delete
 *   search_code / glob_files / semantic_search       ← Grep / Glob / SemanticSearch
 *   web_search / web_fetch                           ← WebSearch / WebFetch
 *   shell_exec / run_tsc / run_vitest / read_lints   ← Shell / ReadLints
 *   task_plan / task_update                          ← TodoWrite
 *   spawn_agent / check_agent                        ← Task (サブエージェント)
 *   finish                                           ← (完了宣言)
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../../../../config/env.js';
import { createLogger } from '../../../../../utils/logger.js';
import { CODE_AGENT_TOOL_DEFS, executeToolCall, resetTaskPlan } from './CodeAgentTools.js';
import { BUILD_TOOL_DEFS, executeBuildTool } from './BuildVerifier.js';

const log = createLogger('SelfImprove:AgentLoop');

const OPUS_MODEL = 'claude-4-opus-20250514';
const SONNET_MODEL = 'claude-sonnet-4-20250514';

const DEFAULT_MAX_ITERATIONS = 25;
const HARD_ITERATION_LIMIT = 40;
const CONTEXT_COMPRESS_THRESHOLD = 80_000;
const MAX_SUB_AGENTS = 4;
const SUB_AGENT_MAX_ITER = 15;
const MAX_TOKENS = 8192;

// ── Anthropic 型 ──

type MessageParam = Anthropic.MessageParam;
type ContentBlockParam = Anthropic.ContentBlockParam;
type ToolResultBlockParam = Anthropic.ToolResultBlockParam;
type Tool = Anthropic.Tool;

// ── サブエージェント管理 ──

interface SubAgentHandle {
    id: string;
    description: string;
    promise: Promise<AgentLoopResult>;
    result?: AgentLoopResult;
}

const subAgents = new Map<string, SubAgentHandle>();
let subAgentCounter = 0;

// ── ツール定義 → Anthropic フォーマットへ変換 ──

function toAnthropicTools(defs: ReadonlyArray<{ type: string; function: { name: string; description: string; parameters: object } }>): Tool[] {
    return defs.map(d => ({
        name: d.function.name,
        description: d.function.description,
        input_schema: d.function.parameters as Tool['input_schema'],
    }));
}

const AGENT_ONLY_DEFS = [
    {
        type: 'function' as const,
        function: {
            name: 'spawn_agent',
            description: '独立したサブエージェントを起動して並列にタスクを実行させる。調査・探索タスクに向く。',
            parameters: {
                type: 'object' as const,
                properties: {
                    description: { type: 'string', description: 'サブエージェントに渡すタスク説明' },
                    context: { type: 'string', description: '追加コンテキスト' },
                    targetFile: { type: 'string', description: '対象ファイル' },
                },
                required: ['description'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'check_agent',
            description: 'サブエージェントの完了を待ち、結果を取得する。',
            parameters: {
                type: 'object' as const,
                properties: {
                    agentId: { type: 'string', description: 'spawn_agent で返された agent ID' },
                },
                required: ['agentId'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'finish',
            description: '作業完了を宣言する。修正内容のサマリと成功・失敗を報告。',
            parameters: {
                type: 'object' as const,
                properties: {
                    summary: { type: 'string', description: '行った変更のサマリ' },
                    success: { type: 'boolean', description: '修正に成功したか' },
                    filesChanged: {
                        type: 'array', items: { type: 'string' },
                        description: '変更したファイルパスの配列',
                    },
                },
                required: ['summary', 'success'],
            },
        },
    },
];

const ALL_OPENAI_DEFS = [...CODE_AGENT_TOOL_DEFS, ...BUILD_TOOL_DEFS, ...AGENT_ONLY_DEFS];
const SUB_OPENAI_DEFS = [...CODE_AGENT_TOOL_DEFS, ...BUILD_TOOL_DEFS, AGENT_ONLY_DEFS[2]];

const ALL_TOOLS = toAnthropicTools(ALL_OPENAI_DEFS as any);
const SUB_TOOLS = toAnthropicTools(SUB_OPENAI_DEFS as any);

const ALL_TOOL_NAMES = new Set(ALL_TOOLS.map(t => t.name));

function isBuildTool(name: string): boolean {
    return name === 'run_tsc' || name === 'run_vitest';
}

// ── システムプロンプト ──

const SYSTEM_PROMPT = `あなたは Shannon バックエンド（TypeScript / Node.js）の自律コーディングエージェントです。
Cursor IDE のコーディングエージェントと同等以上の能力を持っています。

## ツール一覧

### ファイル操作
- **read_file**: ファイル読み取り（行番号付き、範囲指定可）
- **edit_file**: 精密な差分編集（old_string → new_string、replace_all で一括リネーム）
- **create_file**: 新規ファイル作成
- **delete_file**: ファイル削除

### 検索
- **search_code**: 正規表現コード検索（contextBefore/contextAfter で前後行取得）
- **glob_files**: ファイル名パターンで再帰検索
- **semantic_search**: 意味ベースのコード検索（「認証の処理はどこ？」のような自然言語クエリ）

### Web
- **web_search**: Google 検索（ライブラリドキュメント、API リファレンス）
- **web_fetch**: URL コンテンツ取得（HTML→テキスト変換）

### ビルド・検証
- **shell_exec**: 任意のシェルコマンド実行（git, npm, curl 等）
- **run_tsc**: TypeScript 型チェック
- **run_vitest**: テスト実行
- **read_lints**: ESLint エラー取得

### タスク管理
- **task_plan**: 複雑なタスクを分解して構造化プランを作成
- **task_update**: タスクのステータスを更新（in_progress / completed / cancelled）

### サブエージェント
- **spawn_agent**: 独立したサブエージェントを起動（並列調査・探索に有効）
- **check_agent**: サブエージェントの完了を待ち結果を取得

### 完了
- **finish**: 作業完了を宣言

## ワークフロー
1. **計画**: task_plan で作業を分解（3ステップ以上の場合）
2. **探索**: search_code, glob_files, semantic_search, read_file で調査（並列推奨）
3. **修正**: edit_file で精密な差分修正
4. **検証**: run_tsc, read_lints, run_vitest で検証
5. **完了**: task_update で完了マーク → finish

## 並列実行
- 独立した複数のツールを1ターンで同時に呼べる
- 大規模調査は spawn_agent で並列探索

## ルール
- edit_file の old_string はファイル内で一意にマッチする十分な長さを含める
- 最小限の変更。無関係なリファクタは禁止
- process.exit / new Function は禁止
- src/config/ / package.json / tsconfig / .env は変更不可
- 修正不可能なら finish(success=false) を呼ぶ

## プロジェクト構造
- backend/src/services/minebot/ — Minecraft ボットのスキル・エージェント
- backend/src/services/llm/ — LangGraph ベースの認知グラフ
- backend/src/services/discord/ — Discord ボット
- backend/src/services/twitter/ — Twitter 連携
- backend/src/ — その他バックエンド全般`;

const SUB_AGENT_SYSTEM_PROMPT = `あなたは Shannon バックエンドの調査・修正サブエージェントです。
親エージェントから委任されたタスクを効率的に遂行してください。

使えるツール: read_file, search_code, glob_files, semantic_search, edit_file, create_file, delete_file,
shell_exec, run_tsc, run_vitest, read_lints, web_search, web_fetch, task_plan, task_update, finish

作業が完了したら finish を呼んで結果をサマリしてください。`;

// ── 公開インターフェース ──

export interface AgentLoopTask {
    description: string;
    context?: string;
    initialFiles?: string[];
    maxIterations?: number;
    failedTestInfo?: string;
    targetFile?: string;
    isSubAgent?: boolean;
}

export interface AgentLoopResult {
    success: boolean;
    summary: string;
    filesChanged: string[];
    iterations: number;
    aborted: boolean;
}

/**
 * 自律修正エージェントループを実行する。
 */
export async function runCodeAgentLoop(task: AgentLoopTask): Promise<AgentLoopResult> {
    const maxIter = Math.min(task.maxIterations ?? DEFAULT_MAX_ITERATIONS, HARD_ITERATION_LIMIT);
    const modelName = task.isSubAgent ? SONNET_MODEL : OPUS_MODEL;
    const tools = task.isSubAgent ? SUB_TOOLS : ALL_TOOLS;
    const system = task.isSubAgent ? SUB_AGENT_SYSTEM_PROMPT : SYSTEM_PROMPT;

    log.info(`🤖 CodeAgentLoop${task.isSubAgent ? '(sub)' : ''} 開始: ${task.description.slice(0, 80)} (最大${maxIter}iter, ${modelName})`);

    if (!task.isSubAgent) resetTaskPlan();

    const client = new Anthropic({ apiKey: config.anthropic.apiKey || undefined });

    const messages: MessageParam[] = [
        { role: 'user', content: buildInitialPrompt(task) },
    ];

    let finished = false;
    const result: AgentLoopResult = {
        success: false, summary: '', filesChanged: [], iterations: 0, aborted: false,
    };

    for (let iter = 0; iter < maxIter && !finished; iter++) {
        result.iterations = iter + 1;

        if (iter > 0 && iter % 5 === 0) compressContext(messages);

        try {
            const response = await client.messages.create({
                model: modelName,
                max_tokens: MAX_TOKENS,
                system,
                tools,
                messages,
                temperature: 0.1,
            });

            const assistantContent = response.content;
            messages.push({ role: 'assistant', content: assistantContent });

            const textBlocks = assistantContent.filter(
                (b): b is Anthropic.TextBlock => b.type === 'text',
            );
            const thinkingText = textBlocks.map(b => b.text).join('\n').trim();
            if (thinkingText) {
                const lines = thinkingText.split('\n');
                const preview = lines.slice(0, 6).join('\n');
                const suffix = lines.length > 6 ? `\n    ... (${lines.length - 6}行省略)` : '';
                log.info(`💭 [${iter + 1}/${maxIter}] エージェント思考:\n    ${preview.replace(/\n/g, '\n    ')}${suffix}`);
            }

            const toolUseBlocks = assistantContent.filter(
                (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
            );

            if (toolUseBlocks.length === 0) {
                if (iter > 2) {
                    result.summary = thinkingText || 'エージェントがツールを呼ばずに応答しました';
                    finished = true;
                }
                continue;
            }

            const toolResults = await executeToolUsesParallel(toolUseBlocks, iter, maxIter);
            const toolResultContents: ToolResultBlockParam[] = [];

            for (const tr of toolResults) {
                if (tr.finished) {
                    result.success = tr.finishData!.success;
                    result.summary = tr.finishData!.summary;
                    result.filesChanged = tr.finishData!.filesChanged;
                    finished = true;
                }
                toolResultContents.push({
                    type: 'tool_result',
                    tool_use_id: tr.toolUseId,
                    content: tr.content,
                });
            }

            messages.push({ role: 'user', content: toolResultContents });
        } catch (err: any) {
            log.error(`AgentLoop iter ${iter + 1} エラー: ${err.message}`);
            messages.push({
                role: 'user',
                content: `エラー: ${err.message}\n続行するか finish(success=false) を呼んでください。`,
            });
        }
    }

    if (!finished) {
        result.aborted = true;
        result.summary = `最大イテレーション (${maxIter}) に達しました`;
        log.warn(`⏱️ CodeAgentLoop 打ち切り: ${maxIter}iter`);
    }

    log.info(
        `🤖 CodeAgentLoop${task.isSubAgent ? '(sub)' : ''} 完了: ` +
        `${result.success ? '✅' : '❌'} ${result.summary.slice(0, 100)} ` +
        `(${result.iterations}iter, files=${result.filesChanged.length})`,
    );

    return result;
}

// ── 並列ツール実行 ──

interface ToolExecResult {
    toolUseId: string;
    content: string;
    finished: boolean;
    finishData?: { success: boolean; summary: string; filesChanged: string[] };
}

async function executeToolUsesParallel(
    toolUses: Anthropic.ToolUseBlock[],
    iter: number,
    maxIter: number,
): Promise<ToolExecResult[]> {
    const writeTools = new Set(['edit_file', 'create_file', 'delete_file', 'shell_exec']);

    const readBlocks: Anthropic.ToolUseBlock[] = [];
    const writeBlocks: Anthropic.ToolUseBlock[] = [];
    let finishBlock: Anthropic.ToolUseBlock | null = null;

    for (const block of toolUses) {
        if (block.name === 'finish') { finishBlock = block; break; }
        if (writeTools.has(block.name) || isBuildTool(block.name)) writeBlocks.push(block);
        else readBlocks.push(block);
    }

    if (finishBlock) {
        const args = finishBlock.input as Record<string, unknown>;
        return [{
            toolUseId: finishBlock.id,
            content: `Finished: ${args.success ? 'success' : 'failure'}`,
            finished: true,
            finishData: {
                success: (args.success as boolean) ?? false,
                summary: (args.summary as string) ?? '',
                filesChanged: (args.filesChanged as string[]) ?? [],
            },
        }];
    }

    const results: ToolExecResult[] = [];

    if (readBlocks.length > 0) {
        const readResults = await Promise.all(
            readBlocks.map(b => executeSingleToolUse(b, iter, maxIter)),
        );
        results.push(...readResults);
    }

    for (const block of writeBlocks) {
        results.push(await executeSingleToolUse(block, iter, maxIter));
    }

    return results;
}

async function executeSingleToolUse(
    block: Anthropic.ToolUseBlock,
    iter: number,
    maxIter: number,
): Promise<ToolExecResult> {
    const name = block.name;
    const args = block.input as Record<string, unknown>;

    if (!ALL_TOOL_NAMES.has(name)) {
        return { toolUseId: block.id, content: `Unknown tool: ${name}`, finished: false };
    }

    log.info(`🔧 [${iter + 1}/${maxIter}] ${name}(${summarizeArgs(args)})`);

    if (name === 'edit_file' && args.old_string && args.new_string) {
        const oldStr = String(args.old_string);
        const newStr = String(args.new_string);
        log.info(`    📝 edit: ${String(args.path ?? '').split('/').pop()} — ${oldStr.split('\n').length}行 → ${newStr.split('\n').length}行`);
    }

    let output: string;

    if (name === 'spawn_agent') {
        output = execSpawnAgent(args as any);
    } else if (name === 'check_agent') {
        output = await execCheckAgent(args as any);
    } else if (isBuildTool(name)) {
        output = await executeBuildTool(name, args);
    } else {
        output = await executeToolCall(name, args);
    }

    if (name === 'run_tsc' || name === 'run_vitest') {
        const preview = output.slice(0, 200);
        log.info(`    📊 結果: ${preview}${output.length > 200 ? '...' : ''}`);
    }

    return { toolUseId: block.id, content: output, finished: false };
}

// ── サブエージェント実行 ──

function execSpawnAgent(args: { description: string; context?: string; targetFile?: string }): string {
    if (subAgents.size >= MAX_SUB_AGENTS) {
        return `⛔ サブエージェント上限（${MAX_SUB_AGENTS}）。check_agent で既存の結果を取得してください。`;
    }

    const id = `sub_${++subAgentCounter}`;
    const promise = runCodeAgentLoop({
        description: args.description,
        context: args.context,
        targetFile: args.targetFile,
        maxIterations: SUB_AGENT_MAX_ITER,
        isSubAgent: true,
    });

    promise.then(r => {
        const h = subAgents.get(id);
        if (h) h.result = r;
    }).catch(err => {
        const h = subAgents.get(id);
        if (h) h.result = {
            success: false, summary: `サブエージェントエラー: ${err.message}`,
            filesChanged: [], iterations: 0, aborted: true,
        };
    });

    subAgents.set(id, { id, description: args.description, promise });
    log.info(`🚀 サブエージェント起動: ${id} — ${args.description.slice(0, 60)}`);
    return `✅ サブエージェント起動: ${id}\nタスク: ${args.description}\ncheck_agent(agentId="${id}") で結果を取得できます。`;
}

async function execCheckAgent(args: { agentId: string }): Promise<string> {
    const handle = subAgents.get(args.agentId);
    if (!handle) return `❌ サブエージェント "${args.agentId}" が見つかりません`;

    if (!handle.result) {
        log.info(`⏳ サブエージェント ${args.agentId} 待機中...`);
        await handle.promise;
    }

    const r = handle.result!;
    subAgents.delete(args.agentId);

    return [
        `## サブエージェント ${args.agentId} 結果`,
        `成功: ${r.success ? '✅' : '❌'}`,
        `サマリ: ${r.summary}`,
        `イテレーション: ${r.iterations}`,
        r.filesChanged.length > 0 ? `変更ファイル:\n${r.filesChanged.map(f => `  - ${f}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
}

// ── コンテキストウィンドウ管理 ──

function compressContext(messages: MessageParam[]): void {
    const totalChars = messages.reduce((sum, m) => {
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return sum + c.length;
    }, 0);

    if (totalChars < CONTEXT_COMPRESS_THRESHOLD) return;

    log.info(`📦 コンテキスト圧縮: ${totalChars}文字`);

    let compressed = 0;
    for (let i = 0; i < messages.length - 4; i++) {
        const msg = messages[i];
        if (msg.role === 'user' && Array.isArray(msg.content)) {
            for (let j = 0; j < msg.content.length; j++) {
                const block = msg.content[j];
                if (typeof block === 'object' && 'type' in block && block.type === 'tool_result') {
                    const tr = block as ToolResultBlockParam;
                    const content = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content);
                    if (content.length > 800) {
                        const summary = summarizeToolOutput(content);
                        (msg.content[j] as any).content = summary;
                        compressed += content.length - summary.length;
                    }
                }
            }
        }
    }

    if (compressed > 0) log.info(`📦 ${compressed}文字を圧縮`);
}

function summarizeToolOutput(output: string): string {
    const lines = output.split('\n');
    if (lines.length <= 15) return output;
    return `${lines.slice(0, 8).join('\n')}\n... (${lines.length - 13}行省略) ...\n${lines.slice(-5).join('\n')}`;
}

// ── ヘルパ ──

function buildInitialPrompt(task: AgentLoopTask): string {
    const parts: string[] = [`## タスク\n${task.description}`];

    if (task.context) parts.push(`## 追加コンテキスト\n${task.context}`);
    if (task.targetFile) parts.push(`## 主要な対象ファイル\n${task.targetFile}\nまずこのファイルを read_file で読んでください。`);
    if (task.failedTestInfo) parts.push(`## 失敗テスト情報\n${task.failedTestInfo}`);
    if (task.initialFiles?.length) parts.push(`## 関連ファイル（参考）\n${task.initialFiles.join('\n')}`);

    parts.push(
        '\n## 手順\n' +
        '1. task_plan でタスクを分解（3ステップ以上の場合）\n' +
        '2. search_code, glob_files, semantic_search, read_file で調査（並列推奨）\n' +
        '3. edit_file で最小限の差分修正\n' +
        '4. run_tsc / read_lints で検証\n' +
        '5. task_update で完了マーク → finish(success=true) で完了',
    );

    return parts.join('\n\n');
}

function summarizeArgs(args: Record<string, unknown>): string {
    return Object.entries(args)
        .map(([k, v]) => {
            const s = typeof v === 'string' ? v : JSON.stringify(v);
            return `${k}=${s.length > 60 ? s.slice(0, 57) + '...' : s}`;
        })
        .join(', ');
}
