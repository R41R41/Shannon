import { lineGroupId, lineUserId, type LinePolicy } from '../../modules/conversation/lineConversation.js';
export interface LineConfig extends LinePolicy { channelSecret: string; channelAccessToken: string }
/** No implicit dotenv/global env. Empty allowlists deny; no wildcard or display-name matching. */
export function lineConfig(env: Readonly<Record<string, string | undefined>>): LineConfig {
  const fail = (): never => { throw new Error('LINE_CONFIG_INVALID'); };
  const enabled = env.LINE_ENABLED === 'true';
  if (env.LINE_ENABLED && !['true', 'false'].includes(env.LINE_ENABLED)) fail();
  const integer = (key: string, fallback: number, max: number) => {
    const raw = env[key] ?? String(fallback);
    if (!/^\d+$/.test(raw) || Number(raw) > max) return fail();
    return Number(raw);
  };
  const ids = (env.LINE_ALLOWED_GROUP_IDS ?? '').trim();
  const allowedGroupIds = ids ? ids.split(',').map(v => v.trim()) : [];
  if (allowedGroupIds.length > 20 || allowedGroupIds.some(id => !lineGroupId(id))
    || new Set(allowedGroupIds).size !== allowedGroupIds.length) fail();
  const p: LineConfig = { enabled, botUserId: env.LINE_BOT_USER_ID ?? '', personalUserId: env.LINE_PERSONAL_USER_ID ?? '',
    channelSecret: env.LINE_CHANNEL_SECRET ?? '', channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
    allowedGroupIds: Object.freeze(allowedGroupIds), groupMode: env.LINE_GROUP_REPLY_MODE === 'all' ? 'all' : 'addressed',
    chatMaxPer24Hours: integer('LINE_CHAT_MAX_PER_24H', 0, 200), pushMaxPerMonth: integer('LINE_PUSH_MAX_PER_MONTH', 0, 200),
    pushMaxPer24Hours: integer('LINE_PUSH_MAX_PER_24H', 0, 3),
    quietStartJst: integer('LINE_QUIET_START_JST', 22, 23), quietEndJst: integer('LINE_QUIET_END_JST', 8, 23) };
  if (env.LINE_GROUP_REPLY_MODE && !['all', 'addressed'].includes(env.LINE_GROUP_REPLY_MODE)) fail();
  if (p.personalUserId && !lineUserId(p.personalUserId)) fail();
  if (enabled && (!lineUserId(p.botUserId) || p.personalUserId === p.botUserId
    || !/^[A-Za-z0-9]{16,128}$/.test(p.channelSecret) || !/^[A-Za-z0-9+/=_-]{16,2048}$/.test(p.channelAccessToken))) fail();
  return Object.freeze(p);
}
