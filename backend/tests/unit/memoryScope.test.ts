import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/config/env.js', () => ({ config: { openaiApiKey: 'mock' } }));
vi.mock('../../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const db = vi.hoisted(() => ({ rows: [] as any[], queries: [] as any[], created: [] as any[], model: vi.fn(), embedding: vi.fn(), eventCreate: vi.fn(), eventClaim: vi.fn(), eventUpdate: vi.fn() }));
vi.mock('../../src/models/ShannonMemory.js', async () => {
  const { Types } = await import('mongoose');
  const eq = (a: any, b: any): boolean => a === b || (a?.toHexString && b?.toHexString && a.toHexString() === b.toHexString());
  const matches = (row: any, filter: any): boolean => Object.entries(filter).every(([key, value]: any) => {
    if (key === '$or') return value.some((q: any) => matches(row, q));
    if (key === '$text') return row.content.includes(value.$search);
    const actual = row[key];
    if (value && typeof value === 'object' && !(value instanceof Date) && !value.toHexString) {
      return Object.entries(value).every(([op, v]: any) => {
        if (op === '$in') return v.some((x: any) => Array.isArray(actual) ? actual.some(y => eq(y, x)) : eq(actual, x));
        if (op === '$all') return v.every((x: any) => actual?.includes(x));
        if (op === '$exists') return (actual !== undefined) === v;
        if (op === '$ne') return JSON.stringify(actual) !== JSON.stringify(v);
        if (op === '$gte') return actual >= v;
        if (op === '$lte') return actual <= v;
        if (op === '$lt') return actual < v;
        throw new Error(`Unsupported fake Mongo operator ${op}`);
      });
    }
    return eq(actual, value);
  });
  function query(filter: any, one = false) {
    db.queries.push(filter); let limit = Infinity;
    const exec = () => { const rows = db.rows.filter(row => matches(row, filter)).slice(0, limit); return one ? rows[0] ?? null : rows; };
    const chain: any = { sort: () => chain, select: () => chain, limit: (n: number) => { limit = n; return chain; }, lean: async () => exec(), then: (yes: any, no: any) => Promise.resolve(exec()).then(yes, no) };
    return chain;
  }
  return { ShannonMemory: {
    find: vi.fn(filter => query(filter)), findOne: vi.fn(filter => query(filter, true)),
    create: vi.fn(async data => { const row = { ...data, _id: new Types.ObjectId(), save: vi.fn(async () => {}) }; db.rows.push(row); db.created.push(data); return row; }),
    countDocuments: vi.fn(async filter => { db.queries.push(filter); return db.rows.filter(row => matches(row, filter)).length; }),
    deleteMany: vi.fn(async filter => { db.queries.push(filter); db.rows = db.rows.filter(row => !matches(row, filter)); }),
    updateOne: vi.fn(),
  } };
});
vi.mock('../../src/models/MemoryWriteEvent.js', () => ({ MemoryWriteEvent: { create: db.eventCreate, findOneAndUpdate: db.eventClaim, updateOne: db.eventUpdate } }));
vi.mock('../../src/models/ScopedPersonStatement.js', () => ({ ScopedPersonStatement: { find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) } }));
vi.mock('openai', () => ({ default: class { embeddings = { create: db.embedding }; } }));
vi.mock('@langchain/openai', () => ({ ChatOpenAI: class { invoke = db.model; } }));
vi.mock('../../src/services/llm/utils/langfuse.js', () => ({ createTracedModel: () => ({ invoke: db.model }) }));
vi.mock('../../src/services/llm/config/prompts.js', () => ({ loadPrompt: async () => 'mock prompt' }));
import { Types } from 'mongoose';
import { ShannonMemory } from '../../src/models/ShannonMemory.js';
import { deriveMemoryScope, memoryScopeFilter, canReadMemory, hasMemoryScope } from '../../src/modules/memory/index.js';
import { ShannonMemoryService } from '../../src/services/memory/shannonMemoryService.js';
import { EmbeddingService } from '../../src/services/memory/embeddingService.js';
import { createRequestMemory, bindRequestMemory } from '../../src/services/memory/requestMemory.js';
import { createMemoryTools } from '../../src/services/llm/tools/memory/memoryToolFactory.js';
import { TaskEpisodeMemory } from '../../src/services/llm/graph/cognitive/TaskEpisodeMemory.js';
import { WritebackProcessor } from '../../src/services/memory/writeback/WritebackProcessor.js';
import { AutonomyUpdater } from '../../src/services/memory/writeback/AutonomyUpdater.js';
import { ScopeDeriver } from '../../src/services/memory/recall/ScopeDeriver.js';
import { PersonMemoryService } from '../../src/services/memory/personMemoryService.js';
import { RunToolRegistry } from '../../src/modules/execution/runToolRegistry.js';
import { RecallEngine } from '../../src/services/memory/recall/RecallEngine.js';

const envelope = (user = '100', guild = '200', channel = '300', dm = false): any => ({
  requestId: 'request', channel: 'discord', sourceUserId: user, sourceDisplayName: 'same-name',
  conversationId: `discord:${guild}:${channel}`, threadId: `discord:${channel}`, tags: ['discord'],
  discord: { guildId: dm ? undefined : guild, channelId: channel, isDM: dm }, timestampIso: '2026-08-28T00:00:00Z',
});

describe('memory privacy regression', () => {
  const recall = new RecallEngine({} as any);
  it('does not treat legacy missing scope as public', () => {
    expect(recall.privacyFilter([{ content: 'legacy' } as any], 'discord:100', 'discord', envelope())).toEqual([]);
  });
  it('does not take a user private memory into their public channel', () => {
    expect(recall.privacyFilter([{ visibilityScope: 'private_user', ownerUserId: 'discord:100' } as any], 'discord:100', 'discord', envelope())).toEqual([]);
  });
  it('does not authorize a different guild by the generic discord tag', () => {
    expect(recall.privacyFilter([{ visibilityScope: 'shared_channel', channelTags: ['discord', 'discord:guild:other'] } as any], 'discord:100', 'discord', envelope())).toEqual([]);
  });
});

const world = (server = 'server-a', worldId = 'world-a', dimension = 'overworld'): any => ({ ...envelope(), channel: 'minecraft', discord: undefined, minecraft: { serverId: server, worldId, dimension } });
const draft = { category: 'knowledge' as const, content: 'iron_ingot', importance: 5, tags: ['iron_ingot', 'discord'] };
const row = (request: any, content = 'iron_ingot', extra: any = {}) => ({ ...deriveMemoryScope(request), _id: new Types.ObjectId(), category: 'knowledge', content, importance: 5, tags: ['iron_ingot', 'discord'], createdAt: new Date(), embedding: [1, 0], ...extra });
beforeEach(() => {
  vi.clearAllMocks(); db.rows = []; db.queries = []; db.created = [];
  db.embedding.mockResolvedValue({ data: [{ embedding: [1, 0] }] });
  db.model.mockResolvedValue({ content: '{}' });
  db.eventClaim.mockReturnValue({ lean: async () => null });
});

describe('SDK-independent scope and immutable port', () => {
  it.each([
    [envelope('100', '', '300', true), envelope('101', '', '300', true)],
    [envelope('100', '', '300', true), envelope('100', '200', '300')],
    [envelope('100', '200'), envelope('100', '201')],
    [envelope('100', '200', '300'), envelope('100', '200', '301')],
    [envelope(), { ...envelope(), threadId: 'other-thread' }],
    [envelope(), { ...envelope(), conversationId: 'other-conversation' }],
    [world(), world('server-b')], [world(), world('server-a', 'world-b')],
    [world(), world('server-a', 'world-a', 'nether')],
  ])('does not authorize across an audience boundary %#', (a, b) => {
    expect(canReadMemory(deriveMemoryScope(b), row(a))).toBe(false);
    expect(canReadMemory(deriveMemoryScope(a), row(a))).toBe(true);
  });
  it('allows other participants only within the same explicitly shared audience', () => {
    expect(canReadMemory(deriveMemoryScope(envelope('101')), row(envelope('100')))).toBe(true);
  });
  it.each([undefined, { ...envelope(), channel: 'web' }, { ...envelope(), channel: 'x' }, { ...envelope(), sourceUserId: 'unknown' },
    { ...envelope(), discord: undefined }, { ...envelope(), discord: { isDM: true, channelId: '300', guildId: '200' } },
    { ...envelope(), metadata: { isDM: true } }, { ...world(), minecraft: { serverName: 'same-name' } },
    { ...world(), metadata: { memoryDisabled: true } },
  ])('rejects incomplete or unsupported context before I/O %#', async input => {
    expect(deriveMemoryScope(input)).toBeNull();
    const port = createRequestMemory(input);
    expect(await port.search('knowledge', 'iron')).toEqual([]);
    expect((await port.save(draft)).saved).toBe(false);
    expect(db.queries).toEqual([]); expect(db.embedding).not.toHaveBeenCalled();
  });
  it('ignores names/tags/project metadata and rejects fabricated policy objects', () => {
    const request = envelope();
    const scope = deriveMemoryScope(request)!;
    request.sourceDisplayName = 'other'; request.tags = ['private_user']; request.metadata = { projectTags: ['all'] };
    expect(deriveMemoryScope(request)?.scopeKey).toBe(scope.scopeKey);
    expect(Object.isFrozen(scope)).toBe(true);
    expect(hasMemoryScope({ ...scope })).toBe(false);
    expect(canReadMemory(scope, { ...scope, scopeVersion: undefined, generalized: true } as any)).toBe(false);
  });
  it('snapshots nested context before the first await', async () => {
    const request = envelope(); const port = createRequestMemory(request); const original = row(request);
    request.discord.guildId = '999'; request.sourceUserId = '999';
    db.rows = [original, row(request, 'other')];
    expect((await port.search('knowledge', '')).map(r => r.content)).toEqual(['iron_ingot']);
  });
});

describe('real Mongo adapters with a deterministic fake database', () => {
  const service = ShannonMemoryService.getInstance();
  it('restricts both tag and text queries before limit; foreign rows cannot crowd out the permitted result', async () => {
    db.rows = Array.from({ length: 20 }, () => row(envelope('999', '999'), 'foreign'));
    db.rows.push(row(envelope(), 'iron_ingot'));
    expect((await service.searchKnowledge('iron_ingot', 1, deriveMemoryScope(envelope()))).map(r => r.content)).toEqual(['iron_ingot']);
    expect(db.queries.every(q => q.scopeKey === deriveMemoryScope(envelope())!.scopeKey)).toBe(true);
    db.queries = []; db.rows[20].tags = [];
    expect((await service.searchKnowledge('iron_ingot', 5, deriveMemoryScope(envelope()))).map(r => r.content)).toEqual(['iron_ingot']);
    expect(db.queries.some(q => q.$text)).toBe(true);
    expect(db.queries.every(q => q.scopeVersion === 1 && q.scopeKey)).toBe(true);
  });
  it('rejects old unscoped service APIs including maintenance before touching storage/models', async () => {
    expect(await service.searchKnowledge('iron')).toEqual([]);
    expect(await service.searchExperiences('iron')).toEqual([]);
    expect(await service.getRecentImportant('knowledge')).toEqual([]);
    expect((await service.saveWithDedup(draft)).saved).toBe(false);
    expect(await service.consolidateMemories()).toEqual({ clustersProcessed: 0, memoriesRemoved: 0 });
    expect(await service.backfillEmbeddings()).toBe(0);
    expect(await EmbeddingService.getInstance().search('iron')).toEqual([]);
    expect(db.queries).toEqual([]); expect(db.embedding).not.toHaveBeenCalled();
  });
  it('stamps scope in the first insert and deduplicates only within that scope', async () => {
    db.rows = [row(envelope('999', '999'))];
    const scope = deriveMemoryScope(envelope())!;
    expect((await service.saveWithDedup({ ...draft, scopeKey: 'spoof', generalized: true, ownerUserId: 'spoof' } as any, scope)).saved).toBe(true);
    expect(db.created[0]).toMatchObject({ ...scope, generalized: false });
    expect((await service.saveWithDedup(draft, scope)).saved).toBe(false);
    expect(db.created).toHaveLength(1);
    expect(ShannonMemory.updateOne).not.toHaveBeenCalled();
  });
  it('never updates another audience feeling during experience deduplication', async () => {
    const foreign = row(envelope('999', '999'), 'iron_ingot', { category: 'experience', feeling: 'foreign', save: vi.fn() });
    db.rows = [foreign];
    expect((await service.saveWithDedup({ ...draft, category: 'experience', feeling: 'mine' }, deriveMemoryScope(envelope()))).saved).toBe(true);
    expect(foreign.feeling).toBe('foreign'); expect(foreign.save).not.toHaveBeenCalled();
  });
  it('counts and evicts only the writing audience without deleting legacy or other audiences', async () => {
    const foreign = row(envelope('999', '999')); const legacy = { ...foreign, _id: new Types.ObjectId(), scopeVersion: undefined };
    db.rows = [foreign, legacy, ...Array.from({ length: 271 }, () => row(envelope(), 'old', { tags: [] }))];
    await service.saveWithDedup({ ...draft, tags: [] }, deriveMemoryScope(envelope()));
    expect(db.rows).toContain(foreign); expect(db.rows).toContain(legacy);
    expect(ShannonMemory.deleteMany).toHaveBeenCalled();
    expect(db.queries.every(q => q.scopeKey === deriveMemoryScope(envelope())!.scopeKey)).toBe(true);
  });
  it('scores only scoped semantic candidates and rechecks scope on final hydration', async () => {
    db.rows = [row(envelope('999', '999'), 'private'), row(envelope(), 'allowed')];
    const embedding = EmbeddingService.getInstance();
    expect((await embedding.search('iron', 1, 2, undefined, deriveMemoryScope(envelope()))).map(r => r.content)).toEqual(['allowed']);
    expect(db.queries).toHaveLength(2);
    expect(db.queries.every(q => q.scopeVersion === 1 && q.scopeKey === deriveMemoryScope(envelope())!.scopeKey)).toBe(true);
    expect(db.queries[1]._id.$in).toEqual([db.rows[1]._id]);
  });
  it('does not use stale global cache or send a query embedding when no eligible rows remain', async () => {
    const embedding = EmbeddingService.getInstance(); embedding.updateCache(new Types.ObjectId(), [1,0], 'knowledge', 'stale', 5);
    expect(await embedding.search('iron', 5, 2, undefined, deriveMemoryScope(envelope()))).toEqual([]);
    expect(db.embedding).not.toHaveBeenCalled();
  });
  it('applies the same scope to every autonomy recall projection and hides legacy person memory', async () => {
    const recall = new RecallEngine(EmbeddingService.getInstance());
    await recall.searchByTags(envelope(), 'iron'); await recall.recallSelfModel(envelope());
    await recall.recallInternalState(envelope()); await recall.recallStrategyUpdates(envelope(), 'discord:100', ['discord']);
    await recall.recallWorldPatterns(envelope(), ['discord']);
    expect(db.queries).toHaveLength(5); expect(db.queries.every(q => q.scopeKey === deriveMemoryScope(envelope())!.scopeKey)).toBe(true);
    expect(await recall.recallPerson(envelope())).toBeNull();
    expect(recall.toUserProfile({ displayName: 'ライ' } as any)).toBeNull();
    expect(recall.resolveCanonicalUserId({ ...envelope(), sourceDisplayName: 'ライ' })).toBe('discord:100');
    expect(PersonMemoryService.getInstance().resolveCanonicalPersonId('discord', '999999999', 'ライ')).toBe('discord:999999999');
  });
  it('does not write mixed conversation history into legacy PersonMemory', async () => {
    const created = vi.spyOn(PersonMemoryService.prototype, 'getOrCreate');
    await PersonMemoryService.getInstance().updateAfterConversation('discord', '100', 'ライ', [
      { role: 'user', content: 'secret from another channel', timestamp: new Date() } as any,
    ]);
    expect(created).not.toHaveBeenCalled();
    created.mockRestore();
  });
  it('keeps self-model/strategy/world/internal writes in source scope despite inferred generalization', async () => {
    db.model.mockResolvedValue({ content: JSON.stringify({ selfObservations: [{ observation: 'private', confidence: 1 }],
      strategyUpdates: [{ basedOnFailure: 'private', newStrategy: 'private', appliesToModes: [], confidence: 1 }],
      internalState: { curiosity: .5, caution: .5, confidence: .5, warmth: .5, focus: .5, load: .5 },
      worldPatterns: [{ domain: 'social', pattern: 'private', confidence: 1, applicability: [] }],
    }) });
    const request = envelope('100', '', '300', true);
    const updater = new AutonomyUpdater(new ScopeDeriver(), () => 'discord:100');
    await updater.runAutonomyUpdaters(request, 'fixture conversation');
    expect(db.created).toHaveLength(4);
    expect(db.created.every(doc => canReadMemory(deriveMemoryScope(request), doc) && doc.generalized === false)).toBe(true);
    expect(db.queries.every(q => q.scopeKey === deriveMemoryScope(request)!.scopeKey)).toBe(true);
  });
  it('writeback extraction uses a single scoped insert, never a content/time follow-up update', async () => {
    db.model.mockResolvedValue({ content: JSON.stringify({ memories: [{ ...draft, generalized: true, sensitivityLevel: 'low' }] }) });
    const processor = new WritebackProcessor(service, () => 'discord:100');
    await (processor as any).extractAndSaveWithScope('fixture', 'discord', envelope('100', '', '300', true));
    expect(db.created[0]).toMatchObject({ scopeVersion: 1, visibilityScope: 'private_user', generalized: false });
    expect(ShannonMemory.updateOne).not.toHaveBeenCalled();
    await processor.writeback({ envelope: { ...envelope(), channel: 'web' }, conversationText: 'fixture', exchanges: [] });
    expect(db.eventCreate).not.toHaveBeenCalled();
  });
  it('does not report a successful save when persistence fails', async () => {
    vi.mocked(ShannonMemory.create).mockRejectedValueOnce(new Error('fixture failure'));
    await expect(createRequestMemory(envelope()).save({
      category: 'knowledge', content: 'iron', importance: 5, tags: [],
    })).rejects.toThrow('fixture failure');
  });
});

describe('request tool and episode integration', () => {
  it('binds old and new tool names per run and cannot inherit another run memory port', async () => {
    const catalog = new RunToolRegistry<any>(createMemoryTools());
    const a = catalog.createTools(); const b = catalog.createTools();
    bindRequestMemory(a, envelope('100', '', '300', true)); bindRequestMemory(b, envelope('101', '', '301', true));
    const tool = (set: any[], name: string) => set.find(t => t.name === name);
    await tool(a, 'save-knowledge').invoke(draft);
    expect(await tool(a, 'recall-knowledge').invoke({ query: 'iron_ingot' })).toContain('iron_ingot');
    expect(await tool(b, 'recall-knowledge').invoke({ query: 'iron_ingot' })).not.toContain('iron_ingot');
    expect(await tool(a, 'recall-memory').invoke({ question: 'iron_ingot' })).toContain('iron_ingot');
    expect(await tool(b, 'recall-memory').invoke({ question: 'iron_ingot' })).not.toContain('iron_ingot');
    await tool(a, 'save-experience').invoke({ ...draft, feeling: 'mine' });
    expect(await tool(a, 'recall-experience').invoke({ query: 'iron_ingot' })).toContain('mine');
    expect(await tool(b, 'recall-experience').invoke({ query: 'iron_ingot' })).not.toContain('mine');
    expect(await tool(catalog.createTools(), 'save-memory').invoke({ content: 'no scope' })).toContain('初期化');
    expect(await tool(a, 'recall-person').invoke({ name: 'same-name' })).toContain('人物名では検索できません');
  });
  it('initial recall uses the same scope and does not look up a same-named person', async () => {
    db.rows = [row(envelope('999', '999'), 'foreign'), row(envelope(), 'iron_ingot')];
    const lookup = vi.spyOn(PersonMemoryService.getInstance(), 'lookupByName');
    const tool = (createMemoryTools() as any[]).find(t => t.name === 'recall-memory');
    bindRequestMemory([tool], envelope());
    expect(await tool.invoke({ question: 'iron_ingot' })).toContain('iron_ingot');
    expect(await tool.invoke({ question: 'iron_ingot' })).not.toContain('foreign');
    expect(lookup).not.toHaveBeenCalled(); lookup.mockRestore();
  });
  it('episode saves and queries require an envelope, not just a platform tag', async () => {
    const episodes = TaskEpisodeMemory.getInstance();
    const episode = { goal: 'craft iron_ingot', platform: 'discord', success: true, iterationCount: 1, durationMs: 1, strategyUsed: [], failurePatterns: [], lesson: 'fixture', timestamp: new Date() };
    await episodes.saveEpisode(episode); expect(db.created).toEqual([]);
    expect(await episodes.recallRelevantEpisodes('craft iron_ingot', 'discord')).toEqual([]); expect(db.queries).toEqual([]);
    await episodes.saveEpisode(episode, envelope());
    expect(await episodes.recallRelevantEpisodes('craft iron_ingot', 'discord', envelope())).toHaveLength(1);
    expect(await episodes.recallRelevantEpisodes('craft iron_ingot', 'discord', envelope('999', '999'))).toEqual([]);
  });
});

describe('writeback queue scope provenance', () => {
  it('preserves a denied source across the writeback snapshot and does not enqueue or invoke a model', async () => {
    const request = world(); request.metadata = { memoryDisabled: true, bot: { runtime: true } };
    const processor = new WritebackProcessor(ShannonMemoryService.getInstance(), () => 'unused');
    await processor.writeback({ envelope: request, conversationText: 'unreviewed voice fixture', exchanges: [] });
    expect(db.eventCreate).not.toHaveBeenCalled(); expect(db.model).not.toHaveBeenCalled(); expect(db.created).toEqual([]);
  });
  it('claims only versioned jobs and rejects a mismatched scope before any model call', async () => {
    const request = envelope();
    const processor = new WritebackProcessor(ShannonMemoryService.getInstance(), () => 'unused');
    db.eventClaim.mockReturnValueOnce({ lean: async () => ({ _id: 'event', sourceUserId: 'discord:100', scopeKey: 'foreign', payload: { envelope: request, conversationText: 'fixture' } }) });
    await processor.processPendingWritebacks(1);
    expect(db.eventClaim.mock.calls[0][0]).toEqual({ status: 'pending', scopeVersion: 1 });
    expect(db.eventUpdate.mock.calls[0][1].$set).toMatchObject({ status: 'error', errorMessage: 'MEMORY_SCOPE_MISMATCH' });
    expect(db.model).not.toHaveBeenCalled(); expect(db.created).toEqual([]);
  });
  it('captures queue authority and strips runtime metadata before an async create', async () => {
    const request = envelope(); request.metadata = { bot: { runtime: true } };
    const processor = new WritebackProcessor(ShannonMemoryService.getInstance(), () => 'spoofed alias');
    await processor.writeback({ envelope: request, conversationText: 'fixture', exchanges: [] });
    const queued = db.eventCreate.mock.calls[0][0]; request.discord.guildId = '999';
    expect(queued).toMatchObject({ scopeVersion: 1, sourceUserId: 'discord:100' });
    expect(queued.payload.envelope.discord.guildId).toBe('200'); expect(queued.payload.envelope.metadata.bot).toBeUndefined();
    expect(queued.scopeKey).toBe(deriveMemoryScope(queued.payload.envelope)!.scopeKey);
  });
  it('retains the source audience while an autonomy model response is pending', async () => {
    let release!: (x: any) => void; db.model.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const request = envelope('100', '', '300', true); const expected = deriveMemoryScope(request)!;
    const updater = new AutonomyUpdater(new ScopeDeriver(), () => 'spoof');
    const running = updater.runAutonomyUpdaters(request, 'private fixture');
    while (!release) await Promise.resolve();
    request.discord.channelId = '999'; request.sourceUserId = '999';
    release({ content: JSON.stringify({ selfObservations: [{ observation: 'private', confidence: 1 }] }) });
    await running;
    expect(db.created).toHaveLength(1); expect(db.created[0].scopeKey).toBe(expected.scopeKey);
  });
});

it('Mongoose retains the scope stamp and never defaults a legacy document into a shared audience', async () => {
  const actual = await vi.importActual<typeof import('../../src/models/ShannonMemory.js')>('../../src/models/ShannonMemory.js');
  const legacy = new actual.ShannonMemory({ ...draft, source: 'fixture' });
  expect(legacy.visibilityScope).toBeUndefined(); expect(legacy.scopeVersion).toBeUndefined();
  const scope = deriveMemoryScope(envelope())!;
  const fresh = new actual.ShannonMemory({ ...draft, source: 'fixture', ...scope }).toObject();
  expect(fresh).toMatchObject(scope);
});
