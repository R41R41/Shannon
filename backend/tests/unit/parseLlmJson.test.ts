import { describe, expect, it } from 'vitest';
import { parseLlmJsonObject } from '../../src/services/memory/writeback/parseLlmJson.js';

describe('parseLlmJsonObject', () => {
  it('parses memories that include LaTeX backslashes', () => {
    const raw = `{
  "memories": [
    {
      "category": "knowledge",
      "content": "二次不等式 \\( y \\leq 4 - x^2 \\) の面積",
      "tags": ["math"],
      "importance": 5
    }
  ]
}`;
    const parsed = parseLlmJsonObject(raw) as { memories: Array<{ content: string }> };
    expect(parsed.memories[0].content).toContain('y');
    expect(parsed.memories[0].content).toContain('4 - x^2');
  });

  it('leaves valid JSON unchanged', () => {
    const parsed = parseLlmJsonObject('{"memories":[{"content":"hello\\nworld"}]}') as { memories: Array<{ content: string }> };
    expect(parsed.memories[0].content).toBe('hello\nworld');
  });

  it('returns null for non-json text', () => {
    expect(parseLlmJsonObject('no json here')).toBeNull();
  });
});
