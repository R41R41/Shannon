import { describe, expect, it } from 'vitest';
import { bagForPath, isToolAllowedOnPath, isTwitterWriteTool, selectToolsForChannel, selectToolsForPath, toolsForPath, TWITTER_WRITE_TOOLS } from '../../src/modules/access/toolCatalog.js';
import { RADAR_DISCOVERY_TOOLS } from '../../src/services/radar/radarDiscovery.js';

describe('tool path catalog', () => {
  it('keeps minecraft and general as separate bags', () => {
    expect(bagForPath('minecraft_executor')).toBe('minecraft');
    expect(bagForPath('discord_conversation')).toBe('general');
    expect(bagForPath('line_chat')).toBe('general');
    expect(bagForPath('radar_digest')).toBe('general');
    expect(bagForPath('scheduled_post')).toBe('general');
  });

  it('does not put LINE search or Radar digest tools on the minecraft path', () => {
    expect(isToolAllowedOnPath('minecraft_executor', 'search_web')).toBe(false);
    expect(isToolAllowedOnPath('minecraft_executor', 'submit_personal_digest')).toBe(false);
    expect(isToolAllowedOnPath('minecraft_executor', 'chat-on-discord')).toBe(false);
  });

  it('does not put Discord send or memory tools on LINE chat', () => {
    expect(isToolAllowedOnPath('line_chat', 'chat-on-discord')).toBe(false);
    expect(isToolAllowedOnPath('line_chat', 'recall-person')).toBe(false);
    expect(isToolAllowedOnPath('line_chat', 'search_web')).toBe(true);
    expect(isToolAllowedOnPath('line_chat', 'search_youtube')).toBe(true);
  });

  it('lists Radar discovery names on the radar path only', () => {
    for (const tool of RADAR_DISCOVERY_TOOLS) {
      expect(isToolAllowedOnPath('radar_digest', tool.name)).toBe(true);
      expect(isToolAllowedOnPath('line_chat', tool.name)).toBe(false);
      expect(isToolAllowedOnPath('discord_conversation', tool.name)).toBe(false);
    }
    expect(isToolAllowedOnPath('radar_digest', 'submit_personal_digest')).toBe(true);
    expect(isToolAllowedOnPath('radar_digest', 'chat-on-discord')).toBe(false);
  });

  it('filters an injected list to the path allowlist', () => {
    const tools = [
      { name: 'google-search' },
      { name: 'search-by-wikipedia' },
      { name: 'chat-on-discord' },
      { name: 'submit_post' },
    ];
    expect(selectToolsForPath('scheduled_post', tools).map(t => t.name)).toEqual([
      'google-search',
      'search-by-wikipedia',
      'submit_post',
    ]);
    expect(toolsForPath('scheduled_post')).toContain('submit_post');
  });

  it('does not let Discord or web conversation call Twitter write tools', () => {
    const tools = [
      { name: 'chat-on-discord' },
      { name: 'google-search' },
      { name: 'post-on-twitter' },
      { name: 'like-tweet' },
      { name: 'generate-tweet-text' },
    ];
    expect(selectToolsForChannel('discord', tools).map(t => t.name)).toEqual(['chat-on-discord', 'google-search']);
    expect(selectToolsForChannel('web', tools).map(t => t.name)).toEqual(['google-search']);
    expect(isToolAllowedOnPath('discord_conversation', 'post-on-twitter')).toBe(false);
    expect(selectToolsForChannel('scheduler', tools).map(t => t.name)).toEqual(['google-search']);
    expect(selectToolsForChannel('discord', [...tools, { name: 'pause' }]).map(t => t.name)).toEqual([
      'chat-on-discord', 'google-search', 'pause',
    ]);
    expect(selectToolsForChannel('discord', [{ name: 'wolfram-alpha-tool' }])).toEqual([]);
    expect(TWITTER_WRITE_TOOLS.every(name => isTwitterWriteTool(name))).toBe(true);
    expect(isTwitterWriteTool('get-x-or-twitter-post-content-from-url')).toBe(false);
  });
});
