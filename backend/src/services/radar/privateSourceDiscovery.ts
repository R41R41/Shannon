import type { RawRadarCandidate } from './radarDiscovery.js';

const OWNER = /^line:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;

const clean = (value: unknown, max: number): string | undefined =>
  typeof value === 'string'
  && Boolean(value.trim())
  && value.trim().length <= max
  && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim()
    : undefined;

const isNotionUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && (url.hostname === 'notion.so' || url.hostname === 'www.notion.so')
      && Boolean(url.pathname.replaceAll('/', ''))
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
};

const isGmailMessageUrl = (value: unknown, messageId: string): value is string => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'mail.google.com'
      && url.pathname === '/mail/u/0/'
      && url.hash === `#inbox/${messageId}`
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
};

export interface PrivateReadGrant {
  owner: string;
  bindingId: string;
  version: number;
  expiresAt: number;
  scope: string;
}

export interface SelectedNotionRow {
  pageId: string;
  title: string;
  summary: string;
  url: string;
  lastEditedAt: number;
}

export interface ImportantGmailRow {
  messageId: string;
  threadId: string;
  subject: string;
  sender: string;
  receivedAt: number;
  url: string;
}

export interface PrivateReadAuthority<T> {
  authorize(owner: string, signal: AbortSignal): Promise<PrivateReadGrant>;
  read(grant: PrivateReadGrant, limit: number, signal: AbortSignal): Promise<readonly T[]>;
}

const validGrant = (candidate: PrivateReadGrant, owner: string, scope: string, now: number, first?: PrivateReadGrant) =>
  candidate?.owner === owner
  && HASH.test(candidate.bindingId)
  && Number.isSafeInteger(candidate.version)
  && candidate.version > 0
  && Number.isSafeInteger(candidate.expiresAt)
  && candidate.expiresAt > now
  && candidate.scope === scope
  && (!first || (
    candidate.bindingId === first.bindingId
    && candidate.version === first.version
    && candidate.expiresAt === first.expiresAt
  ));

async function readBounded<T>(
  owner: string,
  scope: string,
  limit: number,
  authority: PrivateReadAuthority<T>,
  now: () => number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!OWNER.test(owner) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw new Error('PRIVATE_DISCOVERY_POLICY_INVALID');
  }
  const first = await authority.authorize(owner, signal);
  if (!validGrant(first, owner, scope, now())) throw new Error('PRIVATE_DISCOVERY_DENIED');
  const rows = await authority.read(first, limit, signal);
  signal.throwIfAborted();
  const current = await authority.authorize(owner, signal);
  if (!validGrant(current, owner, scope, now(), first)) throw new Error('PRIVATE_DISCOVERY_DENIED');
  signal.throwIfAborted();
  if (!Array.isArray(rows) || rows.length > limit) throw new Error('PRIVATE_DISCOVERY_RESPONSE_INVALID');
  return rows;
}

/** Only pages explicitly allowed by the injected authority. Workspace-wide search is outside this contract. */
export class SelectedNotionDiscovery {
  constructor(
    private readonly authority: PrivateReadAuthority<SelectedNotionRow>,
    private readonly now = Date.now,
  ) {}

  async find(owner: string, limit: number, signal: AbortSignal): Promise<readonly RawRadarCandidate[]> {
    const rows = await readBounded(owner, 'notion:selected:read', limit, this.authority, this.now, signal);
    const seen = new Set<string>();
    const result: RawRadarCandidate[] = [];
    for (const row of rows) {
      const pageId = clean(row?.pageId, 64);
      const title = clean(row?.title, 300);
      const summary = clean(row?.summary, 600);
      if (!pageId || !HASH.test(pageId) || seen.has(pageId) || !title || !summary || !isNotionUrl(row.url)
        || !Number.isSafeInteger(row.lastEditedAt) || row.lastEditedAt > this.now() + 300000) {
        throw new Error('PRIVATE_DISCOVERY_RESPONSE_INVALID');
      }
      seen.add(pageId);
      result.push(Object.freeze({
        source: 'notion',
        externalId: `${pageId}:${row.lastEditedAt}`,
        title,
        fact: summary,
        url: row.url,
        publishedAt: row.lastEditedAt,
        metadata: Object.freeze(['明示選択Notion']),
      }));
    }
    return Object.freeze(result);
  }
}

/** Header-only important+unread Gmail candidates. Body, attachments and state-changing operations are outside this contract. */
export class ImportantUnreadGmailDiscovery {
  constructor(
    private readonly authority: PrivateReadAuthority<ImportantGmailRow>,
    private readonly now = Date.now,
  ) {}

  async find(owner: string, limit: number, signal: AbortSignal): Promise<readonly RawRadarCandidate[]> {
    const rows = await readBounded(owner, 'https://www.googleapis.com/auth/gmail.metadata', limit, this.authority, this.now, signal);
    const seen = new Set<string>();
    const result: RawRadarCandidate[] = [];
    for (const row of rows) {
      const id = clean(row?.messageId, 128);
      const thread = clean(row?.threadId, 128);
      const subject = clean(row?.subject, 300);
      const sender = clean(row?.sender, 160);
      if (!id || !thread || seen.has(id) || !subject || !sender || !isGmailMessageUrl(row.url, id)
        || !Number.isSafeInteger(row.receivedAt) || row.receivedAt > this.now() + 300000) {
        throw new Error('PRIVATE_DISCOVERY_RESPONSE_INVALID');
      }
      seen.add(id);
      result.push(Object.freeze({
        source: 'gmail',
        externalId: id,
        title: subject,
        fact: `差出人: ${sender}`,
        url: row.url,
        publishedAt: row.receivedAt,
        metadata: Object.freeze(['重要・未読', '本文未取得']),
      }));
    }
    return Object.freeze(result);
  }
}
