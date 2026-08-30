import { describe, expect, it } from 'vitest';
import { filterToolsByMemoryPolicy, selectToolsForChannel } from '../../src/modules/access/toolCatalog.js';

const tools = [
  { name: 'chat-on-discord' },
  { name: 'recall-memory' },
  { name: 'save-memory' },
  { name: 'save-person-memory' },
  { name: 'google-search' },
];

describe('toolCatalog memory policy', () => {
  it('removes memory tools when memoryDisabled is set', () => {
    const filtered = filterToolsByMemoryPolicy({ metadata: { memoryDisabled: true } }, tools);
    expect(filtered.map(t => t.name)).toEqual(['chat-on-discord', 'google-search']);
  });

  it('propagates memoryDisabled through selectToolsForChannel', () => {
    const selected = selectToolsForChannel('discord', tools, undefined, { metadata: { memoryDisabled: true } });
    expect(selected.some(t => t.name === 'recall-memory')).toBe(false);
    expect(selected.some(t => t.name === 'chat-on-discord')).toBe(true);
  });
});
