import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { CommonFcaUiModBridge, planTree, sanitizePlan } from '../../src/services/minebot/integration/commonFca/uiModBridge.js';

// The plan tree into the UI mod v2 (design mb-llm-centric 2.7): nested hierarchicalSubTasks, the current node, and the act's steps
// as its children. The mod is not changed; only what is posted to it.
const plan = {
  revision: 3, current: 'iron',
  nodes: [
    { id: 'root', parentId: null, title: 'エンドラ討伐', state: 'continue' as const },
    { id: 'wood', parentId: 'root', title: '木と石の道具', state: 'done' as const },
    { id: 'iron', parentId: 'root', title: '鉄のツルハシ', state: 'continue' as const },
    { id: 'food', parentId: 'root', title: '食料 60点', state: 'blocked' as const, reason: '村が無い' },
    { id: 'smelt', parentId: 'iron', title: '鉄を焼く', state: 'wait' as const },
  ],
};

describe('the plan as the mod\'s nested tree', () => {
  it('nests, maps the states and puts the act\'s steps under the current node', () => {
    const tree = planTree(plan, { steps: [{ label: 'dig (1,2,3)', status: 'completed', detail: '掘った' }, { label: 'walk → (4,5,6)', status: 'in_progress', detail: '' }] });
    expect(tree).toHaveLength(1);
    const [root] = tree;
    expect(root.status).toBe('pending');
    expect(root.children.map(child => [child.id, child.status, child.depth])).toEqual([['wood', 'completed', 1], ['iron', 'in_progress', 1], ['food', 'error', 1]]);
    expect(root.children[2].failureReason).toBe('村が無い');
    const iron = root.children[1];
    expect(iron.children.map(child => [child.id, child.status])).toEqual([['smelt', 'pending'], ['iron/act-1', 'completed'], ['iron/act-2', 'in_progress']]);
    expect(iron.children[1].goal).toBe('手1: dig (1,2,3)');
  });

  it('keeps a plan only as far as it is well formed', () => {
    const clean = sanitizePlan({ current: 'nope', nodes: [{ id: 'a', parentId: 'ghost', title: 'A', state: 'odd' }, { id: 'a', parentId: null, title: 'dup', state: 'done' }, { nope: 1 }] });
    expect(clean).toEqual({ current: null, nodes: [{ id: 'a', parentId: null, title: 'A', state: 'continue' }] });
    expect(sanitizePlan({ revision: 4, current: 'a', nodes: [{ id: 'a', parentId: null, title: 'A', state: 'blocked', reason: 'r' }] })).toEqual({ revision: 4, current: 'a', nodes: [{ id: 'a', parentId: null, title: 'A', state: 'blocked', reason: 'r' }] });
    expect(sanitizePlan(null)).toBeUndefined();
  });

  it('posts the plan with its current node, and the act\'s progress from the body', async () => {
    const posts: Array<{ url: string; body: any }> = [];
    const fetcher = (async (url: string, init: any) => { posts.push({ url, body: JSON.parse(init.body) }); return new Response('{}'); }) as unknown as typeof fetch;
    const source = new EventEmitter();
    const bridge = new CommonFcaUiModBridge({ baseUrl: () => 'http://127.0.0.1:1', fetcher, source, timeoutMs: 500 });
    bridge.start();
    const context = { scopeKey: 's', taskId: 't1', taskRevision: 1, bodyId: 'b', sessionId: 'x', generation: 1, goal: 'エンドラ討伐', completionCondition: 'ドラゴンが倒れる', plan };
    const command: any = { schemaVersion: 1, id: 'c1', serverId: 's', connectionId: 'k', kind: 'skill', skill: 'act', context,
      lease: { id: 'l', generation: 1, holder: 'h' }, deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      arguments: { hands: [{ do: 'dig', at: [{ x: 1, y: 2, z: 3 }] }, { do: 'walk', to: { x: 4, y: 5, z: 6 }, note: '炉へ' }] } };
    bridge.commandStarted(command);
    source.emit('minebotActStep', { index: 0, status: 'completed', detail: '掘った' });
    source.emit('minebotActStep', { index: 1, status: 'in_progress', detail: '' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const last = posts.filter(post => post.url.endsWith('/task')).at(-1)!.body;
    expect(last.currentSubTaskId).toBe('iron');
    const iron = last.hierarchicalSubTasks[0].children[1];
    expect(iron.children.slice(1).map((child: any) => child.status)).toEqual(['completed', 'in_progress']);
    expect(iron.children[2].goal).toBe('手2: 炉へ');
    bridge.commandEnded(command, { id: 'c1', connectionId: 'k', outcome: 'completed', inputsReleased: true, observedAt: new Date().toISOString(), result: 'ok' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const ended = posts.filter(post => post.url.endsWith('/task')).at(-1)!.body;
    expect(ended.hierarchicalSubTasks[0].children[1].children.slice(1).map((child: any) => child.status)).toEqual(['completed', 'completed']);
    bridge.stop();
  });

  it('without a plan, shows the commands as a flat list as before', () => {
    const bridge = new CommonFcaUiModBridge({ baseUrl: () => 'http://127.0.0.1:1', fetcher: (async () => new Response('{}')) as unknown as typeof fetch });
    const context = { scopeKey: 's', taskId: 't2', taskRevision: 1, bodyId: 'b', sessionId: 'x', generation: 1, goal: 'g', completionCondition: 'c' };
    bridge.commandStarted({ schemaVersion: 1, id: 'c2', serverId: 's', connectionId: 'k', kind: 'skill', skill: 'move-to', context, arguments: { x: 1 },
      lease: { id: 'l', generation: 1, holder: 'h' }, deadlineAt: new Date(Date.now() + 60_000).toISOString() } as any);
    const tree = bridge.taskList().currentTaskTree as any;
    expect(tree.hierarchicalSubTasks).toEqual([{ id: 's1', goal: 'move-to {"x":1}', status: 'in_progress', result: '', failureReason: '', depth: 0, children: [] }]);
    expect(tree.currentSubTaskId).toBe('s1');
    bridge.stop();
  });
});
