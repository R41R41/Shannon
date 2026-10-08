import type { CompanionPrimaryModel } from '../../minebot/integration/companionPrimaryModel.js';
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
import { createConfiguredMinecraftPlanner, createPinnedMinecraftPlanners } from '../../minebot/cognition/configuredMinecraftPlanner.js';
import { isAnthropicPlannerTerminalError, isNativeMinecraftModel, type AnthropicCacheEvidenceError, type AnthropicPlannerRefusalError } from '../../minebot/cognition/AnthropicPlannerClient.js';
import { config } from '../../../config/env.js';
import { createLogger } from '../../../utils/logger.js';
import { CONFIG as MINEBOT_CONFIG } from '../../minebot/config/MinebotConfig.js';
import type { TaskContext, TaskTreeState, TaskNode } from '@shannon/common';
import type { InstantSkills } from '../../minebot/types/collections.js';
import type { RoutineManager } from '../../minebot/routines/RoutineManager.js';
import type { RoutineExecutor } from '../../minebot/routines/RoutineExecutor.js';
import { sendGameChatLimited } from '../../minebot/utils/sendGameChatLimited.js';
import type { MinecraftTaskContinuation } from '../../minebot/runtime/minecraftTaskContinuation.js';
import { TaskWorkspace } from '../../minebot/cognition/TaskWorkspace.js';
import { captureWorldObservation, diffWorldFrames } from '../../minebot/cognition/worldFrame.js';
import { formatCriticFeedback } from '../../minebot/cognition/JevExecutionCritic.js';
import { ExecutionSupervisor } from '../../minebot/cognition/ExecutionSupervisor.js';
import { withActionSignal } from '../../minebot/execution/ActionExecution.js';
import { skillCategory } from '../../minebot/execution/SkillExecutor.js';
import { backgroundJobs } from '../../minebot/execution/backgroundJobs.js';
import { GoalVerifier, GOAL_CONTRACT_TOOL, validateGoalContract, type GoalContract, type GoalPredicate } from '../../minebot/cognition/GoalVerifier.js';
import { CampaignGoalGraph, type CampaignPlanOperation } from '../../minebot/cognition/CampaignGoalGraph.js';
import { reconcileCampaignReadyActions } from '../../minebot/cognition/CampaignGoalReconciler.js';
import { assertKnownInventoryPredicateItems, assertRevisionPreservesItemPurpose, unknownCampaignFrontierItems } from '../../minebot/cognition/CampaignPredicateValidation.js';
import type {
    ActionKind,
    ActionReceipt,
    CognitiveRuntimeMode,
    ExecutionCritic,
    ReflexDecision,
    TaskWorkspaceSnapshot,
} from '../../minebot/cognition/types.js';
import type { MinecraftTaskCheckpoint } from './types.js';
import type { MinecraftLearningService } from '../../minebot/learning/MinecraftLearningService.js';

const log = createLogger('LLM:ShannonExecutor');

type MessageParam = Anthropic.MessageParam;
type Tool = Anthropic.Tool;
type ToolResultBlockParam = Anthropic.ToolResultBlockParam;
type ProviderTerminalError = AnthropicCacheEvidenceError | AnthropicPlannerRefusalError;

// ─── 型定義 ───

export interface ShannonExecutorDeps {
    /** Frozen selection from the original authenticated companion request. */
    primaryModel?: CompanionPrimaryModel;
    /** Explicit injection for isolated planner evals; never load shared credentials there. */
    modelClient?: Pick<Anthropic, 'messages'>;
    /** Actual identity of an injected transport, for request/log attribution. */
    modelIdentity?: { provider: string; model: string };
    /** Isolated tests replace the UI transport without changing production behavior. */
    publishTaskTree?: (tree: TaskTreeState) => void;
    instantSkills?: InstantSkills;
    routineManager?: RoutineManager;
    routineExecutor?: RoutineExecutor;
    /** Minecraft bot 参照 (SubAgentRoutineExecutor に渡す) */
    bot?: import('../../minebot/types/CustomBot.js').CustomBot;
    /** LLM ツール (recall-*, save-*, task-complete, etc.) */
    llmTools?: Map<string, (input: Record<string, unknown>) => Promise<string>>;
    /** World-scoped previous task notes. Process-global last-task is not used. */
    continuation?: MinecraftTaskContinuation;
    /** Fast independent evaluator. Disabled by default at configuration level. */
    executionCritic?: ExecutionCritic;
    criticMode?: CognitiveRuntimeMode;
    /** Direct bounded execution controls require a separate rollout opt-in. */
    executionSupervisionMode?: CognitiveRuntimeMode;
    /** Explicit, world-bound long campaign. Normal short tasks keep the legacy tree. */
    campaign?: CampaignGoalGraph;
    /** Experience recording and learned knowledge (dev isolated labs only, off unless injected). */
    learning?: MinecraftLearningService;
    /**
     * Answering a person who spoke to the bot. A turn that set no goal contract promised nothing in the world,
     * so it completes without native proof; physical work still needs a contract first, and is verified.
     */
    conversation?: boolean;
}

export interface ShannonExecutorState {
    runId: string;
    goal: string;
    context: TaskContext | null;
    systemPrompt: string;
    tools: Tool[];
    /** Minecraft: スキル実行中フラグ管理用 */
    onToolStarting?: (toolName: string, args?: Record<string, unknown>) => void;
    /** Run-owned diagnostics; callers decide whether/how to retain arguments. */
    onToolFinished?: (event: { iteration: number; tool: string; args: Record<string, unknown>; durationMs: number;
        success: boolean | null; result: string; moreInResponse?: boolean }) => void;
    onTaskTreeUpdate?: (taskTree: TaskTreeState) => void;
    onCheckpoint?: (checkpoint: MinecraftTaskCheckpoint) => void;
    abortSignal?: AbortSignal;
    /** envelope のタグ (emergency 等) */
    tags?: string[];
    /** タスク実行中のユーザーフィードバックを取得するコールバック */
    getHumanFeedback?: () => string | null;
    /** MAX_ITERATIONS 到達後の再開時に前回の会話履歴を注入する */
    previousMessages?: MessageParam[];
    /** 再開時に前回のタスクツリーを引き継ぐ */
    previousTaskNodes?: TaskNode[];
    /** Persisted run-scoped cognition state for MAX_ITERATIONS continuation. */
    previousWorkspaceSnapshot?: TaskWorkspaceSnapshot;
    /** Emergency reflex recommendation produced before System 2 starts. */
    initialReflexDecision?: ReflexDecision;
    /** Test/caller supplied contracts take precedence over model-proposed contracts. */
    goalContract?: GoalContract;
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
    recoveryStatus?: 'awaiting_user' | 'failed_terminal';
    /** Closed native refusal or usage/cache evidence failure; never an automatic continuation. */
    providerEvidenceFailure?: ProviderTerminalError['code'];
    /** LLM管理型タスクツリーのノード（再開時に引き継ぐ） */
    taskNodes?: TaskNode[];
    /** Append-only world/action/critic state for observability and continuation. */
    cognitiveWorkspace: TaskWorkspaceSnapshot;
}

// ─── 定数 ───

const MODEL_SONNET = process.env.SHANNON_MODEL || config.anthropic.model;
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

// ─── メイン ───

// ─── manage-task-tree ツール定義 ───

const MANAGE_TASK_TREE_TOOL: Tool = {
    name: 'manage-task-tree',
    description: 'タスクの計画・進捗を管理する。タスク開始時に計画を立て、進捗があれば更新する。他のスキル（move-to等）と同じレスポンスで同時に呼べる。',
    input_schema: {
        type: 'object' as const,
        properties: {
            activeNodeId: { type: ['string', 'null'], description: '次の身体操作のready node ID。completedにするIDを同時にactiveにしない。nullは選択解除。省略時は完了/削除されたactiveを自動解除する。' },
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
                        requires: { type: 'array', items: { type: 'string' }, description: '先に完了が検証されている必要のあるノードID。依存先は先に作成する。' },
                        postconditions: GOAL_CONTRACT_TOOL.input_schema.properties.predicates,
                    },
                    required: ['action', 'id'],
                },
            },
        },
        required: ['operations'],
    },
};

const MANAGE_CAMPAIGN_GOALS_TOOL: Tool = {
    name: 'manage-campaign-goals',
    description: '長期キャンペーンの枝を追加・切替する。結果は永続化される。verifiedはモデルから設定できない。inventory/producedのitemは実在する正確なMinecraft item IDにする。food等のカテゴリ名は不可。採掘対象ブロックと実ドロップ名は異なる場合があるためnative結果を照合する。joinはそのノード自身の子ノード群の集約条件で、all=全子必須、any=いずれかの子でよい。methodは子を段階的に追加でき、子が1つ以上揃ってもseal-methodで子集合の計画完了を明示するまでverifiedにならない。seal-method/unseal-methodには理由と最新projectionのexpectedRevisionが必要。sealedで未検証のmethodへ子を足すには先にunseal-methodする。子関係は前提順序ではない。道具製作など先行必須ならdependsOnを明示する。現在所持のinventory条件は死亡・持ち物喪失後にnative再照合される。観測で未検証ノードの事後条件や子の集約条件が誤りと判明したらreviseで理由付き訂正する。reviseは元のgoalの意味を保つ。同じ目標でない出力（食料確保を木材所持へ等）にすり替えず、新しい別ノードを作る。子がある親のreviseには最新projectionのexpectedRevisionを指定する。検証済み子孫がいる未検証親はpostconditionsのみ訂正可（join変更不可）。根・検証済み・対象枝の物理行動実行中は訂正不可。代替手段は新たなmethod枝として追加する。身体操作前に未完了のactiveNodeIdを指定する。選択先はpending/activeでdependsOnの全ノードがverifiedでなければならず、blocked/abandonedにするノードや検証済みのノードをactiveNodeIdに書いた場合、操作は反映され選択だけが無視される（結果のnoteを読んで次を選ぶ）。action葉が望ましいが、開いているmethod/outcomeを作業文脈にもできる。新規作成と選択は原子的。完了枝をpendingに戻す要求は無視されるので、次の枝を選ぶ。この更新と、その下で行う行動は、同じ応答に並べて呼べる（書いた順に実行され、更新が却下されたら後ろの行動は実行されない）。更新だけの応答を挟む必要はない。',
    input_schema: { type: 'object' as const, properties: {
        activeNodeId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 0, description: '親ノードのreviseには必須。直近の永続キャンペーンprojection.revisionを指定し、古い観測からの訂正を防ぐ' },
        operations: { type: 'array', maxItems: 64, items: { type: 'object', properties: {
            action: { type: 'string', enum: ['create', 'revise', 'seal-method', 'unseal-method', 'set-state'] }, id: { type: 'string' }, parentId: { type: 'string' },
            goal: { type: 'string' }, kind: { type: 'string', enum: ['outcome', 'method', 'action'] },
            join: { type: 'string', enum: ['all', 'any'], description: 'このノードの子群への条件。allは全ての子、anyはいずれかの子' }, dependsOn: { type: 'array', items: { type: 'string' } },
            postconditions: GOAL_CONTRACT_TOOL.input_schema.properties.predicates,
            state: { type: 'string', enum: ['pending', 'active', 'blocked', 'abandoned'] }, blocker: { type: 'string' },
            reason: { type: 'string', minLength: 1, maxLength: 500, description: 'reviseは同じgoalの訂正根拠、seal-methodは子群の計画完了理由、unseal-methodは追加分解の理由を書く' },
        }, required: ['action', 'id'] } },
    }, required: ['operations'] },
};

const INSPECT_CAMPAIGN_GOALS_TOOL: Tool = {
    name: 'inspect-campaign-goals',
    description: '現在の枝または指定ノードの子をページ単位で読み取る。全キャンペーンを一度にプロンプトへ展開しない。',
    input_schema: { type: 'object' as const, properties: {
        nodeId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 32 },
    }, required: ['nodeId'] },
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
    requires?: string[];
    postconditions?: GoalPredicate[];
}

type VerifiedTaskNode = TaskNode & { requires?: string[]; postconditions?: GoalPredicate[]; verification?: ReturnType<GoalVerifier['verify']> };

export class TaskTreeValidationError extends Error {
    constructor(code: string, readonly diagnostic: Record<string, unknown>) { super(code); }
}

/** Project observed evidence into the plan, never model prose or parent status.
 * Completed prerequisites retain historical proof after their materials are used.
 * A parent without its own predicates remains unknown, even if children finish.
 */
export function reconcileTaskNodes(nodes: TaskNode[], verifier: GoalVerifier): string[] {
    const completed: string[] = [];
    const visit = (node: VerifiedTaskNode) => {
        for (const child of node.children ?? []) visit(child);
        if (node.status === 'completed' || !node.postconditions?.length
            || node.children?.some(child => child.status !== 'completed')
            || (node.requires ?? []).some(id => {
                const dependency = findNodeById(nodes, id) as VerifiedTaskNode | null;
                return dependency?.status !== 'completed' || dependency.verification?.status !== 'verified';
            })) return;
        const proof = verifier.verify({ goal: node.goal, predicates: node.postconditions });
        if (proof.status === 'verified') {
            node.verification = proof; node.status = 'completed'; node.blockedBy = null;
            completed.push(node.id);
        }
    };
    // Dependency order may differ from tree order; repeat until no new proof.
    let count: number;
    do { count = completed.length; for (const node of nodes) visit(node); } while (count !== completed.length);
    return completed;
}

export function selectActiveTaskNode(nodes: TaskNode[], requested: unknown, previous?: string): string | undefined {
    const ready = readyGoalNodes(nodes);
    if (requested === null) return undefined;
    if (requested === undefined) return previous && ready.includes(previous) ? previous : undefined;
    if (typeof requested !== 'string' || !ready.includes(requested)) throw new TaskTreeValidationError('TASK_ACTIVE_NODE_NOT_READY', {
        nodeId: requested, readyNodeIds: ready, nodeStatus: typeof requested === 'string' ? findNodeById(nodes, requested)?.status : null,
        remedy: 'Do not select the node you just completed. Select a ready next node, omit activeNodeId, or set it to null.',
    });
    return requested;
}

export function readyGoalNodes(nodes: TaskNode[]): string[] {
    const ready: string[] = [];
    const visit = (node: VerifiedTaskNode) => {
        if (['pending', 'in_progress', 'error'].includes(node.status)
            && !node.children?.some(child => child.status !== 'completed')
            && (node.requires ?? []).every(id => (findNodeById(nodes, id) as VerifiedTaskNode | null)?.verification?.status === 'verified')) ready.push(node.id);
        for (const child of node.children ?? []) visit(child);
    };
    for (const node of nodes) visit(node);
    return ready;
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

const taskNodeIds = new WeakMap<TaskNode[], Set<string>>();
export function applyTaskTreeOperations(target: TaskNode[], operations: TaskTreeOperation[], verifier?: GoalVerifier,
    previousIds?: ReadonlySet<string>): { nodes: TaskNode[]; summary: string; usedNodeIds: string[] } {
    // Atomic batch: a malformed graph cannot leave partial edits behind.
    const nodes = structuredClone(target);
    const usedIds = new Set(previousIds ?? taskNodeIds.get(target));
    const existingIds = new Set<string>();
    const index = (ns: TaskNode[]) => { for (const node of ns) {
        if (existingIds.has(node.id)) throw new Error(`TASK_NODE_DUPLICATE:${node.id}`);
        existingIds.add(node.id); usedIds.add(node.id); index(node.children ?? []);
    } };
    index(nodes);
    let created = 0, updated = 0, deleted = 0;

    for (const op of operations) {
        if (!op.id?.trim() || !['create', 'update', 'delete'].includes(op.action)) throw new Error('TASK_NODE_INVALID');
        if (op.status !== undefined && !['pending', 'in_progress', 'completed', 'error'].includes(op.status)) throw new Error('TASK_STATUS_INVALID');
        if (op.action === 'create' && findNodeById(nodes, op.id)) throw new Error(`TASK_NODE_DUPLICATE:${op.id}`);
        if (op.action === 'create' && usedIds.has(op.id)) throw new Error(`TASK_NODE_ID_RETIRED:${op.id}`);
        if (op.action === 'create' && op.parentId && !findNodeById(nodes, op.parentId)) throw new Error(`TASK_PARENT_UNKNOWN:${op.parentId}`);
        if (op.action !== 'create' && !findNodeById(nodes, op.id)) throw new Error(`TASK_NODE_UNKNOWN:${op.id}`);
        if (op.action === 'create') {
            if (usedIds.size >= 4096) throw new Error('TASK_NODE_HISTORY_LIMIT');
            usedIds.add(op.id);
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
                if (verifier && node.status === 'completed' && op.goal !== undefined && op.goal !== node.goal) throw new Error('TASK_VERIFIED_GOAL_IMMUTABLE');
                if (op.goal !== undefined) node.goal = op.goal;
                if (op.status !== undefined) node.status = op.status as TaskNode['status'];
                if (op.progress !== undefined) node.progress = op.progress || null;
                if (op.blockedBy !== undefined) node.blockedBy = op.blockedBy || null;
                updated++;
            }
        } else if (op.action === 'delete') {
            if (removeNodeById(nodes, op.id)) deleted++;
        }
        const node = findNodeById(nodes, op.id) as VerifiedTaskNode | null;
        if (node) {
            if (op.requires) node.requires = [...new Set(op.requires)];
            if (op.postconditions) node.postconditions = validateGoalContract({ goal: node.goal, predicates: op.postconditions }, node.goal).predicates;
            if (node.status === 'in_progress' || node.status === 'completed') {
                for (const id of node.requires ?? []) {
                    const dependency = findNodeById(nodes, id) as VerifiedTaskNode | null;
                    if (dependency?.status !== 'completed' || verifier && dependency.verification?.status !== 'verified') throw new Error(`TASK_DEPENDENCY_UNVERIFIED:${id}`);
                }
            }
            if (node.status === 'completed' && verifier && (!node.verification || op.status === 'completed' || op.postconditions !== undefined)) {
                if (node.children?.some(child => child.status !== 'completed')) throw new Error('TASK_CHILDREN_UNVERIFIED');
                node.verification = verifier.verify(node.postconditions ? { goal: node.goal, predicates: node.postconditions } : undefined);
                if (node.verification.status !== 'verified') throw new TaskTreeValidationError(`TASK_COMPLETION_${node.verification.status.toUpperCase()}`, {
                    nodeId: node.id, missingPredicates: !node.postconditions?.length, proof: node.verification,
                    readyNodeIds: readyGoalNodes(nodes), remedy: 'Supply this node\'s actual postconditions. Do not weaken the main contract. A parent also needs its own conditions.',
                });
            }
        }
    }

    const visited = new Set<string>(); const visiting = new Set<string>();
    const check = (node: VerifiedTaskNode): void => {
        if (visiting.has(node.id)) throw new Error(`TASK_DEPENDENCY_CYCLE:${node.id}`);
        if (visited.has(node.id)) return;
        visiting.add(node.id);
        for (const id of node.requires ?? []) { const dependency = findNodeById(nodes, id); if (!dependency) throw new Error(`TASK_DEPENDENCY_UNKNOWN:${id}`); check(dependency); }
        // Parent completion depends on its children, so cross-boundary cycles count too.
        for (const child of node.children ?? []) check(child);
        visiting.delete(node.id); visited.add(node.id);
    };
    for (const node of nodes) check(node);
    target.splice(0, target.length, ...nodes);
    taskNodeIds.set(target, usedIds);

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
    return { nodes, summary, usedNodeIds: [...usedIds] };
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

function actionKindFor(
    toolName: string,
    deps: ShannonExecutorDeps,
): { kind: ActionKind; meaningfulWorldAction: boolean } {
    if (toolName === 'manage-task-tree' || toolName === 'manage-campaign-goals' || toolName === 'inspect-campaign-goals'
        || toolName === 'set-goal-contract' || toolName === 'task-complete' || toolName === 'search-skills') {
        return { kind: 'meta_tool', meaningfulWorldAction: false };
    }
    if (toolName.startsWith('routine-')) return { kind: 'routine', meaningfulWorldAction: true };
    if (deps.instantSkills?.getSkill(toolName)) return { kind: 'instant_skill', meaningfulWorldAction: skillCategory(toolName) !== 'query' };
    return { kind: 'agent_tool', meaningfulWorldAction: false };
}

/**
 * Legacy planners attach the current observation to a cloned latest result.
 * Native Haiku instead persists a separate text block on the unsent user tail:
 * signed thinking binds every earlier message, including its old observation.
 * The tail remains an observation for the same task, not a new goal (separate
 * user turns once caused duplicate goal nodes in paid runs L22 and L23).
 */
/**
 * The facts of an observation as the planner is shown them: where each came from and whether it is known. Their
 * values are the observation's own fields; sent again under `facts`, the whole pack went to the planner twice on
 * every call.
 */
export function factSources(facts: Record<string, { source?: string; coverage?: string }> | undefined): Record<string, { source?: string; coverage?: string }> | undefined {
    if (!facts) return undefined;
    return Object.fromEntries(Object.entries(facts).map(([name, fact]) => [name, { source: fact?.source, coverage: fact?.coverage }]));
}

const roundVector = (value: any) => value && typeof value.x === 'number'
    ? { x: Math.round(value.x * 10) / 10, y: Math.round(value.y * 10) / 10, z: Math.round(value.z * 10) / 10 } : value;

/**
 * An observation as it is written into the note the planner gets on every call, at the full price each time (more
 * than half of a paid run's planner bill, L88). Nothing it decides by is left out: positions to a tenth of a block
 * (they came with fifteen digits), each hostile once (under the threats, not also among the entities), the facts by
 * their source (see factSources), and no time stamp.
 */
export function observationForPrompt(world: any): any {
    const threats: any[] | undefined = world?.nearbyThreats;
    const place = (entity: any) => ({ ...entity, position: roundVector(entity.position) });
    return {
        ...world, revision: undefined, observedAt: undefined, facts: factSources(world?.facts),
        position: roundVector(world?.position),
        nearbyEntities: (world?.nearbyEntities ?? []).filter((entity: any) => !threats || entity.kind !== 'hostile').map(place),
        ...(threats ? { nearbyThreats: threats.map(place) } : {}),
        ...(Array.isArray(world?.landmarks) ? { landmarks: world.landmarks.map(place) } : {}),
    };
}

/**
 * The lessons for the situation, split between the conversation and the per-call note. A lesson's text is written
 * into the conversation the first time it applies in a run, where it is cached from the next call on; the note
 * re-sent at the full price every call names only which lessons apply now. Sent whole in the note, they were about a
 * third of what every call paid full price for (paid run L97: some 1,700 characters of the note, each call). A lesson
 * that comes and goes as the situation does is written once. Returns the part for the note.
 */
export function knowledgeIntoHistory(messages: Anthropic.MessageParam[], section: string, written: Set<string>): string {
    const lines = section.split('\n');
    const items = lines.map(line => ({ line, id: line.match(/^- \[([^\]]+)\]/)?.[1] })).filter((entry): entry is { line: string; id: string } => !!entry.id);
    const last = messages[messages.length - 1];
    if (!items.length || last?.role !== 'user') return `\n\n${section}`;
    const fresh = items.filter(entry => !written.has(entry.id));
    if (fresh.length) {
        const header = lines.filter(line => !line.startsWith('- [')).join('\n').trim();
        const text = `${header}\n${fresh.map(entry => entry.line).join('\n')}`;
        const blocks: any[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content];
        messages[messages.length - 1] = { role: 'user', content: [...blocks, { type: 'text', text }] };
        for (const entry of fresh) written.add(entry.id);
    }
    return `\n\n## いま当てはまる経験の知識: ${items.map(entry => entry.id).join(', ')}（本文はこの会話の中で示したもの。最新のnative観測と矛盾する時は観測を優先する）`;
}

export function withLiveState(messages: Anthropic.MessageParam[], liveState: string): Anthropic.MessageParam[] {
    const last = messages[messages.length - 1];
    if (!liveState.trim() || last?.role !== 'user') return messages;
    const note = `\n\n## 現在の状態（この時点の実測。これまでの結果より新しい）${liveState}`;
    const blocks: any[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content];
    let index = -1;
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].type === 'tool_result' || blocks[i].type === 'text') { index = i; break; }
    if (index < 0) return [...messages.slice(0, -1), { role: 'user', content: [...blocks, { type: 'text', text: note.trimStart() }] }];
    const block = blocks[index];
    if (block.type === 'text') blocks[index] = { ...block, text: `${block.text}${note}` };
    else if (typeof block.content === 'string' || block.content === undefined) blocks[index] = { ...block, content: `${block.content ?? ''}${note}` };
    else blocks[index] = { ...block, content: [...block.content, { type: 'text', text: note.trimStart() }] };
    return [...messages.slice(0, -1), { role: 'user', content: blocks }];
}

export class ShannonExecutor {
    private client: Pick<Anthropic, 'messages'>;
    private readonly configuredModel?: string;
    private auxiliaryClient!: Pick<Anthropic, 'messages'>;
    private auxiliaryModel?: string;

    constructor(private deps: ShannonExecutorDeps) {
        if (this.deps.modelClient) {
            this.client = this.deps.modelClient;
        } else if (this.deps.primaryModel) {
            const planners = createPinnedMinecraftPlanners(config, this.deps.primaryModel);
            this.client = planners.primary.client;
            this.configuredModel = planners.primary.model;
            this.auxiliaryClient = planners.auxiliary.client;
            this.auxiliaryModel = planners.auxiliary.model;
        } else {
            const planner = createConfiguredMinecraftPlanner(config);
            this.client = planner.client;
            this.configuredModel = planner.model;
        }
        this.auxiliaryClient ??= this.client;
        this.auxiliaryModel ??= this.configuredModel;
    }

    async run(state: ShannonExecutorState): Promise<ShannonExecutorResult> {
        const evidenceStop = new AbortController();
        let providerEvidenceFailure: ProviderTerminalError | undefined;
        const holdEvidence = (error: unknown): boolean => {
            if (!isAnthropicPlannerTerminalError(error)) return false;
            providerEvidenceFailure ??= error;
            evidenceStop.abort(error);
            return true;
        };
        state = { ...state, abortSignal: state.abortSignal
            ? AbortSignal.any([state.abortSignal, evidenceStop.signal]) : evidenceStop.signal };
        holdEvidence(state.abortSignal?.reason);
        const startTime = Date.now();
        const model = this.deps.modelIdentity?.model ?? this.configuredModel
          ?? (isLightweightTask(state.goal, state.tags) ? MODEL_HAIKU : MODEL_SONNET);
        const native = isNativeMinecraftModel(model);
        // The API binds signed thinking to system, tools and all earlier messages.
        // Snapshot the session inputs before any parallel request can yield.
        const baseSystemPrompt = native ? state.systemPrompt : undefined;
        const terminalStopReason = () => providerEvidenceFailure?.code === 'MINECRAFT_PLANNER_REFUSED'
          ? 'provider_refused' : 'provider_evidence_invalid';
        let messages: MessageParam[];

        const workspace = new TaskWorkspace({
            runId: state.previousWorkspaceSnapshot?.runId ?? state.runId,
            goal: state.goal,
            initialSnapshot: state.previousWorkspaceSnapshot,
        });
        const criticMode = this.deps.criticMode ?? 'off';
        const supervisionMode = this.deps.executionSupervisionMode ?? (criticMode === 'off' ? 'off' : 'shadow');
        const initialObservation = captureWorldObservation(this.deps.bot);
        const previous = state.previousWorkspaceSnapshot;
        const verifier = this.deps.bot ? new GoalVerifier(this.deps.bot, previous?.goalBaseline ?? initialObservation,
          previous?.goalContract && previous?.goalProof ? { contract: previous.goalContract, proof: previous.goalProof } : undefined) : undefined;
        const campaign = this.deps.campaign;
        if (campaign && (campaign.goal !== state.goal || !verifier || !state.goalContract
          || JSON.stringify(campaign.getNode('root')?.postconditions) !== JSON.stringify(state.goalContract.predicates)))
          throw new Error('CAMPAIGN_CONTEXT_OR_SUCCESS_MISMATCH');
        if (campaign) for (const action of campaign.getUncertainActions())
          campaign.finishAction(action.actionId, null, '再開時に状態を再観測。前回操作の成否は不明であり自動再実行しない');
        if (campaign) {
            const invalidated = campaign.reconcileCurrentInventory(initialObservation);
            if (invalidated.length) log.warn(`Campaign current-inventory proof invalidated after native loss observation: ${invalidated.join(', ')}`);
        }
        const sessionTools = native ? structuredClone([...(state.tools ?? []),
          ...(campaign ? [MANAGE_CAMPAIGN_GOALS_TOOL, INSPECT_CAMPAIGN_GOALS_TOOL] : [MANAGE_TASK_TREE_TOOL]),
          ...(verifier && !campaign ? [GOAL_CONTRACT_TOOL as Tool] : [])]) : undefined;
        let goalContract = state.goalContract ?? state.previousWorkspaceSnapshot?.goalContract;
        if (goalContract) {
            assertKnownInventoryPredicateItems(goalContract.predicates, this.deps.bot?.registry);
            goalContract = validateGoalContract(goalContract, state.goal);
            workspace.recordGoal(goalContract, initialObservation);
        }
        if (this.deps.bot) workspace.observeWorld(initialObservation);
        if (state.initialReflexDecision) workspace.recordReflexDecision(state.initialReflexDecision);

        const isResume = state.previousMessages && state.previousMessages.length > 0;

        // LLM管理型タスクツリー
        const taskNodes: TaskNode[] = state.previousTaskNodes ? JSON.parse(JSON.stringify(state.previousTaskNodes)) : [];
        let usedNodeIds = new Set(state.previousWorkspaceSnapshot?.usedTaskNodeIds ?? []);
        let activeSubtaskId = state.previousWorkspaceSnapshot?.activeSubtaskId;
        let campaignActiveId = campaign?.getActiveId();
        // When the node being worked under is finished or closed, the work goes on under the nearest goal
        // above it that is still open (the tool already allows an open method/outcome as the context).
        // Dropping to "nothing selected" made the very next action fail with CAMPAIGN_ACTIVE_NODE_REQUIRED
        // (equipping the shield just crafted, L37) and cost a bookkeeping call after every finished leaf.
        const openContextFrom = (id: string | undefined): string | undefined => {
            if (!campaign) return undefined;
            let node = id ? campaign.getNode(id) : undefined;
            while (node) {
                if (campaign.isActionable(node.id)) return node.id;
                node = node.parentId ? campaign.getNode(node.parentId) : undefined;
            }
            return campaign.getActiveId();
        };
        const refreshCampaignFrontier = () => {
            if (!campaign || !verifier) return;
            const verified = reconcileCampaignReadyActions(campaign, verifier);
            if (verified.length) log.info(`Campaign native frontier verified: ${verified.join(', ')}`, 'cyan');
            if (campaignActiveId && !campaign.isActionable(campaignActiveId)) campaignActiveId = openContextFrom(campaignActiveId);
        };
        refreshCampaignFrontier();
        if (taskNodes.length > 0 && !campaign) workspace.projectPlan(taskNodes);

        let taskTree: TaskTreeState | null = null;

        // ── 表示用タスク名の非同期要約（メイン処理をブロックしない） ──
        let displayGoal = state.goal;
        let titleWork: Promise<void> | null = null;
        if (!isResume && state.goal.length > 20 && !state.abortSignal?.aborted) {
            titleWork = this.summarizeGoal(state.goal, state.abortSignal).then(summary => {
                if (state.abortSignal?.aborted) return;
                displayGoal = summary;
                log.info(`📝 タスク名要約: "${summary}"`, 'green');
                if (taskTree) {
                    taskTree = { ...taskTree, goal: displayGoal };
                    state.onTaskTreeUpdate?.(taskTree);
                    this.postTaskTreeToUiMod(taskTree);
                }
            }).catch(e => {
                holdEvidence(e);
                log.warn(`⚠ タスク名要約失敗 (元テキストを使用): ${e instanceof Error ? e.message : e}`);
            });
        }

        if (isResume) {
            // MAX_ITERATIONS 到達後の再開: LLM で会話履歴を要約して圧縮
            const prev = state.previousMessages!;
            log.info(`♻️ ShannonExecutor: 前回の会話 (${prev.length} messages) → LLM要約して再開`, 'cyan');
            let summary = '';
            try { summary = await this.summarizeWithLLM(prev, state.goal, state.abortSignal); }
            catch (error) { if (!holdEvidence(error)) throw error; }
            if (providerEvidenceFailure || state.abortSignal?.aborted) messages = prev;
            else {
                // タスクツリーがあれば構造化コンテキストとしても渡す
                const treeContext = campaign ? `\n\n【キャンペーンの現在地】\n${JSON.stringify(campaign.projection(campaignActiveId))}` : taskNodes.length > 0
                    ? `\n\n【タスクツリー（前半の計画と進捗）】\n${taskNodesToText(taskNodes)}`
                    : '';

                messages = [
                    { role: 'user', content: `【前半の実行ログ（要約）】\nゴール: ${state.goal}\n\n${summary}${treeContext}` },
                    { role: 'assistant', content: 'ここまでの経緯とタスクツリーを把握しました。続きを実行します。' },
                    { role: 'user', content: `【続行指示】${state.goal}\n上の要約とタスクツリーは前半の実行履歴です。タスクツリーを更新しながら未完了の作業を引き継いでください。同じ失敗を繰り返さないこと。` },
                ];
            }
        } else {
            messages = [];
            // 前タスクのコンテキストを引き継ぐ
            if (this.deps.continuation?.lastSummary && this.deps.continuation.lastGoal) {
                messages.push({
                    role: 'user',
                    content: `【前のタスクの結果】\nゴール: ${this.deps.continuation.lastGoal}\n結果: ${this.deps.continuation.lastSummary}\n\n---\n以下が新しいタスクです:`,
                });
                messages.push({ role: 'assistant', content: 'はい、前のタスクの結果を踏まえて新しいタスクに取り組みます。' });
            }
            messages.push({ role: 'user', content: state.goal });
        }

        const emitCheckpoint = () => {
            if (!state.onCheckpoint) return;
            try {
                state.onCheckpoint({ messages: structuredClone(messages), taskNodes: structuredClone(taskNodes),
                    cognitiveWorkspace: workspace.snapshot() });
            } catch (error) {
                log.warn(`Minecraft continuation checkpoint failed: ${String(error)}`);
            }
        };

        let lastContent: string | null = null;
        let taskCompleted = false;
        let consecutiveTextOnly = 0;
        let totalToolCalls = 0;
        let iterations = 0;
        // The lessons whose text has already been written into this run's conversation (see knowledgeIntoHistory).
        const knowledgeWritten = new Set<string>();
        let stopReason = 'iteration_limit';
        let sentMessageCount = 0;
        const thinkingLog: string[] = [];
        let treeReminderSent = false;
        let pendingShadowAssessment: Promise<void> | null = null;
        const activeSupervisors: ExecutionSupervisor[] = [];

        // 明示モデルは全タスク共通。未指定なら従来の軽量/通常選択を保つ。
        log.info(`▶ ShannonExecutor: "${state.goal.slice(0, 60)}..." (model=${model}, taskTreeCb=${!!state.onTaskTreeUpdate})`, 'cyan');

        const recentLearningTools: string[] = [];
        for (let iter = 0; iter < MAX_ITERATIONS && !taskCompleted; iter++) {
            if (providerEvidenceFailure) { stopReason = terminalStopReason(); break; }
            if (state.abortSignal?.aborted) {
                log.warn('⚠ ShannonExecutor aborted');
                break;
            }
            iterations = iter + 1;
            refreshCampaignFrontier();

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
            if (!campaign && !treeReminderSent && taskNodes.length === 0 && iter === 1 && !isResume) {
                treeReminderSent = true;
                messages.push({
                    role: 'user',
                    content: 'タスクツリーが未作成です。manage-task-tree で計画を立ててください（他のスキルと同時に呼べます）。',
                });
            }

            // システムプロンプトにタスクツリーを動的注入
            let systemPromptWithTree = baseSystemPrompt ?? state.systemPrompt;
            if (verifier) systemPromptWithTree += campaign
              ? '\n\n長期キャンペーンはmanage-campaign-goalsで必要な枝だけ分解し、inspect-campaign-goalsで詳細を検索する。joinは親ノード自身の子群に作用し、all=全子必須、any=子のどれか一つ。methodはデフォルトで展開中。必要な子枝を計画し終えた時だけ理由と最新expectedRevisionを付けてseal-methodし、追加が必要なら未検証のうちにunseal-methodしてから子を足す。子なしmethodや未seal methodは条件が成立しても完了しない。身体操作前に未完了のactiveNodeIdを選ぶ。action葉が望ましいが、method/outcomeも作業文脈にできる。観測と未検証ノードの事後条件・joinが食い違う場合はreasonを付けてreviseする。reviseではgoalの意味を保ち、食料目標を木材所持など無関係な条件へ変えない。別の出力は別ノードで表現する。子を持つ親のreviseは最新projectionのexpectedRevisionが必須。検証済み子孫がいる親ではpostconditionsだけを訂正しjoinを変えない。完成条件を根拠なく弱めず、既存子孫を消さない。完成済みノードをpendingに戻さず、次の枝を選ぶ。モデルはverifiedを設定できず、native証拠が完了を決める。blockedなら原因を記録して代替methodを提案する。大きなmethod/outcomeは子証拠と自分のnative条件を満たして初めて完成する。全木を一度に展開しない。資源検索の候補は高低差と経路可能性を確認する。地表で対象なし、または全候補が地下深部なら、同地点の再検索や成長待ちを繰り返さず、新しい地表地点へ移動して再探索する。必要アイテム不足で失敗したスキルは入手まで同じ引数で再実行しない。設備を要求するレシピでも、手持ちに設備がないだけで新造せず、既設設備を探して利用する。craft-oneは近傍の作業台を探索できる。遠方・大きな高低差のある既設設備への移動が失敗したら、同じ経路を再試行する前に障害を実測し、所持資源から近くに同じ設備を作る代替案をレシピと所持数で比較する。移動・階段・採掘の成功申告だけで位置や資材の達成を推定せず、返された実座標と所持品を照合する。'
              : '\n\nMinecraft完了は世界の証拠で検証する。task-completeは検証要求であって無条件完了ではない。条件を満たさない/不明なら観測・計画を続ける。親を含む各ノードにpostconditionsを設定し、依存をrequiresで示す。証拠が揃ったノードはnative側がcompletedへ反映する。完了したノードをactiveにしない。既知の事実を繰り返し観測せず、独立した観測や計画作成は同じ応答にまとめる。身体操作は返された結果を確認して進める。';
            if (verifier && native) systemPromptWithTree += '\n完了条件が未設定なら、作業開始前にset-goal-contractでユーザー原文に対応する完了条件を設定する。設定済みの主契約は変更不可で、再設定しない。主目標rootにも同じpostconditionsを設定し、単一作業ならroot 1つで十分。position/block/defeated条件にはdimensionが必須。途中で素材を消費する目標は現在所持と歴史的達成を区別する。現在の契約は最新の状態メッセージに示す。';
            if (!native && verifier && !goalContract) systemPromptWithTree += '\n作業開始前にset-goal-contractでユーザー原文に対応する完了条件を設定する。';
            if (!native && goalContract) systemPromptWithTree += campaign
              ? '\n完了条件は設定済み。rootの契約は変更不可。途中で素材を消費する目標は、現在所持と歴史的達成を区別する。'
              : '\n完了条件は設定済み。set-goal-contractを再度呼ぶ必要はない。主目標のroot nodeにも、この契約と同じpostconditionsを設定する。単一作業ならroot 1つで十分。position/block/defeated条件にはdimensionが必須。';
            if (!native && goalContract) systemPromptWithTree += `\n\n変更不可の完了条件: ${JSON.stringify(goalContract)}`;
            if (campaign) systemPromptWithTree += '\nサバイバルでは現在時刻・空腹・体力・敵の密度を長時間作業や地表への遠征前に見積もる。危険なら目的ツリーに安全確保・食料・装備などの依存作業を追加し、状況に応じて安全な場所で進める。既に必要量を満たした資源は追加採取を目的化せず、次の依存工程へ進む。準備の数量を満たすために長期目標の道具・資源の連鎖を止めない。最新native観測に所持品・体力・位置・時刻があるので、同じ事実をcheck-inventory-itemやget-bot-statusで再確認しない。キャンペーン操作とそれに続く身体操作は同じ応答で順に呼べる。固定手順ではなく最新のnative観測に基づいて判断する。';
            // Everything from here on changes with every call. The planner model's
            // prompt cache matches whole blocks from the start: one changed
            // character in the system prompt made every call pay full price for
            // ~16k input tokens (measured: cache written each time, never read).
            // The system prompt stays fixed and the live state goes last.
            let liveState = native && goalContract ? `\n\n変更不可の完了条件（設定済み）: ${JSON.stringify(goalContract)}` : '';
            if (campaign) {
                const projection = campaign.projection(campaignActiveId);
                // The only number that is an expectedRevision. The world observation
                // carried a "revision" of its own, counting observations; a planner
                // sent that one 38 times in eight minutes, one higher each time (paid run L24).
                liveState += `\n\n## 永続キャンペーンの現在地（expectedRevisionに使う版は${projection.revision}）\n${JSON.stringify(projection)}`;
            }
            if (campaign) {
                const invalidItems = unknownCampaignFrontierItems(campaign, this.deps.bot?.registry, campaignActiveId);
                if (invalidItems.length) liveState += `\n既存キャンペーンに実在しないinventory/produced item IDがあります: ${JSON.stringify(invalidItems)}。カテゴリ名を所持品とみなさない。inspectで親子とjoinを確認し、未検証ノードをnative結果に合う正確なitem IDへ理由付きで訂正する。代替経路がANDで束ねられていたら、親ノード自身のjoinをanyへ訂正する。変更不能な枝は代替を計画する。同じ素材探索だけを繰り返さない。`;
            }
            if (taskNodes.length > 0 && !campaign) {
                const treeText = taskNodesToText(taskNodes);
                liveState += `\n\n## 現在のタスクツリー\n${treeText}`;
                if (verifier) liveState += `\n依存・完了証拠を含むGoalGraph: ${JSON.stringify(taskNodes)}\nready_node_ids: ${JSON.stringify(readyGoalNodes(taskNodes))}\n最新の世界と失敗原因から次のノードを選び、manage-task-tree.activeNodeIdを指定する。現在の条件を弱めず、代替経路を計画する。`;
            }
            if (this.deps.bot) {
                const world = workspace.observeWorld(captureWorldObservation(this.deps.bot));
                if (verifier && !campaign) {
                    reconcileTaskNodes(taskNodes, verifier);
                    activeSubtaskId = selectActiveTaskNode(taskNodes, undefined, activeSubtaskId);
                    workspace.setActiveSubtask(activeSubtaskId); workspace.projectPlan(taskNodes);
                    if (goalContract) {
                        const proof = verifier.verify(goalContract); workspace.recordGoalProof(proof);
                        liveState += `\n主契約の現在のnative proof: ${JSON.stringify(proof)}\nverifiedならtask-completeを呼び、同じ成果を重複生産しない。`;
                    }
                }
                liveState += `\n最新native観測（所持品・位置・体力・時間・脅威）: ${JSON.stringify(observationForPrompt(world))}`;
                const jobs = backgroundJobs(this.deps.bot);
                if (jobs.length) liveState += `\n\n## 実行中の外部仕事\n${JSON.stringify(jobs)}\n推定時刻を完了と扱わない。依存せず素材も競合しない準備を選べる。必要な完成品は取り出し後の所持数で確認する。`;
            }
            const learnedKnowledge = this.deps.learning?.promptSection(this.deps.bot, {
                emergency: state.tags?.includes('emergency') ?? false, recentTools: recentLearningTools });
            const beforeKnowledge = liveState.length;
            // Stage each observation/lesson in a new unsent user message. Never
            // rewrite an earlier tool result or a user turn bound by a signature.
            const knowledgeHistory: MessageParam[] = native ? [{ role: 'user', content: [] }] : messages;
            if (learnedKnowledge) liveState += knowledgeIntoHistory(knowledgeHistory, learnedKnowledge, knowledgeWritten);
            const pace = (this.deps.learning as { paceSection?: () => string | null } | undefined)?.paceSection?.();
            if (pace) liveState += `\n\n${pace}`;
            // What the note re-sent in full on every call is made of. It is read at the full price each time (the
            // cache mark sits before it), and in a paid run it was over half of the planner's bill (L88).
            log.debug(`📏 現在の状態の注記: ${liveState.length}字（うち知識${liveState.length - beforeKnowledge}字、観測${liveState.match(/最新native観測[^\n]*/)?.[0].length ?? 0}字）`);

            if (native) {
                const freshKnowledge = knowledgeHistory[0].content as Anthropic.ContentBlockParam[];
                const liveBlocks: Anthropic.ContentBlockParam[] = liveState.trim()
                  ? [{ type: 'text', text: `## 現在の状態（この時点の実測。これまでの結果より新しい）${liveState}` }] : [];
                if (liveBlocks.length || freshKnowledge.length) {
                    const last = messages[messages.length - 1];
                    const blocks = [...liveBlocks, ...freshKnowledge];
                    if (last?.role === 'user' && messages.length > sentMessageCount) {
                        const original = typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : last.content;
                        messages[messages.length - 1] = { role: 'user', content: [...original, ...blocks] };
                    } else messages.push({ role: 'user', content: blocks });
                }
            }
            let response: Anthropic.Message;
            try {
                // Prompt caching: system prompt + tools を cache_control でキャッシュ
                const allTools = sessionTools ?? [...(state.tools ?? []), ...(campaign ? [MANAGE_CAMPAIGN_GOALS_TOOL, INSPECT_CAMPAIGN_GOALS_TOOL] : [MANAGE_TASK_TREE_TOOL]),
                  ...(verifier && !campaign ? [GOAL_CONTRACT_TOOL as Tool] : [])];
                const cachedTools = allTools.length > 0
                    ? allTools.map((t, i) =>
                        i === allTools.length - 1
                            ? { ...t, cache_control: { type: 'ephemeral' as const } }
                            : t,
                      )
                    : [];

                sentMessageCount = messages.length;
                const stream = this.client.messages.stream({
                    model,
                    max_tokens: MAX_TOKENS,
                    system: [
                        { type: 'text' as const, text: systemPromptWithTree, cache_control: { type: 'ephemeral' as const } },
                    ],
                    tools: cachedTools as any,
                    messages: native ? messages : withLiveState(messages, liveState),
                    temperature: 1,
                }, { signal: state.abortSignal });
                response = await stream.finalMessage();
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                log.error(`❌ API error: ${msg}`, e);
                holdEvidence(e);
                stopReason = providerEvidenceFailure ? terminalStopReason() : 'provider_error';
                break;
            }

            if (providerEvidenceFailure) { stopReason = terminalStopReason(); break; }
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
                    stopReason = 'no_tool_progress';
                    break;
                }
                // ツール呼出しを促す
                messages.push({
                    role: 'user',
                    content: 'ツール呼び出しがありません。task-complete で完了するか、次のツールを呼んでください。',
                });
                emitCheckpoint();
                continue;
            }

            consecutiveTextOnly = 0;
            totalToolCalls += toolUseBlocks.length;

            // ── ツール実行 ──
            const toolResults: ToolResultBlockParam[] = [];
            const iterationReceipts: ActionReceipt[] = [];
            const iterationExecutionFeedback: string[] = [];
            let iterationReplanRequested = false;
            // A goal update and the action under it may come in one response. If the update is refused,
            // the action that was written for the updated goal must not run under whatever was active before.
            let goalUpdateRejected = false;
            // Several actions written in one response are a plan made before any of them ran. When one of
            // them fails, the ones after it were planned for a world that did not come about (planks that
            // were not made, a place that was not reached): the planner sees the failure before anything else
            // is done. A planner that batched five crafts watched four of them fail one after another on the
            // first one's missing output (paid run L42).
            let batchFailedAt: string | null = null;

            for (const toolUse of toolUseBlocks) {
                const toolName = toolUse.name;
                const toolInput = toolUse.input as Record<string, unknown>;
                const actionProfile = actionKindFor(toolName, this.deps);
                const actionStartedAt = Date.now();
                const beforeFrame = actionProfile.meaningfulWorldAction
                    ? workspace.observeWorld(captureWorldObservation(this.deps.bot))
                    : null;

                if (!taskCompleted && !iterationReplanRequested && !state.abortSignal?.aborted
                    && !(actionProfile.meaningfulWorldAction && verifier && !goalContract && !state.tags?.includes('emergency'))) state.onToolStarting?.(toolName, toolInput);
                log.info(`  ▶ ${toolName}(${JSON.stringify(toolInput).slice(0, 80)})`, 'cyan');

                let resultText: string;
                let actionSuccess: boolean | null = null;
                let failureType: string | null = null;
                let recoverable: boolean | null = null;
                let executionTrace: ActionReceipt['execution'];
                let campaignActionId: string | undefined;
                const supervisor = beforeFrame && this.deps.bot ? new ExecutionSupervisor({
                    bot: this.deps.bot, workspace, critic: this.deps.executionCritic,
                    mode: supervisionMode,
                    onAssessment: ({ assessment, applied, rejected }) => log.info(
                        `MINECRAFT_COGNITION_METRIC kind=active_critic mode=${supervisionMode} source=${assessment.source}`
                        + ` latency_ms=${assessment.elapsedMilliseconds} control=${assessment.nextControl}`
                        + ` applied=${applied} rejected=${rejected ?? 'none'}`),
                }) : undefined;
                supervisor?.start();
                if (supervisor) activeSupervisors.push(supervisor);

                try {
                    if (taskCompleted) {
                        resultText = '検証済みの完了後なので、このバッチの残りは未実行です。';
                        actionSuccess = false; failureType = 'goal_already_verified'; recoverable = false;
                    } else if (goalUpdateRejected && toolName !== 'manage-campaign-goals' && toolName !== 'inspect-campaign-goals') {
                        resultText = '同じ応答の中の目標の更新が却下されたため、この呼び出しは実行していません。上のエラーを直してから出し直してください。';
                        actionSuccess = false; failureType = 'goal_update_rejected'; recoverable = true;
                    } else if (iterationReplanRequested || state.abortSignal?.aborted) {
                        resultText = '前の行動が中断され計画が失効したため、このバッチの残りの呼び出しは未実行です。最新の状況で再計画してください。';
                        actionSuccess = false;
                        failureType = 'superseded_by_feedback';
                        recoverable = true;
                    } else if (batchFailedAt && actionProfile.meaningfulWorldAction) {
                        resultText = `同じ応答の中で先に呼んだ${batchFailedAt}が失敗したため、この行動は未実行です。失敗の内容を見て、必要なら出し直してください。`;
                        actionSuccess = false; failureType = 'earlier_action_failed'; recoverable = true;
                    }
                    else if (toolName === 'manage-campaign-goals' && campaign) {
                        const requestedOperations = (toolInput.operations as CampaignPlanOperation[]) ?? [];
                        // "Mark it done" is a request to check the world, not a state the
                        // model may write. A bare CAMPAIGN_STATE_INVALID left a planner
                        // repeating it while everything that depended on the node stayed
                        // closed (paid run L20): prove it now, or say what is missing.
                        const SETTABLE = ['pending', 'active', 'blocked', 'abandoned'];
                        const claims = requestedOperations.filter(op => op.action === 'set-state' && !SETTABLE.includes(op.state));
                        const refused: string[] = [];
                        for (const claim of claims) {
                            const node = campaign.getNode(claim.id);
                            if (!node) { refused.push(`${claim.id}: このIDのノードはありません`); continue; }
                            if (node.state === 'verified') continue;
                            if (!verifier || !node.postconditions.length) { refused.push(`${claim.id}: 検証できる事後条件がありません`); continue; }
                            const proof = verifier.verify({ goal: node.goal, predicates: node.postconditions });
                            const unmet = proof.evidence.filter(item => item.status !== 'verified');
                            if (unmet.length) refused.push(`${claim.id}の未達条件: ${unmet.map(item => `${JSON.stringify(item.predicate)} 実測=${JSON.stringify(item.actual)}`).join('; ')}`);
                            else if (!campaign.recordProof(node.id, proof, `native:claim:${proof.checkedAt}:${node.id}`))
                                refused.push(`${claim.id}: 事後条件は満たされていますが、依存先か子ノードが未検証、またはmethodが未sealです`);
                        }
                        if (refused.length) throw new Error('CAMPAIGN_STATE_INVALID（set-stateで指定できるのはpending/active/blocked/abandonedだけです。'
                            + 'verified（完了）は書き込めず、事後条件が実際に満たされた時に自動で付きます。' + refused.join(' / ')
                            + '。条件が実態と合わないなら同じ目的の範囲でreviseし、目的が違うならこのノードをabandonedにして正しい条件の新しいノードを作ってください）');
                        const operations = requestedOperations.filter(op => !claims.includes(op));
                        for (const operation of operations) if (operation.action === 'create' || operation.action === 'revise') {
                            // A join-only repair must not leave an invalid legacy item
                            // contract in place. Validate the resulting node, not just
                            // fields explicitly supplied in this operation.
                            const predicates = operation.postconditions ?? (operation.action === 'revise'
                                ? campaign.getNode(operation.id)?.postconditions : undefined);
                            assertKnownInventoryPredicateItems(predicates, this.deps.bot?.registry);
                            if (operation.action === 'revise') assertRevisionPreservesItemPurpose(operation.id,
                                campaign.getNode(operation.id)?.postconditions, operation.postconditions, this.deps.bot?.registry);
                        }
                        const requested = toolInput.activeNodeId;
                        if (requested !== undefined && typeof requested !== 'string') throw new Error('CAMPAIGN_ACTIVE_NODE_INVALID');
                        // The revision guards the whole batch, but a planner writes it
                        // beside the operation that needs it: six seal-method calls in a
                        // row were refused as "revision required" with the number sitting
                        // inside the operation (paid run L20). Read it from either place;
                        // the oldest view stated is the one checked.
                        const stated = [toolInput.expectedRevision, ...requestedOperations.map(op => (op as { expectedRevision?: unknown }).expectedRevision)]
                            .filter(value => value !== undefined);
                        if (stated.some(value => !Number.isSafeInteger(value) || (value as number) < 0))
                            throw new Error('CAMPAIGN_EXPECTED_REVISION_INVALID');
                        const expectedRevision = stated.length ? Math.min(...stated as number[]) : undefined;
                        const planResult = operations.length || requested !== undefined
                            ? campaign.applyPlan(operations, requested as string | undefined, expectedRevision)
                            : { ignoredVerifiedIds: [] as string[] };
                        const released = (planResult as { releasedActiveId?: string }).releasedActiveId;
                        if (released) { if (campaignActiveId === released || requested === released) campaignActiveId = openContextFrom(released); }
                        else if (typeof requested === 'string') campaignActiveId = requested;
                        resultText = JSON.stringify({ ...campaign.projection(campaignActiveId), ignoredVerifiedIds: planResult.ignoredVerifiedIds,
                          ...(released ? { note: ((planResult as { releasedReason?: string }).releasedReason === 'verified'
                            ? `${released}はすでに検証済み（完了）です。完了したノードは実行対象にならないので、activeNodeIdの指定は無視しました（他の操作は反映済み）。`
                              + 'まだ同じ種類の作業が必要なら、数量などを引き上げた事後条件で別のノードをcreateしてください。'
                            : `${released}は閉じました（操作は反映済み）。閉じたノードは実行対象にならないので、activeNodeIdの指定は無視しました。`)
                            + `いまの作業文脈: ${campaignActiveId ?? 'なし'}（行動はこの下で実行されます）。別の枝へ進むならreadyから選んでactiveNodeIdに指定してください` } : {}) });
                    }
                    else if (toolName === 'inspect-campaign-goals' && campaign) {
                        resultText = JSON.stringify(campaign.inspect(String(toolInput.nodeId ?? ''),
                          Number(toolInput.offset ?? 0), Number(toolInput.limit ?? 16)));
                    }
                    // manage-task-tree: short-task legacy tree. Campaigns never enter it.
                    else if (toolName === 'manage-task-tree' && !campaign) {
                        const ops = (toolInput.operations as TaskTreeOperation[]) || [];
                        for (const operation of ops) assertKnownInventoryPredicateItems(operation.postconditions, this.deps.bot?.registry);
                        const candidate = structuredClone(taskNodes);
                        const result = applyTaskTreeOperations(candidate, ops, verifier, usedNodeIds);
                        const nextActive = selectActiveTaskNode(candidate, toolInput.activeNodeId, activeSubtaskId);
                        taskNodes.splice(0, taskNodes.length, ...candidate);
                        activeSubtaskId = nextActive; workspace.setActiveSubtask(activeSubtaskId);
                        usedNodeIds = new Set(result.usedNodeIds); workspace.recordUsedTaskNodeIds(result.usedNodeIds);
                        resultText = `${result.summary} ready_node_ids=${JSON.stringify(readyGoalNodes(taskNodes))}`;
                        workspace.projectPlan(taskNodes);
                        log.info(`🌳 ${resultText}`, 'cyan');
                    }
                    else if (toolName === 'set-goal-contract' && verifier) {
                        assertKnownInventoryPredicateItems(toolInput.predicates, this.deps.bot?.registry);
                        const proposed = validateGoalContract(toolInput, state.goal);
                        if (goalContract && JSON.stringify(proposed) !== JSON.stringify(goalContract)) throw new Error('GOAL_CONTRACT_LOCKED: 完了条件を弱めず、ユーザー確認で新しい依頼にしてください');
                        goalContract = proposed;
                        workspace.recordGoal(goalContract, initialObservation);
                        resultText = `完了条件を設定: ${JSON.stringify(goalContract)}`;
                    }
                    // task-complete 特殊処理
                    else if (toolName === 'task-complete') {
                        if (verifier && (goalContract || !this.deps.conversation)) {
                            if (!campaign) { reconcileTaskNodes(taskNodes, verifier); workspace.projectPlan(taskNodes); }
                            const proof = verifier.verify(goalContract);
                            workspace.observeWorld(captureWorldObservation(this.deps.bot));
                            workspace.recordGoalProof(proof);
                            if (campaign && proof.status === 'verified') campaign.recordProof('root', proof, `native:root:${proof.checkedAt}`);
                            if (proof.status !== 'verified' || campaign && campaign.getNode('root')?.state !== 'verified') {
                                resultText = `完了を確認できません: ${JSON.stringify(proof)}。条件を満たすまで観測・作業を続けるか、曖昧な目標はユーザーへ確認してください。`;
                                actionSuccess = false; failureType = 'completion_unverified'; recoverable = true;
                                state.onToolFinished?.({ iteration: iter + 1, tool: toolName, args: structuredClone(toolInput),
                                    durationMs: Math.max(0, Date.now() - actionStartedAt), success: false, result: resultText });
                                toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: resultText, is_error: true });
                                continue;
                            }
                        }
                        const summary = (toolInput.summary as string) || '';
                        resultText = `タスク完了: ${summary}`;
                        lastContent = summary;
                        taskCompleted = true;
                        // 次タスクへのコンテキスト引継ぎ用に保存
                        if (this.deps.continuation) {
                            this.deps.continuation.lastGoal = state.goal;
                            this.deps.continuation.lastSummary = summary.slice(0, 500);
                        }
                        taskTree = {
                            goal: displayGoal,
                            strategy: summary,
                            status: 'completed',
                            hierarchicalSubTasks: taskNodesToHierarchicalSubTasks(taskNodes),
                        } as TaskTreeState;
                        state.onTaskTreeUpdate?.(taskTree);
                        this.postTaskTreeToUiMod(taskTree);
                    }
                    // ルーチン (API名: routine-xxx)
                    else if (toolName.startsWith('routine-') && this.deps.routineManager) {
                        if (campaign) {
                            if (!campaignActiveId || !campaign.isActionable(campaignActiveId)) throw new Error('CAMPAIGN_ACTIVE_NODE_REQUIRED');
                            campaignActionId = crypto.randomUUID(); campaign.beginAction(campaignActionId, campaignActiveId, toolName);
                        }
                        if (verifier && !goalContract && !state.tags?.includes('emergency')) throw new Error('GOAL_CONTRACT_REQUIRED');
                        const routineName = toolName.replace('routine-', '');
                        const def = this.deps.routineManager.get(routineName);
                        if (def) {
                            if (def.instruction && this.deps.bot) {
                                // 新方式: Haiku サブエージェント
                                const { SubAgentRoutineExecutor } = await import('../../minebot/routines/SubAgentRoutineExecutor.js');
                                const subAgent = new SubAgentRoutineExecutor();
                                const result = await withActionSignal(this.deps.bot, state.abortSignal, () => subAgent.execute(def, toolInput, {
                                    abortSignal: state.abortSignal,
                                    bot: this.deps.bot,
                                    onTaskTreeUpdate: state.onTaskTreeUpdate,
                                }));
                                resultText = result.summary;
                                actionSuccess = result.success;
                                failureType = result.success ? null : 'routine_failed';
                                recoverable = result.success ? null : true;
                                this.deps.routineManager.updateStats(routineName, result.success, result.durationMs).catch(() => {});
                            } else if (def.steps && this.deps.routineExecutor) {
                                // 旧方式: コードベース実行 (後方互換)
                                const result = await this.deps.routineExecutor.execute(def, toolInput, {
                                    abortSignal: state.abortSignal,
                                });
                                resultText = result.summary;
                                actionSuccess = result.success;
                                failureType = result.success ? null : 'routine_failed';
                                recoverable = result.success ? null : true;
                                this.deps.routineManager.updateStats(routineName, result.success, result.durationMs).catch(() => {});
                            } else {
                                resultText = `ルーチン "${routineName}" の実行方法が不明です`;
                                actionSuccess = false;
                                failureType = 'capability_unavailable';
                                recoverable = false;
                            }
                        } else {
                            resultText = `ルーチン "${routineName}" が見つかりません`;
                            actionSuccess = false;
                            failureType = 'capability_not_found';
                            recoverable = false;
                        }
                    }
                    // InstantSkill
                    else if (this.deps.instantSkills?.getSkill(toolName)) {
                        if (verifier && !goalContract && actionProfile.meaningfulWorldAction && !state.tags?.includes('emergency')) throw new Error('GOAL_CONTRACT_REQUIRED: 作業前にset-goal-contractを呼んでください');
                        if (campaign && actionProfile.meaningfulWorldAction) {
                            if (!campaignActiveId || !campaign.isActionable(campaignActiveId)) throw new Error('CAMPAIGN_ACTIVE_NODE_REQUIRED');
                            campaignActionId = crypto.randomUUID(); campaign.beginAction(campaignActionId, campaignActiveId, toolName);
                        }
                        const skill = this.deps.instantSkills.getSkill(toolName)!;
                        const args = skill.params.map(p => {
                            const val = toolInput[p.name];
                            if (val === undefined) return p.default;
                            if (p.type === 'number') return Number(val);
                            if (p.type === 'boolean') return val === true || val === 'true';
                            return val;
                        });
                        const skillResult = this.deps.bot
                            ? await withActionSignal(this.deps.bot, state.abortSignal, () => skill.run(...args))
                            : await skill.run(...args);
                        executionTrace = skillResult.execution;
                        const status = skillResult.success ? '成功' : '失敗';
                        actionSuccess = skillResult.success;
                        failureType = skillResult.failureType ?? null;
                        if (skillResult.failureType === 'interrupted') {
                            iterationReplanRequested = true;
                            iterationExecutionFeedback.push('身体操作が割り込まれました。同一バッチの古い手順は継続せず、最新の世界状態と実行済み効果を確認して再計画してください。');
                        }
                        recoverable = skillResult.recoverable ?? null;
                        resultText = `結果: ${status} 詳細: ${skillResult.result}`;
                        if (skillResult.failureType) {
                            resultText += ` [failure_type=${skillResult.failureType} recoverable=${skillResult.recoverable ?? true}]`;
                        }
                    }
                    // LLM ツール (recall-*, save-*, manage-routine, etc.)
                    else if (this.deps.llmTools?.has(toolName)) {
                        resultText = await this.deps.llmTools.get(toolName)!(toolInput);
                    }
                    // search-skills: スキルの説明・引数を検索
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
                        // #2 fix: non-MC チャネルでもルーチンは検索可能
                        if (!this.deps.instantSkills && !this.deps.routineManager) {
                            resultText = 'search-skills: このチャネルではスキル検索は利用できません';
                            // ステップ履歴更新等は下に続く
                        } else if (this.deps.instantSkills) {
                            for (const skill of this.deps.instantSkills.getSkills()) {
                                if (matchesQuery(skill.skillName) || matchesQuery(skill.description)) {
                                    const params = skill.params.map((p: any) =>
                                        `${p.name}: ${p.type}${p.required ? ' (必須)' : ` (デフォルト: ${p.default ?? 'なし'})`} — ${p.description}`
                                    ).join('\n    ');
                                    results.push(`**${skill.skillName}**: ${skill.description}\n    ${params || '(引数なし)'}`);
                                }
                            }
                        }
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
                        resultText = results.length > 0
                            ? `検索結果 (${results.length}件):\n${results.slice(0, 15).join('\n\n')}`
                            : `"${query}" に一致するスキル/ルーチンが見つかりません`;
                    }
                    // 不明なツール
                    else {
                        resultText = `不明なツール: ${toolName}`;
                    }
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    if (campaign && toolName === 'manage-campaign-goals') goalUpdateRejected = true;
                    resultText = `エラー: ${msg}${e instanceof TaskTreeValidationError ? ` ${JSON.stringify(e.diagnostic)}` : ''}`
                      + (campaign && toolName === 'manage-campaign-goals' ? ` 現在のready候補: ${JSON.stringify(campaign.projection(campaignActiveId).ready.map(node => ({ id: node.id, kind: node.kind, state: node.state, dependsOn: node.dependsOn })))}` : '');
                    actionSuccess = false;
                    failureType = 'unexpected_error';
                    recoverable = false;
                } finally {
                    supervisor?.stop();
                    for (const feedback of supervisor?.takeFeedback() ?? []) {
                        iterationExecutionFeedback.push(feedback);
                    }
                    if (supervisor?.assessments.some(result => result.applied
                      && ['REPLAN', 'SWITCH_SUBTASK', 'ABORT_UNSAFE'].includes(result.assessment.nextControl))) iterationReplanRequested = true;
                }
                if (actionProfile.meaningfulWorldAction && actionSuccess === false && !batchFailedAt
                    && failureType !== 'earlier_action_failed' && failureType !== 'goal_update_rejected') batchFailedAt = toolName;

                if (beforeFrame) {
                    const afterFrame = workspace.observeWorld(captureWorldObservation(this.deps.bot));
                    const receipt: ActionReceipt = {
                        id: crypto.randomUUID(),
                        runId: workspace.runId,
                        iteration: iter + 1,
                        actionKind: actionProfile.kind,
                        capability: toolName,
                        args: structuredClone(toolInput),
                        intendedEffect: `Execute ${toolName} with the supplied arguments`,
                        startedAt: new Date(actionStartedAt).toISOString(),
                        finishedAt: new Date().toISOString(),
                        durationMs: Math.max(0, Date.now() - actionStartedAt),
                        beforeRevision: beforeFrame.revision,
                        afterRevision: afterFrame.revision,
                        success: actionSuccess,
                        failureType,
                        recoverable,
                        resultSummary: resultText.slice(0, 1_000),
                        observedDelta: diffWorldFrames(beforeFrame, afterFrame),
                        meaningfulWorldAction: true,
                        taskNodeId: activeSubtaskId,
                        execution: executionTrace,
                    };
                    workspace.recordReceipt(receipt);
                    if (campaign && campaignActionId) {
                        campaign.finishAction(campaignActionId, actionSuccess, resultText,
                            afterFrame.facts?.inventory?.coverage === 'known' ? afterFrame.inventory : undefined);
                        if (verifier && campaignActiveId) {
                            const node = campaign.getNode(campaignActiveId);
                            if (node?.kind === 'action' && node.postconditions.length && node.state !== 'verified') {
                                const proof = verifier.verify({ goal: node.goal, predicates: node.postconditions });
                                campaign.recordProof(node.id, proof, `native:${receipt.id}:${node.id}`);
                            }
                            if (!campaign.isActionable(campaignActiveId)) campaignActiveId = openContextFrom(campaignActiveId);
                        }
                    }
                    iterationReceipts.push(receipt);
                    if (verifier && !campaign) {
                        reconcileTaskNodes(taskNodes, verifier);
                        activeSubtaskId = selectActiveTaskNode(taskNodes, undefined, activeSubtaskId);
                        workspace.setActiveSubtask(activeSubtaskId); workspace.projectPlan(taskNodes);
                    }
                }

                state.onToolFinished?.({ iteration: iter + 1, tool: toolName, args: structuredClone(toolInput),
                    durationMs: Math.max(0, Date.now() - actionStartedAt), success: actionSuccess, result: resultText,
                    // The rest of a response runs only after a success (see batchFailedAt).
                    moreInResponse: actionSuccess !== false && toolUseBlocks.indexOf(toolUse) < toolUseBlocks.length - 1 });
                if (this.deps.learning) {
                    recentLearningTools.push(toolName);
                    if (recentLearningTools.length > 6) recentLearningTools.shift();
                    this.deps.learning.recordAction(this.deps.bot, { tool: toolName, args: structuredClone(toolInput),
                        success: actionSuccess, failureType: failureType ?? null, result: resultText,
                        durationMs: Math.max(0, Date.now() - actionStartedAt), emergency: state.tags?.includes('emergency') ?? false });
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
                    ...(actionSuccess === false ? { is_error: true } : {}),
                });
            }

            // ツール結果をバッチで追加
            messages.push({ role: 'user', content: toolResults });
            for (const feedback of iterationExecutionFeedback) messages.push({ role: 'user', content: feedback });

            // Independent execution feedback. In shadow mode it is recorded only;
            // in feedback mode a high-confidence, non-stale control is returned to
            // System 2 on the next turn. It never directly mutates the bot here.
            if (!taskCompleted && iterationReceipts.length > 0 && criticMode !== 'off' && this.deps.executionCritic) {
                const critic = this.deps.executionCritic;
                if (criticMode === 'shadow') {
                    // Shadow evaluation must not lengthen the active control loop.
                    // Keep at most one request in flight; a late result is recorded
                    // as stale if newer WorldFrames have already arrived.
                    if (!pendingShadowAssessment) {
                        const criticInput = workspace.criticInput();
                        const pending = critic.assess(criticInput).then(rawAssessment => {
                            const assessment = workspace.recordAssessment(rawAssessment);
                            log.info(
                                `🧭 ExecutionCritic(${assessment.source}, shadow): ${assessment.progressState} → ${assessment.nextControl}`
                                + ` (${assessment.elapsedMilliseconds}ms)`
                                + `${assessment.stale ? ' [stale]' : ''}`,
                                'cyan',
                            );
                            log.info(
                                `MINECRAFT_COGNITION_METRIC kind=critic mode=shadow source=${assessment.source}`
                                + ` latency_ms=${assessment.elapsedMilliseconds} stale=${assessment.stale}`,
                            );
                        }).catch(error => {
                            log.warn(`⚠ ExecutionCritic shadow error: ${error instanceof Error ? error.message : error}`);
                        }).finally(() => {
                            if (pendingShadowAssessment === pending) pendingShadowAssessment = null;
                        });
                        pendingShadowAssessment = pending;
                    }
                } else {
                    const assessment = workspace.recordAssessment(
                        await critic.assess(workspace.criticInput()),
                    );
                    log.info(
                        `🧭 ExecutionCritic(${assessment.source}): ${assessment.progressState} → ${assessment.nextControl}`
                        + ` (${assessment.elapsedMilliseconds}ms)`
                        + `${assessment.stale ? ' [stale]' : ''}`,
                        'cyan',
                    );
                    log.info(
                        `MINECRAFT_COGNITION_METRIC kind=critic mode=feedback source=${assessment.source}`
                        + ` latency_ms=${assessment.elapsedMilliseconds} stale=${assessment.stale}`,
                    );
                    const criticFeedback = formatCriticFeedback(assessment);
                    if (criticFeedback) messages.push({ role: 'user', content: criticFeedback });
                }
            }

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

            // A preemption may abort the next provider call or physical action.
            // Retain only a closed turn with its tool results and native receipts.
            emitCheckpoint();

            // MetaObserver 削除 — メインループが自分で recall-memory / search-skills を呼ぶ
        }

        // Preserve the final shadow observation in the persisted snapshot. This
        // wait happens only after the control loop has ended.
        if (pendingShadowAssessment) await pendingShadowAssessment;
        await Promise.all(activeSupervisors.map(supervisor => supervisor.drain()));
        if (verifier && goalContract) workspace.recordGoalProof(verifier.verify(goalContract));
        verifier?.dispose();

        // A parallel title request is paid work of this run. Its evidence must
        // settle before a terminal result is returned. Both requests retain the
        // original abort signal; an uncooperative transport grants no early ACK.
        if (titleWork) await titleWork;
        const durationMs = Date.now() - startTime;

        // MAX_ITERATIONS 到達 or 中断の処理
        let resultRecoveryStatus: 'awaiting_user' | 'failed_terminal' | undefined;
        let resultMessages: MessageParam[] | undefined;

        if (providerEvidenceFailure) taskCompleted = false;
        if (!taskCompleted) {
            if (providerEvidenceFailure) {
                resultRecoveryStatus = 'failed_terminal';
                resultMessages = messages;
                taskTree = { goal: displayGoal, strategy: providerEvidenceFailure.code === 'MINECRAFT_PLANNER_REFUSED'
                    ? `モデルが要求を拒否した (${providerEvidenceFailure.code})`
                    : `モデルの利用量・キャッシュ証拠を確認できない (${providerEvidenceFailure.code})`,
                    status: 'error', recoveryStatus: 'failed_terminal',
                    hierarchicalSubTasks: taskNodes.length > 0 ? taskNodesToHierarchicalSubTasks(taskNodes) : [] } as TaskTreeState;
                state.onTaskTreeUpdate?.(taskTree);
                this.postTaskTreeToUiMod(taskTree);
            } else if (state.abortSignal?.aborted) {
                // 緊急割込みで中断 — 次タスクで復帰できるようにコンテキスト保存
                const treeProgress = taskNodes.length > 0 ? taskNodesToText(taskNodes).slice(0, 200) : 'なし';
                if (this.deps.continuation) {
                    this.deps.continuation.lastGoal = state.goal;
                    this.deps.continuation.lastSummary = `【中断】緊急割込みにより中断。進捗: ${treeProgress}。このタスクの続きを実行する必要がある`;
                }
                log.info(`💾 中断タスク保存: "${state.goal.slice(0, 40)}..." → 次タスクで復帰可能`);
                taskTree = {
                    goal: displayGoal,
                    strategy: '緊急割込みにより中断',
                    status: 'error',
                    hierarchicalSubTasks: taskNodes.length > 0 ? taskNodesToHierarchicalSubTasks(taskNodes) : [],
                } as TaskTreeState;
                resultMessages = messages;
            } else {
                // MAX_ITERATIONS 到達 → ユーザーに続行確認
                log.warn(`⚠ 実行ループ終了 (${iterations} turns, reason=${stopReason}) → awaiting_user`);
                const treeProgress = taskNodes.length > 0
                    ? taskNodesToText(taskNodes).slice(0, 200)
                    : 'なし';
                const chatMsgFull = `${iterations}ターンで停止しました（理由: ${stopReason}、進捗: ${treeProgress}）。続けますか？`;
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
                    strategy: `${iterations}ターンで停止 (${stopReason}) — ユーザーの続行確認待ち`,
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

        campaign?.checkpoint();

        return {
            lastContent,
            taskTree,
            iterations,
            toolCallCount: totalToolCalls,
            durationMs,
            thinkingLog,
            messages: resultMessages,
            recoveryStatus: resultRecoveryStatus,
            taskNodes: taskNodes.length > 0 ? taskNodes : undefined,
            cognitiveWorkspace: workspace.snapshot(),
            ...(providerEvidenceFailure ? { providerEvidenceFailure: providerEvidenceFailure.code } : {}),
        };
    }

    /**
     * ユーザーの生チャットを短い表示用タスク名に要約する（並列実行用）。
     * 例: 「ダイヤモンドが欲しいんだけどさ、地下に行って掘ってきてくれない？」→「ダイヤモンドの採掘」
     */
    private async summarizeGoal(rawGoal: string, signal?: AbortSignal): Promise<string> {
        const response = await this.auxiliaryClient.messages.create({
            model: this.auxiliaryModel ?? MODEL_HAIKU,
            max_tokens: 60,
            system: 'ユーザーの指示を短い動作名詞句（〜10文字）に要約せよ。例:「ダイヤモンドの採掘」「ネザーポータル建設」「鉄装備の作成」。要約のみ出力。',
            messages: [{ role: 'user', content: rawGoal }],
        }, { signal });
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
    private async summarizeWithLLM(messages: MessageParam[], goal: string, signal?: AbortSignal): Promise<string> {
        const mechanical = ShannonExecutor.compressMessagesMechanical(messages);
        if (signal?.aborted) return mechanical;
        try {
            const response = await this.auxiliaryClient.messages.create({
                model: this.auxiliaryModel ?? MODEL_HAIKU,
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
            }, { signal });

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
            if (isAnthropicPlannerTerminalError(e)) throw e;
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
        if (this.deps.publishTaskTree) { this.deps.publishTaskTree(taskTree); return; }
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
