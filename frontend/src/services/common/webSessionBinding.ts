export const WEB_BIND_SESSION_TYPE = 'web:bind-session' as const;

export function createWebBindSessionMessage(sessionId: string): string {
  return JSON.stringify({ type: WEB_BIND_SESSION_TYPE, sessionId });
}
