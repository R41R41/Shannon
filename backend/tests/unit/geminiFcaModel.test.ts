import { describe, expect, it } from 'vitest';
import { buildGeminiGenerateContentBody, parseGeminiGenerateContentResponse } from '../../src/services/fca/geminiFcaModel.js';

describe('Gemini FCA payload', () => {
  it('folds later system turns into systemInstruction and keeps one user/model transcript', () => {
    const body = buildGeminiGenerateContentBody({
      system: 'base system',
      messages: [
        { role: 'user', content: '天気は？' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'request-tools', arguments: { names: ['weather'] } }] },
        { role: 'tool', content: '{"requested":["weather"]}', toolCallId: 'call_1' },
        { role: 'system', content: '【初期記憶コンテキスト】none' },
      ],
      tools: [{ name: 'weather', description: '天気', parameters: { type: 'object', additionalProperties: true, properties: {} } }],
      maxTokens: 2048,
      temperature: 1,
    });
    expect(body.systemInstruction).toEqual({
      parts: [{ text: 'base system\n\n【初期記憶コンテキスト】none' }],
    });
    const contents = body.contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents.map(row => row.role)).toEqual(['user', 'model', 'user']);
    expect(contents[2].parts[0]).toEqual({
      functionResponse: { name: 'request-tools', response: { result: '{"requested":["weather"]}' } },
    });
    const tools = body.tools as Array<{ functionDeclarations: Array<{ parameters: Record<string, unknown> }> }>;
    expect(tools[0].functionDeclarations[0].parameters.additionalProperties).toBeUndefined();
  });

  it('parses function calls into FCA-safe ids', () => {
    const parsed = parseGeminiGenerateContentResponse({
      candidates: [{
        content: {
          parts: [
            { text: '調べます' },
            { functionCall: { name: 'request-tools', args: { names: ['weather'] } } },
          ],
        },
      }],
    });
    expect(parsed.content).toBe('調べます');
    expect(parsed.toolCalls[0]).toEqual({
      id: 'gemini_call_1',
      name: 'request-tools',
      arguments: { names: ['weather'] },
    });
  });

  it('echoes thoughtSignature on the stored functionCall part', () => {
    const parsed = parseGeminiGenerateContentResponse({
      candidates: [{
        content: {
          parts: [{
            functionCall: { name: 'request-tools', args: { names: ['weather'] } },
            thoughtSignature: 'sig-abc',
          }],
        },
      }],
    });
    const body = buildGeminiGenerateContentBody({
      system: 'sys',
      messages: [
        { role: 'user', content: '天気は？' },
        { role: 'assistant', content: '', toolCalls: parsed.toolCalls },
        { role: 'tool', content: 'ok', toolCallId: parsed.toolCalls[0].id },
      ],
      tools: [],
      maxTokens: 2048,
      temperature: 1,
      modelPartsByCalls: new Map([[parsed.toolCalls[0].id, parsed.modelParts]]),
    });
    const contents = body.contents as Array<{ role: string; parts: Array<{ thoughtSignature?: string }> }>;
    expect(contents[1].parts[0].thoughtSignature).toBe('sig-abc');
  });

  it('does not end contents on a model turn after a text-only assistant message', () => {
    const body = buildGeminiGenerateContentBody({
      system: 'sys',
      messages: [
        { role: 'user', content: 'どんなスキルが使えますか？' },
        { role: 'assistant', content: '' },
      ],
      tools: [],
      maxTokens: 2048,
      temperature: 1,
    });
    const contents = body.contents as Array<{ role: string }>;
    expect(contents.at(-1)?.role).toBe('user');
  });
});
