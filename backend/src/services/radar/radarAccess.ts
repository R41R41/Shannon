import { createHash } from 'node:crypto';
import { requireCapability, type RequestContext } from '../../modules/access/index.js';

export class PersonalRadarError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'CONFLICT' | 'NOT_FOUND' | 'LIMIT' | 'UNAVAILABLE' | 'CANCELLED' | 'FORBIDDEN') { super(code); }
}
/** Server-owned callback: renew the same request's identity/authorization, never a body-supplied actor. */
export interface LineRadarContext { readonly kind: 'line-radar'; readonly expiresAtMs: number }
export type RadarContext = RequestContext | LineRadarContext;
export type ReauthorizeRadar = () => Promise<RadarContext>;
const lineGrants = new WeakMap<LineRadarContext, string>();
export function firebasePersonalRadarOwner(projectId: string, uid: string): string {
  if (!projectId || !uid) throw new PersonalRadarError('INVALID_INPUT');
  return 'firebase:' + createHash('sha256').update(JSON.stringify([projectId, uid])).digest('hex');
}
/** Trusted server factory only. LINE ingress/worker must verify signed identity and durable consent first.
 * Opaque in-process grant: JSON copies cannot mint authority; it never impersonates a Firebase UID. */
export function issueLineRadarContext(botUserId: string, userId: string, expiresAtMs: number): LineRadarContext {
  if (!/^U[a-f0-9]{32}$/.test(botUserId) || !/^U[a-f0-9]{32}$/.test(userId) || botUserId === userId
    || !Number.isSafeInteger(expiresAtMs)) throw new PersonalRadarError('INVALID_INPUT');
  const context = Object.freeze({ kind: 'line-radar' as const, expiresAtMs });
  lineGrants.set(context, 'line:' + createHash('sha256').update(JSON.stringify([botUserId, userId])).digest('hex'));
  return context;
}
/** Only call with a server-verified AccessService context. Never accepts a browser's subject/audience/admin flag. */
export function personalRadarOwner(context: RadarContext, now = Date.now()): string {
  if ('kind' in context) {
    const owner = lineGrants.get(context);
    if (!owner || context.expiresAtMs <= now) throw new PersonalRadarError('UNAVAILABLE');
    return owner;
  }
  requireCapability(context, 'profile:read', now);
  return firebasePersonalRadarOwner(context.principal.projectId, context.principal.uid);
}
