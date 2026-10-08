import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { GoalVerifier } from '../../src/services/minebot/cognition/GoalVerifier.js';
import { CompanionBodyClient, type CompanionRequest } from '../../src/services/minebot/integration/CompanionBodyClient.js';
import { CompanionRuntimeTasks } from '../../src/services/minebot/integration/CompanionRuntimeTasks.js';
import { CompanionRequestLoop } from '../../src/services/minebot/integration/CompanionRequestLoop.js';
import { assertMindCampaignQuiet, isDragonCampaignGoal, MIND_CAMPAIGN_USER_GOAL, MindControlledCampaign,
  submitMindCampaignGoal, privateMindCampaignAttestor, readMindCampaignThread, watchCampaignEvidenceFailures,
  type MindCampaignAttestor } from '../../src/services/minebot/testing/MindControlledCampaign.js';

const rootId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const ownerThreadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const origin = Date.parse('2026-10-08T08:00:00Z');
const request = (changes: Partial<CompanionRequest> = {}): CompanionRequest => ({ id: rootId,
  goal: MIND_CAMPAIGN_USER_GOAL, surface: 'text', createdAt: new Date(origin).toISOString(),
  leaseExpiresAt: new Date(origin + 120_000).toISOString(), ...changes });

function harness() {
  let now = origin;
  const tasks: Array<{ id: string; status: string }> = [];
  const executing = new Set<string>();
  const admitted: Array<{ goal: string; tags?: string[]; metadata?: Record<string, unknown> }> = [];
  const runtime = {
    putTaskFirst: vi.fn((input: { userMessage?: string | null }, extras?: { tags?: string[]; metadata?: Record<string, unknown> }) => {
      const id = `task-${admitted.length + 1}`;
      admitted.push({ goal: input.userMessage!, ...extras }); tasks.push({ id, status: 'pending' });
      return { success: true, taskId: id };
    }),
    getTaskListState: () => ({ tasks, currentTaskId: [...executing][0] ?? null }),
    isTaskExecuting: (id: string) => executing.has(id),
    removeTask: vi.fn((id: string) => { const at = tasks.findIndex(task => task.id === id); if (at >= 0) tasks.splice(at, 1); return { success: true }; }),
    stopTaskAndWait: vi.fn(async (id: string) => { executing.delete(id); runtime.removeTask(id); return true; }),
  };
  let campaign: MindControlledCampaign;
  const attestor = vi.fn(async (input: Parameters<MindCampaignAttestor>[0]): ReturnType<MindCampaignAttestor> => input.requestId);
  const delegate = new CompanionRuntimeTasks(runtime, { waiting: () => 0, deaths: () => 0, inventory: () => ({ oak_log: 2 }),
    envelope: value => campaign.isRootRequest(value.id)
      ? { tags: ['mind_campaign_root'], metadata: { mindCampaignRequestId: value.id, companionTask: { requestId: value.id } } }
      : { tags: ['user_chat'], metadata: { humanChat: { requestId: value.id } } }, step: id => `${id}-skill` });
  campaign = new MindControlledCampaign(delegate, runtime, { now: () => now, setupMs: 120_000, windowMs: 2_400_000, ownerThreadId, attestRoot: attestor });
  campaign.submitting();
  const responses = [request()];
  const holding: string[][] = [];
  const reports: Array<{ id: string; outcome: string; code?: string }> = [];
  const progress: Array<{ id: string; phase: string; step?: string }> = [];
  let reportResponse: { state: string; recorded: boolean } | null = { state: 'done', recorded: true };
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer body-token-synthetic');
    if (String(url).endsWith('/claim')) {
      holding.push(body.holding); return Response.json({ request: responses.shift() ?? null, cancel: [] });
    }
    const id = String(url).split('/').at(-2)!;
    if (String(url).endsWith('/progress')) { progress.push({ id, ...body }); return Response.json({ state: 'running', cancel: false }); }
    reports.push({ id, ...body });
    return reportResponse ? Response.json(reportResponse) : new Response(null, { status: 503 });
  }) as typeof fetch;
  const client = new CompanionBodyClient({ baseUrl: 'http://127.0.0.1:3999', serverId: 'offline-unique-trial',
    token: 'body-token-synthetic', fetcher });
  const loop = new CompanionRequestLoop(campaign.trackClient(client), campaign, { now: () => now, stopWaitMs: 0 });
  return { campaign, delegate, attestor, runtime, tasks, executing, admitted, loop, reports, progress, holding, responses,
    advance: (ms: number) => { now += ms; }, reply: (value: typeof reportResponse) => { reportResponse = value; } };
}

describe('Mind-controlled campaign canonical root', () => {
  it.each(['エンドラを討伐してください', ' エンダードラゴン を 倒す。 ', 'Minecraftでエンドラを撃破する！', 'マイクラでエンダードラゴン討伐'])('accepts only a closed dragon alias: %s', goal => {
    expect(isDragonCampaignGoal(goal)).toBe(true);
  });
  it.each(['木を集める', 'エンドラを倒す。その前に木を集める', 'エンドラを倒すか鉄を集める', 'エンドラを探す', 'クリエイティブでエンドラを倒す'])('refuses another root or expanded goal: %s', goal => {
    expect(isDragonCampaignGoal(goal)).toBe(false);
  });
  it('uses the actual claimed goal and original request metadata; no independent root is enqueued', async () => {
    const h = harness(); h.responses[0] = request({ goal: 'Minecraftでエンダードラゴンを撃破する。' });
    expect(h.runtime.putTaskFirst).not.toHaveBeenCalled(); await h.loop.claimOnce(0);
    expect(h.admitted).toEqual([{ goal: 'Minecraftでエンダードラゴンを撃破する。', tags: ['mind_campaign_root'],
      metadata: { mindCampaignRequestId: rootId, companionTask: { requestId: rootId } } }]);
    expect(h.campaign.receipt()).toMatchObject({ taskSegments: 1, activeStartedAt: null, requestId: rootId });
    expect(h.progress).toMatchObject([{ id: rootId, phase: 'accepted' }]);
    h.advance(70_000); h.executing.add(h.campaign.taskId!); h.campaign.markStarted(rootId);
    expect(h.campaign.deadline).toBe(origin + 70_000 + 2_400_000); await h.loop.tick();
    expect(h.progress.at(-1)).toMatchObject({ id: rootId, phase: 'started', step: 'task-1-skill' });
  });
  it.each([{ createdAt: new Date(origin - 1).toISOString() }, { leaseExpiresAt: new Date(origin).toISOString() },
    { createdAt: 'bad' }, { surface: 'voice' as const }, { goal: '木を集める' }])('refuses a stale/unsupported first root permanently', changes => {
    const h = harness(); expect(h.campaign.start(request(changes))).toEqual({ refused: 'unsupported' });
    expect(h.campaign.start(request())).toEqual({ refused: 'unsupported' }); expect(h.admitted).toHaveLength(0);
  });
  it('setup expires without extending the active clock or issuing a replacement owner request', () => {
    const h = harness(); h.advance(120_000); expect(h.campaign.setupExpired).toBe(true);
    expect(h.campaign.start(request())).toEqual({ refused: 'unsupported' });
    expect(() => h.campaign.submitting()).toThrow('MIND_CAMPAIGN_GOAL_ALREADY_SENT'); expect(h.campaign.deadline).toBeNull();
  });
  it('duplicate original request cannot admit a new executor or change its goal', async () => {
    const h = harness(); await h.loop.claimOnce(0);
    expect(h.campaign.start(request({ goal: '木を集める' }))).toEqual({ taskId: 'task-1' });
    expect(h.admitted).toHaveLength(1); expect(h.campaign.acceptedGoal).toBe(MIND_CAMPAIGN_USER_GOAL);
  });
  it('a synchronous queue failure cannot reauthorize a later root', async () => {
    const h = harness(); h.runtime.putTaskFirst.mockImplementationOnce(() => { throw new Error('fixture queue lost'); });
    await h.loop.claimOnce(0); expect(h.loop.taken[0]).toMatchObject({ outcome: 'failed', code: 'error' });
    expect(h.campaign.start(request())).toEqual({ refused: 'unsupported' }); expect(h.admitted).toHaveLength(0);
  });
  it('keeps awaiting_user/MAX_ITERATIONS held and never delegates it into gave_up', async () => {
    const h = harness(); await h.loop.claimOnce(0); h.tasks[0].status = 'awaiting_user';
    h.campaign.markSegmentEnded('task-1'); h.delegate.noteRun(rootId, false);
    const status = vi.spyOn(h.delegate, 'status'); await h.loop.tick(); await h.loop.claimOnce(0);
    expect(status).not.toHaveBeenCalled(); expect(h.runtime.removeTask).not.toHaveBeenCalled(); expect(h.reports).toHaveLength(0);
    expect(h.holding.at(-1)).toEqual([rootId]);
    h.executing.add('task-1'); h.tasks[0].status = 'executing'; await h.loop.tick();
    expect(h.progress.at(-1)?.phase).toBe('started');
  });
  it('keeps later genuine owner requests on the existing independent intervention path', async () => {
    const h = harness(); await h.loop.claimOnce(0); h.campaign.start(request({ id: otherId, goal: '木を集める' }));
    h.tasks[1].status = 'awaiting_user';
    expect(h.campaign.status('task-2')).toEqual({ state: 'failed', code: 'gave_up' });
    expect(h.admitted[1].tags).toEqual(['user_chat']);
  });
  it('does not detach an executing original generation during dimension re-admission', async () => {
    const h = harness(); await h.loop.claimOnce(0); h.executing.add('task-1'); h.campaign.markSegmentEnded('task-1');
    expect(() => h.campaign.replaceTask('task-2')).toThrow('MIND_CAMPAIGN_ORIGINAL_EXECUTION_UNKNOWN');
    h.executing.delete('task-1'); h.campaign.replaceTask('task-2'); h.tasks.push({ id: 'task-2', status: 'executing' }); h.executing.add('task-2');
    expect(h.campaign.status('task-1').state).toBe('running');
    h.executing.add('task-1'); h.campaign.markSegmentEnded('task-2');
    expect(h.campaign.canReplaceTask()).toBe(false); h.executing.delete('task-1');
    await h.campaign.stop('task-1'); expect(h.runtime.stopTaskAndWait).toHaveBeenCalledWith('task-2');
    expect(h.campaign.receipt()).toMatchObject({ requestId: rootId, taskSegments: 2, settledSegments: 2, verified: false });
  });
  it('requires campaign AND independent native oracle AND physical settlement before done', async () => {
    const h = harness(); await h.loop.claimOnce(0);
    expect(h.campaign.finishVerified(true, true)).toBe(false); h.campaign.markSegmentEnded('task-1');
    expect(h.campaign.finishVerified(true, false)).toBe(false); expect(h.campaign.finishVerified(false, true)).toBe(false);
    h.executing.add('task-1'); expect(h.campaign.finishVerified(true, true)).toBe(false); h.executing.delete('task-1');
    expect(h.campaign.finishVerified(true, true)).toBe(true); expect(h.campaign.verifiedAcknowledged).toBe(false);
    await h.loop.tick(); await h.loop.tick(); expect(h.reports).toMatchObject([{ id: rootId, outcome: 'done' }]);
    expect(h.campaign.verifiedAcknowledged).toBe(true);
  });
  it('native dragon death without this body attacking it cannot finish the claimed root', async () => {
    const h = harness(); await h.loop.claimOnce(0); h.campaign.markSegmentEnded('task-1');
    const bot = Object.assign(new EventEmitter(), { game: { dimension: 'the_end' }, inventory: { items: () => [] } });
    const oracle = new GoalVerifier(bot);
    const contract = { goal: h.campaign.acceptedGoal!, predicates: [{ kind: 'boss_defeated' as const, entity: 'ender_dragon' as const, dimension: 'the_end' as const }] };
    try {
      bot.emit('entityDead', { id: 7, name: 'ender_dragon' });
      expect(h.campaign.finishVerified(true, oracle.verify(contract).status === 'verified')).toBe(false);
      await h.loop.tick(); expect(h.reports).toHaveLength(0);
      bot.emit('minebotTargetAttacked', { id: 8, name: 'ender_dragon' }); bot.emit('entityDead', { id: 8, name: 'ender_dragon' });
      expect(h.campaign.finishVerified(true, oracle.verify(contract).status === 'verified')).toBe(true);
      await h.loop.tick(); expect(h.campaign.verifiedAcknowledged).toBe(true);
      expect(JSON.stringify(h.campaign.receipt())).not.toContain(h.campaign.acceptedGoal);
    } finally { oracle.dispose(); }
  });
  it('does not call failed transport a canonical ACK even when legacy delivery attempts are exhausted', async () => {
    const h = harness(); await h.loop.claimOnce(0); h.campaign.markSegmentEnded('task-1'); h.campaign.finishVerified(true, true);
    h.reply(null); for (let n = 0; n < 6; n++) await h.loop.tick();
    expect(h.reports).toHaveLength(5); expect(h.loop.taken[0].outcome).toBe('done');
    expect(h.campaign.verifiedAcknowledged).toBe(false); expect(h.campaign.receipt().terminalAck).toBeNull();
  });
  it('accepts a matching idempotent canonical done receipt, but not a definitive unknown response', async () => {
    const h = harness(); await h.loop.claimOnce(0); h.campaign.markSegmentEnded('task-1'); h.campaign.finishVerified(true, true);
    h.reply({ state: 'unknown', recorded: false }); await h.loop.tick(); expect(h.campaign.verifiedAcknowledged).toBe(false);
    const client = h.campaign.trackClient({ claim: async () => null, progress: async () => null, report: async () => ({ state: 'done', recorded: false }) });
    await client.report(rootId, 'done'); expect(h.campaign.verifiedAcknowledged).toBe(true);
  });
  it('unknown stop keeps holding and sends no terminal ACK; exact original completion permits stop', async () => {
    const h = harness(); await h.loop.claimOnce(0); h.executing.add('task-1');
    h.runtime.stopTaskAndWait.mockResolvedValueOnce(false); await h.loop.stop('timeout');
    expect(h.reports).toHaveLength(0); expect(h.campaign.stopped).toBe(false);
    h.reply({ state: 'failed', recorded: true }); await h.loop.stop('timeout');
    expect(h.reports.at(-1)).toMatchObject({ id: rootId, outcome: 'failed', code: 'timeout' });
    expect(h.campaign.receipt()).toMatchObject({ terminalAck: { state: 'failed', recorded: true }, verified: false });
  });
});

describe('trusted exact pre-dispatch attestation', () => {
  it('keeps Executor admission at zero until the fixed owner thread and claimed ID are attested', async () => {
    const h = harness(); let confirm!: (id: string) => void;
    h.attestor.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    const claiming = h.loop.claimOnce(0); await vi.waitFor(() => expect(h.attestor).toHaveBeenCalledTimes(1));
    expect(h.admitted).toHaveLength(0); expect(h.progress).toHaveLength(0);
    expect(h.attestor.mock.calls[0][0]).toMatchObject({ threadId: ownerThreadId, requestId: rootId });
    confirm(rootId); await claiming; expect(h.admitted).toHaveLength(1); expect(h.campaign.receipt().attested).toBe(true);
  });
  it('direct task.start cannot bypass attestation even with the right fresh goal', () => {
    const h = harness(); expect(h.campaign.start(request())).toEqual({ refused: 'unknown' });
    expect(h.admitted).toHaveLength(0); expect(h.campaign.rejection).toBe('MIND_CAMPAIGN_PROVENANCE_UNKNOWN');
  });
  it.each(['transport', 'mismatch', 'not-found', 'malformed'] as const)('fails closed on %s without ACK, a new claim or a replacement executor', async reason => {
    const h = harness(); h.attestor.mockImplementationOnce(async () => {
      if (reason === 'transport') throw new Error('PRIVATE_DB_ERROR_NOT_PUBLISHED');
      if (reason === 'malformed') return { pending: false } as any;
      return reason === 'mismatch' ? otherId : null;
    });
    expect(await h.loop.claimOnce(0)).toBe(false); await h.loop.claimOnce(0); await h.loop.stop();
    expect(h.admitted).toHaveLength(0); expect(h.holding).toHaveLength(1); expect(h.reports).toHaveLength(0);
    expect(h.campaign.receipt()).toMatchObject({ attested: false, unacceptedRequests: [rootId], rejected: 'MIND_CAMPAIGN_PROVENANCE_UNKNOWN' });
    expect(JSON.stringify(h.campaign.receipt())).not.toContain('PRIVATE_DB_ERROR');
  });
  it('only a known admission-pending response retries the same read proof, never the owner POST or another ID', async () => {
    const h = harness(); h.attestor.mockResolvedValueOnce({ pending: true }); await h.loop.claimOnce(0);
    expect(h.attestor).toHaveBeenCalledTimes(2);
    expect(h.attestor.mock.calls.map(call => ({ threadId: call[0].threadId, requestId: call[0].requestId }))).toEqual([
      { threadId: ownerThreadId, requestId: rootId }, { threadId: ownerThreadId, requestId: rootId }]);
    expect(h.admitted).toHaveLength(1); expect(h.holding).toHaveLength(1);
  });
  it('bounded pending proof expires unknown with zero dispatch', async () => {
    const h = harness(); h.attestor.mockResolvedValue({ pending: true }); await h.loop.claimOnce(0);
    expect(h.attestor.mock.calls.length).toBeLessThanOrEqual(20); expect(h.admitted).toHaveLength(0); expect(h.reports).toHaveLength(0);
    expect(h.campaign.rejection).toBe('MIND_CAMPAIGN_PROVENANCE_UNKNOWN');
  }, 4_000);
  it('a stalled or late attestor cannot hang shutdown or admit an executor after its timeout', async () => {
    const h = harness(); let confirm!: (id: string) => void;
    h.attestor.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    const claiming = h.loop.claimOnce(0); await vi.waitFor(() => expect(h.attestor).toHaveBeenCalledTimes(1));
    expect(await claiming).toBe(false); confirm(rootId); await Promise.resolve(); await h.loop.stop();
    expect(h.admitted).toHaveLength(0); expect(h.reports).toHaveLength(0); expect(h.campaign.receipt().attested).toBe(false);
  }, 4_000);
  it('caller abort while attesting cannot publish a late proof as admission', async () => {
    const h = harness(); const abort = new AbortController();
    h.attestor.mockImplementationOnce(async () => { abort.abort(); return rootId; });
    const client = h.campaign.trackClient({ claim: async () => ({ request: request(), cancel: [] }), progress: async () => null, report: async () => null });
    expect(await client.claim([], 0, abort.signal)).toBeNull(); expect(h.admitted).toHaveLength(0);
  });
});

describe('private readonly CLI context and closed response', () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
  it('requires root-supplied private context and exact pre-generated thread; never generates a substitute', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-attestor-fixture-')); directories.push(directory);
    const config = path.join(directory, 'context.json');
    fs.writeFileSync(config, JSON.stringify({ schema: 'shannon.private-minebot-attestor.v1', ownerThreadId }), { mode: 0o600 });
    expect(readMindCampaignThread(config, ownerThreadId)).toBe(ownerThreadId);
    expect(() => readMindCampaignThread(config, otherId)).toThrow('MIND_CAMPAIGN_PRIVATE_CONTEXT_INVALID');
    fs.chmodSync(config, 0o644); expect(() => readMindCampaignThread(config, ownerThreadId)).toThrow('MIND_CAMPAIGN_PRIVATE_CONTEXT_INVALID');
    fs.chmodSync(config, 0o600); fs.symlinkSync(config, path.join(directory, 'link.json'));
    expect(() => readMindCampaignThread(path.join(directory, 'link.json'), ownerThreadId)).toThrow('MIND_CAMPAIGN_PRIVATE_CONTEXT_INVALID');
    const stat = fs.statSync(config); const fstat = vi.spyOn(fs, 'fstatSync').mockReturnValueOnce(Object.assign(stat, { uid: stat.uid + 1 }));
    try { expect(() => readMindCampaignThread(config, ownerThreadId)).toThrow('MIND_CAMPAIGN_PRIVATE_CONTEXT_INVALID'); } finally { fstat.mockRestore(); }
  });
  it('uses only fixed script/config and opaque identities; accepts only ATTESTED, not a bare success boolean', async () => {
    const execute = vi.fn(async (_argv: string[], _signal?: AbortSignal) => JSON.stringify({ ok: true, reason: 'ATTESTED', checks: { origin: true } }));
    const attest = privateMindCampaignAttestor({ configPath: '/private/context.json', threadId: ownerThreadId, execute });
    expect(await attest({ threadId: ownerThreadId, requestId: rootId })).toBe(rootId);
    expect(execute.mock.calls[0][0]).toEqual(['/home/azureuser/.cache/minebot-integration/attest.py', '--config', '/private/context.json', 'attest', '--request-id', rootId, '--thread-id', ownerThreadId]);
    execute.mockResolvedValueOnce(JSON.stringify({ ok: true })); expect(await attest({ threadId: ownerThreadId, requestId: rootId })).toBeNull();
    execute.mockResolvedValueOnce(JSON.stringify({ ok: false, reason: 'ACTION_ADMISSION_PENDING', retryable: true }));
    expect(await attest({ threadId: ownerThreadId, requestId: rootId })).toEqual({ pending: true });
    execute.mockResolvedValueOnce(JSON.stringify({ ok: false, reason: 'ORIGIN_MISMATCH', retryable: true }));
    expect(await attest({ threadId: ownerThreadId, requestId: rootId })).toBeNull();
    const count = execute.mock.calls.length; expect(await attest({ threadId: otherId, requestId: rootId })).toBeNull();
    expect(await attest({ threadId: ownerThreadId, requestId: '../private;not-an-id' })).toBeNull(); expect(execute).toHaveBeenCalledTimes(count);
  });
  it('invalid JSON, oversized output or process error remains unknown without revealing private diagnostic text', async () => {
    const execute = vi.fn(async () => '{PRIVATE_ERROR');
    const attest = privateMindCampaignAttestor({ configPath: '/private/context.json', threadId: ownerThreadId, execute });
    expect(await attest({ threadId: ownerThreadId, requestId: rootId })).toBeNull();
    execute.mockResolvedValueOnce(' '.repeat(16_385)); expect(await attest({ threadId: ownerThreadId, requestId: rootId })).toBeNull();
    execute.mockRejectedValueOnce(new Error('PRIVATE_TOKEN_NOT_PUBLISHED')); expect(await attest({ threadId: ownerThreadId, requestId: rootId })).toBeNull();
  });
});

describe('post-metering cache evidence stop', () => {
  it.each(['create', 'finalMessage'] as const)('preserves the %s error and recorded usage while stopping immediately', async method => {
    const error = Object.assign(new Error('synthetic cache evidence missing'), { proofFatal: true });
    const usage: object[] = [];
    const send = vi.fn(async () => { usage.push({ input: 7, output: 3, unknownReservedUsd: 0 }); throw error; });
    const native = { messages: { create: send, stream: () => ({ finalMessage: send }) } };
    const stop = vi.fn(); const client = watchCampaignEvidenceFailures(native, value => value === error, stop);
    const result = method === 'create' ? client.messages.create() : client.messages.stream().finalMessage();
    await expect(result).rejects.toBe(error); expect(usage).toHaveLength(1); expect(stop).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
  });
  it('keeps ordinary provider errors, normal create results and stream methods unchanged', async () => {
    const stop = vi.fn(); const error = new Error('ordinary timeout');
    const native = { messages: { create: vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({ content: 'fixture' }),
      stream: () => ({ value: 4, finalMessage: async () => ({ content: 'fixture' }), current() { return this.value; } }) } };
    const client = watchCampaignEvidenceFailures(native, () => false, stop);
    await expect(client.messages.create()).rejects.toBe(error); expect(await client.messages.create()).toEqual({ content: 'fixture' });
    expect(client.messages.stream().current()).toBe(4); expect(stop).not.toHaveBeenCalled();
  });
});

describe('one authenticated owner turn, separate from body bearer', () => {
  it('posts only the original goal once and never stores the private reply', async () => {
    const calls: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const result = await submitMindCampaignGoal({ baseUrl: 'http://localhost:3999/ignored', ownerToken: 'owner-token-synthetic', threadId: 'unique-trial',
      fetcher: (async (url, init) => { calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) });
        return Response.json({ reply: 'PRIVATE_RESPONSE_NOT_RETURNED' }); }) as typeof fetch });
    expect(calls).toEqual([{ url: 'http://localhost:3999/v1/chat', auth: 'Bearer owner-token-synthetic',
      body: { scopeKey: 'owner', threadId: 'unique-trial', message: MIND_CAMPAIGN_USER_GOAL } }]);
    expect(result).toEqual({ status: 200, acknowledged: true });
  });
  it('lost response never resends an ambiguous owner goal', async () => {
    const fetcher = vi.fn(async () => { throw new Error('synthetic response lost'); }) as typeof fetch;
    await expect(submitMindCampaignGoal({ baseUrl: 'http://localhost:3999', ownerToken: 'owner-token-synthetic', threadId: 'unique', fetcher })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('caller stop aborts before owner dispatch, with zero requests', async () => {
    const controller = new AbortController(); controller.abort(); const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(submitMindCampaignGoal({ baseUrl: 'http://localhost:3999', ownerToken: 'owner-token-synthetic', threadId: 'unique', signal: controller.signal, fetcher })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('preflight refuses live requests or unreadable state and allows only known terminal rows', async () => {
    const input = { baseUrl: 'http://localhost:3999', ownerToken: 'owner-token-synthetic' };
    await expect(assertMindCampaignQuiet({ ...input, fetcher: (async () => Response.json({ requests: [{ state: 'running' }] })) as typeof fetch })).rejects.toThrow('MIND_CAMPAIGN_EXISTING_REQUESTS');
    await expect(assertMindCampaignQuiet({ ...input, fetcher: (async () => new Response(null, { status: 401 })) as typeof fetch })).rejects.toThrow('MIND_CAMPAIGN_OWNER_READ_UNAVAILABLE');
    await assertMindCampaignQuiet({ ...input, fetcher: (async () => Response.json({ requests: ['done', 'failed', 'cancelled', 'expired'].map(state => ({ state })) })) as typeof fetch });
  });
});
