import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/config/env.js', () => ({ config: { anthropic: { apiKey: 'test-only', model: 'fixture' } } }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { UI_MOD_BASE_URL: 'http://example.invalid' } }));
import { ShannonExecutor } from '../../src/services/llm/graph/ShannonExecutor.js';
import { CampaignGoalGraph } from '../../src/services/minebot/cognition/CampaignGoalGraph.js';
import { CompanionBodyClient, type CompanionRequest } from '../../src/services/minebot/integration/CompanionBodyClient.js';
import { CompanionRequestLoop } from '../../src/services/minebot/integration/CompanionRequestLoop.js';
import { CompanionRuntimeTasks } from '../../src/services/minebot/integration/CompanionRuntimeTasks.js';
import { MindControlledCampaign, MIND_CAMPAIGN_USER_GOAL } from '../../src/services/minebot/testing/MindControlledCampaign.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const requestId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const now = Date.parse('2026-10-08T08:00:00Z');
const success = [{ kind: 'boss_defeated' as const, entity: 'ender_dragon' as const, dimension: 'the_end' as const }];

function pipeline(goal: string, options: { unattested?: boolean; wrongGoal?: boolean; wrongSuccess?: boolean; bindingFailure?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-root-executor-')); directories.push(directory);
  const request: CompanionRequest = { id: requestId, goal, surface: 'text',
    createdAt: new Date(now).toISOString(), leaseExpiresAt: new Date(now + 120000).toISOString() };
  let graph: CampaignGoalGraph | undefined;
  const stop = new AbortController();
  // End only this synthetic run after one real planner entry; this is not world success.
  const stream = vi.fn(() => ({ finalMessage: async () => {
    stop.abort();
    return { content: [{ type: 'text', text: 'fixture' }], usage: {} };
  } }));
  const create = vi.fn(async () => ({ content: [{ type: 'text', text: 'fixture' }], usage: {} }));
  const bot: any = Object.assign(new EventEmitter(), { inventory: { items: () => [] },
    entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'overworld' }, entities: {}, health: 20, food: 20 });
  const results: Array<Promise<{ ok: true } | { ok: false; code: string }>> = [];
  const events: string[] = [];
  let campaign: MindControlledCampaign;
  const runtime = {
    // Synchronous entry matters: onTaken/putTaskFirst's return is too late to bind the immutable graph.
    putTaskFirst: vi.fn((input: { userMessage?: string | null }) => {
      events.push('dispatch');
      expect(graph).toBeDefined();
      expect(campaign.acceptedGoal).toBe(input.userMessage);
      const executor = new ShannonExecutor({ modelClient: { messages: { stream, create } } as any,
        modelIdentity: { provider: 'fixture', model: 'fixture' }, bot, campaign: graph,
        publishTaskTree: () => {}, instantSkills: { getSkill: () => undefined, getSkills: () => [] } as any });
      results.push(executor.run({ runId: 'canonical-run', goal: options.wrongGoal ? '別の目的' : input.userMessage!,
        context: null, systemPrompt: 'Fixture only', tools: [], abortSignal: stop.signal,
        goalContract: { goal: input.userMessage!, predicates: options.wrongSuccess
          ? [{ kind: 'inventory', item: 'oak_log', count: 1 }] : success } } as any)
        .then(() => ({ ok: true as const }), error => ({ ok: false as const, code: error.message })));
      return { success: true, taskId: 'original-task' };
    }),
    getTaskListState: () => ({ tasks: [] }),
    isTaskExecuting: () => false,
    stopTaskAndWait: async () => true,
    removeTask: () => ({ success: true }),
  };
  const delegate = new CompanionRuntimeTasks(runtime, { waiting: () => 0, deaths: () => 0, inventory: () => ({}),
    envelope: value => ({ tags: ['mind_campaign_root'], metadata: { mindCampaignRequestId: value.id, companionTask: { requestId: value.id } } }) });
  const bind = vi.fn((value: Readonly<CompanionRequest>) => {
    events.push('bind');
    if (options.bindingFailure) throw new Error('fixture binding failed');
    graph = CampaignGoalGraph.open({ directory, id: 'canonical', worldId: 'isolated-world', goal: value.goal, success });
  });
  campaign = new MindControlledCampaign(delegate, runtime, { now: () => now, setupMs: 120000, windowMs: 2400000,
    ownerThreadId: threadId, attestRoot: async () => { events.push('attest'); return options.unattested ? null : requestId; },
    beforeRootDispatch: bind });
  const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/claim')
    ? Response.json({ request, cancel: [] }) : Response.json({ state: 'running', cancel: false })) as typeof fetch;
  const client = new CompanionBodyClient({ baseUrl: 'http://127.0.0.1:3999', serverId: 'isolated-world',
    token: 'synthetic-body-token', fetcher });
  const loop = new CompanionRequestLoop(campaign.trackClient(client), campaign, { now: () => now });
  campaign.submitting();
  return { campaign, request, loop, runtime, bind, stream, create, results, events, directory, graph: () => graph };
}

describe('attested canonical goal reaches the real campaign executor', () => {
  it.each(['エンドラを倒す。', ' Minecraftでエンダードラゴンを撃破する！ '])('binds the exact accepted alias before synchronous dispatch: %s', async goal => {
    const h = pipeline(goal);
    expect(fs.readdirSync(h.directory)).toEqual([]);
    await h.loop.claimOnce(0);
    expect(h.events).toEqual(['attest', 'bind', 'dispatch']);
    expect(await Promise.all(h.results)).toEqual([{ ok: true }]);
    expect(h.stream).toHaveBeenCalledTimes(1);
    expect(h.graph()?.goal).toBe(goal);
    expect(h.graph()?.getNode('root')?.postconditions).toEqual(success);
    expect(h.graph()?.getNode('root')?.state).not.toBe('verified');
    expect(h.campaign.verifiedAcknowledged).toBe(false);
    expect(h.campaign.userGoal).toBe(MIND_CAMPAIGN_USER_GOAL);
    expect(h.campaign.receipt().originalGoalSha256).not.toBe(h.campaign.receipt().acceptedGoalSha256);
  });
  it.each([{ wrongGoal: true }, { wrongSuccess: true }])('retains the exact executor context/success guard: %j', async options => {
    const h = pipeline('エンドラを倒す。', options);
    await h.loop.claimOnce(0);
    expect(await Promise.all(h.results)).toEqual([{ ok: false, code: 'CAMPAIGN_CONTEXT_OR_SUCCESS_MISMATCH' }]);
    expect(h.stream).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled();
  });
  it('unattested/direct roots cannot create a graph or dispatch a model', async () => {
    const h = pipeline('エンドラを倒す。', { unattested: true });
    await h.loop.claimOnce(0);
    expect(h.campaign.start(h.request)).toEqual({ refused: 'unsupported' });
    expect(h.bind).not.toHaveBeenCalled(); expect(h.runtime.putTaskFirst).not.toHaveBeenCalled();
    expect(h.stream).not.toHaveBeenCalled(); expect(h.graph()).toBeUndefined();
    expect(fs.readdirSync(h.directory)).toEqual([]);
  });
  it('duplicate delivery cannot rebind or dispatch the original a second time', async () => {
    const h = pipeline('エンドラを倒す。');
    await h.loop.claimOnce(0); await Promise.all(h.results);
    expect(h.campaign.start({ ...h.request, goal: MIND_CAMPAIGN_USER_GOAL })).toEqual({ taskId: 'original-task' });
    expect(h.bind).toHaveBeenCalledTimes(1); expect(h.runtime.putTaskFirst).toHaveBeenCalledTimes(1);
    expect(h.stream).toHaveBeenCalledTimes(1); expect(h.graph()?.goal).toBe(h.request.goal);
  });
  it('a binding failure stops before the queue and never retries the original', async () => {
    const h = pipeline('エンドラを倒す。', { bindingFailure: true });
    await h.loop.claimOnce(0);
    expect(h.runtime.putTaskFirst).not.toHaveBeenCalled(); expect(h.stream).not.toHaveBeenCalled();
    expect(h.campaign.start(h.request)).toEqual({ refused: 'unsupported' }); expect(h.bind).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(h.directory)).toEqual([]);
  });
});
