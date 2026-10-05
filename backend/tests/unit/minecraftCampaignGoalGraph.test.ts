import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CampaignGoalGraph, type CampaignPlanOperation } from '../../src/services/minebot/cognition/CampaignGoalGraph.js';
import { reconcileCampaignReadyActions } from '../../src/services/minebot/cognition/CampaignGoalReconciler.js';
import { assertKnownInventoryPredicateItems, assertRevisionPreservesItemPurpose, similarItemNames, unknownCampaignFrontierItems } from '../../src/services/minebot/cognition/CampaignPredicateValidation.js';
import minecraftData from 'minecraft-data';
import { GoalVerifier } from '../../src/services/minebot/cognition/GoalVerifier.js';
import { captureWorldObservation } from '../../src/services/minebot/cognition/worldFrame.js';
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
vi.mock('../../src/config/env.js', () => ({ config: { anthropic: { apiKey: 'test-only', model: 'test-model' } } }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { UI_MOD_BASE_URL: 'http://example.invalid' } }));
import { factSources, knowledgeIntoHistory, observationForPrompt, ShannonExecutor, withLiveState } from '../../src/services/llm/graph/ShannonExecutor.js';

const directories: string[] = [];
const contract = [{ kind: 'boss_defeated' as const, entity: 'ender_dragon' as const, dimension: 'the_end' as const }];
const inventoryObservation = (items: Array<{ name: string; count: number }>) =>
  captureWorldObservation({ inventory: { items: () => items } });
function open(id = 'dragon') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-campaign-'));
  directories.push(directory);
  return { directory, graph: CampaignGoalGraph.open({ directory, id, worldId: 'isolated-world', goal: 'エンダードラゴンを討伐する', success: contract }) };
}
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('durable campaign goal graph', () => {
  it('requires exact versioned inventory item IDs but keeps valid silk-touch drops legal', () => {
    const registry = { itemsByName: { beef: { id: 1 }, raw_iron: { id: 2 }, iron_ore: { id: 3 } } };
    expect(() => assertKnownInventoryPredicateItems([{ kind: 'inventory', item: 'food', count: 1 }], registry))
      .toThrow('GOAL_ITEM_UNKNOWN:food');
    // Paid run L13 asked for raw_beef; name the registry IDs that share its words.
    expect(similarItemNames('raw_beef', minecraftData('1.21.11'))).toEqual(expect.arrayContaining(['beef', 'cooked_beef']));
    expect(similarItemNames('raw_beef', minecraftData('1.21.11'))[0]).toBe('beef');
    expect(() => assertKnownInventoryPredicateItems([{ kind: 'inventory', item: 'raw_beef', count: 1 }], minecraftData('1.21.11')))
      .toThrow(/raw_beefに近い登録ID: beef/);
    expect(() => assertKnownInventoryPredicateItems([{ kind: 'inventory', item: 'beef', count: 1 },
      { kind: 'produced', item: 'raw_iron', count: 1 }, { kind: 'inventory', item: 'iron_ore', count: 1 }], registry))
      .not.toThrow();
    const { graph } = open();
    graph.applyPlan([{ action: 'create', id: 'legacy_food', parentId: 'root', goal: '食料を確保', kind: 'action',
      postconditions: [{ kind: 'inventory', item: 'food', count: 1 }] }]);
    expect(unknownCampaignFrontierItems(graph, registry)).toEqual([{ nodeId: 'legacy_food', item: 'food' }]);
    expect(graph.getNode('legacy_food')?.state).toBe('pending');
  });

  it('rejects a new category predicate before persisting the planner batch', async () => {
    const { graph } = open();
    const bot: any = Object.assign(new EventEmitter(), { registry: { itemsByName: { beef: { id: 1 } } },
      inventory: { items: () => [] }, entity: { position: { x: 0, y: 64, z: 0 } },
      game: { dimension: 'overworld' }, entities: {}, health: 20, food: 20 });
    const outputs = [
      [{ type: 'tool_use', id: 'bad', name: 'manage-campaign-goals', input: { operations: [
        { action: 'create', id: 'bad_food', parentId: 'root', goal: 'food', kind: 'action',
          postconditions: [{ kind: 'inventory', item: 'food', count: 1 }] }], activeNodeId: 'bad_food' } }],
      [{ type: 'tool_use', id: 'good', name: 'manage-campaign-goals', input: { operations: [
        { action: 'create', id: 'beef_food', parentId: 'root', goal: 'beef', kind: 'action',
          postconditions: [{ kind: 'inventory', item: 'beef', count: 1 }] }], activeNodeId: 'beef_food' } }],
    ];
    let turn = 0;
    const modelClient: any = { messages: { stream: () => ({ finalMessage: async () => ({
      content: outputs[turn++] ?? [{ type: 'text', text: '続行' }], usage: {},
    }) }) } };
    const result = await new ShannonExecutor({ modelClient, modelIdentity: { provider: 'fixture', model: 'fixture' },
      campaign: graph, publishTaskTree: () => {}, bot }).run({ runId: 'validity-run', goal: graph.goal,
      context: null, systemPrompt: 'Use tools', goalContract: { goal: graph.goal, predicates: contract }, tools: [] });
    expect(graph.getNode('bad_food')).toBeUndefined();
    expect(graph.getNode('beef_food')?.state).toBe('active');
    expect(JSON.stringify(result.messages)).toContain('GOAL_ITEM_UNKNOWN:food');
  });

  it('requires a join-only legacy repair to fix its invalid item predicate too', async () => {
    const { graph } = open();
    graph.applyPlan([{ action: 'create', id: 'safe_food', parentId: 'root', goal: '食料', kind: 'action',
      postconditions: [{ kind: 'inventory', item: 'food', count: 1 }] }]);
    const observedRevision = graph.currentRevision;
    const bot: any = Object.assign(new EventEmitter(), { registry: { itemsByName: { beef: { id: 1 } } },
      inventory: { items: () => [{ name: 'beef', count: 2 }] }, entity: { position: { x: 0, y: 64, z: 0 } },
      game: { dimension: 'overworld' }, entities: {}, health: 20, food: 20 });
    const outputs = [
      [{ type: 'tool_use', id: 'join-only', name: 'manage-campaign-goals', input: {
        expectedRevision: observedRevision + 1, operations: [{ action: 'revise', id: 'safe_food', join: 'any', reason: '食料は代替' }],
      } }],
      [{ type: 'tool_use', id: 'join-and-item', name: 'manage-campaign-goals', input: {
        expectedRevision: observedRevision + 1, operations: [{ action: 'revise', id: 'safe_food', join: 'any',
          postconditions: [{ kind: 'inventory', item: 'beef', count: 1 }], reason: '確認済みの牛肉へ訂正' }],
      } }],
    ];
    let turn = 0;
    const modelClient: any = { messages: { stream: () => ({ finalMessage: async () => ({
      content: outputs[turn++] ?? [{ type: 'text', text: '続行' }], usage: {},
    }) }) } };
    const result = await new ShannonExecutor({ modelClient, modelIdentity: { provider: 'fixture', model: 'fixture' },
      campaign: graph, publishTaskTree: () => {}, bot }).run({ runId: 'legacy-repair', goal: graph.goal,
      context: null, systemPrompt: 'Use tools', goalContract: { goal: graph.goal, predicates: contract }, tools: [] });
    expect(graph.getNode('safe_food')?.postconditions).toEqual([{ kind: 'inventory', item: 'beef', count: 1 }]);
    expect(graph.getNode('safe_food')?.join).toBe('any');
    // The valid repair is one revision; the following frontier pass may add
    // a separate native proof for the already-held beef.
    expect(graph.currentRevision).toBeGreaterThanOrEqual(observedRevision + 1);
    expect(JSON.stringify(result.messages)).toContain('GOAL_ITEM_UNKNOWN:food');
  });

  it('keeps an item revision within the node purpose using the versioned registry', () => {
    const registry = minecraftData('1.21.11');
    const inv = (item: string, count = 1) => [{ kind: 'inventory' as const, item, count }];
    const allowed: Array<[string, string]> = [['iron_ore', 'raw_iron'], ['raw_iron', 'iron_ingot'],
      ['deepslate_iron_ore', 'iron_ingot'], ['cooked_porkchop', 'porkchop'], ['beef', 'mutton'],
      ['oak_log', 'spruce_log'], ['wooden_pickaxe', 'stone_pickaxe'], ['stone', 'cobblestone'],
      ['cobblestone', 'cobbled_deepslate'], ['food', 'beef'], ['logs', 'birch_log']];
    for (const [from, to] of allowed)
      expect(() => assertRevisionPreservesItemPurpose('n', inv(from), inv(to), registry), `${from}->${to}`).not.toThrow();
    const rejected: Array<[string, string]> = [['beef', 'oak_log'], ['food', 'oak_log'], ['iron_ore', 'cobblestone'],
      ['stone_pickaxe', 'stone_sword'], ['raw_iron', 'raw_gold']];
    for (const [from, to] of rejected)
      expect(() => assertRevisionPreservesItemPurpose('n', inv(from), inv(to), registry), `${from}->${to}`)
        .toThrow(`CAMPAIGN_REVISION_ITEM_PURPOSE_CHANGED:n:${from}->${to}`);
    expect(() => assertRevisionPreservesItemPurpose('n', inv('beef', 8), [{ kind: 'breathing_safe' }], registry))
      .toThrow('CAMPAIGN_REVISION_ITEM_PURPOSE_CHANGED:n:beef->(no item)');
    expect(() => assertRevisionPreservesItemPurpose('n', [{ kind: 'breathing_safe' }], inv('oak_log'), registry)).not.toThrow();
    expect(() => assertRevisionPreservesItemPurpose('n', inv('beef', 8), inv('beef', 3), registry)).not.toThrow();
    expect(() => assertRevisionPreservesItemPurpose('n', inv('beef'), undefined, registry)).not.toThrow();
  });

  it('refuses the observed food-to-log revision before it can be natively verified', async () => {
    const { graph } = open();
    graph.applyPlan([{ action: 'create', id: 'food', parentId: 'root', goal: '食料を確保する', kind: 'action',
      postconditions: [{ kind: 'inventory', item: 'beef', count: 8 }] }]);
    const bot: any = Object.assign(new EventEmitter(), { registry: minecraftData('1.21.11'),
      inventory: { items: () => [{ name: 'oak_log', count: 7 }] }, entity: { position: { x: 0, y: 64, z: 0 } },
      game: { dimension: 'overworld' }, entities: {}, health: 20, food: 20 });
    const outputs = [
      [{ type: 'tool_use', id: 'drift', name: 'manage-campaign-goals', input: { operations: [
        { action: 'revise', id: 'food', postconditions: [{ kind: 'inventory', item: 'oak_log', count: 7 }],
          reason: '牛が見つからないので木材確保へ訂正' }] } }],
    ];
    let turn = 0;
    const modelClient: any = { messages: { stream: () => ({ finalMessage: async () => ({
      content: outputs[turn++] ?? [{ type: 'text', text: '続行' }], usage: {},
    }) }) } };
    const result = await new ShannonExecutor({ modelClient, modelIdentity: { provider: 'fixture', model: 'fixture' },
      campaign: graph, publishTaskTree: () => {}, bot }).run({ runId: 'purpose-drift', goal: graph.goal,
      context: null, systemPrompt: 'Use tools', goalContract: { goal: graph.goal, predicates: contract }, tools: [] });
    expect(graph.getNode('food')?.postconditions).toEqual([{ kind: 'inventory', item: 'beef', count: 8 }]);
    expect(graph.getNode('food')?.state).not.toBe('verified');
    expect(JSON.stringify(result.messages)).toContain('CAMPAIGN_REVISION_ITEM_PURPOSE_CHANGED:food:beef->oak_log');
  });

  it('native-reconciles already satisfied ready leaves without closing the dragon root or unsatisfied work', () => {
    const { graph } = open();
    graph.applyPlan([
      { action: 'create', id: 'prep', parentId: 'root', goal: '準備', kind: 'method' },
      { action: 'create', id: 'stone', parentId: 'prep', goal: '石を確保', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'cobblestone', count: 8 }] },
      { action: 'create', id: 'smelt_remaining', parentId: 'prep', goal: '鉄3個', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'iron_ingot', count: 3 }] },
      { action: 'create', id: 'iron_pickaxe', parentId: 'prep', goal: '鉄のツルハシを作る', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'iron_pickaxe', count: 1 }] },
    ], 'stone');
    const bot = { inventory: { items: () => [{ name: 'cobblestone', count: 50 }, { name: 'iron_ingot', count: 3 }] } };
    const verifier = new GoalVerifier(bot);
    expect(reconcileCampaignReadyActions(graph, verifier)).toEqual(['stone', 'smelt_remaining']);
    expect(graph.getNode('stone')?.state).toBe('verified');
    expect(graph.getNode('smelt_remaining')?.state).toBe('verified');
    expect(graph.getNode('iron_pickaxe')?.state).toBe('pending');
    expect(graph.isReady('iron_pickaxe')).toBe(true);
    expect(graph.getNode('root')?.state).toBe('pending');
    expect(reconcileCampaignReadyActions(graph, verifier)).toEqual([]);
    // The planner names the node the world has just finished (it may not have noticed, or wants to say "done").
    // The commonest refusal of all (17 of 43 in L32): now the other operations stand and nothing is selected.
    const revision = graph.currentRevision;
    const named = graph.applyPlan([{ action: 'create', id: 'sticks', parentId: 'prep', goal: '棒', kind: 'action',
      postconditions: [{ kind: 'inventory', item: 'stick', count: 2 }] }], 'stone');
    expect(named).toMatchObject({ releasedActiveId: 'stone', releasedReason: 'verified' });
    expect(graph.getNode('sticks')?.state).toBe('pending');
    expect(graph.getNode('stone')?.state).toBe('verified');
    expect(graph.getActiveId()).not.toBe('stone');
    expect(graph.currentRevision).toBeGreaterThan(revision);
    // Naming it with nothing else to do changes nothing and is not an error either.
    expect(graph.applyPlan([], 'stone')).toMatchObject({ releasedActiveId: 'stone', releasedReason: 'verified' });
    verifier.dispose();
  });

  it('explains the exact blocked activation and keeps an invalid batch atomic', () => {
    const { graph } = open();
    graph.applyPlan([
      { action: 'create', id: 'wood', parentId: 'root', goal: '木材', kind: 'action' },
      { action: 'create', id: 'tool', parentId: 'root', goal: '道具', kind: 'action', dependsOn: ['wood'] },
    ]);
    const revision = graph.currentRevision;
    expect(() => graph.applyPlan([{ action: 'create', id: 'later', parentId: 'root', goal: '後続', kind: 'action' }], 'tool'))
      .toThrow('CAMPAIGN_ACTIVE_NODE_NOT_READY:tool:state=pending:unmet_dependencies=["wood"]');
    expect(graph.getNode('later')).toBeUndefined();
    expect(graph.currentRevision).toBe(revision);
    // Closing a node while naming it is one statement, not a contradiction: the closure stands, nothing is selected.
    expect(graph.applyPlan([{ action: 'set-state', id: 'wood', state: 'blocked', blocker: '未発見' }], 'wood')).toMatchObject({ releasedActiveId: 'wood' });
    expect(graph.getNode('wood')?.state).toBe('blocked');
    expect(graph.getActiveId()).not.toBe('wood');
  });

  it('does not call a planner stale for its own actions, only for a change to what it edits (paid run L17 lost 8 turns)', () => {
    const { graph } = open();
    graph.applyPlan([
      { action: 'create', id: 'hunt', parentId: 'root', goal: '狩る', kind: 'action' },
      { action: 'create', id: 'fish', parentId: 'root', goal: '釣る', kind: 'action' },
    ], 'hunt');
    const seen = graph.currentRevision;
    graph.beginAction('a1', 'hunt', 'attack-entity'); graph.finishAction('a1', false, '見つからない');
    expect(graph.currentRevision).toBeGreaterThan(seen);
    // Blocking the node it just worked under, creating an alternative and fixing a leaf contract all go through.
    graph.applyPlan([{ action: 'set-state', id: 'hunt', state: 'blocked', blocker: '獲物なし' },
      { action: 'create', id: 'forage', parentId: 'root', goal: '採集', kind: 'action' }], 'forage', seen);
    expect(graph.getNode('hunt')?.state).toBe('blocked');
    // A node someone else changed since is stale, and the message says which and what to resend.
    const before = graph.currentRevision;
    graph.applyPlan([{ action: 'set-state', id: 'fish', state: 'blocked', blocker: '水なし' }]);
    expect(() => graph.applyPlan([{ action: 'set-state', id: 'fish', state: 'pending' }], undefined, before))
      .toThrow(`fishがその後に変わっています。最新の状態を確認し、expectedRevision=${graph.currentRevision}で出し直してください`);
    expect(() => graph.applyPlan([{ action: 'set-state', id: 'forage', state: 'pending' }], undefined, graph.currentRevision + 5))
      .toThrow('CAMPAIGN_REVISION_STALE');
  });

  it('says how to proceed when a selection contradicts its own batch (paid run L11 resent such batches 20+ times)', () => {
    const { graph } = open();
    graph.applyPlan([{ action: 'create', id: 'wood', parentId: 'root', goal: '木材', kind: 'action' }]);
    // L11 to L33: a planner closing the node it names kept being refused, whatever the refusal said. It is accepted now.
    const closed = graph.applyPlan([{ action: 'set-state', id: 'wood', state: 'blocked', blocker: '未発見' }], 'wood');
    expect(closed.releasedActiveId).toBe('wood');
    expect(graph.getNode('wood')).toMatchObject({ state: 'blocked', blocker: '未発見' });
    expect(() => graph.applyPlan([{ action: 'create', id: 'other', parentId: 'root', goal: '別', kind: 'action' }], 'wood'))
      .toThrow('{"action":"set-state","id":"wood","state":"pending"}');
    graph.applyPlan([{ action: 'set-state', id: 'wood', state: 'pending' }], 'wood');
    expect(graph.getNode('wood')?.state).toBe('active');
    expect(() => graph.applyPlan([{ action: 'revise', id: 'wood', reason: '' } as any]))
      .toThrow('CAMPAIGN_REVISION_INVALID:wood（postconditionsかjoinの少なくとも一方が必要です）');
    // Paid runs L12/L13: block a node for a missing prerequisite, then aim at it or at a child under it.
    expect(graph.applyPlan([{ action: 'set-state', id: 'wood', state: 'blocked', blocker: '前提不足' },
      { action: 'create', id: 'prereq', parentId: 'root', goal: '前提', kind: 'action' }], 'wood').releasedActiveId).toBe('wood');
    expect(graph.getNode('prereq')?.state).toBe('pending');
    expect(graph.getNode('wood')?.state).toBe('blocked');
    expect(() => graph.applyPlan([{ action: 'set-state', id: 'wood', state: 'blocked', blocker: '前提不足' },
      { action: 'create', id: 'child', parentId: 'wood', goal: '前提', kind: 'action' }], 'child'))
      .toThrow('同じ呼び出しでwoodをpendingに戻してください');
  });

  it('gates a deep frontier by every ancestor dependency and refreshes it after proof and state changes', () => {
    const { directory, graph } = open();
    graph.applyPlan([
      { action: 'create', id: 'survive', parentId: 'root', goal: '生存する', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'bread', count: 1 }] },
      { action: 'create', id: 'gather', parentId: 'root', goal: '討伐準備', kind: 'method', dependsOn: ['survive'] },
      { action: 'create', id: 'nether', parentId: 'gather', goal: 'ネザー素材', kind: 'method' },
      { action: 'create', id: 'nether_search', parentId: 'nether', goal: '素材探索', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'blaze_rod', count: 1 }] },
    ]);
    expect(graph.isReady('nether_search')).toBe(false);
    expect(graph.projection().ready.map(node => node.id)).not.toContain('nether_search');
    const revision = graph.currentRevision;
    expect(() => graph.applyPlan([], 'nether_search'))
      .toThrow('CAMPAIGN_ACTIVE_NODE_NOT_READY:nether_search:ancestor=gather:pending:unmet_dependencies=["survive"]');
    expect(graph.currentRevision).toBe(revision);

    const verifier = new GoalVerifier({ inventory: { items: () => [{ name: 'bread', count: 1 }] } });
    const proof = verifier.verify({ goal: '生存する', predicates: graph.getNode('survive')!.postconditions });
    expect(graph.recordProof('survive', proof, 'native:bread')).toBe(true);
    expect(graph.isReady('nether_search')).toBe(true);
    expect(graph.projection().ready.map(node => node.id)).toContain('nether_search');

    graph.applyPlan([{ action: 'set-state', id: 'gather', state: 'blocked', blocker: '要再計画' }]);
    expect(graph.isReady('nether_search')).toBe(false);
    expect(graph.projection().ready.map(node => node.id)).not.toContain('nether_search');
    expect(() => graph.applyPlan([], 'nether_search'))
      .toThrow('CAMPAIGN_ACTIVE_NODE_NOT_READY:nether_search:ancestor=gather:blocked');
    graph.applyPlan([{ action: 'set-state', id: 'gather', state: 'pending' }]);
    expect(graph.isReady('nether_search')).toBe(true);
    expect(graph.projection().ready.map(node => node.id)).toContain('nether_search');
    graph.checkpoint();
    const resumed = CampaignGoalGraph.open({ directory, id: 'dragon', worldId: 'isolated-world',
      goal: 'エンダードラゴンを討伐する', success: contract });
    expect(resumed.isReady('nether_search')).toBe(true);
    verifier.dispose();
  });

  it('keeps sibling dependencies on both a branch and its nested result until both are proven', () => {
    const { graph } = open();
    graph.applyPlan([
      { action: 'create', id: 'prep', parentId: 'root', goal: '探索準備', kind: 'method',
        postconditions: [{ kind: 'inventory', item: 'ender_eye', count: 1 }] },
      { action: 'create', id: 'stronghold', parentId: 'prep', goal: '要塞準備', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'ender_eye', count: 1 }] },
      { action: 'create', id: 'dragon_fight', parentId: 'root', goal: '討伐', kind: 'action',
        dependsOn: ['prep', 'stronghold'], postconditions: contract },
    ]);
    graph.applyPlan([{ action: 'seal-method', id: 'prep', reason: '要塞準備の子を計画済み' }], undefined, graph.currentRevision);
    expect(graph.isReady('dragon_fight')).toBe(false);
    const verifier = new GoalVerifier({ inventory: { items: () => [{ name: 'ender_eye', count: 1 }] } });
    const strongholdProof = verifier.verify({ goal: '要塞準備', predicates: graph.getNode('stronghold')!.postconditions });
    expect(graph.recordProof('stronghold', strongholdProof, 'native:stronghold')).toBe(true);
    expect(graph.isReady('dragon_fight')).toBe(false);
    const prepProof = verifier.verify({ goal: '探索準備', predicates: graph.getNode('prep')!.postconditions });
    expect(graph.recordProof('prep', prepProof, 'native:prep')).toBe(true);
    expect(graph.isReady('dragon_fight')).toBe(true);
    verifier.dispose();
  });

  it('keeps a trivially true native method open until its child set is explicitly sealed', () => {
    const { directory, graph } = open();
    const bot: any = Object.assign(new EventEmitter(), { entity: { position: { x: 0, y: 64, z: 0 }, isInWater: false },
      game: { dimension: 'overworld' }, inventory: { items: () => [
        { name: 'bread', count: 1 }, { name: 'stone_pickaxe', count: 1 }] },
      entities: {}, health: 20, food: 20, oxygenLevel: 400,
      blockAt: () => ({ name: 'air', boundingBox: 'empty' }) });
    const verifier = new GoalVerifier(bot);
    graph.applyPlan([{ action: 'create', id: 'prep', parentId: 'root', goal: '食料と道具を整える', kind: 'method',
      postconditions: [{ kind: 'breathing_safe' }] }], 'prep');
    const prep = graph.getNode('prep')!;
    const breathingProof = verifier.verify({ goal: prep.goal, predicates: prep.postconditions });
    expect(breathingProof.status).toBe('verified');
    expect(graph.isReady('prep')).toBe(false);
    expect(graph.recordProof('prep', breathingProof, 'native:breathing')).toBe(false);
    expect(reconcileCampaignReadyActions(graph, verifier)).not.toContain('prep');
    expect(graph.getNode('prep')?.state).toBe('active');

    graph.applyPlan([{ action: 'create', id: 'food', parentId: 'prep', goal: '食料', kind: 'action',
      postconditions: [{ kind: 'inventory', item: 'bread', count: 1 }] }]);
    const food = graph.getNode('food')!;
    expect(graph.recordProof('food', verifier.verify({ goal: food.goal, predicates: food.postconditions }), 'native:food')).toBe(true);
    expect(graph.getNode('prep')?.state).toBe('active');
    expect(graph.isReady('prep')).toBe(false);
    graph.applyPlan([
      { action: 'create', id: 'tools', parentId: 'prep', goal: '道具', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'stone_pickaxe', count: 1 }] },
      { action: 'seal-method', id: 'prep', reason: '食料と道具の両方を計画した' },
    ], undefined, graph.currentRevision);
    expect(graph.getNode('prep')?.sealed).toBe(true);
    expect(graph.isReady('prep')).toBe(false);
    expect(() => graph.applyPlan([{ action: 'create', id: 'late_child', parentId: 'prep', goal: '未計画', kind: 'action' }]))
      .toThrow('CAMPAIGN_METHOD_SEALED:prep');
    expect(() => graph.applyPlan([{ action: 'seal-method', id: 'root', reason: '不正' }], undefined, graph.currentRevision))
      .toThrow('CAMPAIGN_METHOD_SEAL_INVALID:root');
    const tools = graph.getNode('tools')!;
    expect(graph.recordProof('tools', verifier.verify({ goal: tools.goal, predicates: tools.postconditions }), 'native:tools')).toBe(true);
    expect(graph.isReady('prep')).toBe(true);
    expect(reconcileCampaignReadyActions(graph, verifier)).toContain('prep');
    expect(graph.getNode('prep')?.state).toBe('verified');
    expect(graph.getNode('root')?.state).toBe('pending');
    graph.checkpoint();
    const resumed = CampaignGoalGraph.open({ directory, id: 'dragon', worldId: 'isolated-world',
      goal: 'エンダードラゴンを討伐する', success: contract });
    expect(resumed.getNode('prep')).toMatchObject({ state: 'verified', sealed: true,
      sealReason: '食料と道具の両方を計画した' });
    verifier.dispose();
  });

  it('treats an older snapshot without a method seal as still expandable', () => {
    const { directory, graph } = open();
    graph.applyPlan([{ action: 'create', id: 'legacy_prep', parentId: 'root', goal: '準備', kind: 'method',
      postconditions: [{ kind: 'inventory', item: 'bread', count: 1 }] }]);
    graph.checkpoint();
    const snapshotPath = path.join(directory, 'dragon.snapshot.json');
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    const method = snapshot.nodes.find((node: { id: string }) => node.id === 'legacy_prep');
    delete method.sealed;
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
    const resumed = CampaignGoalGraph.open({ directory, id: 'dragon', worldId: 'isolated-world',
      goal: 'エンダードラゴンを討伐する', success: contract });
    expect(resumed.getNode('legacy_prep')?.sealed).toBeUndefined();
    expect(resumed.isReady('legacy_prep')).toBe(false);
    resumed.applyPlan([{ action: 'create', id: 'late_food', parentId: 'legacy_prep', goal: '食料', kind: 'action',
      postconditions: [{ kind: 'inventory', item: 'bread', count: 1 }] }]);
    expect(resumed.getNode('late_food')).toBeDefined();
  });

  it('derives empty-contract methods from child proofs through the dragon plan but never closes the root', () => {
    const { directory, graph } = open();
    graph.applyPlan([
      { action: 'create', id: 'prep', parentId: 'root', goal: '討伐準備', kind: 'method', join: 'all' },
      { action: 'create', id: 'survive', parentId: 'prep', goal: '生存準備', kind: 'method', join: 'all' },
      { action: 'create', id: 'gather', parentId: 'prep', goal: '素材収集', kind: 'method', join: 'all', dependsOn: ['survive'] },
      { action: 'create', id: 'nether', parentId: 'gather', goal: 'ネザー素材', kind: 'method', join: 'all' },
      { action: 'create', id: 'stronghold', parentId: 'gather', goal: '要塞攻略', kind: 'method', join: 'all', dependsOn: ['nether'] },
      { action: 'create', id: 'dragon_fight', parentId: 'root', goal: 'エンドラを倒す', kind: 'action',
        dependsOn: ['prep', 'stronghold'], postconditions: contract },
      { action: 'create', id: 'survive_food', parentId: 'survive', goal: '食料', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'bread', count: 1 }] },
      { action: 'create', id: 'survive_tools', parentId: 'survive', goal: '道具', kind: 'action', dependsOn: ['survive_food'],
        postconditions: [{ kind: 'inventory', item: 'stone_pickaxe', count: 1 }] },
      { action: 'create', id: 'blaze', parentId: 'nether', goal: 'ブレイズ素材', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'blaze_rod', count: 1 }] },
      { action: 'create', id: 'eyes', parentId: 'stronghold', goal: 'エンドアイ', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'ender_eye', count: 1 }] },
    ]);
    graph.applyPlan(['survive', 'nether', 'stronghold', 'gather', 'prep'].map(id =>
      ({ action: 'seal-method' as const, id, reason: 'この枝の必要な子タスクを計画した' })), undefined, graph.currentRevision);
    const held = ['bread', 'stone_pickaxe', 'blaze_rod', 'ender_eye'].map(name => ({ name, count: 1 }));
    let items = held;
    const verifier = new GoalVerifier({ inventory: { items: () => items } });
    const prove = (id: string) => {
      const node = graph.getNode(id)!;
      expect(graph.recordProof(id, verifier.verify({ goal: node.goal, predicates: node.postconditions }), `native:${id}`)).toBe(true);
    };
    expect(graph.recordProof('survive', { status: 'verified', checkedAt: new Date().toISOString(), evidence: [] },
      'model:empty-claim')).toBe(false);
    expect(graph.isReady('blaze')).toBe(false);
    prove('survive_food');
    expect(graph.getNode('survive')?.state).toBe('pending');
    prove('survive_tools');
    expect(graph.getNode('survive')?.state).toBe('verified');
    expect(graph.getNode('survive')?.evidenceRef).toMatch(/^derived:children:/);
    expect(graph.isReady('blaze')).toBe(true);
    prove('blaze');
    expect(graph.getNode('nether')?.state).toBe('verified');
    expect(graph.isReady('eyes')).toBe(true);
    prove('eyes');
    for (const id of ['stronghold', 'gather', 'prep']) expect(graph.getNode(id)?.state).toBe('verified');
    expect(graph.isReady('dragon_fight')).toBe(true);
    expect(graph.getNode('root')?.state).toBe('pending');
    graph.checkpoint();
    const resumed = CampaignGoalGraph.open({ directory, id: 'dragon', worldId: 'isolated-world',
      goal: 'エンダードラゴンを討伐する', success: contract });
    expect(resumed.getNode('prep')?.state).toBe('verified');
    expect(resumed.getNode('root')?.state).toBe('pending');
    expect(resumed.isReady('dragon_fight')).toBe(true);

    resumed.noteActorDeath('lost inventory', held);
    items = [];
    const invalidated = resumed.reconcileCurrentInventory(inventoryObservation(items));
    for (const id of ['survive_food', 'survive_tools', 'survive', 'blaze', 'nether', 'eyes', 'stronghold', 'gather', 'prep']) {
      expect(invalidated).toContain(id);
      expect(resumed.getNode(id)?.state).toBe('pending');
    }
    expect(resumed.inspect('survive').recentProofInvalidations.at(-1)?.invalidatedChildren).toContain('survive_food');
    expect(resumed.getNode('root')?.state).toBe('pending');
    expect(resumed.isReady('blaze')).toBe(false);
    expect(resumed.isReady('survive_food')).toBe(true);
    resumed.applyPlan([
      { action: 'unseal-method', id: 'prep', reason: '死亡後の復旧用サブタスクを追加する' },
      { action: 'create', id: 'recover_prep', parentId: 'prep', goal: '復旧準備', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'bread', count: 1 }] },
    ], undefined, resumed.currentRevision);
    expect(resumed.getNode('prep')?.sealed).toBe(false);
    expect(resumed.getNode('recover_prep')).toBeDefined();
    verifier.dispose();
  });

  it('keeps a method with its own contract pending until native proof and honors OR child survival', () => {
    const { graph } = open();
    graph.applyPlan([
      { action: 'create', id: 'iron_route', parentId: 'root', goal: '製鉄', kind: 'method',
        postconditions: [{ kind: 'inventory', item: 'iron_ingot', count: 1 }] },
      { action: 'create', id: 'raw', parentId: 'iron_route', goal: '原鉄', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'raw_iron', count: 1 }] },
      { action: 'create', id: 'food_route', parentId: 'root', goal: '食料の代替', kind: 'method', join: 'any' },
      { action: 'create', id: 'apple', parentId: 'food_route', goal: 'リンゴ', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'apple', count: 1 }] },
      { action: 'create', id: 'beef', parentId: 'food_route', goal: '牛肉', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'beef', count: 1 }] },
    ]);
    graph.applyPlan(['iron_route', 'food_route'].map(id =>
      ({ action: 'seal-method' as const, id, reason: '必要な子を計画済み' })), undefined, graph.currentRevision);
    let items = ['raw_iron', 'apple', 'beef'].map(name => ({ name, count: 1 }));
    const verifier = new GoalVerifier({ inventory: { items: () => items } });
    const raw = graph.getNode('raw')!;
    expect(graph.recordProof('raw', verifier.verify({ goal: raw.goal, predicates: raw.postconditions }), 'native:raw')).toBe(true);
    expect(graph.getNode('iron_route')?.state).toBe('pending');
    items = [...items, { name: 'iron_ingot', count: 1 }];
    expect(reconcileCampaignReadyActions(graph, verifier)).toContain('iron_route');
    expect(graph.getNode('iron_route')?.state).toBe('verified');
    const apple = graph.getNode('apple')!;
    const beef = graph.getNode('beef')!;
    expect(graph.recordProof('apple', verifier.verify({ goal: apple.goal, predicates: apple.postconditions }), 'native:apple')).toBe(true);
    expect(graph.getNode('food_route')?.state).toBe('verified');
    expect(graph.recordProof('beef', verifier.verify({ goal: beef.goal, predicates: beef.postconditions }), 'native:beef')).toBe(true);
    graph.noteActorDeath('lost apple only', items);
    items = items.filter(item => item.name !== 'apple');
    expect(graph.reconcileCurrentInventory(inventoryObservation(items))).toContain('apple');
    expect(graph.getNode('food_route')?.state).toBe('verified');
    expect(graph.getNode('apple')?.state).toBe('pending');
    expect(graph.isReady('apple')).toBe(false);
    graph.noteActorDeath('lost beef too', items);
    items = items.filter(item => item.name !== 'beef');
    const invalidated = graph.reconcileCurrentInventory(inventoryObservation(items));
    expect(invalidated).toContain('beef');
    expect(invalidated).toContain('food_route');
    expect(graph.getNode('food_route')?.state).toBe('pending');
    verifier.dispose();
  });

  it('clears stale resource leaves before the next dragon-root planner turn', async () => {
    const { graph } = open();
    graph.applyPlan([
      { action: 'create', id: 'prep', parentId: 'root', goal: '討伐準備', kind: 'method' },
      { action: 'create', id: 'stone', parentId: 'prep', goal: '石を確保', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'cobblestone', count: 8 }] },
      { action: 'create', id: 'iron_pickaxe', parentId: 'prep', goal: '鉄のツルハシを作る', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'iron_pickaxe', count: 1 }] },
    ], 'stone');
    const bot: any = Object.assign(new EventEmitter(), {
      inventory: { items: () => [{ name: 'cobblestone', count: 50 }, { name: 'iron_ingot', count: 3 }, { name: 'stick', count: 4 }] },
      entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'overworld' }, entities: {}, health: 20, food: 19,
    });
    const prompts: string[] = [];
    const states: string[] = [];
    const toolDefinitions: any[][] = [];
    const modelClient: any = { messages: { stream: (input: any) => {
      prompts.push(input.system[0].text);
      states.push(input.messages[input.messages.length - 1].content[0].text);
      toolDefinitions.push(input.tools);
      return { finalMessage: async () => ({ content: [{ type: 'text', text: '準備を継続' }], usage: {} }) };
    } } };
    await new ShannonExecutor({ modelClient, modelIdentity: { provider: 'fixture', model: 'fixture' },
      campaign: graph, publishTaskTree: () => {}, bot }).run({ runId: 'dragon-run', goal: graph.goal,
      context: null, systemPrompt: 'Use tools', goalContract: { goal: graph.goal, predicates: contract }, tools: [] });
    expect(prompts.length).toBeGreaterThan(0);
    expect(graph.getNode('stone')?.state).toBe('verified');
    expect(graph.getNode('iron_pickaxe')?.state).toBe('pending');
    expect(graph.getNode('root')?.state).toBe('pending');
    // The live state travels as the last message; the system prompt never changes between calls,
    // so the provider's prompt cache is read instead of rewritten on every call.
    expect(states[0]).toContain('## 現在の状態');
    expect(states[0].startsWith(graph.goal)).toBe(true);
    expect(states[0]).toContain('"id":"iron_pickaxe"');
    expect(states[0]).not.toContain('"id":"stone"');
    expect(states[0]).toContain('最新native観測');
    // One "revision" only: the campaign's. The observation's own counter was sent as expectedRevision (paid run L24).
    expect(states[0]).toContain(`expectedRevisionに使う版は${graph.projection().revision}`);
    expect(states[0].match(/"revision":/g)).toHaveLength(1);
    expect(prompts[0]).not.toContain('永続キャンペーンの現在地');
    expect(prompts[0]).not.toContain('最新native観測（');
    expect(new Set(prompts).size).toBe(1);
    expect(prompts[0]).toContain('seal-method');
    expect(prompts[0]).toContain('食料目標を木材所持など無関係な条件へ変えない');
    const campaignTool = toolDefinitions[0].find(tool => tool.name === 'manage-campaign-goals');
    expect(campaignTool.input_schema.properties.operations.items.properties.action.enum).toContain('seal-method');
    expect(campaignTool.input_schema.properties.operations.items.properties.action.enum).toContain('unseal-method');
  });

  it('audits correction of an unverified leaf contract without weakening the immutable root', () => {
    const { directory, graph } = open();
    graph.applyPlan([{ action: 'create', id: 'mine_iron_next', parentId: 'root', goal: '鉄鉱石を採掘する',
      kind: 'action', postconditions: [{ kind: 'inventory', item: 'iron_ore', count: 1 }] }]);
    const verifier = new GoalVerifier({ inventory: { items: () => [{ name: 'raw_iron', count: 8 }] } });
    expect(verifier.verify({ goal: '鉄鉱石を採掘する', predicates: graph.getNode('mine_iron_next')!.postconditions }).status).not.toBe('verified');
    expect(() => graph.applyPlan([{ action: 'revise', id: 'root', postconditions: [{ kind: 'inventory', item: 'dirt', count: 1 }], reason: 'weaken root' }])).toThrow('CAMPAIGN_REVISION_INVALID');
    graph.applyPlan([{ action: 'revise', id: 'mine_iron_next',
      postconditions: [{ kind: 'inventory', item: 'raw_iron', count: 8 }],
      reason: '通常採掘の実ドロップはiron_oreではなくraw_iron x8だった' }], 'mine_iron_next');
    const node = graph.getNode('mine_iron_next')!;
    expect(node.postconditions).toEqual([{ kind: 'inventory', item: 'raw_iron', count: 8 }]);
    const proof = verifier.verify({ goal: node.goal, predicates: node.postconditions });
    expect(graph.recordProof(node.id, proof, 'native:inventory:raw_iron')).toBe(true);
    expect(() => graph.applyPlan([{ action: 'revise', id: node.id,
      postconditions: [{ kind: 'inventory', item: 'dirt', count: 1 }], reason: 'late edit' }])).toThrow('CAMPAIGN_REVISION_INVALID');
    graph.checkpoint();
    const reopened = CampaignGoalGraph.open({ directory, id: 'dragon', worldId: 'isolated-world',
      goal: 'エンダードラゴンを討伐する', success: contract });
    expect(reopened.getNode(node.id)?.postconditions).toEqual(node.postconditions);
    expect(reopened.getNode(node.id)?.state).toBe('verified');
    expect(reopened.getNode('root')?.postconditions).toEqual(contract);
    verifier.dispose();
  });
  it('lets the planner repair an unverified alternative parent with an atomic audited revision', () => {
    const { directory, graph } = open();
    const food = [{ kind: 'inventory' as const, item: 'food', count: 1 }];
    const beef = [{ kind: 'inventory' as const, item: 'beef', count: 1 }];
    graph.applyPlan([
      { action: 'create', id: 'safe_food', parentId: 'root', goal: '食料確保', kind: 'action', join: 'all', postconditions: food },
      { action: 'create', id: 'food_alt', parentId: 'safe_food', goal: '別の食料', kind: 'method' },
      { action: 'create', id: 'find_mushrooms', parentId: 'food_alt', goal: 'キノコ採集', kind: 'action' },
      { action: 'create', id: 'hunt_food', parentId: 'safe_food', goal: '牛を狩る', kind: 'action', postconditions: food },
    ], 'hunt_food');
    const registry = { itemsByName: { beef: { id: 1 } } };
    expect(unknownCampaignFrontierItems(graph, registry, 'hunt_food')).toEqual([
      { nodeId: 'safe_food', item: 'food' }, { nodeId: 'hunt_food', item: 'food' },
    ]);
    const observedRevision = graph.currentRevision;
    graph.beginAction('attack-in-flight', 'hunt_food', 'attack-entity');
    expect(() => graph.applyPlan([{ action: 'revise', id: 'safe_food', join: 'any', postconditions: beef,
      reason: '牛肉を所持し、子の食料経路は代替だった' }], undefined, graph.currentRevision)).toThrow('CAMPAIGN_REVISION_INVALID');
    graph.finishAction('attack-in-flight', true, '攻撃終了');
    expect(() => graph.applyPlan([{ action: 'revise', id: 'safe_food', join: 'any', postconditions: beef,
      reason: '牛肉を所持し、子の食料経路は代替だった' }])).toThrow('CAMPAIGN_REVISION_EXPECTED_REVISION_REQUIRED');
    const currentRevision = graph.currentRevision;
    expect(() => graph.applyPlan([{ action: 'revise', id: 'safe_food', join: 'any', postconditions: beef,
      reason: '牛肉を所持し、子の食料経路は代替だった' }], undefined, observedRevision)).toThrow('CAMPAIGN_REVISION_STALE');
    expect(graph.currentRevision).toBe(currentRevision);
    graph.applyPlan([
      { action: 'revise', id: 'safe_food', join: 'any', postconditions: beef,
        reason: '牛肉を所持し、子の食料経路は代替だった' },
      { action: 'revise', id: 'hunt_food', postconditions: beef,
        reason: '牛からの実ドロップはbeefだった' },
    ], 'hunt_food', currentRevision);
    expect(unknownCampaignFrontierItems(graph, registry, 'hunt_food')).toEqual([]);
    expect(graph.getNode('safe_food')?.join).toBe('any');
    const event = JSON.parse(fs.readFileSync(path.join(directory, 'dragon.jsonl'), 'utf8').trim().split('\n').at(-1)!);
    expect(event.data.repairs).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'safe_food', before: { join: 'all', postconditions: food },
        after: { join: 'any', postconditions: beef } }),
    ]));
    const verifier = new GoalVerifier({ inventory: { items: () => [{ name: 'beef', count: 6 }] } });
    const hunt = graph.getNode('hunt_food')!;
    expect(graph.recordProof(hunt.id, verifier.verify({ goal: hunt.goal, predicates: hunt.postconditions }), 'native:beef')).toBe(true);
    const parent = graph.getNode('safe_food')!;
    expect(graph.recordProof(parent.id, verifier.verify({ goal: parent.goal, predicates: parent.postconditions }), 'native:beef')).toBe(true);
    expect(graph.isReady('find_mushrooms')).toBe(false);
    expect(graph.projection().ready.map(node => node.id)).not.toContain('find_mushrooms');
    expect(() => graph.applyPlan([{ action: 'revise', id: 'food_alt', join: 'any', reason: '遅い変更' }],
      undefined, graph.currentRevision)).toThrow('CAMPAIGN_REVISION_INVALID');
    graph.checkpoint();
    const resumed = CampaignGoalGraph.open({ directory, id: 'dragon', worldId: 'isolated-world',
      goal: 'エンダードラゴンを討伐する', success: contract });
    expect(resumed.getNode('safe_food')?.join).toBe('any');
    expect(resumed.inspect('safe_food').recentPlanRepairs).toEqual([
      expect.objectContaining({ nodeId: 'safe_food', reason: '牛肉を所持し、子の食料経路は代替だった',
        before: { join: 'all', postconditions: food }, after: { join: 'any', postconditions: beef } }),
    ]);
    expect(resumed.isReady('find_mushrooms')).toBe(false);
    verifier.dispose();
  });
  it('corrects only an unverified parent contract after child proof without rewriting that proof', () => {
    const { directory, graph } = open();
    const food = [{ kind: 'inventory' as const, item: 'food', count: 1 }];
    const beef = [{ kind: 'inventory' as const, item: 'beef', count: 1 }];
    graph.applyPlan([
      { action: 'create', id: 'safe_food', parentId: 'root', goal: '食料を確保', kind: 'action', join: 'any', postconditions: food },
      { action: 'create', id: 'hunt_food', parentId: 'safe_food', goal: '牛を狩る', kind: 'action', postconditions: beef },
      { action: 'create', id: 'food_alt', parentId: 'safe_food', goal: '他の食料', kind: 'method' },
    ]);
    const verifier = new GoalVerifier({ inventory: { items: () => [{ name: 'beef', count: 6 }] } });
    const hunt = graph.getNode('hunt_food')!;
    expect(graph.recordProof(hunt.id, verifier.verify({ goal: hunt.goal, predicates: hunt.postconditions }), 'native:hunt:beef')).toBe(true);
    const childProof = graph.getNode('hunt_food');
    const beforeRepairRevision = graph.currentRevision;
    expect(() => graph.applyPlan([{ action: 'revise', id: 'safe_food', join: 'all', postconditions: beef,
      reason: '後からANDに変更' }], undefined, beforeRepairRevision))
      .toThrow('CAMPAIGN_REVISION_VERIFIED_DESCENDANT_JOIN_IMMUTABLE');
    expect(() => graph.applyPlan([{ action: 'revise', id: 'safe_food', join: 'any',
      reason: '事後条件を伴わない変更' }], undefined, beforeRepairRevision))
      .toThrow('CAMPAIGN_REVISION_VERIFIED_DESCENDANT_CONTRACT_REQUIRED');
    expect(() => graph.applyPlan([{ action: 'revise', id: 'root', postconditions: beef,
      reason: '根を変更' }], undefined, beforeRepairRevision)).toThrow('CAMPAIGN_REVISION_INVALID');
    expect(graph.currentRevision).toBe(beforeRepairRevision);
    expect(graph.getNode('safe_food')?.postconditions).toEqual(food);
    graph.beginAction('physical-action', 'safe_food', 'attack-entity');
    expect(() => graph.applyPlan([{ action: 'revise', id: 'safe_food', postconditions: beef,
      reason: '実行中に変更' }], undefined, graph.currentRevision)).toThrow('CAMPAIGN_REVISION_INVALID');
    graph.finishAction('physical-action', true, '攻撃終了');
    expect(() => graph.applyPlan([{ action: 'revise', id: 'safe_food', postconditions: beef,
      reason: '古い観測で変更' }], undefined, beforeRepairRevision)).toThrow('CAMPAIGN_REVISION_STALE');
    expect(graph.getNode('hunt_food')).toEqual(childProof);
    const expectedRevision = graph.currentRevision;
    graph.applyPlan([{ action: 'revise', id: 'safe_food', postconditions: beef,
      reason: '食料カテゴリは実在itemでなく、native観測ではbeefを所持' }], undefined, expectedRevision);
    expect(graph.getNode('hunt_food')).toEqual(childProof);
    expect(graph.getNode('safe_food')?.join).toBe('any');
    expect(graph.getNode('safe_food')?.postconditions).toEqual(beef);
    expect(graph.getNode('safe_food')?.state).toBe('pending');
    expect(graph.inspect('safe_food').recentPlanRepairs.at(-1)).toEqual(expect.objectContaining({
      revision: expectedRevision + 1, nodeId: 'safe_food',
      before: { join: 'any', postconditions: food }, after: { join: 'any', postconditions: beef },
    }));
    const parent = graph.getNode('safe_food')!;
    expect(graph.recordProof(parent.id, verifier.verify({ goal: parent.goal, predicates: parent.postconditions }), 'native:safe:beef')).toBe(true);
    expect(() => graph.applyPlan([{ action: 'revise', id: 'safe_food', postconditions: food,
      reason: '検証済み親を変更' }], undefined, graph.currentRevision)).toThrow('CAMPAIGN_REVISION_INVALID');
    graph.checkpoint();
    const resumed = CampaignGoalGraph.open({ directory, id: 'dragon', worldId: 'isolated-world',
      goal: 'エンダードラゴンを討伐する', success: contract });
    expect(resumed.getNode('hunt_food')).toEqual(childProof);
    expect(resumed.getNode('safe_food')?.state).toBe('verified');
    expect(resumed.inspect('safe_food').recentPlanRepairs.at(-1)).toEqual(expect.objectContaining({
      reason: '食料カテゴリは実在itemでなく、native観測ではbeefを所持',
      before: { join: 'any', postconditions: food }, after: { join: 'any', postconditions: beef },
    }));
    verifier.dispose();
  });
  it('replays post-checkpoint repairs and bounds durable audit history', () => {
    const { directory, graph } = open();
    graph.applyPlan([{ action: 'create', id: 'resource', parentId: 'root', goal: '資源を得る', kind: 'action',
      postconditions: [{ kind: 'inventory', item: 'beef', count: 1 }] }]);
    graph.checkpoint();
    for (let count = 2; count <= 131; count++) graph.applyPlan([{ action: 'revise', id: 'resource',
      postconditions: [{ kind: 'inventory', item: 'beef', count }], reason: `native observation ${count}` }]);
    const resumed = CampaignGoalGraph.open({ directory, id: 'dragon', worldId: 'isolated-world',
      goal: 'エンダードラゴンを討伐する', success: contract });
    expect(resumed.getNode('resource')?.postconditions).toEqual([{ kind: 'inventory', item: 'beef', count: 131 }]);
    expect(resumed.inspect('resource').recentPlanRepairs).toHaveLength(8);
    expect(resumed.inspect('resource').recentPlanRepairs.at(-1)?.after.postconditions)
      .toEqual([{ kind: 'inventory', item: 'beef', count: 131 }]);
    resumed.checkpoint();
    const snapshot = JSON.parse(fs.readFileSync(path.join(directory, 'dragon.snapshot.json'), 'utf8'));
    expect(snapshot.recentPlanRepairs).toHaveLength(128);
    expect(snapshot.recentPlanRepairs[0].reason).toBe('native observation 4');
  });
  it('reopens legacy verified gear, sticks and food after a known empty-inventory resume', () => {
    const { directory, graph } = open();
    let items: Array<{ name: string; count: number }> = [];
    const bot: any = Object.assign(new EventEmitter(), { inventory: { items: () => items } });
    const verifier = new GoalVerifier(bot);
    graph.applyPlan([
      { action: 'create', id: 'stone_pickaxe_action', parentId: 'root', goal: '石ツルハシ', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'stone_pickaxe', count: 1 }] },
      { action: 'create', id: 'craft_sticks_action', parentId: 'root', goal: '棒', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'stick', count: 4 }] },
      { action: 'create', id: 'hunt_food', parentId: 'root', goal: '牛肉', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'beef', count: 1 }] },
      { action: 'create', id: 'produce_iron', parentId: 'root', goal: '鉄を生産', kind: 'action',
        postconditions: [{ kind: 'produced', item: 'raw_iron', count: 1 }] },
    ]);
    items = [{ name: 'stone_pickaxe', count: 1 }, { name: 'stick', count: 4 },
      { name: 'beef', count: 3 }, { name: 'raw_iron', count: 1 }];
    for (const id of ['stone_pickaxe_action', 'craft_sticks_action', 'hunt_food', 'produce_iron']) {
      const node = graph.getNode(id)!;
      expect(graph.recordProof(id, verifier.verify({ goal: node.goal, predicates: node.postconditions }), `native:${id}`)).toBe(true);
    }
    graph.checkpoint();
    const resumed = CampaignGoalGraph.open({ directory, id: 'dragon', worldId: 'isolated-world',
      goal: 'エンダードラゴンを討伐する', success: contract });
    expect(resumed.reconcileCurrentInventory(inventoryObservation([])).sort())
      .toEqual(['craft_sticks_action', 'hunt_food', 'stone_pickaxe_action']);
    for (const id of ['stone_pickaxe_action', 'craft_sticks_action', 'hunt_food']) {
      expect(resumed.getNode(id)?.state).toBe('pending');
      expect(resumed.getNode(id)?.evidenceRef).toBeUndefined();
      expect(resumed.isReady(id)).toBe(true);
      expect(resumed.inspect(id).recentProofInvalidations.at(-1)).toEqual(expect.objectContaining({
        nodeId: id, cause: 'legacy_empty', priorEvidenceRef: `native:${id}`,
      }));
    }
    expect(resumed.getNode('produce_iron')?.state).toBe('verified');
    expect(resumed.getNode('root')?.state).toBe('pending');
    resumed.checkpoint();
    const again = CampaignGoalGraph.open({ directory, id: 'dragon', worldId: 'isolated-world',
      goal: 'エンダードラゴンを討伐する', success: contract });
    expect(again.getNode('stone_pickaxe_action')?.state).toBe('pending');
    expect(again.inspect('hunt_food').recentProofInvalidations).toHaveLength(1);
    expect(again.reconcileCurrentInventory(inventoryObservation([]))).toEqual([]);
    verifier.dispose();
  });

  it('keeps intentionally consumed ingredients when a completed action observed their use', () => {
    const { directory, graph } = open();
    let items = [{ name: 'stick', count: 4 }];
    const bot: any = Object.assign(new EventEmitter(), { inventory: { items: () => items } });
    const verifier = new GoalVerifier(bot);
    graph.applyPlan([
      { action: 'create', id: 'sticks', parentId: 'root', goal: '棒', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'stick', count: 4 }] },
      { action: 'create', id: 'pickaxe', parentId: 'root', goal: '石ツルハシ', kind: 'action', dependsOn: ['sticks'],
        postconditions: [{ kind: 'inventory', item: 'stone_pickaxe', count: 1 }] },
      { action: 'create', id: 'mine_iron', parentId: 'root', goal: '鉄採掘', kind: 'action', dependsOn: ['pickaxe'],
        postconditions: [{ kind: 'inventory', item: 'raw_iron', count: 1 }] },
    ]);
    const sticks = graph.getNode('sticks')!;
    expect(graph.recordProof(sticks.id, verifier.verify({ goal: sticks.goal, predicates: sticks.postconditions }), 'native:sticks')).toBe(true);
    graph.beginAction('craft-pickaxe', 'pickaxe', 'craft-one');
    items = [{ name: 'stone_pickaxe', count: 1 }];
    graph.finishAction('craft-pickaxe', true, '棒を消費してツルハシを製作', items);
    const pickaxe = graph.getNode('pickaxe')!;
    expect(graph.recordProof(pickaxe.id, verifier.verify({ goal: pickaxe.goal, predicates: pickaxe.postconditions }), 'native:pickaxe')).toBe(true);
    graph.checkpoint();
    const resumed = CampaignGoalGraph.open({ directory, id: 'dragon', worldId: 'isolated-world',
      goal: 'エンダードラゴンを討伐する', success: contract });
    expect(resumed.reconcileCurrentInventory(inventoryObservation(items))).toEqual([]);
    expect(resumed.getNode('sticks')?.state).toBe('verified');
    expect(resumed.getNode('pickaxe')?.state).toBe('verified');
    expect(resumed.isReady('mine_iron')).toBe(true);
    verifier.dispose();
  });
  it('persists death before respawn, waits for known inventory, and reopens explicit prerequisites', () => {
    const { directory, graph } = open();
    let items = [{ name: 'stick', count: 4 }];
    const bot: any = Object.assign(new EventEmitter(), { inventory: { items: () => items } });
    const verifier = new GoalVerifier(bot);
    graph.applyPlan([
      { action: 'create', id: 'sticks', parentId: 'root', goal: '棒', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'stick', count: 4 }] },
      { action: 'create', id: 'pickaxe', parentId: 'root', goal: '石ツルハシ', kind: 'action', dependsOn: ['sticks'],
        postconditions: [{ kind: 'inventory', item: 'stone_pickaxe', count: 1 }] },
      { action: 'create', id: 'mine_iron', parentId: 'root', goal: '鉄鉱石', kind: 'action', dependsOn: ['pickaxe'],
        postconditions: [{ kind: 'inventory', item: 'raw_iron', count: 1 }] },
    ]);
    const sticks = graph.getNode('sticks')!;
    expect(graph.recordProof('sticks', verifier.verify({ goal: sticks.goal, predicates: sticks.postconditions }), 'native:sticks')).toBe(true);
    items = [{ name: 'stone_pickaxe', count: 1 }, { name: 'dirt', count: 1 }];
    const pickaxe = graph.getNode('pickaxe')!;
    expect(graph.recordProof('pickaxe', verifier.verify({ goal: pickaxe.goal, predicates: pickaxe.postconditions }), 'native:pickaxe')).toBe(true);
    graph.beginAction('last-physical', 'pickaxe', 'inspect-inventory');
    graph.finishAction('last-physical', true, '観測済み', items);
    graph.noteActorDeath('native death event', items);
    graph.checkpoint();
    const resumed = CampaignGoalGraph.open({ directory, id: 'dragon', worldId: 'isolated-world',
      goal: 'エンダードラゴンを討伐する', success: contract });
    expect(resumed.reconcileCurrentInventory(captureWorldObservation({}))).toEqual([]);
    expect(resumed.getNode('pickaxe')?.state).toBe('verified');
    items = [{ name: 'dirt', count: 1 }];
    expect(resumed.reconcileCurrentInventory(inventoryObservation(items)).sort()).toEqual(['pickaxe', 'sticks']);
    expect(resumed.isReady('mine_iron')).toBe(false);
    expect(resumed.isReady('sticks')).toBe(true);
    expect(resumed.inspect('pickaxe').recentProofInvalidations.at(-1)?.cause).toBe('death');
    resumed.checkpoint();
    const again = CampaignGoalGraph.open({ directory, id: 'dragon', worldId: 'isolated-world',
      goal: 'エンダードラゴンを討伐する', success: contract });
    expect(again.getNode('pickaxe')?.state).toBe('pending');
    expect(again.inspect('sticks').recentProofInvalidations).toHaveLength(1);
    verifier.dispose();
  });

  it('never revokes an independently proven dragon defeat when inventory is lost', () => {
    const { graph } = open();
    const bot: any = Object.assign(new EventEmitter(), { game: { dimension: 'the_end' },
      inventory: { items: () => [{ name: 'stone_pickaxe', count: 1 }] } });
    const verifier = new GoalVerifier(bot);
    bot.emit('minebotTargetAttacked', { id: 57, name: 'ender_dragon' });
    bot.emit('entityDead', { id: 57, name: 'ender_dragon' });
    expect(graph.recordProof('root', verifier.verify({ goal: graph.goal, predicates: contract }), 'native:dragon')).toBe(true);
    graph.noteActorDeath('after dragon', [{ name: 'stone_pickaxe', count: 1 }]);
    expect(graph.reconcileCurrentInventory(inventoryObservation([]))).toEqual([]);
    expect(graph.getNode('root')?.state).toBe('verified');
    expect(graph.getNode('root')?.evidenceRef).toBe('native:dragon');
    verifier.dispose();
  });

  it('rebuilds parent child counts after food loss and re-verifies the recovery path', () => {
    const { directory, graph } = open();
    let items = [{ name: 'beef', count: 3 }];
    const bot: any = Object.assign(new EventEmitter(), { inventory: { items: () => items } });
    const verifier = new GoalVerifier(bot);
    const beef = [{ kind: 'inventory' as const, item: 'beef', count: 1 }];
    graph.applyPlan([
      { action: 'create', id: 'safe_food', parentId: 'root', goal: '食料確保', kind: 'action', join: 'any', postconditions: beef },
      { action: 'create', id: 'hunt_food', parentId: 'safe_food', goal: '牛肉を得る', kind: 'action', postconditions: beef },
      { action: 'create', id: 'fish_food', parentId: 'safe_food', goal: '魚を得る', kind: 'action',
        postconditions: [{ kind: 'inventory', item: 'cod', count: 1 }] },
    ]);
    for (const id of ['hunt_food', 'safe_food']) {
      const node = graph.getNode(id)!;
      expect(graph.recordProof(id, verifier.verify({ goal: node.goal, predicates: node.postconditions }), `native:${id}`)).toBe(true);
    }
    graph.noteActorDeath('native death event', items);
    graph.checkpoint();
    const resumed = CampaignGoalGraph.open({ directory, id: 'dragon', worldId: 'isolated-world',
      goal: 'エンダードラゴンを討伐する', success: contract });
    items = [];
    expect(resumed.reconcileCurrentInventory(inventoryObservation(items)).sort()).toEqual(['hunt_food', 'safe_food']);
    expect(resumed.isReady('safe_food')).toBe(false);
    expect(resumed.isReady('hunt_food')).toBe(true);
    items = [{ name: 'beef', count: 2 }];
    expect(reconcileCampaignReadyActions(resumed, verifier)).toContain('hunt_food');
    expect(reconcileCampaignReadyActions(resumed, verifier)).toContain('safe_food');
    expect(resumed.getNode('safe_food')?.state).toBe('verified');
    verifier.dispose();
  });
  it('routes a real skill through the campaign frontier and native goal proof', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-campaign-executor-')); directories.push(directory);
    const goal = 'wood'; const success = [{ kind: 'inventory' as const, item: 'oak_log', count: 1 }];
    const graph = CampaignGoalGraph.open({ directory, id: 'wood', worldId: 'isolated-world', goal, success });
    let items: any[] = []; let turn = 0;
    const bot: any = Object.assign(new EventEmitter(), { inventory: { items: () => items },
      entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'overworld' }, entities: {}, health: 20, food: 20 });
    const skill = { skillName: 'mine-block', params: [], run: vi.fn(async () => { items = [{ name: 'oak_log', count: 1 }]; return { success: true, result: 'oak log collected' }; }) };
    const catalog: string[][] = [];
    const messages = [
      [{ type: 'tool_use', id: 'plan', name: 'manage-campaign-goals', input: { operations: [
        { action: 'create', id: 'wood-step', parentId: 'root', goal: 'collect a log', kind: 'action', postconditions: success },
      ], activeNodeId: 'wood-step' } }],
      [{ type: 'tool_use', id: 'skill', name: 'mine-block', input: {} }],
      [{ type: 'tool_use', id: 'done', name: 'task-complete', input: { summary: 'one log collected' } }],
    ];
    const modelClient: any = { messages: { stream: (input: any) => { catalog.push(input.tools.map((tool: any) => tool.name));
      return { finalMessage: async () => ({ content: messages[turn++], usage: {} }) }; } } };
    const result = await new ShannonExecutor({ modelClient, modelIdentity: { provider: 'fixture', model: 'fixture' }, campaign: graph,
      publishTaskTree: () => {}, bot, instantSkills: { getSkill: (name: string) => name === 'mine-block' ? skill : undefined,
        getSkills: () => [skill] } as any }).run({ runId: 'run', goal, context: null, systemPrompt: 'Use tools',
      goalContract: { goal, predicates: success }, tools: [{ name: 'mine-block', description: 'mine', input_schema: { type: 'object', properties: {} } },
        { name: 'task-complete', description: 'done', input_schema: { type: 'object', properties: {} } }] as any });
    expect(result.taskTree?.status).toBe('completed');
    expect(graph.getNode('root')?.state).toBe('verified');
    expect(graph.getNode('wood-step')?.state).toBe('verified');
    expect(graph.getUncertainActions()).toEqual([]);
    expect(skill.run).toHaveBeenCalledTimes(1);
    expect(catalog[0]).toContain('manage-campaign-goals');
    expect(catalog[0]).not.toContain('manage-task-tree');
  });
  it('hands the live state to the planner inside what it reads last, without touching the stored conversation', () => {
    const history: any[] = [
      { role: 'user', content: 'エンドラを倒す' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'mine-block', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '結果: 成功' }] },
    ];
    const frozen = JSON.stringify(history);
    const sent = withLiveState(history, '\n最新native観測: {"health":20}');
    expect(JSON.stringify(history)).toBe(frozen);
    expect(sent).toHaveLength(3); // no user turn of its own: that read as a new request (paid runs L22, L23)
    expect(sent.slice(0, 2)).toEqual(history.slice(0, 2));
    const last: any = (sent[2].content as any[])[0];
    expect(last).toMatchObject({ type: 'tool_result', tool_use_id: 'a' });
    expect(last.content).toMatch(/^結果: 成功\n\n## 現在の状態（この時点の実測。これまでの結果より新しい）\n最新native観測: \{"health":20\}$/);
    const first = withLiveState(history.slice(0, 1), '\n最新native観測: {}');
    expect(first[0].content).toEqual([{ type: 'text', text: expect.stringMatching(/^エンドラを倒す\n\n## 現在の状態/) }]);
    expect(withLiveState(history, '  ')).toBe(history);
  });
  it('answers a completion claim with the world: proves it, or names what is missing (paid run L20)', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-campaign-claim-')); directories.push(directory);
    const goal = 'tools'; const success = [{ kind: 'inventory' as const, item: 'stone_pickaxe', count: 1 }];
    const graph = CampaignGoalGraph.open({ directory, id: 'claim', worldId: 'isolated-world', goal, success });
    graph.applyPlan([
      { action: 'create', id: 'wood', parentId: 'root', goal: 'logs', kind: 'action', postconditions: [{ kind: 'inventory', item: 'oak_log', count: 3 }] },
      { action: 'create', id: 'stone', parentId: 'root', goal: 'cobblestone', kind: 'action', dependsOn: ['wood'], postconditions: [{ kind: 'inventory', item: 'cobblestone', count: 3 }] },
    ], 'wood');
    let items: any[] = [{ name: 'oak_log', count: 1 }]; let turn = 0;
    const bot: any = Object.assign(new EventEmitter(), { inventory: { items: () => items },
      entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'overworld' }, entities: {}, health: 20, food: 20 });
    const results: string[] = [];
    const call = (id: string, input: any) => [{ type: 'tool_use', id, name: 'manage-campaign-goals', input }];
    const messages = [
      call('claim-early', { activeNodeId: 'wood', operations: [{ action: 'set-state', id: 'wood', state: 'verified' }] }),
      call('claim-met', { operations: [{ action: 'set-state', id: 'wood', state: 'verified' }, { action: 'set-state', id: 'stone', state: 'active' }], activeNodeId: 'stone' }),
      [{ type: 'tool_use', id: 'done', name: 'task-complete', input: { summary: 'stop' } }],
      [{ type: 'text', text: 'stop' }],
    ];
    const modelClient: any = { messages: { stream: (input: any) => {
      for (const message of input.messages) for (const block of Array.isArray(message.content) ? message.content : [])
        if (block.type === 'tool_result' && !results.includes(String(block.content))) results.push(String(block.content));
      if (turn === 1) items = [{ name: 'oak_log', count: 3 }];
      return { finalMessage: async () => ({ content: messages[Math.min(turn++, messages.length - 1)], usage: {} }) }; } } };
    await new ShannonExecutor({ modelClient, modelIdentity: { provider: 'fixture', model: 'fixture' }, campaign: graph,
      publishTaskTree: () => {}, bot, instantSkills: { getSkill: () => undefined, getSkills: () => [] } as any })
      .run({ runId: 'run', goal, context: null, systemPrompt: 'Use tools', maxIterations: 4,
        goalContract: { goal, predicates: success }, tools: [{ name: 'task-complete', description: 'done', input_schema: { type: 'object', properties: {} } }] as any } as any);
    const refusal = results.find(text => text.includes('CAMPAIGN_STATE_INVALID'))!;
    expect(refusal).toContain('verified（完了）は書き込めず');
    expect(refusal).toContain('woodの未達条件');
    expect(refusal).toContain('"item":"oak_log","count":3');
    expect(refusal).toMatch(/実測=.*1/);
    expect(graph.getNode('wood')?.state).toBe('verified');
    expect(graph.getNode('stone')?.state).toBe('active');
  });
  it('reads the revision from beside the operation that needs it (paid run L20 lost six calls)', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'minebot-campaign-seal-')); directories.push(directory);
    const goal = 'tools'; const success = [{ kind: 'inventory' as const, item: 'stone_pickaxe', count: 1 }];
    const graph = CampaignGoalGraph.open({ directory, id: 'seal', worldId: 'isolated-world', goal, success });
    graph.applyPlan([
      { action: 'create', id: 'sticks', parentId: 'root', goal: 'get sticks', kind: 'method' },
      { action: 'create', id: 'craft', parentId: 'sticks', goal: 'craft sticks', kind: 'action', postconditions: [{ kind: 'inventory', item: 'stick', count: 2 }] },
    ]);
    expect(() => graph.applyPlan([{ action: 'seal-method', id: 'sticks', reason: 'planned' }]))
      .toThrow(`expectedRevision=${graph.projection().revision}を付けて同じ操作を出し直してください`);
    // A refused seal says which condition failed (paid run L26 repeated a bare CAMPAIGN_METHOD_SEAL_INVALID).
    const revision = graph.projection().revision;
    expect(() => graph.applyPlan([{ action: 'seal-method', id: 'craft', reason: 'done' }], undefined, revision)).toThrow('kindがactionです');
    expect(() => graph.applyPlan([{ action: 'unseal-method', id: 'sticks', reason: 'more' }], undefined, revision)).toThrow('すでに未sealの状態です');
    expect(() => graph.applyPlan([{ action: 'seal-method', id: 'sticks', reason: ' ' }], undefined, revision)).toThrow('reason（理由）が必要です');
    expect(() => graph.applyPlan([{ action: 'seal-method', id: 'nowhere', reason: 'x' }], undefined, revision)).toThrow('このIDのノードはありません');
    let turn = 0;
    const bot: any = Object.assign(new EventEmitter(), { inventory: { items: () => [] },
      entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'overworld' }, entities: {}, health: 20, food: 20 });
    const messages = [
      [{ type: 'tool_use', id: 'seal', name: 'manage-campaign-goals', input: { operations: [
        { action: 'seal-method', id: 'sticks', expectedRevision: graph.projection().revision, reason: 'the child set is complete' }] } }],
      [{ type: 'text', text: 'stop' }],
    ];
    const modelClient: any = { messages: { stream: () => ({ finalMessage: async () => ({ content: messages[Math.min(turn++, 1)], usage: {} }) }) } };
    await new ShannonExecutor({ modelClient, modelIdentity: { provider: 'fixture', model: 'fixture' }, campaign: graph,
      publishTaskTree: () => {}, bot, instantSkills: { getSkill: () => undefined, getSkills: () => [] } as any })
      .run({ runId: 'run', goal, context: null, systemPrompt: 'Use tools', maxIterations: 2,
        goalContract: { goal, predicates: success }, tools: [] as any } as any);
    expect(graph.getNode('sticks')?.sealed).toBe(true);
  });
  it('keeps AND/OR alternatives, dependencies, proof and action uncertainty across restart', () => {
    const { directory, graph } = open();
    graph.applyPlan([
      { action: 'create', id: 'eyes', parentId: 'root', goal: 'エンドへ向かう準備', kind: 'outcome', join: 'any', postconditions: [{ kind: 'inventory', item: 'ender_eye', count: 1 }] },
      { action: 'create', id: 'barter', parentId: 'eyes', goal: '交換経路', kind: 'action', postconditions: [{ kind: 'inventory', item: 'ender_eye', count: 1 }] },
      { action: 'create', id: 'fight', parentId: 'eyes', goal: '戦闘経路', kind: 'action', postconditions: [{ kind: 'inventory', item: 'ender_eye', count: 1 }] },
      { action: 'create', id: 'portal', parentId: 'root', goal: 'ポータルへ到達', kind: 'action', dependsOn: ['eyes'], postconditions: [{ kind: 'position', dimension: 'overworld', position: { x: 1, y: 64, z: 1 }, radius: 2 }] },
    ]);
    expect(graph.isReady('root')).toBe(false);
    expect(graph.isReady('portal')).toBe(false);
    expect(graph.isReady('barter')).toBe(true);
    graph.applyPlan([{ action: 'set-state', id: 'barter', state: 'blocked', blocker: '交換相手が見つからない' }]);
    expect(graph.isReady('barter')).toBe(false);
    expect(graph.isReady('fight')).toBe(true);
    const bot = { inventory: { items: () => [{ name: 'ender_eye', count: 1 }] } };
    const verifier = new GoalVerifier(bot);
    const proof = verifier.verify({ goal: '戦闘経路', predicates: graph.getNode('fight')!.postconditions });
    expect(graph.recordProof('fight', proof, 'receipt:fight')).toBe(true);
    expect(graph.recordProof('root', proof, 'wrong-contract')).toBe(false);
    const parentProof = verifier.verify({ goal: 'エンドへ向かう準備', predicates: graph.getNode('eyes')!.postconditions });
    expect(graph.recordProof('eyes', parentProof, 'receipt:eyes')).toBe(true);
    expect(graph.isReady('portal')).toBe(true);
    graph.beginAction('action-1', 'portal', 'move-to');
    graph.checkpoint();
    verifier.dispose();
    const resumed = CampaignGoalGraph.open({ directory, id: 'dragon', worldId: 'isolated-world', goal: 'エンダードラゴンを討伐する', success: contract });
    expect(resumed.getNode('eyes')?.evidenceRef).toBe('receipt:eyes');
    expect(resumed.getUncertainActions()).toEqual([{ actionId: 'action-1', nodeId: 'portal', capability: 'move-to' }]);
    resumed.finishAction('action-1', null, '再観測が必要');
    expect(resumed.inspect('portal').recentReceipts.at(-1)?.success).toBeNull();
    expect(() => resumed.finishAction('action-1', true, '二重完了')).toThrow('CAMPAIGN_ACTION_UNKNOWN');
    expect(() => CampaignGoalGraph.open({ directory, id: 'dragon', worldId: 'another-world', goal: 'エンダードラゴンを討伐する', success: contract })).toThrow('CAMPAIGN_IDENTITY_MISMATCH');
  });

  it('rejects cycles and unverifiable model completion without partial writes', () => {
    const { graph } = open();
    const before = graph.currentRevision;
    expect(() => graph.applyPlan([
      { action: 'create', id: 'a', parentId: 'root', goal: 'a', kind: 'outcome', dependsOn: ['b'] },
      { action: 'create', id: 'b', parentId: 'a', goal: 'b', kind: 'action' },
    ])).toThrow('CAMPAIGN_CYCLE');
    expect(graph.currentRevision).toBe(before);
    expect(graph.getNode('a')).toBeUndefined();
    const forged: any = { status: 'verified', evidence: [{ predicate: { kind: 'inventory', item: 'bread', count: 1 }, status: 'verified', actual: 1 }] };
    expect(graph.recordProof('root', forged, 'model-says-so')).toBe(false);
    graph.applyPlan([{ action: 'create', id: 'container', parentId: 'root', goal: 'prepare', kind: 'method' }], 'container');
    expect(graph.getActiveId()).toBe('container');
    const beforeBadSelection = graph.currentRevision;
    expect(() => graph.applyPlan([{ action: 'create', id: 'candidate', parentId: 'container', goal: 'new action', kind: 'action' }], 'missing'))
      .toThrow('CAMPAIGN_ACTIVE_NODE_UNKNOWN');
    expect(graph.getNode('candidate')).toBeUndefined();
    expect(graph.currentRevision).toBe(beforeBadSelection);
  });

  it('late-binds a dragon encounter and never treats disappearance or a stranger death as success', () => {
    const bot: any = Object.assign(new EventEmitter(), { game: { dimension: 'the_end' }, inventory: { items: () => [] } });
    const verifier = new GoalVerifier(bot);
    const goal = { goal: 'エンダードラゴンを討伐する', predicates: contract };
    bot.emit('entityDead', { id: 7, name: 'ender_dragon' });
    expect(verifier.verify(goal).status).toBe('unknown');
    bot.emit('minebotTargetAttacked', { id: 8, name: 'ender_dragon' });
    bot.emit('entityDead', { id: 8, name: 'zombie' });
    expect(verifier.verify(goal).status).toBe('unknown');
    bot.emit('minebotTargetAttacked', { id: 9, name: 'ender_dragon' });
    bot.emit('entityDead', { id: 9, name: 'ender_dragon' });
    expect(verifier.verify(goal).status).toBe('verified');
    verifier.dispose();
  });

  it('keeps a 50k-node plan out of the prompt projection and survives a checkpoint', () => {
    const { directory, graph } = open();
    for (let batch = 0; batch < 1000; batch++) {
      const operations: CampaignPlanOperation[] = [];
      for (let i = 0; i < 50; i++) {
        const n = batch * 50 + i;
        operations.push({ action: 'create', id: `step-${n}`, parentId: 'root', goal: `探索候補 ${n}`, kind: 'action' });
      }
      graph.applyPlan(operations);
    }
    expect(graph.size).toBe(50_001);
    const serialized = JSON.stringify(graph.projection('step-49999'));
    expect(serialized.length).toBeLessThan(8000);
    graph.checkpoint();
    const reopened = CampaignGoalGraph.open({ directory, id: 'dragon', worldId: 'isolated-world', goal: 'エンダードラゴンを討伐する', success: contract });
    expect(reopened.size).toBe(50_001);
    expect(reopened.inspect('root', 49_990, 16).children).toHaveLength(10);
  }, 30000);
});

describe('the facts of an observation are shown by their source, not a second copy of their values (L88: over half the planner bill was the note re-sent each call)', () => {
  it('keeps where each fact came from and whether it is known, and drops the value and the time stamp', () => {
    const facts = { inventory: { value: [{ name: 'cobblestone', count: 64 }], observedAt: 't', source: 'window', coverage: 'known' },
      time: { value: '6000', observedAt: 't', source: 'native', coverage: 'known' } };
    expect(factSources(facts as any)).toEqual({ inventory: { source: 'window', coverage: 'known' }, time: { source: 'native', coverage: 'known' } });
    expect(factSources(undefined)).toBeUndefined();
  });
});

describe('the observation written into the per-call note is the same facts in fewer characters', () => {
  it('rounds positions, lists each hostile once, and drops the time stamp and the fact values', () => {
    const world = { observedAt: '2026-10-05T00:00:00.000Z', revision: 7, health: 20, position: { x: -36.312345678901234, y: 61, z: -56.04999999 },
      inventory: [{ name: 'cobblestone', count: 64 }],
      nearbyEntities: [{ name: 'cow', kind: 'animal', distance: 3, position: { x: 1.23456, y: 64, z: 2.98765 } },
        { name: 'zombie', kind: 'hostile', distance: 9, position: { x: 10.0001, y: 64, z: 0 } }],
      nearbyThreats: [{ name: 'zombie', kind: 'hostile', distance: 9, position: { x: 10.0001, y: 64, z: 0 } }],
      facts: { inventory: { value: [{ name: 'cobblestone', count: 64 }], observedAt: 't', source: 'window', coverage: 'known' } } };
    const shown = observationForPrompt(world);
    expect(shown.position).toEqual({ x: -36.3, y: 61, z: -56 });
    expect(shown.nearbyEntities.map((e: any) => e.name)).toEqual(['cow']);
    expect(shown.nearbyEntities[0].position).toEqual({ x: 1.2, y: 64, z: 3 });
    expect(shown.nearbyThreats).toEqual([{ name: 'zombie', kind: 'hostile', distance: 9, position: { x: 10, y: 64, z: 0 } }]);
    expect(JSON.stringify(shown)).not.toContain('observedAt');
    expect(shown.inventory).toEqual(world.inventory);
    expect(JSON.stringify(shown).length).toBeLessThan(JSON.stringify(world).length * 0.75);
    // Without a separate list of threats, the hostiles stay among the entities.
    expect(observationForPrompt({ ...world, nearbyThreats: undefined }).nearbyEntities).toHaveLength(2);
  });
});

describe('lessons are written into the conversation once and named in the per-call note (L97: a third of the note re-sent at full price each call)', () => {
  const section = (ids: string[]) => `## 経験から学んだ知識（いまの状況に合うものだけ）\n最新のnative観測と矛盾する時は観測を優先する。\n${ids.map(id => `- [${id}] (prefer) 状況 → 助言${id}`).join('\n')}`;
  it('writes a lesson\'s text the first time it applies and only its name after that', () => {
    const messages: any[] = [{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'done' }] }];
    const written = new Set<string>();
    const note = knowledgeIntoHistory(messages, section(['a', 'b']), written);
    expect(note).toContain('a, b');
    expect(note).not.toContain('助言a');
    expect(messages[2].content.at(-1).text).toContain('助言a');
    expect(messages[2].content.at(-1).text).toContain('助言b');
    expect(messages[2].content[0].type).toBe('tool_result');
    // Next call: b again and a new c; only c's text is added.
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'next' }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u', content: 'done' }] });
    knowledgeIntoHistory(messages, section(['b', 'c']), written);
    const added = messages[4].content.at(-1).text;
    expect(added).toContain('助言c');
    expect(added).not.toContain('助言b');
    // Back to a: already in the conversation, nothing written.
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'again' }] }, { role: 'user', content: 'plain' });
    knowledgeIntoHistory(messages, section(['a']), written);
    expect(messages[6].content).toBe('plain');
  });
});

