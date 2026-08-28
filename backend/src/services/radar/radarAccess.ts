import { createHash } from 'node:crypto';
import { requireCapability, type RequestContext } from '../../modules/access/index.js';

export class PersonalRadarError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'CONFLICT' | 'NOT_FOUND' | 'LIMIT' | 'UNAVAILABLE' | 'CANCELLED') { super(code); }
}
/** Server-owned callback: renew the same request's identity/authorization, never a body-supplied actor. */
export type ReauthorizeRadar = () => Promise<RequestContext>;
/** Only call with a server-verified AccessService context. Never accepts a browser's subject/audience/admin flag. */
export function personalRadarOwner(context: RequestContext, now = Date.now()): string {
  requireCapability(context, 'profile:read', now);
  if (!context.principal.projectId || !context.principal.uid) throw new PersonalRadarError('INVALID_INPUT');
  return 'firebase:' + createHash('sha256').update(JSON.stringify([context.principal.projectId, context.principal.uid])).digest('hex');
}
