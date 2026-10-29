/** A YouTube live chat message as the head's stream contract wants it (stream-contract.md §2, `POST /v1/platform/stream/comments`). */
import type { LiveChatMessageResource } from './youtubeLiveApi.js';

export type StreamCommentKind = 'text' | 'superchat' | 'supersticker' | 'membership' | 'gift';
export type StreamCommentRole = 'owner' | 'moderator' | 'member' | 'verified';

export interface StreamComment {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  publishedAt: string;
  kind: StreamCommentKind;
  amount?: { display: string; micros: number; currency: string };
  roles: StreamCommentRole[];
}

/** The head cuts `text` at 300 chars; the ear cuts first so the wire stays small. */
export const COMMENT_TEXT_LIMIT = 300;

export type ChatEventClass =
  | { class: 'comment'; comment: StreamComment }
  /** The chat says it has ended (`chatEndedEvent`). */
  | { class: 'chat_ended' }
  /** Everything else: deletions, bans, mode changes, polls, gift receipts, ... never sent to the head. */
  | { class: 'ignored' };

export function classifyChatMessage(item: LiveChatMessageResource): ChatEventClass {
  const snippet = item.snippet;
  const type = snippet?.type;
  if (type === 'chatEndedEvent') return { class: 'chat_ended' };
  if (!item.id || !snippet || snippet.hasDisplayContent === false) return { class: 'ignored' };
  const author = item.authorDetails;
  const base = {
    id: item.id,
    authorId: author?.channelId ?? '',
    authorName: author?.displayName ?? '',
    publishedAt: snippet.publishedAt ?? '',
    roles: rolesOf(author),
  };
  if (!base.authorId || !base.authorName || !base.publishedAt) return { class: 'ignored' };

  switch (type) {
    case 'textMessageEvent': {
      const text = snippet.textMessageDetails?.messageText ?? snippet.displayMessage ?? '';
      if (!text.trim()) return { class: 'ignored' };
      return comment({ ...base, text, kind: 'text' });
    }
    case 'superChatEvent': {
      const details = snippet.superChatDetails;
      return comment({ ...base, text: details?.userComment ?? '', kind: 'superchat', ...amountOf(details) });
    }
    case 'superStickerEvent': {
      const details = snippet.superStickerDetails;
      return comment({ ...base, text: details?.superStickerMetadata?.altText ?? '', kind: 'supersticker', ...amountOf(details) });
    }
    case 'newSponsorEvent': {
      const details = snippet.newSponsorDetails;
      const level = details?.memberLevelName ? `（${details.memberLevelName}）` : '';
      return comment({ ...base, text: `${details?.isUpgrade ? 'メンバーシップをアップグレード' : 'メンバーになりました'}${level}`, kind: 'membership' });
    }
    case 'memberMilestoneChatEvent': {
      const details = snippet.memberMilestoneChatDetails;
      const months = typeof details?.memberMonth === 'number' ? `メンバー歴${details.memberMonth}か月` : 'メンバー歴の節目';
      const level = details?.memberLevelName ? `（${details.memberLevelName}）` : '';
      return comment({ ...base, text: details?.userComment?.trim() ? details.userComment : `${months}${level}`, kind: 'membership' });
    }
    case 'membershipGiftingEvent': {
      const details = snippet.membershipGiftingDetails;
      const count = typeof details?.giftMembershipsCount === 'number' ? details.giftMembershipsCount : 1;
      const level = details?.giftMembershipsLevelName ? `（${details.giftMembershipsLevelName}）` : '';
      return comment({ ...base, text: `メンバーシップを${count}件ギフトしました${level}`, kind: 'gift' });
    }
    default:
      return { class: 'ignored' };
  }
}

function comment(value: StreamComment): ChatEventClass {
  return { class: 'comment', comment: { ...value, text: cut(value.text, COMMENT_TEXT_LIMIT) } };
}

function rolesOf(author: LiveChatMessageResource['authorDetails']): StreamCommentRole[] {
  const roles: StreamCommentRole[] = [];
  if (author?.isChatOwner) roles.push('owner');
  if (author?.isChatModerator) roles.push('moderator');
  if (author?.isChatSponsor) roles.push('member');
  if (author?.isVerified) roles.push('verified');
  return roles;
}

function amountOf(details: { amountMicros?: string | number; currency?: string; amountDisplayString?: string } | undefined): Pick<StreamComment, 'amount'> {
  if (!details) return {};
  const micros = Number(details.amountMicros);
  if (!Number.isFinite(micros) || !details.currency) return {};
  return { amount: { display: details.amountDisplayString ?? `${details.currency} ${micros / 1e6}`, micros, currency: details.currency } };
}

/** Cuts on code points, so a surrogate pair is never split. */
function cut(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit).join('');
}

/** Splits for the wire: at most `maxCount` comments and `maxBytes` of JSON per request. */
export function chunkComments(comments: StreamComment[], maxCount = 200, maxBytes = 120 * 1024): StreamComment[][] {
  const chunks: StreamComment[][] = [];
  let current: StreamComment[] = [];
  let bytes = 0;
  for (const item of comments) {
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (current.length > 0 && (current.length >= maxCount || bytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
