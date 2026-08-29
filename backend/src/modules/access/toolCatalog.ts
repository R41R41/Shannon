/**
 * Two bags, many paths. A path receives a named subset; it does not inherit the other bag.
 * InstantSkills stay in the minecraft bag and are not listed name-by-name here.
 */
import { selectAllowedTools } from './toolSelection.js';

export const TOOL_BAGS = ['minecraft', 'general'] as const;
export type ToolBag = (typeof TOOL_BAGS)[number];
export const TWITTER_WRITE_TOOLS = Object.freeze([
  'post-on-twitter',
  'like-tweet',
  'retweet-tweet',
  'quote-retweet',
  'generate-tweet-text',
]);

export const TOOL_PATHS = [
  'minecraft_executor',
  'discord_conversation',
  'web_conversation',
  'line_chat',
  'radar_digest',
  'scheduled_post',
] as const;
export type ToolPath = (typeof TOOL_PATHS)[number];

const MINECRAFT_LLM_TOOLS = Object.freeze([
  'task-complete',
  'search-skills',
  'plan-craft',
  'manage-routine',
  'wait',
  'recall-memory',
  'save-memory',
  'recall-experience',
  'save-experience',
  'recall-knowledge',
  'save-knowledge',
]);

const DISCORD_CONVERSATION_TOOLS = Object.freeze([
  'update-plan',
  'task-complete',
  'wait',
  'google-search',
  'search-by-wikipedia',
  'search-weather',
  'fetch-url',
  'describe-image',
  'create-image',
  'chat-on-discord',
  'get-discord-recent-messages',
  'get-discord-images',
  'get-server-emoji-on-discord',
  'react-by-server-emoji-on-discord',
  'get-youtube-video-content-from-url',
  'get-notion-page-content-from-url',
  'get-x-or-twitter-post-content-from-url',
  'recall-memory',
  'save-memory',
  'save-person-memory',
  'recall-person',
  'recall-experience',
  'save-experience',
  'recall-knowledge',
  'save-knowledge',
]);

const WEB_CONVERSATION_TOOLS = Object.freeze([
  'update-plan',
  'task-complete',
  'wait',
  'google-search',
  'search-by-wikipedia',
  'search-weather',
  'fetch-url',
  'describe-image',
  'create-image',
  'chat-on-web',
]);

const LINE_CHAT_TOOLS = Object.freeze(['search_web', 'search_youtube']);

const RADAR_DIGEST_TOOLS = Object.freeze([
  'get_unshared_youtube_videos',
  'search_shareable_tweets',
  'search_web_for_sharing',
  'get_upcoming_calendar_events',
  'get_weather_forecast',
  'get_selected_notion_updates',
  'get_important_unread_gmail',
  'get_allowlisted_discord_updates',
  'submit_personal_digest',
]);

const SCHEDULED_POST_TOOLS = Object.freeze([
  'google-search',
  'search-by-wikipedia',
  'submit_post',
]);

const PATH_BAG: Readonly<Record<ToolPath, ToolBag>> = Object.freeze({
  minecraft_executor: 'minecraft',
  discord_conversation: 'general',
  web_conversation: 'general',
  line_chat: 'general',
  radar_digest: 'general',
  scheduled_post: 'general',
});

const PATH_TOOLS: Readonly<Record<ToolPath, readonly string[]>> = Object.freeze({
  minecraft_executor: MINECRAFT_LLM_TOOLS,
  discord_conversation: DISCORD_CONVERSATION_TOOLS,
  web_conversation: WEB_CONVERSATION_TOOLS,
  line_chat: LINE_CHAT_TOOLS,
  radar_digest: RADAR_DIGEST_TOOLS,
  scheduled_post: SCHEDULED_POST_TOOLS,
});

const EXTRA_NAMED_TOOLS = Object.freeze([
  ...TWITTER_WRITE_TOOLS,
  'wolfram-alpha-tool',
  'edit-image',
  'describe-notion-image',
]);

const NAMED_PLATFORM_TOOLS = new Set<string>([
  ...Object.values(PATH_TOOLS).flat(),
  ...EXTRA_NAMED_TOOLS,
]);

const CHANNEL_PATH: Readonly<Record<string, ToolPath>> = Object.freeze({
  minecraft: 'minecraft_executor',
  minebot: 'minecraft_executor',
  discord: 'discord_conversation',
  web: 'web_conversation',
  scheduler: 'scheduled_post',
});

export function toolPathForChannel(channel: string | undefined): ToolPath | undefined {
  return channel ? CHANNEL_PATH[channel] : undefined;
}

export function bagForPath(path: ToolPath): ToolBag {
  return PATH_BAG[path];
}

export function toolsForPath(path: ToolPath): readonly string[] {
  return PATH_TOOLS[path];
}

export function selectToolsForPath<T extends { name: string }>(path: ToolPath, tools: readonly T[]): T[] {
  return selectAllowedTools(tools, PATH_TOOLS[path]);
}

export function isToolAllowedOnPath(path: ToolPath, name: string): boolean {
  return PATH_TOOLS[path].includes(name);
}

export function isTwitterWriteTool(name: string): boolean {
  return (TWITTER_WRITE_TOOLS as readonly string[]).includes(name);
}

/** Catalog first for named platform tools. InstantSkills and test tools keep their injected names. Twitter write never leaks onto a conversation path. */
export function selectToolsForChannel<T extends { name: string }>(
  channel: string | undefined,
  tools: readonly T[],
  extraAllowlist?: readonly string[],
): T[] {
  const path = toolPathForChannel(channel);
  const allowed = path ? new Set(toolsForPath(path)) : undefined;
  const selected = tools.filter(tool => {
    if (isTwitterWriteTool(tool.name) && path !== 'scheduled_post') return false;
    if (!NAMED_PLATFORM_TOOLS.has(tool.name)) return true;
    if (!allowed) return !isTwitterWriteTool(tool.name);
    return allowed.has(tool.name);
  });
  return extraAllowlist === undefined ? selected : selectAllowedTools(selected, extraAllowlist);
}
