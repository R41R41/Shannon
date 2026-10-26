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

  it('carries the words of a node: where, doneWhen, note, forbid and caution to the mod, only the ones it has, clipped', () => {
    const clean = sanitizePlan({ revision: 5, current: 'a', nodes: [
      { id: 'a', parentId: null, title: 'A', state: 'continue', where: '(196,69,237) 村の北', doneWhen: 'iron_ingot×24 を持つ', note: 'x'.repeat(200),
        forbid: ['夜に外へ出ない', '', 7, 'y'.repeat(200), 'c', 'd', 'e'], caution: [] },
      { id: 'b', parentId: 'a', title: 'B', state: 'wait', where: '', note: 5, forbid: 'not a list' }] })!;
    expect(clean.nodes[0]).toEqual({ id: 'a', parentId: null, title: 'A', state: 'continue', where: '(196,69,237) 村の北', doneWhen: 'iron_ingot×24 を持つ',
      note: 'x'.repeat(120), forbid: ['夜に外へ出ない', 'y'.repeat(80), 'c', 'd'] });
    expect(clean.nodes[1]).toEqual({ id: 'b', parentId: 'a', title: 'B', state: 'wait' });
    const [root] = planTree(clean, { steps: [{ label: 'dig', status: 'in_progress', detail: '' }] });
    expect(root).toMatchObject({ where: '(196,69,237) 村の北', doneWhen: 'iron_ingot×24 を持つ', forbid: ['夜に外へ出ない', 'y'.repeat(80), 'c', 'd'] });
    expect(root.children[0]).not.toHaveProperty('where');
    expect(root.children[0]).not.toHaveProperty('forbid');
    // The act's step under the current node has none of these.
    expect(root.children[1]).not.toHaveProperty('doneWhen');
    expect(planTree(plan)[0]).not.toHaveProperty('note');
  });

  it('posts the plan revision, and the reflex that holds the body from its start to its end', async () => {
    const posts: Array<{ url: string; body: any }> = [];
    const fetcher = (async (url: string, init: any) => { posts.push({ url, body: JSON.parse(init.body) }); return new Response('{}'); }) as unknown as typeof fetch;
    const bridge = new CommonFcaUiModBridge({ baseUrl: () => 'http://127.0.0.1:1', fetcher, timeoutMs: 500 });
    const context = { scopeKey: 's', taskId: 't3', taskRevision: 1, bodyId: 'b', sessionId: 'x', generation: 1, goal: 'g', completionCondition: 'c', plan };
    const base = { schemaVersion: 1, serverId: 's', connectionId: 'k', context, lease: { id: 'l', generation: 1, holder: 'h' },
      deadlineAt: new Date(Date.now() + 60_000).toISOString() };
    const tasks = () => posts.filter(post => post.url.endsWith('/task')).map(post => post.body);
    const done = { connectionId: 'k', outcome: 'completed' as const, inputsReleased: true, observedAt: new Date().toISOString(), result: 'ok' };
    const reflex: any = { ...base, id: 'r1', kind: 'reflex', operation: { candidate: { label: '右へ避ける'.padEnd(80, '！') } } };
    bridge.commandStarted(reflex);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(tasks().at(-1)).toMatchObject({ planRevision: 3, activeReflex: '右へ避ける'.padEnd(60, '！') });
    expect((bridge.taskList().currentTaskTree as any).activeReflex).toBe('右へ避ける'.padEnd(60, '！'));
    // Another command ending does not end the reflex; its own end does.
    const skill: any = { ...base, id: 'c3', kind: 'skill', skill: 'move-to', arguments: { x: 1 } };
    bridge.commandStarted(skill);
    bridge.commandEnded(skill, { ...done, id: 'c3' });
    expect((bridge.taskList().currentTaskTree as any).activeReflex).toBe('右へ避ける'.padEnd(60, '！'));
    bridge.commandEnded(reflex, { ...done, id: 'r1' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(tasks().at(-1)).toMatchObject({ planRevision: 3, activeReflex: null });
    bridge.stop();
  });

  it('logs one line when the plan revision, its current node or the mod\'s answer changes, and no plan text (dragon26)', async () => {
    const lines: string[] = [];
    let status = 200;
    const fetcher = (async (url: string) => (url.endsWith('/task') ? new Response('{}', { status }) : new Response('{}'))) as unknown as typeof fetch;
    const bridge = new CommonFcaUiModBridge({ baseUrl: () => 'http://127.0.0.1:1', fetcher, timeoutMs: 500, log: line => lines.push(line) });
    const context = (revision: number, current: string) => ({ scopeKey: 's', taskId: 'task-abcdef-123456', taskRevision: 1, bodyId: 'b', sessionId: 'x', generation: 1,
      goal: 'g', completionCondition: 'c', plan: { ...plan, revision, current } });
    const command = (id: string, revision: number, current: string): any => ({ schemaVersion: 1, serverId: 's', connectionId: 'k', id, kind: 'skill', skill: 'move-to',
      arguments: { x: 1 }, context: context(revision, current), lease: { id: 'l', generation: 1, holder: 'h' }, deadlineAt: new Date(Date.now() + 60_000).toISOString() });
    const wait = () => new Promise(resolve => setTimeout(resolve, 40));
    bridge.commandStarted(command('c1', 3, 'iron')); await wait();
    bridge.commandStarted(command('c2', 3, 'iron')); await wait();
    bridge.commandStarted(command('c3', 4, 'food')); await wait();
    status = 500;
    bridge.commandStarted(command('c4', 4, 'food')); await wait();
    expect(lines).toEqual([
      'UI_MOD push /task ok=1 status=200 revision=3 current=iron task=task-abcdef-',
      'UI_MOD push /task ok=1 status=200 revision=4 current=food task=task-abcdef-',
      'UI_MOD push /task ok=0 status=500 revision=4 current=food task=task-abcdef-',
    ]);
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
    expect(tree.activeReflex).toBeNull();
    expect(tree).not.toHaveProperty('planRevision');
    bridge.stop();
  });
});
