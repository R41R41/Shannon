import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/config/env.js', () => ({ config: { anthropic: { apiKey: 'test-only', model: 'test-model' } } }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({ CONFIG: { UI_MOD_BASE_URL: 'http://example.invalid' } }));
import { ShannonExecutor } from '../../src/services/llm/graph/ShannonExecutor.js';

async function answer(conversation: boolean) {
  const bot: any = Object.assign(new EventEmitter(), { executingSkill: false, interruptExecution: false,
    registry: { itemsByName: {} }, health: 20, food: 20, activeFurnaces: [], entities: {}, inventory: { items: () => [] },
    entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'overworld' },
    pathfinder: { stop: vi.fn(), setGoal: vi.fn() }, clearControlStates: vi.fn() });
  const chat = { params: [{ name: 'message', type: 'string', description: 'line', required: true }],
    run: vi.fn(async () => ({ success: true, result: 'sent' })) };
  const outputs = [
    [{ type: 'tool_use', id: 'say', name: 'chat', input: { message: 'はーい、元気だよ' } }],
    [{ type: 'tool_use', id: 'done', name: 'task-complete', input: { summary: '返事をした' } }],
  ];
  let turn = 0;
  const modelClient: any = { messages: { stream: () => ({ finalMessage: async () => ({
    content: outputs[turn++] ?? [{ type: 'text', text: '返事は済んだ' }], usage: {} }) }) } };
  const result = await new ShannonExecutor({ modelClient, modelIdentity: { provider: 'fixture', model: 'fixture' }, bot,
    instantSkills: { getSkill: (name: string) => name === 'chat' ? chat : undefined } as any,
    publishTaskTree: () => {}, conversation }).run({ runId: 'chat-run', goal: 'シャノン、元気？', context: null,
    systemPrompt: 'Answer with chat', tools: [] });
  return { result, chat, turns: turn };
}

describe('a conversation turn', () => {
  it('completes after answering when it promised nothing in the world', async () => {
    const { result, chat, turns } = await answer(true);
    expect(chat.run).toHaveBeenCalledWith('はーい、元気だよ');
    expect(result.taskTree?.status).toBe('completed');
    expect(result.lastContent).toBe('返事をした');
    expect(turns).toBe(2);
  });

  it('keeps native proof for an ordinary task without a contract', async () => {
    const { result } = await answer(false);
    expect(result.taskTree?.status).not.toBe('completed');
    expect(JSON.stringify(result.messages ?? [])).toContain('完了を確認できません');
  });
});
