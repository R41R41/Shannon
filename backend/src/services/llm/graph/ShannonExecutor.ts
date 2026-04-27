/**
 * ShannonExecutor — Anthropic API 直接呼出による実行エンジン
 *
 * FCA (FunctionCallingAgent, 1200行) を置き換える ~200行の実装。
 * LangChain を使わず @anthropic-ai/sdk を直接使用。
 *
 * Claude Code と同じアーキテクチャ:
 *   System prompt + tools → Claude Opus → tool_use → execute → tool_result → loop
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../../config/env.js';
import { createLogger } from '../../../utils/logger.js';
import { CONFIG as MINEBOT_CONFIG } from '../../minebot/config/MinebotConfig.js';
import type { TaskContext, TaskTreeState, TaskNode } from '@shannon/common';
import type { InstantSkills } from '../../minebot/types/collections.js';
import type { RoutineManager } from '../../minebot/routines/RoutineManager.js';
import type { RoutineExecutor } from '../../minebot/routines/RoutineExecutor.js';
import { sendGameChatLimited } from '../../minebot/utils/sendGameChatLimited.js';

const log = createLogger('LLM:ShannonExecutor');

type MessageParam = Anthropic.MessageParam;
type Tool = Anthropic.Tool;
type ToolResultBlockParam = Anthropic.ToolResultBlockParam;

// ─── 型定義 ───

export interface ShannonExecutorDeps {
    instantSkills?: InstantSkills;
    routineManager?: RoutineManager;
    routineExecutor?: RoutineExecutor;
    /** Minecraft bot 参照 (SubAgentRoutineExecutor に渡す) */
    bot?: import('../../minebot/types/CustomBot.js').CustomBot;
    /** LLM ツール (recall-*, save-*, task-complete, etc.) */
    llmTools?: Map<string, (input: Record<string, unknown>) => Promise<string>>;
}

export interface ShannonExecutorState {
    goal: string;
    context: TaskContext | null;
    systemPrompt: string;
    tools: Tool[];
    /** Minecraft: スキル実行中フラグ管理用 */
    onToolStarting?: (toolName: string, args?: Record<string, unknown>) => void;
    onTaskTreeUpdate?: (taskTree: TaskTreeState) => void;
    abortSignal?: AbortSignal;
    /** envelope のタグ (emergency 等) */
    tags?: string[];
    /** タスク実行中のユーザーフィードバックを取得するコールバック */
    getHumanFeedback?: () => string | null;
    /** MAX_ITERATIONS 到達後の再開時に前回の会話履歴を注入する */
    previousMessages?: MessageParam[];
    /** 再開時に前回のタスクツリーを引き継ぐ */
    previousTaskNodes?: TaskNode[];
}

export interface ShannonExecutorResult {
    lastContent: string | null;
    taskTree: TaskTreeState | null;
    iterations: number;
    toolCallCount: number;
    durationMs: number;
    thinkingLog: string[];
    /** MAX_ITERATIONS 到達時に会話履歴を保存し、再開に使う */
    messages?: MessageParam[];
    /** awaiting_user: ユーザーに続行確認中 */
    recoveryStatus?: 'awaiting_user';
    /** LLM管理型タスクツリーのノード（再開時に引き継ぐ） */
    taskNodes?: TaskNode[];
}

// ─── 定数 ───

const MODEL_OPUS = process.env.SHANNON_MODEL_OPUS || 'claude-opus-4-6';
const MODEL_SONNET = process.env.SHANNON_MODEL || 'claude-sonnet-4-6';
const MODEL_HAIKU = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 16384;
const MAX_ITERATIONS = 30;
const MAX_CONSECUTIVE_TEXT = 3;

/** 軽量タスク判定: Haiku で十分なタスクか */
function isLightweightTask(goal: string, tags?: string[]): boolean {
    // 緊急タスク → Haiku (「逃げろ」「食べろ」程度、Sonnet の精度は不要)
    if (tags?.includes('emergency')) return true;

    const g = goal.toLowerCase();
    // 挨拶・雑談・質問系
    if (g.length < 30 && /こんにち|おはよ|こんばん|やあ|ねえ|hello|hi\b/.test(g)) return true;
    if (/何してる|元気|調子|天気|時間/.test(g)) return true;
    return false;
}

function selectModel(goal: string, tags?: string[]): string {
    if (config.useOpus) {
        if (isLightweightTask(goal, tags)) return MODEL_SONNET;
        return MODEL_OPUS;
    }
    return isLightweightTask(goal, tags) ? MODEL_HAIKU : MODEL_SONNET;
}

// ─── メイン ───

// ─── manage-task-tree ツール定義 ───

const MANAGE_TASK_TREE_TOOL: Tool = {
    name: 'manage-task-tree',
    description: 'タスクの計画・進捗を管理する。タスク開始時に計画を立て、進捗があれば更新する。他のスキル（move-to等）と同じレスポンスで同時に呼べる。',
    input_schema: {
        type: 'object' as const,
        properties: {
            operations: {
                type: 'array',
                description: 'タスクツリーへの操作リスト',
                items: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', enum: ['create', 'update', 'delete'], description: '操作種別' },
                        id: { type: 'string', description: 'ノードID' },
                        parentId: { type: 'string', description: 'サブタスクの場合、親のID（トップレベルは省略）' },
                        goal: { type: 'string', description: 'タスクの内容' },
                        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'error'] },
                        progress: { type: 'string', description: '進捗メモ（例: 3/10個）' },
                        blockedBy: { type: 'string', description: 'ブロッカー（例: 鉄のツルハシが必要）' },
                    },
                    required: ['action', 'id'],
                },
            },
        },
        required: ['operations'],
    },
};

// ─── タスクツリー操作ヘルパー ───

interface TaskTreeOperation {
    action: 'create' | 'update' | 'delete';
    id: string;
    parentId?: string;
    goal?: string;
    status?: string;
    progress?: string;
    blockedBy?: string;
}

function findNodeById(nodes: TaskNode[], id: string): TaskNode | null {
    for (const node of nodes) {
        if (node.id === id) return node;
        if (node.children) {
            const found = findNodeById(node.children, id);
            if (found) return found;
        }
    }
    return null;
}

function removeNodeById(nodes: TaskNode[], id: string): boolean {
    const idx = nodes.findIndex(n => n.id === id);
    if (idx >= 0) { nodes.splice(idx, 1); return true; }
    for (const node of nodes) {
        if (node.children && removeNodeById(node.children, id)) return true;
    }
    return false;
}

function applyTaskTreeOperations(nodes: TaskNode[], operations: TaskTreeOperation[]): { nodes: TaskNode[]; summary: string } {
    let created = 0, updated = 0, deleted = 0;

    for (const op of operations) {
        if (op.action === 'create') {
            const newNode: TaskNode = {
                id: op.id,
                goal: op.goal || op.id,
                status: (op.status as TaskNode['status']) || 'pending',
                progress: op.progress || null,
                blockedBy: op.blockedBy || null,
                children: [],
            };
            if (op.parentId) {
                const parent = findNodeById(nodes, op.parentId);
                if (parent) {
                    if (!parent.children) parent.children = [];
                    parent.children.push(newNode);
                } else {
                    nodes.push(newNode);
                }
            } else {
                nodes.push(newNode);
            }
            created++;
        } else if (op.action === 'update') {
            const node = findNodeById(nodes, op.id);
            if (node) {
                if (op.goal !== undefined) node.goal = op.goal;
                if (op.status !== undefined) node.status = op.status as TaskNode['status'];
                if (op.progress !== undefined) node.progress = op.progress || null;
                if (op.blockedBy !== undefined) node.blockedBy = op.blockedBy || null;
                updated++;
            }
        } else if (op.action === 'delete') {
            if (removeNodeById(nodes, op.id)) deleted++;
        }
    }

    const countNodes = (ns: TaskNode[]): { total: number; completed: number } => {
        let total = 0, completed = 0;
        for (const n of ns) {
            total++; if (n.status === 'completed') completed++;
            if (n.children) { const c = countNodes(n.children); total += c.total; completed += c.completed; }
        }
        return { total, completed };
    };
    const { total, completed } = countNodes(nodes);
    const summary = `ツリー更新完了 (作成:${created} 更新:${updated} 削除:${deleted})。${total}件中${completed}件完了。`;
    return { nodes, summary };
}

function taskNodesToText(nodes: TaskNode[], depth: number = 0): string {
    const lines: string[] = [];
    for (const node of nodes) {
        const indent = depth === 0 ? '' : '│   '.repeat(depth - 1) + '├── ';
        const statusIcon = node.status === 'completed' ? '[完了]'
            : node.status === 'in_progress' ? '[進行中]'
            : node.status === 'error' ? '[エラー]'
            : '[未着手]';
        let line = `${indent}${node.goal} ${statusIcon}`;
        if (node.progress) line += ` (${node.progress})`;
        if (node.blockedBy) line += ` (blocked: ${node.blockedBy})`;
        lines.push(line);
        if (node.children && node.children.length > 0) {
            lines.push(taskNodesToText(node.children, depth + 1));
        }
    }
    return lines.join('\n');
}

function taskNodesToHierarchicalSubTasks(nodes: TaskNode[]): TaskTreeState['hierarchicalSubTasks'] {
    const convert = (ns: TaskNode[], parentId: string | null, depth: number): NonNullable<TaskTreeState['hierarchicalSubTasks']> => {
        return ns.map(n => ({
            id: n.id,
            goal: n.goal + (n.progress ? ` (${n.progress})` : ''),
            status: n.status,
            result: n.status === 'completed' ? (n.progress || '完了') : null,
            failureReason: n.status === 'error' ? (n.blockedBy || 'エラー') : null,
            parentId,
            depth,
            children: n.children && n.children.length > 0
                ? convert(n.children, n.id, depth + 1)
                : [],
        }));
    };
    return convert(nodes, null, 0);
}

export class ShannonExecutor {
    private client: Anthropic;

    /** 直前のタスクの結果サマリ（次のタスクにコンテキストとして引き継ぐ） */
    private static lastTaskSummary: string | null = null;
    private static lastTaskGoal: string | null = null;

    constructor(private deps: ShannonExecutorDeps) {
        this.client = new Anthropic({
            apiKey: config.anthropic.apiKey || undefined,
        });
    }

    async run(state: ShannonExecutorState): Promise<ShannonExecutorResult> {
        const startTime = Date.now();
        let messages: MessageParam[];

        const isResume = state.previousMessages && state.previousMessages.length > 0;

        // LLM管理型タスクツリー
        const taskNodes: TaskNode[] = state.previousTaskNodes ? JSON.parse(JSON.stringify(state.previousTaskNodes)) : [];

        let taskTree: TaskTreeState | null = null;

        // ── 表示用タスク名の非同期要約（メイン処理をブロックしない） ──
        let displayGoal = state.goal;
        if (!isResume && state.goal.length > 20) {
            this.summarizeGoal(state.goal).then(summary => {
                displayGoal = summary;
                log.info(`📝 タスク名要約: "${summary}"`, 'green');
                if (taskTree) {
                    taskTree = { ...taskTree, goal: displayGoal };
                    state.onTaskTreeUpdate?.(taskTree);
                    this.postTaskTreeToUiMod(taskTree);
                }
            }).catch(e => {
                log.warn(`⚠ タスク名要約失敗 (元テキストを使用): ${e instanceof Error ? e.message : e}`);
            });
        }

        if (isResume) {
            // MAX_ITERATIONS 到達後の再開: LLM で会話履歴を要約して圧縮
            const prev = state.previousMessages!;
            log.info(`♻️ ShannonExecutor: 前回の会話 (${prev.length} messages) → LLM要約して再開`, 'cyan');
            const summary = await this.summarizeWithLLM(prev, state.goal);

            // タスクツリーがあれば構造化コンテキストとしても渡す
            const treeContext = taskNodes.length > 0
                ? `\n\n【タスクツリー（前半の計画と進捗）】\n${taskNodesToText(taskNodes)}`
                : '';

            messages = [
                { role: 'user', content: `【前半の実行ログ（要約）】\nゴール: ${state.goal}\n\n${summary}${treeContext}` },
                { role: 'assistant', content: 'ここまでの経緯とタスクツリーを把握しました。続きを実行します。' },
                { role: 'user', content: `【続行指示】${state.goal}\n上の要約とタスクツリーは前半の実行履歴です。タスクツリーを更新しながら未完了の作業を引き継いでください。同じ失敗を繰り返さないこと。` },
            ];
        } else {
            messages = [];
            // 前タスクのコンテキストを引き継ぐ
            if (ShannonExecutor.lastTaskSummary && ShannonExecutor.lastTaskGoal) {
                messages.push({
                    role: 'user',
                    content: `【前のタスクの結果】\nゴール: ${ShannonExecutor.lastTaskGoal}\n結果: ${ShannonExecutor.lastTaskSummary}\n\n---\n以下が新しいタスクです:`,
                });
                messages.push({ role: 'assistant', content: 'はい、前のタスクの結果を踏まえて新しいタスクに取り組みます。' });
            }
            messages.push({ role: 'user', content: state.goal });
        }

        let lastContent: string | null = null;
        let taskCompleted = false;
        let consecutiveTextOnly = 0;
        let totalToolCalls = 0;
        const thinkingLog: string[] = [];
        let treeReminderSent = false;

        const model = selectModel(state.goal, state.tags);
        log.info(`▶ ShannonExecutor: "${state.goal.slice(0, 60)}..." (model=${model}, taskTreeCb=${!!state.onTaskTreeUpdate})`, 'cyan');

        for (let iter = 0; iter < MAX_ITERATIONS && !taskCompleted; iter++) {
            if (state.abortSignal?.aborted || (this.deps.bot as any)?._minebotStopping) {
                log.warn(`⚠ ShannonExecutor aborted (signal=${state.abortSignal?.aborted}, botFlag=${(this.deps.bot as any)?._minebotStopping})`);
                break;
            }

            // ユーザーからのリアルタイムフィードバックをチェック
            const feedback = state.getHumanFeedback?.();
            if (feedback) {
                log.info(`💬 ユーザーフィードバック受信: "${feedback.slice(0, 60)}"`, 'cyan');
                messages.push({
                    role: 'user',
                    content: `【ユーザーからのリアルタイムフィードバック】${feedback}\nこのフィードバックを考慮して、現在のタスクを続行してください。`,
                });
            }

            const llmStart = Date.now();

            // タスクツリー未作成リマインド（初回スキル実行後に1度だけ）
            if (!treeReminderSent && taskNodes.length === 0 && iter === 1 && !isResume) {
                treeReminderSent = true;
                messages.push({
                    role: 'user',
                    content: 'タスクツリーが未作成です。manage-task-tree で計画を立ててください（他のスキルと同時に呼べます）。',
                });
            }

            // システムプロンプトにタスクツリーを動的注入
            let systemPromptWithTree = state.systemPrompt;
            if (taskNodes.length > 0) {
                const treeText = taskNodesToText(taskNodes);
                systemPromptWithTree += `\n\n## 現在のタスクツリー\n${treeText}`;
            }

            let response: Anthropic.Message;
            try {
                // Prompt caching: system prompt + tools を cache_control でキャッシュ
                const allTools = [...(state.tools ?? []), MANAGE_TASK_TREE_TOOL];
                const cachedTools = allTools.length > 0
                    ? allTools.map((t, i) =>
                        i === allTools.length - 1
                            ? { ...t, cache_control: { type: 'ephemeral' as const } }
                            : t,
                      )
                    : [];

                const stream = this.client.messages.stream({
                    model,
                    max_tokens: MAX_TOKENS,
                    system: [
                        { type: 'text' as const, text: systemPromptWithTree, cache_control: { type: 'ephemeral' as const } },
                    ],
                    tools: cachedTools as any,
                    messages,
                    temperature: 1,
                });
                response = await stream.finalMessage();
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                log.error(`❌ API error: ${msg}`, e);
                break;
            }

            const llmMs = Date.now() - llmStart;

            // usage ログ（キャッシュ効果を確認）
            const usage = response.usage as any;
            if (usage) {
                const cached = usage.cache_read_input_tokens ?? 0;
                const cacheWrite = usage.cache_creation_input_tokens ?? 0;
                const newInput = usage.input_tokens ?? 0;
                const totalInput = cached + cacheWrite + newInput;
                const cacheRate = totalInput > 0 ? Math.round((cached / totalInput) * 100) : 0;
                const cwPart = cacheWrite > 0 ? `+cw=${cacheWrite}` : '';
                log.info(`  📊 tokens: in=${newInput}${cwPart}+cached=${cached} (${cacheRate}%), out=${usage.output_tokens ?? 0}`, 'cyan');
            }

            // アシスタント応答を記録
            const assistantContent = response.content;
            messages.push({ role: 'assistant', content: assistantContent });

            // thinking ブロックを収集
            for (const block of assistantContent) {
                if (block.type === 'thinking') {
                    thinkingLog.push((block as any).thinking);
                }
            }

            // テキストブロックを収集
            const textBlocks = assistantContent.filter(b => b.type === 'text');
            const textContent = textBlocks.map(b => (b as Anthropic.TextBlock).text).join('\n');
            if (textContent) {
                lastContent = textContent;
                log.info(`💭 思考: ${textContent.slice(0, 100)}...`);
            }

            // ツール呼出しブロックを収集
            const toolUseBlocks = assistantContent.filter(
                (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
            );

            log.info(`⏱ LLM応答: ${llmMs}ms (iteration ${iter + 1}, tools: ${toolUseBlocks.length})`, 'cyan');

            if (toolUseBlocks.length === 0) {
                consecutiveTextOnly++;
                if (consecutiveTextOnly >= MAX_CONSECUTIVE_TEXT) {
                    log.warn(`⚠ テキストのみ ${MAX_CONSECUTIVE_TEXT}回連続 → 終了`);
                    break;
                }
                // ツール呼出しを促す
                messages.push({
                    role: 'user',
                    content: 'ツール呼び出しがありません。task-complete で完了するか、次のツールを呼んでください。',
                });
                continue;
            }

            consecutiveTextOnly = 0;
            totalToolCalls += toolUseBlocks.length;

            // ── ツール実行 ──
            const toolResults: ToolResultBlockParam[] = [];

            for (const toolUse of toolUseBlocks) {
                const toolName = toolUse.name;
                const toolInput = toolUse.input as Record<string, unknown>;

                state.onToolStarting?.(toolName, toolInput);
                log.info(`  ▶ ${toolName}(${JSON.stringify(toolInput).slice(0, 80)})`, 'cyan');

                let resultText: string;

                try {
                    // manage-task-tree: タスクツリーの CRUD 操作
                    if (toolName === 'manage-task-tree') {
                        const ops = (toolInput.operations as TaskTreeOperation[]) || [];
                        const result = applyTaskTreeOperations(taskNodes, ops);
                        resultText = result.summary;
                        log.info(`🌳 ${resultText}`, 'cyan');
                    }
                    // task-complete 特殊処理
                    else if (toolName === 'task-complete') {
                        const summary = (toolInput.summary as string) || '';
                        resultText = `タスク完了: ${summary}`;
                        lastContent = summary;
                        taskCompleted = true;
                        // 次タスクへのコンテキスト引継ぎ用に保存
                        ShannonExecutor.lastTaskGoal = state.goal;
                        ShannonExecutor.lastTaskSummary = summary.slice(0, 500);
                        taskTree = {
                            goal: displayGoal,
                            strategy: summary,
                            status: 'completed',
                            hierarchicalSubTasks: [],
                        } as TaskTreeState;
                        state.onTaskTreeUpdate?.(taskTree);
                        this.postTaskTreeToUiMod(taskTree);
                    }
                    // ルーチン (API名: routine-xxx)
                    else if (toolName.startsWith('routine-') && this.deps.routineManager) {
                        const routineName = toolName.replace('routine-', '');
                        const def = this.deps.routineManager.get(routineName);
                        if (def) {
                            if (def.instruction && this.deps.bot) {
                                // 新方式: Haiku サブエージェント
                                const { SubAgentRoutineExecutor } = await import('../../minebot/routines/SubAgentRoutineExecutor.js');
                                const subAgent = new SubAgentRoutineExecutor();
                                const result = await subAgent.execute(def, toolInput, {
                                    abortSignal: state.abortSignal,
                                    bot: this.deps.bot,
                                    onTaskTreeUpdate: state.onTaskTreeUpdate,
                                });
                                resultText = result.summary;
                                this.deps.routineManager.updateStats(routineName, result.success, result.durationMs).catch(() => {});
                            } else if (def.steps && this.deps.routineExecutor) {
                                // 旧方式: コードベース実行 (後方互換)
                                const result = await this.deps.routineExecutor.execute(def, toolInput, {
                                    abortSignal: state.abortSignal,
                                });
                                resultText = result.summary;
                                this.deps.routineManager.updateStats(routineName, result.success, result.durationMs).catch(() => {});
                            } else {
                                resultText = `ルーチン "${routineName}" の実行方法が不明です`;
                            }
                        } else {
                            resultText = `ルーチン "${routineName}" が見つかりません`;
                        }
                    }
                    // InstantSkill
                    else if (this.deps.instantSkills?.getSkill(toolName)) {
                        const skill = this.deps.instantSkills.getSkill(toolName)!;
                        const args = skill.params.map(p => {
                            const val = toolInput[p.name];
                            if (val === undefined) return p.default;
                            if (p.type === 'number') return Number(val);
                            if (p.type === 'boolean') return val === true || val === 'true';
                            return val;
                        });
                        const skillResult = await skill.run(...args);
                        const status = skillResult.success ? '成功' : '失敗';
                        resultText = `結果: ${status} 詳細: ${skillResult.result}`;
                        if (skillResult.failureType) {
                            resultText += ` [failure_type=${skillResult.failureType} recoverable=${skillResult.recoverable ?? true}]`;
                        }
                    }
                    // LLM ツール (recall-*, save-*, manage-routine, etc.)
                    else if (this.deps.llmTools?.has(toolName)) {
                        resultText = await this.deps.llmTools.get(toolName)!(toolInput);
                    }
                    // search-skills: スキル・ルーチン・LLMツール（記憶/計画系）を横断検索
                    else if (toolName === 'search-skills') {
                        const rawQuery = ((toolInput.query as string) || '').toLowerCase();
                        // routine- プレフィックスを除去してから検索
                        const query = rawQuery.replace(/^routine-/, '');
                        // クエリを単語分割し、いずれかの単語がマッチすれば結果に含める
                        const queryWords = query.split(/[\s,\-]+/).filter(w => w.length > 0);
                        const matchesQuery = (text: string) => {
                            const t = text.toLowerCase();
                            return queryWords.some(w => t.includes(w));
                        };
                        const results: string[] = [];

                        // 1. InstantSkills (Minecraft 物理スキル)
                        if (this.deps.instantSkills) {
                            for (const skill of this.deps.instantSkills.getSkills()) {
                                if (matchesQuery(skill.skillName) || matchesQuery(skill.description)) {
                                    const params = skill.params.map((p: any) =>
                                        `${p.name}: ${p.type}${p.required ? ' (必須)' : ` (デフォルト: ${p.default ?? 'なし'})`} — ${p.description}`
                                    ).join('\n    ');
                                    results.push(`**${skill.skillName}**: ${skill.description}\n    ${params || '(引数なし)'}`);
                                }
                            }
                        }

                        // 2. Routines (sub-agent 手順書)
                        if (this.deps.routineManager) {
                            for (const r of this.deps.routineManager.getAll()) {
                                if (matchesQuery(r.name) || matchesQuery(r.description) || matchesQuery(r.instruction ?? '')) {
                                    const params = r.params.map((p: any) =>
                                        `${p.name}: ${p.type}${p.required ? ' (必須)' : ` (デフォルト: ${p.default ?? 'なし'})`} — ${p.description}`
                                    ).join('\n    ');
                                    results.push(`**routine-${r.name}**: ${r.description}\n    ${params || '(引数なし)'}`);
                                }
                            }
                        }

                        // 3. LLM ツール (記憶・計画・ユーティリティなど)
                        //    toolsForRun（このセッションで渡されている Anthropic Tool 定義）から引く。
                        //    ShannonExecutor.run が state.tools として保持しているものを検索する。
                        for (const t of (state.tools ?? [])) {
                            if (matchesQuery(t.name) || matchesQuery(t.description ?? '')) {
                                const schema = (t.input_schema ?? {}) as Record<string, any>;
                                const props = (schema.properties ?? {}) as Record<string, any>;
                                const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
                                const paramLines = Object.entries(props).map(([name, def]) => {
                                    const d = def as Record<string, any>;
                                    const req = required.has(name) ? ' (必須)' : '';
                                    return `${name}: ${d.type ?? 'any'}${req} — ${d.description ?? ''}`;
                                });
                                const paramBlock = paramLines.length > 0 ? paramLines.join('\n    ') : '(引数なし)';
                                // routine-xxx は routineManager 側で既に出ているので重複除去
                                if (t.name.startsWith('routine-')) continue;
                                // InstantSkill も instantSkills 側で既に出ているので重複除去
                                if (this.deps.instantSkills?.getSkill(t.name)) continue;
                                results.push(`**${t.name}**: ${t.description ?? ''}\n    ${paramBlock}`);
                            }
                        }

                        // 4. ハードコードされた内部ツール（state.tools に含まれない manage-task-tree 等）
                        const internalHardcoded: Array<{ name: string; description: string }> = [
                            { name: 'manage-task-tree', description: 'タスクの計画・進捗を管理する。create/update/delete を operations 配列で。他のスキルと同じレスポンスで同時に呼べる' },
                            { name: 'search-skills', description: 'スキル・ルーチン・LLMツールの説明と引数を検索する（このツール自身）' },
                            { name: 'task-complete', description: 'タスク完了を宣言する。summary にユーザーへの返答を書く' },
                        ];
                        for (const t of internalHardcoded) {
                            if (matchesQuery(t.name) || matchesQuery(t.description)) {
                                results.push(`**${t.name}**: ${t.description}`);
                            }
                        }

                        if (!this.deps.instantSkills && !this.deps.routineManager && (state.tools ?? []).length === 0) {
                            resultText = 'search-skills: このチャネルではスキル検索は利用できません';
                        } else {
                            resultText = results.length > 0
                                ? `検索結果 (${results.length}件):\n${results.slice(0, 15).join('\n\n')}`
                                : `"${query}" に一致するスキル/ルーチン/ツールが見つかりません`;
                        }
                    }
                    // 不明なツール
                    else {
                        resultText = `不明なツール: ${toolName}`;
                    }
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    resultText = `エラー: ${msg}`;
                }

                const truncated = resultText.length > 150
                    ? resultText.slice(0, 150) + '...'
                    : resultText;
                log.info(`  ✓ ${toolName}: ${truncated}`, resultText.includes('失敗') ? 'yellow' : 'green');

                const MAX_TOOL_RESULT_CHARS = 2000;
                const trimmedResult = resultText.length > MAX_TOOL_RESULT_CHARS
                    ? resultText.slice(0, MAX_TOOL_RESULT_CHARS) + `\n...(${resultText.length - MAX_TOOL_RESULT_CHARS}文字省略)`
                    : resultText;

                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: trimmedResult,
                });
            }

            // ツール実行後の即時 abort チェック
            if (state.abortSignal?.aborted || (this.deps.bot as any)?._minebotStopping) {
                log.warn(`⚠ ShannonExecutor aborted after tool execution (signal=${state.abortSignal?.aborted}, botFlag=${(this.deps.bot as any)?._minebotStopping})`);
                messages.push({ role: 'user', content: toolResults });
                break;
            }

            // ツール結果をバッチで追加
            messages.push({ role: 'user', content: toolResults });

            // タスクツリー更新 (毎イテレーション UI Mod に送信)
            if (!taskCompleted) {
                const thinking = textContent ? textContent.slice(0, 100) : undefined;
                taskTree = {
                    goal: displayGoal,
                    strategy: thinking || `実行中... (${iter + 1}/${MAX_ITERATIONS})`,
                    status: 'in_progress',
                    currentThinking: thinking,
                    hierarchicalSubTasks: taskNodes.length > 0
                        ? taskNodesToHierarchicalSubTasks(taskNodes)
                        : [],
                } as TaskTreeState;
                state.onTaskTreeUpdate?.(taskTree);
                this.postTaskTreeToUiMod(taskTree);
            }

            // MetaObserver 削除 — メインループが自分で recall-knowledge / search-skills を呼ぶ
        }

        const durationMs = Date.now() - startTime;

        // MAX_ITERATIONS 到達 or 中断の処理
        let resultRecoveryStatus: 'awaiting_user' | undefined;
        let resultMessages: MessageParam[] | undefined;

        if (!taskCompleted) {
            if (state.abortSignal?.aborted || (this.deps.bot as any)?._minebotStopping) {
                // 緊急割込みで中断 — 次タスクで復帰できるようにコンテキスト保存
                const treeProgress = taskNodes.length > 0 ? taskNodesToText(taskNodes).slice(0, 200) : 'なし';
                ShannonExecutor.lastTaskGoal = state.goal;
                ShannonExecutor.lastTaskSummary = `【中断】緊急割込みにより中断。進捗: ${treeProgress}。このタスクの続きを実行する必要がある`;
                log.info(`💾 中断タスク保存: "${state.goal.slice(0, 40)}..." → 次タスクで復帰可能`);
                taskTree = {
                    goal: displayGoal,
                    strategy: '緊急割込みにより中断',
                    status: 'interrupted',
                    hierarchicalSubTasks: taskNodes.length > 0 ? taskNodesToHierarchicalSubTasks(taskNodes) : [],
                } as TaskTreeState;
            } else {
                // MAX_ITERATIONS 到達 → ユーザーに続行確認
                log.warn(`⚠ MAX_ITERATIONS (${MAX_ITERATIONS}) に到達 → awaiting_user`);
                const treeProgress = taskNodes.length > 0
                    ? taskNodesToText(taskNodes).slice(0, 200)
                    : 'なし';
                const chatMsgFull = `${MAX_ITERATIONS}ターン使いました（進捗: ${treeProgress}）。続けますか？`;
                const chatMsg = chatMsgFull.length > 240 ? chatMsgFull.slice(0, 237) + '...' : chatMsgFull;

                try {
                    if (this.deps.bot) {
                        sendGameChatLimited(this.deps.bot, chatMsg, 240);
                    }
                } catch (e) {
                    log.warn(`⚠ MAX_ITERATIONS chat notification failed: ${e}`);
                }

                resultRecoveryStatus = 'awaiting_user';
                resultMessages = messages;

                taskTree = {
                    goal: displayGoal,
                    strategy: `${MAX_ITERATIONS}ターン到達 — ユーザーの続行確認待ち`,
                    status: 'in_progress',
                    recoveryStatus: 'awaiting_user',
                    hierarchicalSubTasks: taskNodes.length > 0 ? taskNodesToHierarchicalSubTasks(taskNodes) : [],
                } as TaskTreeState;
                state.onTaskTreeUpdate?.(taskTree);
                this.postTaskTreeToUiMod(taskTree);
            }
        }

        log.info(
            `${taskCompleted ? '✔' : '⚠'} ShannonExecutor: ` +
            `${taskCompleted ? '完了' : resultRecoveryStatus === 'awaiting_user' ? '続行確認待ち' : '未完了'} ` +
            `(${durationMs}ms, ${totalToolCalls} tools)`,
            taskCompleted ? 'green' : 'yellow',
        );

        return {
            lastContent,
            taskTree,
            iterations: MAX_ITERATIONS,
            toolCallCount: totalToolCalls,
            durationMs,
            thinkingLog,
            messages: resultMessages,
            recoveryStatus: resultRecoveryStatus,
            taskNodes: taskNodes.length > 0 ? taskNodes : undefined,
        };
    }

    /**
     * ユーザーの生チャットを短い表示用タスク名に要約する（並列実行用）。
     * 例: 「ダイヤモンドが欲しいんだけどさ、地下に行って掘ってきてくれない？」→「ダイヤモンドの採掘」
     */
    private async summarizeGoal(rawGoal: string): Promise<string> {
        const response = await this.client.messages.create({
            model: MODEL_HAIKU,
            max_tokens: 60,
            system: 'ユーザーの指示を短い動作名詞句（〜10文字）に要約せよ。例:「ダイヤモンドの採掘」「ネザーポータル建設」「鉄装備の作成」。要約のみ出力。',
            messages: [{ role: 'user', content: rawGoal }],
        });
        const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map(b => b.text)
            .join('')
            .trim();
        if (!text || text.length > 30) return rawGoal;
        return text;
    }

    /**
     * LLM (Haiku) で前回の会話を意味的に要約する。
     * 失敗時は機械的要約にフォールバック。
     */
    private async summarizeWithLLM(messages: MessageParam[], goal: string): Promise<string> {
        const mechanical = ShannonExecutor.compressMessagesMechanical(messages);
        try {
            const response = await this.client.messages.create({
                model: MODEL_HAIKU,
                max_tokens: 1024,
                system: `あなたはタスク実行ログの要約者です。以下のツール呼出し履歴を、後続のAIエージェントが作業を引き継げるように要約してください。

要約に含めるべき情報:
1. **完了した作業**: 何を実行し、何が成功したか（具体的な数値・座標・アイテム名を保持）
2. **失敗した作業**: 何が失敗し、なぜか（エラーメッセージの要点）
3. **現在の状態**: インベントリ、位置、HP等の最新状態（分かる範囲で）
4. **残りの作業**: ゴール達成に何が未完了か

形式: 簡潔な箇条書き。合計500文字以内。`,
                messages: [
                    {
                        role: 'user',
                        content: `ゴール: ${goal}\n\n以下がツール呼出し履歴です:\n\n${mechanical}`,
                    },
                ],
            });

            const usage = response.usage as any;
            if (usage) {
                log.info(`  📊 要約LLM: in=${usage.input_tokens ?? 0}, out=${usage.output_tokens ?? 0}`, 'cyan');
            }

            const text = response.content
                .filter((b): b is Anthropic.TextBlock => b.type === 'text')
                .map(b => b.text)
                .join('\n');

            if (text.trim()) {
                log.info(`♻️ LLM要約完了 (${text.length}文字)`, 'green');
                return text;
            }
        } catch (e) {
            log.warn(`⚠ LLM要約失敗、機械的要約にフォールバック: ${e instanceof Error ? e.message : e}`);
        }
        return mechanical;
    }

    /**
     * 機械的にツール呼出しと結果を抽出してコンパクトなリストにする（フォールバック用）。
     */
    static compressMessagesMechanical(messages: MessageParam[]): string {
        const steps: string[] = [];
        let stepNum = 0;

        for (const msg of messages) {
            if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    if ((block as any).type === 'text') {
                        const t = ((block as any).text ?? '').trim();
                        if (t) steps.push(`💭 ${t.slice(0, 80)}`);
                    }
                }
                for (const block of msg.content) {
                    if ((block as any).type === 'tool_use') {
                        const name = (block as any).name ?? '?';
                        const input = JSON.stringify((block as any).input ?? {});
                        steps.push(`→ ${name}(${input.slice(0, 100)}${input.length > 100 ? '...' : ''})`);
                    }
                }
            }
            if (msg.role === 'user' && Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    if ((block as any).type === 'tool_result') {
                        const raw = typeof (block as any).content === 'string'
                            ? (block as any).content
                            : JSON.stringify((block as any).content ?? '');
                        const status = raw.includes('失敗') || raw.includes('エラー') ? '❌' : '✅';
                        steps.push(`  ${status} ${raw.slice(0, 120)}${raw.length > 120 ? '...' : ''}`);
                        stepNum++;
                    }
                }
            }
        }

        const header = `合計 ${stepNum} ツール呼出し、${messages.length} メッセージ`;
        const body = steps.join('\n');
        const MAX_SUMMARY_CHARS = 6000;
        if (body.length <= MAX_SUMMARY_CHARS) {
            return `${header}\n\n${body}`;
        }
        const tail = body.slice(-MAX_SUMMARY_CHARS);
        const firstNewline = tail.indexOf('\n');
        const trimmed = firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;
        return `${header}\n\n（前半省略）\n${trimmed}`;
    }

    /** UI Mod の /task エンドポイントにタスクツリーを直接送信 */
    private postTaskTreeToUiMod(taskTree: TaskTreeState): void {
        const url = `${MINEBOT_CONFIG.UI_MOD_BASE_URL}/task`;
        try {
            fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify(taskTree),
            }).then(res => {
                if (!res.ok) log.warn(`⚠ UI Mod POST /task failed: ${res.status}`);
            }).catch(e => {
                log.warn(`⚠ UI Mod POST /task error: ${e instanceof Error ? e.message : e}`);
            });
        } catch (e) {
            log.warn(`⚠ UI Mod POST /task exception: ${e}`);
        }
    }
}

// ─── ユーティリティ: スキルをAnthropicツール定義に変換 ───

export function skillToAnthropicTool(skill: { skillName: string; description: string; params: Array<{ name: string; type: string; description: string; required?: boolean; default?: unknown }> }): Tool {
    const properties: Record<string, { type: string; description: string }> = {};
    const required: string[] = [];

    for (const p of skill.params) {
        properties[p.name] = {
            type: p.type === 'Vec3' ? 'object' : p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string',
            description: p.description || p.name,
        };
        if (p.required) required.push(p.name);
    }

    return {
        name: skill.skillName,
        description: skill.description,
        input_schema: {
            type: 'object' as const,
            properties,
            required: required.length > 0 ? required : undefined,
        },
    };
}

/** routine:name の ':' を Anthropic 互換の '-' に変換 */
export function sanitizeToolName(name: string): string {
    return name.replace(/:/g, '-');
}

export function routineToAnthropicTool(name: string, def: { description: string; params: Array<{ name: string; type: string; description: string; required?: boolean; default?: unknown }> }): Tool {
    const properties: Record<string, { type: string; description: string }> = {};
    const required: string[] = [];

    for (const p of def.params) {
        properties[p.name] = {
            type: p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string',
            description: p.description || p.name,
        };
        if (p.required) required.push(p.name);
    }

    return {
        name: `routine-${name}`,
        description: `[Routine] ${def.description}. LLM呼出なしで高速実行。`,
        input_schema: {
            type: 'object' as const,
            properties,
            required: required.length > 0 ? required : undefined,
        },
    };
}
