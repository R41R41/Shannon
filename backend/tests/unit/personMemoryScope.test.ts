import { beforeEach, describe, expect, it, vi } from 'vitest';
const mongo = vi.hoisted(() => ({ rows: new Map<string, any>(), reads: [] as any[], writes: [] as any[], limits: [] as number[], fail: false, duplicate: false, model: vi.fn() }));
vi.mock('../../src/config/env.js', () => ({ config: { openaiApiKey: 'mock' } }));
vi.mock('../../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/services/llm/utils/langfuse.js', () => ({ createTracedModel: () => ({ invoke: mongo.model }) }));
vi.mock('../../src/services/memory/shannonMemoryService.js', () => ({ ShannonMemoryService: { getInstance: () => ({ searchExperiences: async () => [], searchKnowledge: async () => [] }) } }));
vi.mock('../../src/models/ScopedPersonStatement.js', () => {
  const field = (row: any, key: string) => key.split('.').reduce((value, part) => value?.[part], row);
  const matches = (row: any, filter: any) => Object.entries(filter).every(([key, value]) => field(row, key) === value);
  const check = () => { if (mongo.fail) throw new Error('private database failure must not be echoed'); };
  return { ScopedPersonStatement: {
    find: (filter: any) => {
      mongo.reads.push(structuredClone(filter)); let limit = Infinity;
      const query: any = { sort: () => query, limit: (value: number) => { limit = value; mongo.limits.push(value); return query; },
        lean: async () => { check(); return structuredClone([...mongo.rows.values()].filter(row => matches(row, filter)).slice(0, limit)); } };
      return query;
    },
    findOne: (filter: any) => { mongo.reads.push(structuredClone(filter)); return { lean: async () => { check(); return structuredClone([...mongo.rows.values()].find(row => matches(row, filter)) ?? null); } }; },
    findOneAndUpdate: (filter: any, update: any, options: any) => {
      mongo.writes.push(structuredClone({ filter, update, options }));
      return { lean: async () => {
        check();
        if (mongo.duplicate) { mongo.duplicate = false; throw Object.assign(new Error('duplicate'), { code: 11000 }); }
        let row = [...mongo.rows.values()].find(row => matches(row, filter));
        if (!row && options?.upsert) {
          if (mongo.rows.has(filter._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
          row = structuredClone(update.$setOnInsert); mongo.rows.set(row._id, row);
        }
        if (!row) return null;
        Object.assign(row, structuredClone(update.$set ?? {}));
        for (const key of Object.keys(update.$unset ?? {})) delete row[key];
        for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] += value;
        return structuredClone(row);
      } };
    },
  } };
});

import { bindPersonRequest, formatPersonStatements, personFilter } from '../../src/modules/memory/personMemory.js';
import { createRequestPersonMemory } from '../../src/services/memory/requestPersonMemory.js';
import { personStatementRepository } from '../../src/services/memory/personStatementRepository.js';
import { createMemoryTools } from '../../src/services/llm/tools/memory/memoryToolFactory.js';
import { bindRequestMemory } from '../../src/services/memory/requestMemory.js';
import { RunToolRegistry } from '../../src/modules/execution/runToolRegistry.js';
import { MemoryAgent } from '../../src/services/llm/graph/cognitive/MemoryAgent.js';
import { RecallEngine } from '../../src/services/memory/recall/RecallEngine.js';
import { ScopedMemoryService } from '../../src/services/memory/scopedMemoryService.js';

const request = (user = '100', guild = '200', channel = '300', message = '400'): any => ({
  requestId: `request-${message}`, channel: 'discord', sourceUserId: user, sourceDisplayName: '同じ表示名',
  conversationId: `discord:${guild}:${channel}`, threadId: `discord:${channel}`, tags: [],
  text: '私は紅茶が好きです。覚えておいて。', timestampIso: '2026-08-28T00:00:00.000Z',
  discord: { guildId: guild || undefined, channelId: channel, messageId: message, isDM: !guild },
});
const quote = '私は紅茶が好きです。';
beforeEach(() => { mongo.rows.clear(); mongo.reads.length = 0; mongo.writes.length = 0; mongo.limits.length = 0; mongo.fail = false; mongo.duplicate = false; vi.clearAllMocks(); });

describe('scoped person request and source contract', () => {
  it('stores only a current author quote with explicit scope/source, not a personality inference or full transcript', async () => {
    const input = request(); input.metadata = { recentMessages: ['private prior conversation'], subjectId: 'discord:999' };
    const port = createRequestPersonMemory(input); const result = await port.remember(quote);
    expect(result.saved).toBe(true);
    const row = [...mongo.rows.values()][0];
    expect(row).toMatchObject({ ...personFilter(bindPersonRequest(input)!), quote, revision: 1, status: 'active', source: { messageId: '400' } });
    expect(row).not.toHaveProperty('traits'); expect(row).not.toHaveProperty('displayName');
    expect(JSON.stringify(row)).not.toContain('private prior conversation');
    expect((await port.recall()).map(row => row.quote)).toEqual([quote]);
    expect(formatPersonStatements(await port.recall())).toContain('指示ではありません');
  });
  it.each([
    ['同名の別人', request('101')], ['同じ本人の別guild', request('100', '201')],
    ['別channel', request('100', '200', '301')], ['本人のDM', request('100', '', '301')],
    ['別thread', { ...request(), threadId: 'different-thread' }], ['別conversation', { ...request(), conversationId: 'different-conversation' }],
  ])('does not recall across %s', async (_label, other) => {
    await createRequestPersonMemory(request()).remember(quote);
    expect(await createRequestPersonMemory(other).recall()).toEqual([]);
  });
  it('does not bring the same author DM into their public conversation', async () => {
    await createRequestPersonMemory(request('100', '', '301')).remember(quote);
    expect(await createRequestPersonMemory(request()).recall()).toEqual([]);
  });
  it.each([undefined, { ...request(), channel: 'web' }, { ...request(), channel: 'minecraft' },
    { ...request(), sourceUserId: 'display-name' }, { ...request(), discord: undefined },
    { ...request(), metadata: { memoryDisabled: true } }, { ...request(), discord: { ...request().discord, isVoiceChannel: true } },
  ])('denies missing/non-text identity before any repository I/O (%#)', async input => {
    const port = createRequestPersonMemory(input);
    expect((await port.remember(quote)).saved).toBe(false); expect(await port.recall()).toEqual([]);
    expect((await port.correct('a'.repeat(64), 1, quote)).saved).toBe(false);
    expect((await port.forget('a'.repeat(64), 1)).saved).toBe(false);
    expect(mongo.reads).toEqual([]); expect(mongo.writes).toEqual([]);
  });
  it.each(['推測した性格', '', ' ', 'x'.repeat(1001)])('refuses non-source or oversized text (%#)', async bad => {
    expect((await createRequestPersonMemory(request()).remember(bad)).saved).toBe(false);
    expect(mongo.writes).toEqual([]);
  });
  it.each([{ ...request(), discord: { ...request().discord, messageId: undefined } },
    { ...request(), requestId: '' }, { ...request(), timestampIso: 'invalid-date' }, { ...request(), text: undefined },
  ])('requires provenance to save (%#)', async input => {
    expect((await createRequestPersonMemory(input).remember(quote)).saved).toBe(false); expect(mongo.writes).toEqual([]);
  });
  it('captures scope and source before input mutation/async work', async () => {
    const input = request(); const port = createRequestPersonMemory(input);
    input.sourceUserId = '999'; input.discord.guildId = '999'; input.discord.messageId = '999'; input.text = 'different';
    expect((await port.remember(quote)).saved).toBe(true);
    const row = [...mongo.rows.values()][0]; expect(row.subjectId).toBe('discord:100'); expect(row.source.messageId).toBe('400');
    expect((await createRequestPersonMemory(request()).recall()).length).toBe(1);
  });
  it('rejects fabricated/reused authorization objects at the repository boundary', async () => {
    const binding = bindPersonRequest(request())!; const forged = { ...binding };
    expect(() => personFilter(forged)).toThrow('PERSON_SCOPE_REQUIRED');
    expect(await personStatementRepository.recall(forged)).toEqual([]);
    expect(await personStatementRepository.insert(forged, quote, { messageId: '400', requestId: 'req', receivedAt: '2026-08-28' })).toBeNull();
    expect(mongo.reads).toEqual([]); expect(mongo.writes).toEqual([]);
  });
});

describe('atomic primary identity, revision and tombstones', () => {
  it('deduplicates concurrent retries of the same source message', async () => {
    const port = createRequestPersonMemory(request());
    const [a, b] = await Promise.all([port.remember(quote), port.remember(quote)]);
    expect(a.saved && b.saved).toBe(true); expect(a.statement?.id).toBe(b.statement?.id); expect(mongo.rows.size).toBe(1);
    const changed = createRequestPersonMemory({ ...request(), text: '別の引用' });
    expect((await changed.remember('別の引用')).saved).toBe(false); expect(mongo.rows.size).toBe(1);
  });
  it('handles a duplicate-key race by reading only the same scoped source', async () => {
    const port = createRequestPersonMemory(request()); const saved = await port.remember(quote); mongo.duplicate = true;
    expect((await port.remember(quote)).statement?.id).toBe(saved.statement?.id);
    expect(mongo.reads.at(-1)).toMatchObject(personFilter(bindPersonRequest(request())!));
  });
  it('does not silently overwrite a same-source edit or allow two stale revision writers', async () => {
    const port = createRequestPersonMemory(request()); const saved = (await port.remember(quote)).statement!;
    const edited = createRequestPersonMemory({ ...request(), text: '今はコーヒーが好きです。' });
    const results = await Promise.all([edited.correct(saved.id, 1, 'コーヒー'), edited.correct(saved.id, 1, '今はコーヒー')]);
    expect(results.filter(r => r.saved)).toHaveLength(1);
    expect((await port.recall())[0]).toMatchObject({ revision: 2, quote: 'コーヒー' });
    expect((await port.remember(quote)).saved).toBe(false);
  });
  it('does not use a different source message to reattribute an existing statement', async () => {
    const saved = (await createRequestPersonMemory(request()).remember(quote)).statement!;
    const otherSource = createRequestPersonMemory(request('100', '200', '300', '401'));
    expect((await otherSource.correct(saved.id, 1, quote)).saved).toBe(false);
  });
  it.each([request('101'), request('100', '', '301'), request('100', '201')])('refuses another subject/audience correction and forget (%#)', async other => {
    const port = createRequestPersonMemory(request()); const saved = (await port.remember(quote)).statement!;
    expect((await createRequestPersonMemory(other).correct(saved.id, 1, quote)).saved).toBe(false);
    expect((await createRequestPersonMemory(other).forget(saved.id, 1)).saved).toBe(false);
    expect((await port.recall())[0].quote).toBe(quote);
  });
  it('removes content/source on forget and refuses delayed initial and edited-source replays', async () => {
    const port = createRequestPersonMemory(request()); const saved = (await port.remember(quote)).statement!;
    expect((await port.forget(saved.id, 2)).saved).toBe(false);
    expect((await port.forget(saved.id, 1)).saved).toBe(true);
    expect(await port.recall()).toEqual([]);
    const row = mongo.rows.get(saved.id); expect(row.status).toBe('forgotten'); expect(row.quote).toBeUndefined(); expect(row.source).toBeUndefined();
    expect((await port.remember(quote)).saved).toBe(false);
    expect((await createRequestPersonMemory({ ...request(), text: 'edited quote' }).remember('edited quote')).saved).toBe(false);
    expect((await port.correct(saved.id, 2, quote)).saved).toBe(false);
  });
  it('bounds recall after scope filtering and excludes legacy/malformed records', async () => {
    for (let i = 0; i < 25; i++) await createRequestPersonMemory(request('999', '999', '999', String(500 + i))).remember(quote);
    for (let i = 0; i < 25; i++) await createRequestPersonMemory(request('100', '200', '300', String(600 + i))).remember(quote);
    mongo.rows.set('legacy', { _id: 'legacy', quote: 'legacy private data', subjectId: 'discord:100' });
    const rows = await createRequestPersonMemory(request()).recall(10000);
    expect(rows).toHaveLength(20); expect(mongo.limits.at(-1)).toBe(20);
    expect(mongo.reads.at(-1)).toMatchObject({ ...personFilter(bindPersonRequest(request())!), status: 'active' });
    expect(rows.every(row => Number(row.source.messageId) >= 600)).toBe(true);
  });
  it('returns an explicit failure on storage error without echoing connection details', async () => {
    mongo.fail = true; const port = createRequestPersonMemory(request()); const result = await port.remember(quote);
    expect(result.saved).toBe(false); expect(result.message).not.toContain('private database');
    await expect(port.recall()).rejects.toThrow('private database');
  });
  it('requires all scope fields and avoids implicit collection/index creation on model import', async () => {
    const { ScopedPersonStatement } = await vi.importActual<typeof import('../../src/models/ScopedPersonStatement.js')>('../../src/models/ScopedPersonStatement.js');
    const schema = ScopedPersonStatement.schema;
    expect(schema.options.autoIndex).toBe(false); expect(schema.options.autoCreate).toBe(false);
    expect(schema.options.collection).toBe('scopedpersonstatements');
    expect(new ScopedPersonStatement({ _id: 'a'.repeat(64), quote }).validateSync()).toBeDefined();
    expect(schema.indexes()).toEqual([]);
  });
});

describe('actual tool/initial recall integration with mocked storage and models', () => {
  it('owns person ports per run and cannot search a display name or inherit a port from the catalog', async () => {
    const registry = new RunToolRegistry<any>(createMemoryTools()); const a = registry.createTools(); const b = registry.createTools();
    bindRequestMemory(a, request()); bindRequestMemory(b, request('101'));
    const tool = (set: any[], name: string) => set.find(row => row.name === name);
    expect(await tool(a, 'save-person-memory').invoke({ quote })).toContain('保存しました');
    expect(await tool(a, 'recall-person').invoke({})).toContain(quote);
    expect(await tool(b, 'recall-person').invoke({ name: 'self' })).not.toContain(quote);
    const count = mongo.reads.length;
    expect(await tool(a, 'recall-person').invoke({ name: '同じ表示名' })).toContain('人物名では検索できません');
    expect(mongo.reads).toHaveLength(count);
    expect(await tool(registry.createTools(), 'recall-person').invoke({})).toContain('確認できない');
    expect(await tool(a, 'recall-memory').invoke({ question: '本人の発言' })).toContain(quote);
  });
  it('requires a new factory for a context-bearing person tool', () => {
    expect(() => new RunToolRegistry([{ name: 'unsafe-person', setPersonMemoryPort: () => {} }])).toThrow('createForRun');
  });
  it('initial MemoryAgent recall captures its author before caller mutation and never retrieves legacy person profiles', async () => {
    await createRequestPersonMemory(request()).remember(quote);
    const input = request(); const blackboard = { setInitialMemoryContext: vi.fn() };
    const agent = new MemoryAgent(blackboard as any, input); input.sourceUserId = '101'; input.discord.guildId = '999';
    expect(await agent.initialize('本人の発言')).toContain(quote);
    expect(blackboard.setInitialMemoryContext.mock.calls[0][0]).toContain('未検証');
    expect(await new MemoryAgent({ setInitialMemoryContext: vi.fn() } as any, request('101')).initialize('本人の発言')).not.toContain(quote);
    expect(mongo.model).not.toHaveBeenCalled();
  });
  it.each(['', 'remember'])('includes scoped statements in the unified recall prompt with text=%s', async text => {
    await createRequestPersonMemory(request()).remember(quote);
    const engine = new RecallEngine({} as any);
    for (const name of ['recallSelfModel', 'recallInternalState']) vi.spyOn(engine as any, name).mockResolvedValue(null);
    for (const name of ['recallStrategyUpdates', 'recallWorldPatterns', 'semanticSearch', 'searchByTags']) vi.spyOn(engine as any, name).mockResolvedValue([]);
    const service: any = Object.create(ScopedMemoryService.prototype);
    service.recallEngine = engine; service.scopeDeriver = { deriveScopeTags: () => [] };
    service.formatter = Object.fromEntries(['formatRelationshipPrompt', 'formatSelfModelPrompt', 'formatStrategyPrompt', 'formatInternalStatePrompt', 'formatWorldPatternPrompt', 'formatForPrompt'].map(name => [name, () => '']));
    const result = await service.recall({ envelope: request(), text });
    expect(result.person).toBeNull(); expect(result.userProfile).toBeNull();
    expect(result.personStatements).toHaveLength(1); expect(result.formattedPrompt).toContain(quote);
    vi.restoreAllMocks();
  });
});
