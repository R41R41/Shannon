import fs from 'node:fs';
import path from 'node:path';
import type { GoalPredicate, GoalProof } from './GoalVerifier.js';
import type { WorldObservation } from './types.js';

export type CampaignNodeKind = 'outcome' | 'method' | 'action';
export type CampaignNodeState = 'pending' | 'active' | 'blocked' | 'verified' | 'abandoned';
export type CampaignJoin = 'all' | 'any';

export interface CampaignNode {
  id: string;
  parentId: string | null;
  goal: string;
  kind: CampaignNodeKind;
  join: CampaignJoin;
  dependsOn: string[];
  postconditions: GoalPredicate[];
  state: CampaignNodeState;
  /** Methods remain expandable until the planner explicitly seals their child set. */
  sealed?: boolean;
  sealReason?: string;
  sealRevision?: number;
  blocker?: string;
  evidenceRef?: string;
  attempts: number;
}

export type CampaignPlanOperation =
  | { action: 'create'; id: string; parentId: string; goal: string; kind: CampaignNodeKind;
      join?: CampaignJoin; dependsOn?: string[]; postconditions?: GoalPredicate[] }
  | { action: 'revise'; id: string; postconditions?: GoalPredicate[]; join?: CampaignJoin; reason: string }
  | { action: 'seal-method' | 'unseal-method'; id: string; reason: string }
  | { action: 'set-state'; id: string; state: 'pending' | 'active' | 'blocked' | 'abandoned'; blocker?: string };

interface CampaignEvent {
  revision: number;
  at: string;
  kind: 'plan' | 'proof' | 'structural-proof' | 'action-started' | 'action-finished' | 'actor-death' | 'inventory-reconciled';
  data: any;
}

export interface CampaignPlanRepairAudit {
  revision: number;
  at: string;
  nodeId: string;
  reason: string;
  before: { join: CampaignJoin; postconditions: GoalPredicate[] };
  after: { join: CampaignJoin; postconditions: GoalPredicate[] };
}

type CampaignInventory = Array<{ name: string; count: number }>;
export interface CampaignProofInvalidationAudit {
  revision: number;
  at: string;
  nodeId: string;
  priorEvidenceRef?: string;
  cause: 'death' | 'observed_loss' | 'legacy_empty';
  mismatches: Array<{ item: string; required: number; actual: number }>;
  invalidatedChildren?: string[];
  invalidatedDependencies?: string[];
}

interface CampaignSnapshot {
  schemaVersion: 1;
  id: string;
  worldId: string;
  goal: string;
  revision: number;
  nodes: CampaignNode[];
  activeNodeId?: string;
  inFlight: Array<{ actionId: string; nodeId: string; capability: string }>;
  recentReceipts: Array<{ actionId: string; nodeId: string; success: boolean | null; summary: string }>;
  recentPlanRepairs?: CampaignPlanRepairAudit[];
  recentProofInvalidations?: CampaignProofInvalidationAudit[];
  lastObservedInventory?: CampaignInventory;
  pendingDeath?: { reason: string; inventory?: CampaignInventory };
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const SNAPSHOT_INTERVAL = 512;
const REPAIR_AUDIT_LIMIT = 128;
const INVALIDATION_AUDIT_LIMIT = 128;

function normalizedInventory(inventory: ReadonlyArray<{ name: string; count: number }>): CampaignInventory {
  const counts = new Map<string, number>();
  for (const item of inventory.slice(0, 512)) {
    if (!item || typeof item.name !== 'string' || !/^[a-z0-9_]+$/.test(item.name)
      || !Number.isSafeInteger(item.count) || item.count < 1) continue;
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([name, count]) => ({ name, count }));
}

function inventoryCount(inventory: CampaignInventory, item: string): number {
  return inventory.find(stack => stack.name === item)?.count ?? 0;
}

/**
 * A campaign owns its durable goal state. A model may propose branches and
 * blockers, but can never write verified proof. The physical executor remains
 * the only source of action receipts and the native verifier owns completion.
 *
 * The graph is indexed in memory; the append-only journal is fsynced before a
 * mutation is exposed. A snapshot bounds restart replay without writing the
 * entire graph on every action. One process must own a campaign directory.
 */
export class CampaignGoalGraph {
  private nodes = new Map<string, CampaignNode>();
  private children = new Map<string, Set<string>>();
  private childCounts = new Map<string, { total: number; verified: number }>();
  private dependents = new Map<string, Set<string>>();
  private ready = new Set<string>();
  private inFlight = new Map<string, { actionId: string; nodeId: string; capability: string }>();
  private recentReceipts: CampaignSnapshot['recentReceipts'] = [];
  private recentPlanRepairs: CampaignPlanRepairAudit[] = [];
  private recentProofInvalidations: CampaignProofInvalidationAudit[] = [];
  private lastObservedInventory?: CampaignInventory;
  private pendingDeath?: CampaignSnapshot['pendingDeath'];
  private activeNodeId?: string;
  private revision = 0;
  /** Revision at which each node's own state, contract or child set last changed. */
  private changedAt = new Map<string, number>();
  /** Revision of the last action receipt within each node's subtree. */
  private actedAt = new Map<string, number>();
  /** Nodes restored from a snapshot carry no change record; assume they changed at its revision. */
  private restoredRevision = 0;
  private readonly journalPath: string;
  private readonly snapshotPath: string;
  private constructor(private readonly directory: string, readonly id: string, readonly worldId: string, readonly goal: string) {
    if (!ID.test(id) || !worldId.trim() || !goal.trim()) throw new Error('CAMPAIGN_IDENTITY_INVALID');
    this.journalPath = path.join(directory, `${id}.jsonl`);
    this.snapshotPath = path.join(directory, `${id}.snapshot.json`);
  }

  static open(options: { directory: string; id: string; worldId: string; goal: string; success: GoalPredicate[] }): CampaignGoalGraph {
    const graph = new CampaignGoalGraph(options.directory, options.id, options.worldId, options.goal);
    fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(graph.snapshotPath)) {
      const saved = JSON.parse(fs.readFileSync(graph.snapshotPath, 'utf8')) as CampaignSnapshot;
      if (saved.schemaVersion !== 1 || saved.id !== options.id || saved.worldId !== options.worldId || saved.goal !== options.goal)
        throw new Error('CAMPAIGN_IDENTITY_MISMATCH');
      graph.revision = saved.revision;
      graph.restoredRevision = saved.revision;
      graph.activeNodeId = saved.activeNodeId;
      for (const node of saved.nodes) graph.nodes.set(node.id, node);
      for (const action of saved.inFlight) graph.inFlight.set(action.actionId, action);
      graph.recentReceipts = saved.recentReceipts;
      graph.recentPlanRepairs = (saved.recentPlanRepairs ?? []).slice(-REPAIR_AUDIT_LIMIT);
      graph.recentProofInvalidations = (saved.recentProofInvalidations ?? []).slice(-INVALIDATION_AUDIT_LIMIT);
      graph.lastObservedInventory = saved.lastObservedInventory;
      graph.pendingDeath = saved.pendingDeath;
      // Journal events after a checkpoint may reference existing parents and
      // children; rebuild their indexes before replaying those events.
      graph.rebuildIndexes();
    }
    if (fs.existsSync(graph.journalPath)) {
      const journal = fs.readFileSync(graph.journalPath, 'utf8');
      if (journal && !journal.endsWith('\n')) throw new Error('CAMPAIGN_JOURNAL_INCOMPLETE');
      for (const line of journal.split('\n')) {
        if (!line) continue;
        const event = JSON.parse(line) as CampaignEvent;
        if (event.revision <= graph.revision) continue;
        if (event.revision !== graph.revision + 1) throw new Error('CAMPAIGN_JOURNAL_GAP');
        graph.applyEvent(event);
      }
    }
    if (!graph.nodes.size) {
      if (!options.success.length) throw new Error('CAMPAIGN_SUCCESS_REQUIRED');
      graph.append('plan', { operations: [{ action: 'create-root', id: 'root', goal: options.goal,
        postconditions: options.success }] });
    } else if (JSON.stringify(graph.nodes.get('root')?.postconditions) !== JSON.stringify(options.success)) {
      throw new Error('CAMPAIGN_SUCCESS_IMMUTABLE');
    }
    graph.rebuildIndexes();
    // Recover a crash between a native child proof and its derived method
    // proof through the same fsynced journal path, including older snapshots.
    graph.closeSatisfiedStructuralMethods([...graph.nodes.keys()]);
    return graph;
  }

  get size(): number { return this.nodes.size; }
  get currentRevision(): number { return this.revision; }
  getNode(id: string): CampaignNode | undefined { const node = this.nodes.get(id); return node && structuredClone(node); }
  isReady(id: string): boolean { return this.ready.has(id) && this.isActionable(id); }
  isActionable(id: string): boolean {
    let node = this.nodes.get(id);
    while (node) {
      if (!['pending', 'active'].includes(node.state)
        || !node.dependsOn.every(dep => this.nodes.get(dep)?.state === 'verified')) return false;
      if (!node.parentId) return true;
      node = this.nodes.get(node.parentId);
    }
    return false;
  }
  getActiveId(): string | undefined {
    if (this.activeNodeId && this.isActionable(this.activeNodeId)) return this.activeNodeId;
    for (const node of this.nodes.values()) if (node.state === 'active' && this.isActionable(node.id)) return node.id;
    return undefined;
  }
  getUncertainActions(): Array<{ actionId: string; nodeId: string; capability: string }> {
    return [...this.inFlight.values()].map(action => ({ ...action }));
  }

  inspect(nodeId: string, offset = 0, limit = 16): { node: CampaignNode; children: CampaignNode[]; childCount: number;
      recentReceipts: CampaignSnapshot['recentReceipts']; recentPlanRepairs: CampaignPlanRepairAudit[];
      recentProofInvalidations: CampaignProofInvalidationAudit[] } {
    const node = this.nodes.get(nodeId);
    if (!node || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 32)
      throw new Error('CAMPAIGN_INSPECT_INVALID');
    const ids = [...(this.children.get(nodeId) ?? [])];
    return { node: structuredClone(node), children: ids.slice(offset, offset + limit).map(id => structuredClone(this.nodes.get(id)!)),
      childCount: ids.length, recentReceipts: structuredClone(this.recentReceipts.slice(-8)),
      recentPlanRepairs: structuredClone(this.recentPlanRepairs.filter(repair => repair.nodeId === nodeId).slice(-8)),
      recentProofInvalidations: structuredClone(this.recentProofInvalidations.filter(entry => entry.nodeId === nodeId).slice(-8)) };
  }

  /** Atomic model plan proposal. Edges never change in place; alternatives are new nodes. */
  applyPlan(operations: CampaignPlanOperation[], activeNodeId?: string, expectedRevision?: number): { ignoredVerifiedIds: string[]; releasedActiveId?: string; releasedReason?: 'closed' | 'verified' } {
    if (expectedRevision !== undefined && expectedRevision !== this.revision) {
      // Every action receipt advances the revision, so a planner that moved its
      // body always held an older number (a paid run lost 8 turns to this in 13
      // minutes). Its view is stale only if a node this batch edits, or that
      // node's child set, changed after the revision it saw.
      // A state change or a leaf's contract fix follows from the planner's own
      // actions, whose results it has seen. Repairing a parent's aggregation
      // or sealing a method also depends on what ran beneath it.
      const lastRelevant = (op: CampaignPlanOperation): number => {
        const changed = this.changedAt.get(op.id) ?? this.restoredRevision;
        const aggregates = op.action === 'seal-method' || op.action === 'unseal-method'
          || (op.action === 'revise' && Boolean(this.children.get(op.id)?.size || op.join !== undefined));
        return aggregates ? Math.max(changed, this.actedAt.get(op.id) ?? this.restoredRevision) : changed;
      };
      const edited = operations.filter(op => op.action !== 'create' && this.nodes.has(op.id));
      const changed = expectedRevision > this.revision ? ['expectedRevision']
        : [...new Set(edited.filter(op => lastRelevant(op) > expectedRevision).map(op => op.id))];
      if (expectedRevision > this.revision) throw new Error(`CAMPAIGN_REVISION_STALE:expected=${expectedRevision}:actual=${this.revision}`
        + `（${expectedRevision}はキャンペーンの版より大きく、別の番号と取り違えています。キャンペーンの現在の版は${this.revision}です。expectedRevision=${this.revision}で出し直してください）`);
      if (changed.length) throw new Error(`CAMPAIGN_REVISION_STALE:expected=${expectedRevision}:actual=${this.revision}`
        + `（${changed.join(', ')}がその後に変わっています。最新の状態を確認し、expectedRevision=${this.revision}で出し直してください）`);
    }
    if ((!operations.length && !activeNodeId) || operations.length > 64) throw new Error('CAMPAIGN_PLAN_BATCH_INVALID');
    const ignoredVerifiedIds = operations.filter(op => op.action === 'set-state'
      && ['pending', 'active'].includes(op.state) && this.nodes.get(op.id)?.state === 'verified').map(op => op.id);
    operations = operations.filter(op => !(op.action === 'set-state' && ignoredVerifiedIds.includes(op.id)));
    const additions = new Map<string, CampaignNode>();
    const revised = new Set<string>();
    const stagedSeal = new Map<string, boolean>();
    const stagedChildren = new Map<string, number>();
    for (const op of operations) {
      if (!ID.test(op.id)) throw new Error('CAMPAIGN_NODE_ID_INVALID');
      if (op.action === 'create') {
        if (this.nodes.has(op.id) || additions.has(op.id)) throw new Error(`CAMPAIGN_NODE_DUPLICATE:${op.id}`
          + `（同じidのノードが既にあります${this.nodes.has(op.id) ? `: state=${this.nodes.get(op.id)!.state}` : ''}。既存のノードを使うか、別のidで作成してください）`);
        if (!ID.test(op.parentId) || !op.goal.trim() || !['outcome', 'method', 'action'].includes(op.kind)) throw new Error('CAMPAIGN_NODE_INVALID');
        const parent = additions.get(op.parentId) ?? this.nodes.get(op.parentId);
        if (parent?.kind === 'method' && (stagedSeal.get(op.parentId) ?? parent.sealed ?? false))
          throw new Error(`CAMPAIGN_METHOD_SEALED:${op.parentId}`);
        if (op.join && !['all', 'any'].includes(op.join)) throw new Error('CAMPAIGN_JOIN_INVALID');
        const dependsOn = [...new Set(op.dependsOn ?? [])];
        if (dependsOn.some(id => !ID.test(id))) throw new Error('CAMPAIGN_DEPENDENCY_INVALID');
        additions.set(op.id, { id: op.id, parentId: op.parentId, goal: op.goal, kind: op.kind,
          join: op.join ?? 'all', dependsOn, postconditions: structuredClone(op.postconditions ?? []), state: 'pending',
          sealed: op.kind === 'method' ? false : undefined, attempts: 0 });
        stagedChildren.set(op.parentId, (stagedChildren.get(op.parentId) ?? 0) + 1);
      } else if (op.action === 'revise') {
        const existing = this.nodes.get(op.id);
        const parentRepair = Boolean(existing && (this.children.get(op.id)?.size || op.join !== undefined));
        // Name the rule that failed: a bare code left the planner resending the same edit.
        const invalid = !existing ? 'ノードが存在しません'
          : op.id === 'root' ? 'rootは変更できません'
          : existing.state === 'verified' ? '検証済み（完了）のノードは変更できません。必要なら新しいノードを作成してください'
          : this.hasInFlightActionWithin(op.id) ? '配下で行動を実行中です。終わってから変更してください'
          : this.hasClosedAncestor(op.id) ? '祖先のノードが完了または放棄済みです'
          : 'goal' in op ? 'goalは変更できません。別の目標なら新しいノードを作成してください'
          : revised.has(op.id) ? '同じ呼び出しで同じノードを二度変更しています'
          : (op.postconditions === undefined && op.join === undefined) ? 'postconditionsかjoinの少なくとも一方が必要です'
          : (op.postconditions !== undefined && (!Array.isArray(op.postconditions)
            || !op.postconditions.length || op.postconditions.length > 16)) ? 'postconditionsは1〜16件の配列にしてください'
          : (op.join !== undefined && !['all', 'any'].includes(op.join)) ? 'joinはallかanyです'
          : (typeof op.reason !== 'string' || !op.reason.trim() || op.reason.length > 500) ? 'reason（500文字以内の変更理由）が必要です'
          : null;
        if (invalid || !existing) throw new Error(`CAMPAIGN_REVISION_INVALID:${op.id}（${invalid}）`);
        if (this.hasVerifiedDescendant(op.id)) {
          // A child's native proof is immutable. Keep the parent aggregation
          // semantics fixed, but allow its own unverified contract to be
          // corrected and proven independently against the current world.
          if (op.join !== undefined && op.join !== existing.join)
            throw new Error(`CAMPAIGN_REVISION_VERIFIED_DESCENDANT_JOIN_IMMUTABLE:${op.id}`);
          if (op.postconditions === undefined)
            throw new Error(`CAMPAIGN_REVISION_VERIFIED_DESCENDANT_CONTRACT_REQUIRED:${op.id}`);
        }
        if (parentRepair && expectedRevision === undefined)
          throw new Error(`CAMPAIGN_REVISION_EXPECTED_REVISION_REQUIRED:${op.id}:current=${this.revision}`
            + `（expectedRevision=${this.revision}を付けて同じ操作を出し直してください）`);
        revised.add(op.id);
      } else if (op.action === 'seal-method' || op.action === 'unseal-method') {
        const method = additions.get(op.id) ?? this.nodes.get(op.id);
        const sealed = stagedSeal.get(op.id) ?? method?.sealed ?? false;
        // Which of the conditions failed: a bare code was sent again unchanged (paid run L26).
        const sealing = op.action === 'seal-method';
        const refusal = !method ? 'このIDのノードはありません'
          : method.kind !== 'method' ? `kindが${method.kind}です。seal/unsealできるのはkind=methodのノードだけで、action/outcomeには不要です`
          : method.state === 'verified' || method.state === 'abandoned' ? `すでに${method.state}です`
          : this.hasInFlightActionWithin(op.id) ? 'この枝の身体操作が実行中です。終わってから出し直してください'
          : this.hasClosedAncestor(op.id) ? '祖先のノードが完了または放棄されています'
          : sealed === sealing ? `すでに${sealing ? 'seal済み' : '未sealの状態'}です。同じ操作は不要です`
          : typeof op.reason !== 'string' || !op.reason.trim() ? 'reason（理由）が必要です'
          : op.reason.length > 500 ? 'reasonは500文字以内にしてください' : null;
        if (refusal) throw new Error(`CAMPAIGN_METHOD_SEAL_INVALID:${op.id}（${refusal}）`);
        if (expectedRevision === undefined)
          throw new Error(`CAMPAIGN_METHOD_SEAL_EXPECTED_REVISION_REQUIRED:${op.id}:current=${this.revision}`
            + `（expectedRevision=${this.revision}を付けて同じ操作を出し直してください）`);
        if (op.action === 'seal-method'
          && (this.children.get(op.id)?.size ?? 0) + (stagedChildren.get(op.id) ?? 0) < 1)
          throw new Error(`CAMPAIGN_METHOD_CHILD_REQUIRED:${op.id}`);
        stagedSeal.set(op.id, op.action === 'seal-method');
      } else if (op.action === 'set-state') {
        if (!['pending', 'active', 'blocked', 'abandoned'].includes(op.state)) throw new Error('CAMPAIGN_STATE_INVALID');
        if (!this.nodes.has(op.id) && !additions.has(op.id)) throw new Error(`CAMPAIGN_NODE_UNKNOWN:${op.id}`);
        if (op.id === 'root' && op.state === 'abandoned') throw new Error('CAMPAIGN_ROOT_IMMUTABLE');
      } else {
        throw new Error('CAMPAIGN_OPERATION_INVALID');
      }
    }
    const nodeFor = (id: string) => additions.get(id) ?? this.nodes.get(id);
    for (const node of additions.values()) {
      if (!nodeFor(node.parentId!)) throw new Error(`CAMPAIGN_PARENT_UNKNOWN:${node.parentId}`);
      if (this.nodes.get(node.parentId!)?.state === 'verified') throw new Error(`CAMPAIGN_PARENT_CLOSED:${node.parentId}`);
      for (const dep of node.dependsOn) if (!nodeFor(dep)) throw new Error(`CAMPAIGN_DEPENDENCY_UNKNOWN:${dep}`);
    }
    const pending = new Set<string>(); const done = new Set<string>();
    for (const start of additions.keys()) {
      const stack: Array<{ id: string; exit: boolean }> = [{ id: start, exit: false }];
      while (stack.length) {
        const { id, exit } = stack.pop()!;
        if (exit) { pending.delete(id); done.add(id); continue; }
        if (!additions.has(id) || done.has(id)) continue; // Existing edges cannot point at a new ID.
        if (pending.has(id)) throw new Error(`CAMPAIGN_CYCLE:${id}`);
        pending.add(id); stack.push({ id, exit: true });
        const node = nodeFor(id)!;
        for (const dep of node.dependsOn) stack.push({ id: dep, exit: false });
        if (node.parentId) stack.push({ id: node.parentId, exit: false });
      }
    }
    for (const op of operations) if (op.action === 'set-state' && this.nodes.get(op.id)?.state === 'verified')
      throw new Error('CAMPAIGN_VERIFIED_IMMUTABLE');
    let releasedActiveId: string | undefined;
    let releasedReason: 'closed' | 'verified' | undefined;
    if (activeNodeId !== undefined) {
      const candidate = nodeFor(activeNodeId);
      if (!candidate) throw new Error('CAMPAIGN_ACTIVE_NODE_UNKNOWN');
      const effectiveState = (node: CampaignNode) => {
        const staged = [...operations].reverse().find(op => op.action === 'set-state' && op.id === node.id);
        return staged?.action === 'set-state' ? staged.state : node.state;
      };
      const state = effectiveState(candidate);
      const unmet = candidate.dependsOn.filter(id => nodeFor(id)?.state !== 'verified');
      if (!['pending', 'active'].includes(state) || unmet.length) {
        // Say what the selection conflicts with and how to proceed; the bare
        // code made a paid run resend the same contradictory batch 20+ times.
        const closedHere = operations.some(op => op.action === 'set-state' && op.id === activeNodeId);
        // Closing a node and naming it as the one to work on says one thing: this node is done with.
        // Refusing the whole batch for the pointer cost a planner a turn every time, from L11 to L33,
        // however the refusal was worded. The closure stands and nothing is selected.
        if (closedHere && (state === 'blocked' || state === 'abandoned')) { releasedActiveId = activeNodeId; releasedReason = 'closed'; activeNodeId = undefined; }
        // Naming a finished node is the same kind of statement: the planner is done with it (or has not yet
        // noticed that the world finished it). It was the commonest refusal of all: 17 of 43 in L32, 14 of 24 in L33.
        else if (state === 'verified') { releasedActiveId = activeNodeId; releasedReason = 'verified'; activeNodeId = undefined; }
        else {
        const hint = state === 'blocked' || state === 'abandoned'
              ? `${state}のノードです。再開するなら同じ呼び出しに {"action":"set-state","id":"${activeNodeId}","state":"pending"} を含めてください`
              : '依存先が未検証です。先に依存先のノードをactiveNodeIdにしてください';
        throw new Error(`CAMPAIGN_ACTIVE_NODE_NOT_READY:${activeNodeId}:state=${state}:unmet_dependencies=${JSON.stringify(unmet)}（${hint}）`);
        }
      }
      let parentId = activeNodeId === undefined ? null : candidate.parentId;
      while (parentId) {
        const parent = nodeFor(parentId);
        const parentState = parent ? effectiveState(parent) : 'missing';
        const parentUnmet = parent?.dependsOn.filter(id => nodeFor(id)?.state !== 'verified') ?? [];
        if (!['pending', 'active'].includes(parentState) || parentUnmet.length) {
          const hint = parentState === 'blocked' || parentState === 'abandoned'
            ? `祖先の${parentId}が${parentState}のため、その配下は実行できません。${parentState}は作業を止める状態です。`
              + `配下で前提を満たす作業をするなら、同じ呼び出しで${parentId}をpendingに戻してください`
            : parentState === 'verified' ? `祖先の${parentId}は検証済み（完了）です。別の親の下に作成してください`
              : `祖先の${parentId}の依存先が未検証です。先にその依存先をactiveNodeIdにしてください`;
          throw new Error(`CAMPAIGN_ACTIVE_NODE_NOT_READY:${activeNodeId}:ancestor=${parentId}:${parentState}`
            + (parentUnmet.length ? `:unmet_dependencies=${JSON.stringify(parentUnmet)}` : '') + `（${hint}）`);
        }
        parentId = parent!.parentId;
      }
    }
    const committed = activeNodeId && !operations.some(op => op.action === 'set-state' && op.id === activeNodeId && op.state === 'active')
      ? [...operations, { action: 'set-state' as const, id: activeNodeId, state: 'active' as const }] : operations;
    const repairs = committed.filter((op): op is Extract<CampaignPlanOperation, { action: 'revise' }> => op.action === 'revise')
      .map(op => {
        const node = this.nodes.get(op.id)!;
        return { nodeId: op.id, reason: op.reason,
          before: { join: node.join, postconditions: structuredClone(node.postconditions) },
          after: { join: op.join ?? node.join, postconditions: structuredClone(op.postconditions ?? node.postconditions) } };
      });
    if (committed.length) {
      this.append('plan', { operations: committed, repairs });
      this.closeSatisfiedStructuralMethods(committed.map(op => op.id));
    }
    return { ignoredVerifiedIds, ...(releasedActiveId ? { releasedActiveId, releasedReason } : {}) };
  }

  /** Only the native verifier may call this, with a proof of the exact node contract. */
  recordProof(nodeId: string, proof: GoalProof, evidenceRef: string): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error('CAMPAIGN_NODE_UNKNOWN');
    if (!node.postconditions.length || proof.status !== 'verified' || !evidenceRef.trim()
      || JSON.stringify(proof.evidence.map(item => item.predicate)) !== JSON.stringify(node.postconditions)
      || proof.evidence.some(item => item.status !== 'verified')) return false;
    if (node.state === 'verified') return true;
    if (!node.dependsOn.every(id => this.nodes.get(id)?.state === 'verified')) return false;
    const counts = this.childCounts.get(nodeId);
    if (node.kind === 'method' && (!node.sealed || !counts?.total)) return false;
    if (nodeId !== 'root' && counts?.total) {
      if (node.join === 'all' ? counts.verified !== counts.total : counts.verified === 0) return false;
    }
    this.append('proof', { nodeId, proof, evidenceRef });
    this.closeSatisfiedStructuralMethods([node.parentId, ...(this.dependents.get(nodeId) ?? [])]);
    return true;
  }

  /** A method with no own contract is proven only by already verified
   * children and dependencies. The root outcome never closes this way.
   */
  private closeSatisfiedStructuralMethods(seeds: Iterable<string | null>): void {
    const pending = [...seeds].filter((id): id is string => Boolean(id));
    const queued = new Set(pending);
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const id = pending[cursor]!;
      queued.delete(id);
      const node = this.nodes.get(id);
      if (!node || node.kind !== 'method' || !node.sealed || node.postconditions.length
        || !['pending', 'active'].includes(node.state)) continue;
      const counts = this.childCounts.get(id);
      if (!counts?.total || !node.dependsOn.every(dep => this.nodes.get(dep)?.state === 'verified')
        || (node.join === 'all' ? counts.verified !== counts.total : counts.verified === 0)) continue;
      const evidenceRef = `derived:children:${id}:r${this.revision + 1}`;
      this.append('structural-proof', { nodeId: id, evidenceRef, join: node.join,
        verifiedChildCount: counts.verified, totalChildCount: counts.total });
      for (const next of [node.parentId, ...(this.dependents.get(id) ?? [])]) {
        if (next && !queued.has(next)) { pending.push(next); queued.add(next); }
      }
    }
  }

  beginAction(actionId: string, nodeId: string, capability: string): void {
    if (!ID.test(actionId) || !this.nodes.has(nodeId) || !capability.trim()) throw new Error('CAMPAIGN_ACTION_INVALID');
    if (this.inFlight.has(actionId)) throw new Error('CAMPAIGN_ACTION_DUPLICATE');
    this.append('action-started', { actionId, nodeId, capability });
  }
  finishAction(actionId: string, success: boolean | null, summary: string, inventory?: CampaignInventory): void {
    if (!this.inFlight.has(actionId)) throw new Error('CAMPAIGN_ACTION_UNKNOWN');
    this.append('action-finished', { actionId, success, summary: summary.slice(0, 500),
      inventory: inventory && normalizedInventory(inventory) });
  }

  /** Persist the native actor-death signal before respawn can replace the inventory view. */
  noteActorDeath(reason: string, inventory?: CampaignInventory): void {
    if (this.pendingDeath) return;
    this.append('actor-death', { reason: reason.slice(0, 200),
      inventory: inventory && normalizedInventory(inventory) });
  }

  /** Reconcile current-inventory proofs only after a known loss or a legacy empty-handed resume.
   * Missing ingredients already consumed during a completed action are not revisited on every turn.
   * `produced`, `defeated`, and `boss_defeated` remain historical evidence.
   */
  reconcileCurrentInventory(observation: WorldObservation): string[] {
    if (observation.facts?.inventory?.coverage !== 'known') return [];
    const current = normalizedInventory(observation.inventory);
    const previous = this.pendingDeath?.inventory ?? this.lastObservedInventory;
    const catastrophic = current.length === 0 && (this.pendingDeath !== undefined || previous === undefined);
    const cause: CampaignProofInvalidationAudit['cause'] = this.pendingDeath ? 'death'
      : previous === undefined ? 'legacy_empty' : 'observed_loss';
    const mismatches = new Map<string, CampaignProofInvalidationAudit['mismatches']>();
    for (const node of this.nodes.values()) {
      if (node.state !== 'verified') continue;
      const lost = node.postconditions.flatMap(predicate => {
        if (predicate.kind !== 'inventory') return [];
        const actual = inventoryCount(current, predicate.item);
        if (actual >= predicate.count || !catastrophic
          && (previous === undefined || inventoryCount(previous, predicate.item) <= actual)) return [];
        return [{ item: predicate.item, required: predicate.count, actual }];
      });
      if (lost.length) mismatches.set(node.id, lost);
    }
    const nativeLosses = new Set(mismatches.keys());
    const derivedReasons = new Map<string, { invalidatedChildren: string[]; invalidatedDependencies: string[] }>();
    const expandInvalidations = (roots: Set<string>): Set<string> => {
      const invalidated = new Set(roots);
      derivedReasons.clear();
      let changed = true;
      while (changed) {
        changed = false;
        // An output lost now needs its explicitly ordered, still-missing inputs.
        // Tree edges alone never imply material prerequisite ordering.
        for (const id of [...invalidated]) {
          for (const dependencyId of this.nodes.get(id)!.dependsOn) {
            const dependency = this.nodes.get(dependencyId);
            if (dependency?.state !== 'verified' || invalidated.has(dependencyId)) continue;
            const missing = dependency.postconditions.flatMap(predicate => predicate.kind === 'inventory'
              && inventoryCount(current, predicate.item) < predicate.count
              ? [{ item: predicate.item, required: predicate.count,
                actual: inventoryCount(current, predicate.item) }] : []);
            if (!missing.length) continue;
            invalidated.add(dependencyId); mismatches.set(dependencyId, missing); changed = true;
          }
        }
        // A derived method has no independent output: its proof survives only
        // while its AND/OR child proof and explicit dependencies still hold.
        for (const node of this.nodes.values()) {
          if (node.state !== 'verified' || node.kind !== 'method' || node.postconditions.length
            || !node.evidenceRef?.startsWith('derived:children:') || invalidated.has(node.id)) continue;
          const children = [...(this.children.get(node.id) ?? [])];
          const invalidatedChildren = children.filter(id => this.nodes.get(id)?.state !== 'verified' || invalidated.has(id));
          const validChildren = children.length - invalidatedChildren.length;
          const invalidatedDependencies = node.dependsOn.filter(id => this.nodes.get(id)?.state !== 'verified' || invalidated.has(id));
          if (!invalidatedDependencies.length && (node.join === 'all'
            ? validChildren === children.length : validChildren > 0)) continue;
          invalidated.add(node.id);
          derivedReasons.set(node.id, { invalidatedChildren, invalidatedDependencies });
          changed = true;
        }
      }
      return invalidated;
    };
    const hasSurvivingNativeAncestor = (id: string, invalidated: Set<string>): boolean => {
      let parentId = this.nodes.get(id)?.parentId;
      while (parentId) {
        const parent = this.nodes.get(parentId)!;
        if (parent.state === 'verified' && parent.postconditions.length && !invalidated.has(parentId)) return true;
        parentId = parent.parentId;
      }
      return false;
    };
    // A still-held native output can preserve consumed inputs. A derived
    // method cannot do so by itself: otherwise death would leave missing food
    // or tools falsely verified beneath a now-empty aggregation node.
    let invalidated: Set<string>;
    while (true) {
      invalidated = expandInvalidations(nativeLosses);
      const retainedLosses = new Set([...nativeLosses].filter(id => {
        if (hasSurvivingNativeAncestor(id, invalidated)) return false;
        const dependentIds = [...(this.dependents.get(id) ?? [])];
        const pendingDependent = dependentIds.some(dependentId => this.nodes.get(dependentId)?.state !== 'verified');
        const survivingNativeOutput = dependentIds.some(dependentId => {
          const dependent = this.nodes.get(dependentId)!;
          return dependent.state === 'verified' && dependent.postconditions.length && !invalidated.has(dependentId);
        });
        return !survivingNativeOutput || pendingDependent;
      }));
      if (retainedLosses.size === nativeLosses.size) break;
      nativeLosses.clear();
      for (const id of retainedLosses) nativeLosses.add(id);
    }
    const entries = [...invalidated].map(nodeId => ({ nodeId,
      priorEvidenceRef: this.nodes.get(nodeId)?.evidenceRef,
      cause, mismatches: mismatches.get(nodeId) ?? [], ...derivedReasons.get(nodeId) }));
    if (entries.length || this.pendingDeath || JSON.stringify(current) !== JSON.stringify(this.lastObservedInventory))
      this.append('inventory-reconciled', { inventory: current, invalidations: entries });
    return [...invalidated];
  }

  /** Fixed-size retrieval: no full graph or receipt history is placed in a prompt. */
  projection(activeId?: string, maxReady = 12): { root: CampaignNode; activePath: CampaignNode[]; omittedAncestors: number;
      ready: CampaignNode[]; unresolvedActions: ReturnType<CampaignGoalGraph['getUncertainActions']>; totalNodes: number; revision: number } {
    const pathNodes: CampaignNode[] = [];
    let id = activeId;
    while (id) {
      const node = this.nodes.get(id); if (!node) break;
      pathNodes.unshift(structuredClone(node)); id = node.parentId ?? undefined;
    }
    const ready: CampaignNode[] = [];
    for (const nodeId of this.ready) {
      if (ready.length >= Math.max(1, Math.min(32, maxReady))) break;
      const node = this.nodes.get(nodeId);
      if (node && this.isActionable(nodeId)) ready.push(structuredClone(node));
    }
    const omittedAncestors = Math.max(0, pathNodes.length - 9);
    return { root: structuredClone(this.nodes.get('root')!), activePath: pathNodes.slice(-9), omittedAncestors, ready,
      unresolvedActions: this.getUncertainActions().slice(0, 8), totalNodes: this.nodes.size, revision: this.revision };
  }

  private append(kind: CampaignEvent['kind'], data: any): void {
    const event: CampaignEvent = { revision: this.revision + 1, at: new Date().toISOString(), kind, data };
    const fd = fs.openSync(this.journalPath, 'a', 0o600);
    try { fs.writeSync(fd, `${JSON.stringify(event)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.applyEvent(event);
    if (this.revision % SNAPSHOT_INTERVAL === 0) this.checkpoint();
  }

  checkpoint(): void {
    const snapshot: CampaignSnapshot = { schemaVersion: 1, id: this.id, worldId: this.worldId, goal: this.goal,
      revision: this.revision, nodes: [...this.nodes.values()], activeNodeId: this.activeNodeId,
      inFlight: [...this.inFlight.values()], recentReceipts: this.recentReceipts,
      recentPlanRepairs: this.recentPlanRepairs, recentProofInvalidations: this.recentProofInvalidations,
      lastObservedInventory: this.lastObservedInventory, pendingDeath: this.pendingDeath };
    const temporary = `${this.snapshotPath}.${process.pid}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify(snapshot)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.snapshotPath);
    const dirFd = fs.openSync(this.directory, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    // The fsynced snapshot contains every prior event. An older journal after
    // a crash is harmless (revisions are skipped); truncating it bounds replay.
    const journalFd = fs.openSync(this.journalPath, 'w', 0o600);
    try { fs.fsyncSync(journalFd); } finally { fs.closeSync(journalFd); }
  }

  private applyEvent(event: CampaignEvent): void {
    if (event.kind === 'plan') {
      for (const op of event.data.operations) {
        if (op.action === 'create-root') {
          this.nodes.set(op.id, { id: op.id, parentId: null, goal: op.goal,
            kind: 'outcome', join: 'all', dependsOn: [], postconditions: op.postconditions, state: 'pending', attempts: 0 });
          this.refreshReady(op.id);
        } else if (op.action === 'create') {
          this.nodes.set(op.id, { id: op.id, parentId: op.parentId, goal: op.goal,
            kind: op.kind, join: op.join ?? 'all', dependsOn: op.dependsOn ?? [], postconditions: op.postconditions ?? [],
            state: 'pending', sealed: op.kind === 'method' ? false : undefined, attempts: 0 });
          if (!this.children.has(op.parentId)) this.children.set(op.parentId, new Set());
          this.children.get(op.parentId)!.add(op.id);
          const counts = this.childCounts.get(op.parentId) ?? { total: 0, verified: 0 };
          counts.total++; this.childCounts.set(op.parentId, counts);
          for (const dep of op.dependsOn ?? []) {
            if (!this.dependents.has(dep)) this.dependents.set(dep, new Set());
            this.dependents.get(dep)!.add(op.id);
          }
          this.refreshSubtreeReady(op.id);
          if (counts.total === 1 || this.nodes.get(op.parentId)?.join === 'all') this.ready.delete(op.parentId);
          this.touch(op.id, event.revision);
        }
        else if (op.action === 'revise') {
          const node = this.nodes.get(op.id)!;
          const before = { join: node.join, postconditions: structuredClone(node.postconditions) };
          if (op.postconditions !== undefined) node.postconditions = structuredClone(op.postconditions);
          if (op.join !== undefined) node.join = op.join;
          const recorded = event.data.repairs?.find((repair: CampaignPlanRepairAudit) => repair.nodeId === op.id);
          this.recentPlanRepairs.push({ revision: event.revision, at: event.at, nodeId: op.id,
            reason: recorded?.reason ?? op.reason,
            before: structuredClone(recorded?.before ?? before),
            after: structuredClone(recorded?.after ?? { join: node.join, postconditions: node.postconditions }) });
          this.recentPlanRepairs = this.recentPlanRepairs.slice(-REPAIR_AUDIT_LIMIT);
          node.state = 'pending';
          node.blocker = undefined;
          node.evidenceRef = undefined;
          if (this.activeNodeId === node.id) this.activeNodeId = undefined;
          this.refreshSubtreeReady(node.id);
          this.touch(node.id, event.revision);
        }
        else if (op.action === 'seal-method' || op.action === 'unseal-method') {
          const node = this.nodes.get(op.id)!;
          node.sealed = op.action === 'seal-method';
          node.sealReason = op.reason;
          node.sealRevision = event.revision;
          this.refreshReady(node.id);
          this.touch(node.id, event.revision);
        }
        else if (op.action === 'set-state') {
          const node = this.nodes.get(op.id)!;
          node.state = op.state;
          node.blocker = op.state === 'blocked' ? (op.blocker ?? 'unknown') : undefined;
          if (op.state === 'active') { node.attempts++; this.activeNodeId = node.id; }
          else if (this.activeNodeId === node.id) this.activeNodeId = undefined;
          this.refreshSubtreeReady(op.id);
          this.touch(op.id, event.revision);
        }
        else throw new Error('CAMPAIGN_OPERATION_INVALID');
      }
    } else if (event.kind === 'proof' || event.kind === 'structural-proof') {
      const node = this.nodes.get(event.data.nodeId)!;
      if (event.kind === 'structural-proof') {
        const counts = this.childCounts.get(node.id);
        if (node.kind !== 'method' || !node.sealed || node.postconditions.length || !['pending', 'active'].includes(node.state)
          || !counts?.total || !node.dependsOn.every(dep => this.nodes.get(dep)?.state === 'verified')
          || (node.join === 'all' ? counts.verified !== counts.total : counts.verified === 0)
          || event.data.join !== node.join || event.data.verifiedChildCount !== counts.verified
          || event.data.totalChildCount !== counts.total
          || typeof event.data.evidenceRef !== 'string' || !event.data.evidenceRef.startsWith(`derived:children:${node.id}:`))
          throw new Error(`CAMPAIGN_STRUCTURAL_PROOF_INVALID:${node.id}`);
      }
      node.state = 'verified'; node.evidenceRef = event.data.evidenceRef; node.blocker = undefined;
      this.touch(node.id, event.revision);
      if (this.activeNodeId === node.id) this.activeNodeId = undefined;
      if (node.parentId) this.childCounts.get(node.parentId)!.verified++;
      this.refreshSubtreeReady(node.id);
      for (const id of this.dependents.get(node.id) ?? []) this.refreshSubtreeReady(id);
      if (node.parentId) this.refreshReady(node.parentId);
    } else if (event.kind === 'action-started') {
      this.inFlight.set(event.data.actionId, event.data);
      this.markActed(event.data.nodeId, event.revision);
    } else if (event.kind === 'action-finished') {
      const action = this.inFlight.get(event.data.actionId)!;
      this.inFlight.delete(event.data.actionId);
      this.markActed(action.nodeId, event.revision);
      this.recentReceipts.push({ actionId: action.actionId, nodeId: action.nodeId,
        success: event.data.success, summary: event.data.summary });
      this.recentReceipts = this.recentReceipts.slice(-64);
      if (event.data.inventory) this.lastObservedInventory = event.data.inventory;
    } else if (event.kind === 'actor-death') {
      this.pendingDeath = { reason: event.data.reason, inventory: event.data.inventory };
    } else if (event.kind === 'inventory-reconciled') {
      this.lastObservedInventory = event.data.inventory;
      this.pendingDeath = undefined;
      for (const entry of event.data.invalidations as Array<Omit<CampaignProofInvalidationAudit, 'revision' | 'at'>>) {
        const node = this.nodes.get(entry.nodeId)!;
        node.state = 'pending'; node.evidenceRef = undefined; node.blocker = undefined;
        this.touch(node.id, event.revision);
        if (this.activeNodeId === node.id) this.activeNodeId = undefined;
        this.recentProofInvalidations.push({ ...entry, revision: event.revision, at: event.at });
      }
      this.recentProofInvalidations = this.recentProofInvalidations.slice(-INVALIDATION_AUDIT_LIMIT);
      if (event.data.invalidations.length) this.rebuildIndexes();
    }
    this.revision = event.revision;
  }

  private markActed(id: string | undefined, revision: number): void {
    for (let node = id ? this.nodes.get(id) : undefined; node; node = node.parentId ? this.nodes.get(node.parentId) : undefined)
      this.actedAt.set(node.id, revision);
  }

  /** Record a change to a node and, through it, to its parent's child set. */
  private touch(id: string, revision: number): void {
    this.changedAt.set(id, revision);
    const parentId = this.nodes.get(id)?.parentId;
    if (parentId) this.changedAt.set(parentId, revision);
  }

  private rebuildIndexes(): void {
    this.children.clear(); this.childCounts.clear(); this.dependents.clear(); this.ready.clear();
    for (const node of this.nodes.values()) {
      if (node.parentId) {
        if (!this.children.has(node.parentId)) this.children.set(node.parentId, new Set());
        this.children.get(node.parentId)!.add(node.id);
        const counts = this.childCounts.get(node.parentId) ?? { total: 0, verified: 0 };
        counts.total++; if (node.state === 'verified') counts.verified++;
        this.childCounts.set(node.parentId, counts);
      }
      for (const dep of node.dependsOn) {
        if (!this.dependents.has(dep)) this.dependents.set(dep, new Set());
        this.dependents.get(dep)!.add(node.id);
      }
    }
    for (const node of this.nodes.values()) this.refreshReady(node.id);
  }
  private hasVerifiedDescendant(id: string): boolean {
    const pending = [...(this.children.get(id) ?? [])];
    while (pending.length) {
      const childId = pending.pop()!;
      if (this.nodes.get(childId)?.state === 'verified') return true;
      pending.push(...(this.children.get(childId) ?? []));
    }
    return false;
  }
  private hasInFlightActionWithin(id: string): boolean {
    for (const action of this.inFlight.values()) {
      let nodeId: string | null = action.nodeId;
      while (nodeId) {
        if (nodeId === id) return true;
        nodeId = this.nodes.get(nodeId)?.parentId ?? null;
      }
    }
    return false;
  }
  private hasClosedAncestor(id: string): boolean {
    let parentId = this.nodes.get(id)?.parentId ?? null;
    while (parentId) {
      const parent = this.nodes.get(parentId);
      if (!parent || parent.state === 'verified' || parent.state === 'abandoned') return true;
      parentId = parent.parentId;
    }
    return false;
  }
  private refreshReady(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    const counts = this.childCounts.get(id);
    const eligible = this.isActionable(id)
      && (node.kind !== 'method' || (node.sealed && Boolean(counts?.total)))
      && (!counts?.total || (node.join === 'all' ? counts.verified === counts.total : counts.verified > 0));
    if (eligible) this.ready.add(id); else this.ready.delete(id);
  }

  /** An ancestor's state or dependency gates every descendant's frontier entry. */
  private refreshSubtreeReady(id: string): void {
    const pending = [id];
    while (pending.length) {
      const next = pending.pop()!;
      this.refreshReady(next);
      pending.push(...(this.children.get(next) ?? []));
    }
  }
}
