/** Session-scoped Web console notification delivery helpers. */

export function shouldDeliverWebNotification(
  payload: { sessionId?: string },
  connectionSessionId?: string,
): boolean {
  if (!payload.sessionId) return false;
  if (!connectionSessionId) return false;
  return payload.sessionId === connectionSessionId;
}

/** System logs omit sessionId; conversation logs must match the bound console session. */
export function shouldDeliverWebLog(
  entry: { sessionId?: string },
  connectionSessionId?: string,
): boolean {
  if (!entry.sessionId) return true;
  if (!connectionSessionId) return false;
  return entry.sessionId === connectionSessionId;
}

export function webLogHistoryFilter(sessionId: string): Record<string, unknown> {
  return {
    $or: [
      { sessionId: { $exists: false } },
      { sessionId: null },
      { sessionId: '' },
      { sessionId },
    ],
  };
}
