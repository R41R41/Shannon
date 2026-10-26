import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { CommonFcaUiModBridge, planTree } from '../../src/services/minebot/integration/commonFca/uiModBridge.js';

// The task queue in the mod's task tab (design 8.2): a running item's hands go under the plan node the item is for, not under whatever the plan's
// current node is; the items that wait show under their nodes as pending; one line says how many run and wait.
const plan = {
  revision: 5, current: 'bed',
  nodes: [
    { id: 'p1', parentId: null, title: 'エンドラ討伐', state: 'continue' as const },
    { id: 'bed', parentId: 'p1', title: '地下のベッドを取る', state: 'continue' as const },
    { id: 'iron', parentId: 'p1', title: '鉄を焼く', state: 'continue' as const },
    { id: 'food', parentId: 'p1', title: '食料', state: 'continue' as const },
  ],
};
const context = { scopeKey: 's', taskId: 'task-abcdef-123456', taskRevision: 1, bodyId: 'b', sessionId: 'x', generation: 1, goal: 'g', completionCondition: 'c', plan };
const item = (id: string, name: string, node: string | null, hands: unknown[]): any => ({ schemaVersion: 1, id, serverId: 's', connectionId: 'k', kind: 'skill', skill: 'act',
  context, lease: { id: 'l', generation: 1, holder: 'h' }, deadlineAt: new Date(Date.now() + 60_000).toISOString(), arguments: { hands },
  queue: { item: name, after: null, node, maxMs: 60_000, startBy: new Date(Date.now() + 60_000).toISOString() } });
const done = { connectionId: 'k', outcome: 'completed' as const, inputsReleased: true, observedAt: new Date().toISOString() };
const wait = () => new Promise(resolve => setTimeout(resolve, 40));

function setup() {
  const posts: Array<{ url: string; body: any }> = [], lines: string[] = [];
  const fetcher = (async (url: string, init: any) => { posts.push({ url, body: JSON.parse(init.body) }); return new Response('{}'); }) as unknown as typeof fetch;
  const source = new EventEmitter();
  const bridge = new CommonFcaUiModBridge({ baseUrl: () => 'http://127.0.0.1:1', fetcher, source, timeoutMs: 500, log: line => lines.push(line) });
  bridge.start();
  const last = () => posts.filter(post => post.url.endsWith('/task')).at(-1)!.body;
  return { bridge, source, posts, lines, last };
}

describe('the task queue in the task tab', () => {
  it('shows the running item\'s hands under the item\'s own node, the current node is that one, and a waiting item is pending under its node', async () => {
    const { bridge, source, last } = setup();
    const a = item('a', 'q1', 'iron', [{ do: 'dig', at: [{ x: 1, y: 2, z: 3 }] }, { do: 'walk', to: { x: 4, y: 5, z: 6 }, note: '炉へ' }]);
    const b = item('b', 'q2', 'food', [{ do: 'eat' }]);
    bridge.commandQueued(b);
    bridge.commandStarted(a);
    source.emit('minebotActStep', { index: 0, status: 'completed', detail: '掘った' });
    source.emit('minebotActStep', { index: 1, status: 'in_progress', detail: '' });
    bridge.commandQueued(item('c', 'q3', 'food', [{ do: 'wait', seconds: 1 }]));
    await wait();
    const tree = last();
    expect(tree.currentSubTaskId).toBe('iron');
    const [root] = tree.hierarchicalSubTasks;
    const byId = Object.fromEntries(root.children.map((child: any) => [child.id, child]));
    expect(byId.bed.children).toEqual([]);
    expect(byId.iron.children.map((child: any) => [child.goal, child.status])).toEqual([['手1: dig (1,2,3)', 'completed'], ['手2: 炉へ', 'in_progress']]);
    expect(byId.food.children.map((child: any) => child.status)).toEqual(['pending', 'pending']);
    expect(byId.food.children[0].goal).toContain('待ち: q2 act 1手');
    bridge.stop();
  });

  it('a started waiting item leaves the waiting list; an item with a node the plan lacks, or none, falls back to the plan\'s current node', async () => {
    const { bridge, last } = setup();
    const b = item('b', 'q2', 'food', [{ do: 'eat' }]);
    bridge.commandQueued(b);
    bridge.commandStarted(b);
    await wait();
    expect(last().currentSubTaskId).toBe('food');
    expect(last().hierarchicalSubTasks[0].children.find((child: any) => child.id === 'food').children.map((child: any) => child.id)).toEqual(['food/act-1']);
    bridge.commandEnded(b, { ...done, id: 'b' });
    const c = item('c', 'q3', 'ghost', [{ do: 'jump' }]);
    bridge.commandStarted(c);
    await wait();
    expect(last().currentSubTaskId).toBe('bed');
    bridge.commandEnded(c, { ...done, id: 'c' });
    bridge.commandStarted(item('d', 'q4', null, [{ do: 'jump' }]));
    await wait();
    expect(last().currentSubTaskId).toBe('bed');
    bridge.stop();
  });

  it('an item that never started (dropped) is listed among the steps as an error; it no longer waits', async () => {
    const { bridge, last } = setup();
    const a = item('a', 'q1', 'iron', [{ do: 'jump' }]), b = item('b', 'q2', 'iron', [{ do: 'eat' }]);
    bridge.commandStarted(a);
    bridge.commandQueued(b);
    bridge.commandEnded(a, { ...done, id: 'a', outcome: 'failed', failureType: 'out_of_reach' });
    bridge.commandEnded(b, { ...done, id: 'b', outcome: 'cancelled', failureType: 'queue_dropped', result: '捨てた: 前の項目 q1 が止まった（out_of_reach）。手は動いていない' });
    await wait();
    const iron = last().hierarchicalSubTasks[0].children.find((child: any) => child.id === 'iron');
    expect(iron.children.filter((child: any) => child.id.includes('wait'))).toEqual([]);
    expect(bridge.taskList().currentTaskTree).toBeDefined();
    bridge.stop();
  });

  it('says in a line of its own how many items run and wait when that changes, besides the rel52 line', async () => {
    const { bridge, lines } = setup();
    bridge.commandStarted(item('a', 'q1', 'iron', [{ do: 'jump' }])); await wait();
    bridge.commandQueued(item('b', 'q2', 'food', [{ do: 'eat' }])); await wait();
    bridge.commandQueued(item('c', 'q3', 'food', [{ do: 'eat' }])); await wait();
    expect(lines).toEqual([
      'UI_MOD push /task items=1+0 current=iron ok=1 task=task-abcdef-',
      'UI_MOD push /task ok=1 status=200 revision=5 current=iron task=task-abcdef-',
      'UI_MOD push /task items=1+1 current=iron ok=1 task=task-abcdef-',
      'UI_MOD push /task items=1+2 current=iron ok=1 task=task-abcdef-',
    ]);
    bridge.stop();
  });

  it('planTree keeps its old two arguments working', () => {
    const tree = planTree(plan, { steps: [{ label: 'dig', status: 'in_progress', detail: '' }] });
    expect(tree[0]!.children.find(child => child.id === 'bed')!.children.map(child => child.id)).toEqual(['bed/act-1']);
  });
});
