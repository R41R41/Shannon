import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
vi.mock('../../src/config/env.js', () => ({ config: { anthropic: { apiKey: 'test-only', model: 'test-model' } } }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { UI_MOD_BASE_URL: 'http://example.invalid' } }));
vi.mock('../../src/services/minebot/testing/MinecraftCommandOracle.js', () => ({ MinecraftCommandOracle: class {
  async verifyReady() {} async executeSetupCommand() {} async evaluate() { return { passed: true }; }
} }));
import { applyTaskTreeOperations, reconcileTaskNodes, selectActiveTaskNode, TaskTreeValidationError } from '../../src/services/llm/graph/ShannonExecutor.js';
import { flatAcceptanceSetup } from '../../src/services/minebot/testing/acceptanceFixture.js';
import { GoalVerifier } from '../../src/services/minebot/cognition/GoalVerifier.js';
import { AutonomousScenarioRunner } from '../../src/services/minebot/testing/AutonomousScenarioRunner.js';

const node = (id: string): any => ({ id, goal: id, status: 'pending', children: [] });
describe('atomic verified goal graph', () => {
  it('does not reuse a deleted ID, including descendants and resumed history', () => {
    const nodes: any[] = [];
    applyTaskTreeOperations(nodes, [{ action: 'create', id: 'root' }, { action: 'create', id: 'child', parentId: 'root' }]);
    const deleted = applyTaskTreeOperations(nodes, [{ action: 'delete', id: 'root' }]);
    expect(() => applyTaskTreeOperations(nodes, [{ action: 'create', id: 'child' }])).toThrow('TASK_NODE_ID_RETIRED');
    expect(() => applyTaskTreeOperations([], [{ action: 'create', id: 'root' }], undefined, new Set(deleted.usedNodeIds))).toThrow('TASK_NODE_ID_RETIRED');
    expect(nodes).toEqual([]);
  });
  it('does not retire IDs from an invalid atomic batch', () => {
    const nodes: any[] = [];
    expect(() => applyTaskTreeOperations(nodes, [{ action: 'create', id: 'new' }, { action: 'create', id: 'bad', parentId: 'missing' }])).toThrow();
    expect(() => applyTaskTreeOperations(nodes, [{ action: 'create', id: 'new' }])).not.toThrow();
  });
  it.each([
    [{ action: 'create', id: 'a' }, { action: 'create', id: 'a' }],
    [{ action: 'create', id: 'a', parentId: 'missing' }],
    [{ action: 'create', id: 'a', requires: ['missing'] }],
    [{ action: 'create', id: 'a', requires: ['a'] }],
    [{ action: 'create', id: 'a' }, { action: 'create', id: 'b', requires: ['a'] }, { action: 'update', id: 'a', requires: ['b'] }],
    [{ action: 'create', id: 'a' }, { action: 'create', id: 'b', parentId: 'a', requires: ['a'] }],
    [{ action: 'update', id: 'missing', status: 'completed' }],
  ])('rejects invalid graph batch atomically %#', (operations: any) => {
    const nodes: any[] = []; expect(() => applyTaskTreeOperations(nodes, operations)).toThrow(); expect(nodes).toEqual([]);
  });
  it('rejects a completed node without evidence and preserves its prior status', () => {
    const nodes = [node('iron')]; const verifier = new GoalVerifier({ inventory: { items: () => [] } });
    expect(() => applyTaskTreeOperations(nodes, [{ action: 'update', id: 'iron', status: 'completed' }], verifier)).toThrow('TASK_COMPLETION_UNKNOWN');
    expect(nodes[0].status).toBe('pending'); verifier.dispose();
  });
  it('retains verified prerequisite evidence after resources are consumed by a dependent task', () => {
    let inventory = [{ name: 'iron_ingot', count: 3 }];
    const verifier = new GoalVerifier({ inventory: { items: () => inventory } }); const nodes: any[] = [];
    applyTaskTreeOperations(nodes, [{ action: 'create', id: 'iron', goal: 'get iron', status: 'completed', postconditions: [{ kind: 'inventory', item: 'iron_ingot', count: 3 }] },
      { action: 'create', id: 'pickaxe', requires: ['iron'], status: 'in_progress' }], verifier);
    inventory = [{ name: 'iron_pickaxe', count: 1 }];
    applyTaskTreeOperations(nodes, [{ action: 'update', id: 'iron', progress: 'consumed to craft tool' }], verifier);
    expect(nodes[0].verification.status).toBe('verified');
    applyTaskTreeOperations(nodes, [{ action: 'update', id: 'pickaxe', status: 'completed', postconditions: [{ kind: 'inventory', item: 'iron_pickaxe', count: 1 }] }], verifier);
    expect(nodes.every(node => node.status === 'completed')).toBe(true); verifier.dispose();
  });
  it('does not trust a legacy completed dependency without verification', () => {
    const nodes = [{ ...node('iron'), status: 'completed' }]; const verifier = new GoalVerifier({ inventory: { items: () => [] } });
    expect(() => applyTaskTreeOperations(nodes, [{ action: 'create', id: 'tool', requires: ['iron'], status: 'in_progress' }], verifier)).toThrow('TASK_DEPENDENCY_UNVERIFIED');
    verifier.dispose();
  });
  it('reconciles child, dependent, and parent only from their own native evidence', () => {
    const bot = { inventory: { items: () => [{ name: 'bread', count: 1 }] } };
    const verifier = new GoalVerifier(bot);
    const bread = [{ kind: 'inventory', item: 'bread', count: 1 }];
    const nodes: any[] = [{ ...node('root'), status: 'in_progress', postconditions: bread,
      children: [{ ...node('second'), requires: ['first'], postconditions: bread }, { ...node('first'), postconditions: bread }] }];
    expect(new Set(reconcileTaskNodes(nodes, verifier))).toEqual(new Set(['root', 'first', 'second']));
    expect(nodes[0].status).toBe('completed');
    expect(reconcileTaskNodes(nodes, verifier)).toEqual([]); verifier.dispose();
  });
  it('does not infer proof for an unspecified parent or missing inventory', () => {
    const verifier = new GoalVerifier({ inventory: { items: () => [] } });
    const nodes: any[] = [{ ...node('parent'), children: [{ ...node('missing'), postconditions: [{ kind: 'inventory', item: 'bread', count: 1 }] }] }];
    expect(reconcileTaskNodes(nodes, verifier)).toEqual([]);
    nodes[0].children[0].status = 'completed';
    expect(reconcileTaskNodes(nodes, verifier)).toEqual([]); expect(nodes[0].status).toBe('pending'); verifier.dispose();
  });
  it('explains missing proof without committing a partial batch', () => {
    const nodes = [node('bread')]; const verifier = new GoalVerifier({ inventory: { items: () => [] } });
    try { applyTaskTreeOperations(nodes, [{ action: 'update', id: 'bread', status: 'completed' }], verifier); throw new Error('expected rejection'); }
    catch (error) { expect(error).toBeInstanceOf(TaskTreeValidationError); expect((error as TaskTreeValidationError).diagnostic).toMatchObject({ nodeId: 'bread', missingPredicates: true }); }
    expect(nodes[0].status).toBe('pending'); verifier.dispose();
  });
  it('clears a completed active node, but rejects an explicit selection with ready IDs', () => {
    const nodes = [{ ...node('old'), status: 'completed' }, node('next')];
    expect(selectActiveTaskNode(nodes, undefined, 'old')).toBeUndefined();
    expect(selectActiveTaskNode(nodes, null, 'next')).toBeUndefined();
    expect(selectActiveTaskNode(nodes, 'next')).toBe('next');
    try { selectActiveTaskNode(nodes, 'old'); throw new Error('expected rejection'); }
    catch (error) { expect((error as TaskTreeValidationError).diagnostic).toMatchObject({ nodeId: 'old', readyNodeIds: ['next'], nodeStatus: 'completed' }); }
  });
});

describe('flat fixture isolation', () => {
  it('resets the complete search cube including the old height-107 residue, within fill limits', () => {
    const fills = flatAcceptanceSetup().filter(command => command.endsWith(' air')).map(command => command.split(' ').slice(1, 7).map(Number));
    expect(fills.some(([x1, y1, z1, x2, y2, z2]) => x1 <= 0 && x2 >= 0 && z1 <= 2 && z2 >= 2 && y1 <= 107 && y2 >= 107)).toBe(true);
    expect(fills[0]).toEqual([-24, 76, -24, 24, 83, 24]); expect(fills.at(-1)).toEqual([-24, 124, -24, 24, 124, 24]);
    for (const [x1, y1, z1, x2, y2, z2] of fills) expect((x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1)).toBeLessThanOrEqual(32768);
  });
});

describe('isolated planner dispatch boundary', () => {
  const fixture = (): any => Object.assign(new EventEmitter(), {
    _client: { socket: { remoteAddress: '127.0.0.1', remotePort: 25577 } },
    inventory: { items: () => [] }, entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'overworld' },
    instantSkills: { getSkill: vi.fn(), getSkills: () => [] }, entities: {}, health: 20, food: 20,
  });
  const scenario: any = { id: 'fixture', goal: 'stand here', constraints: '', setup: [], assertions: [],
    goalContract: { goal: 'stand here', predicates: [{ kind: 'position', dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, radius: 1 }] } };
  it.each(['chat', 'get-advancements', 'investigate-terrain'])('rejects non-isolated %s in the model catalog', async name => {
    const runner = new AutonomousScenarioRunner(fixture(), {} as any, 25577);
    await expect(runner.run(scenario, { tools: [{ name }] as any, plannerKind: 'protocol_fixture' })).rejects.toThrow('ISOLATED_LOCAL_TOOLS_ONLY');
  });
  it('cannot dispatch a hallucinated unlisted chat command even though the native bot owns that skill', async () => {
    const bot = fixture(); const run = vi.fn(); bot.instantSkills.getSkill.mockReturnValue({ params: [], run });
    let turn = 0;
    const client: any = { messages: { stream: () => ({ finalMessage: async () => ({ usage: {}, content: turn++ === 0
      ? [{ type: 'tool_use', id: 'forbidden', name: 'chat', input: { message: '/give @s oak_log 3' } }]
      : [{ type: 'tool_use', id: 'done', name: 'task-complete', input: { summary: 'verified position' } }] }) }) } };
    const runner = new AutonomousScenarioRunner(bot, { modelClient: client } as any, 25577);
    const result = await runner.run(scenario, { tools: [], plannerKind: 'protocol_fixture' });
    expect(result.passed).toBe(true); expect(run).not.toHaveBeenCalled(); expect(bot.instantSkills.getSkill).not.toHaveBeenCalled();
    expect(result.autonomousQualityEvaluated).toBe(false);
  });
  it.each(['end', 'death'])('aborts after %s without dispatching stale model actions or another API request', async event => {
    const bot = fixture(); const run = vi.fn(); bot.instantSkills.getSkill.mockReturnValue({ params: [], run });
    const finalMessage = vi.fn(async () => { bot.emit(event); return { usage: {}, content: [{ type: 'tool_use', id: 'stale', name: 'move-to', input: {} }] }; });
    const client: any = { messages: { stream: () => ({ finalMessage }) } };
    const result = await new AutonomousScenarioRunner(bot, { modelClient: client } as any, 25577).run(scenario, {
      tools: [{ name: 'move-to' }] as any, plannerKind: 'protocol_fixture',
    });
    expect(result.passed).toBe(false); expect(finalMessage).toHaveBeenCalledTimes(1); expect(run).not.toHaveBeenCalled();
    expect(bot.listenerCount(event)).toBe(0);
  });
});
