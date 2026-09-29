import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAiFcaModel } from '../../src/services/fca/openAiFcaModel.js';
const mocks = vi.hoisted(() => ({ bind: vi.fn(), invoke: vi.fn(async () => ({ content: '', tool_calls: [] })) }));
vi.mock('@langchain/openai', () => ({ ChatOpenAI: class {
  bindTools(tools: unknown, options: unknown) { mocks.bind(tools, options); return { invoke: mocks.invoke }; }
  invoke = mocks.invoke;
} }));
const submit = { name: 'submit_post', description: 'submit', parameters: { type: 'object' } };
const search = { name: 'google-search', description: 'search', parameters: { type: 'object' } };
const settings = { apiKey: 'offline', model: 'test', maxTokens: 1000, temperature: 0.7 };
describe('scheduled submission tool choice', () => {
  beforeEach(() => vi.clearAllMocks());
  it('forces submission only after searches are removed', async () => {
    const model = createOpenAiFcaModel({ ...settings, requireSingleTool: 'submit_post' });
    await model.next({ system: 'test', messages: [], tools: [submit] }, new AbortController().signal);
    expect(mocks.bind.mock.calls[0][1]).toEqual({ parallel_tool_calls: false,
      tool_choice: { type: 'function', function: { name: 'submit_post' } } });
  });
  it('keeps free tool choice during research', async () => {
    const model = createOpenAiFcaModel({ ...settings, requireSingleTool: 'submit_post' });
    await model.next({ system: 'test', messages: [], tools: [search, submit] }, new AbortController().signal);
    expect(mocks.bind.mock.calls[0][1]).toEqual({ parallel_tool_calls: false });
  });
  it('preserves other callers with one tool', async () => {
    const model = createOpenAiFcaModel(settings);
    await model.next({ system: 'test', messages: [], tools: [search] }, new AbortController().signal);
    expect(mocks.bind.mock.calls[0][1]).toEqual({ parallel_tool_calls: false });
  });
});
