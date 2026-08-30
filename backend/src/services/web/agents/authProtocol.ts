import { AccessError, AccessService } from '../../../modules/access/index.js';

/** Stateless protocol adapter; there is no email lookup or user-creation command. */
export async function handleAuthMessage(raw: string, access: AccessService): Promise<object> {
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    data = parsed as Record<string, unknown>;
  } catch { return { type: 'auth:response', success: false, error: 'INVALID_MESSAGE' }; }
  if (data.type === 'ping') return { type: 'pong' };
  if (data.type === 'auth:init') return { type: 'auth:init_response', success: false, error: 'REGISTRATION_DISABLED' };
  if (data.type !== 'auth:check') return { type: 'auth:response', success: false, error: 'INVALID_MESSAGE' };
  try {
    const context = await access.authenticate(data.idToken);
    return { type: 'auth:response', success: true, userData: {
      name: context.principal.name, email: context.principal.email,
      isAdmin: context.capabilities.includes('models:write'),
      uid: context.principal.uid,
      projectId: context.principal.projectId,
    } };
  } catch (error) {
    return { type: 'auth:response', success: false, error: error instanceof AccessError ? error.code : 'AUTH_UNAVAILABLE' };
  }
}
