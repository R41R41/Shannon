/** Exclusive owner of the shared OpenAI Realtime API input channel. SDK-free registry. */

let ownerSessionId: string | undefined;

export function acquireWebRealtimeInput(sessionId: string): boolean {
  const trimmed = sessionId.trim();
  if (!trimmed) return false;
  if (ownerSessionId && ownerSessionId !== trimmed) return false;
  ownerSessionId = trimmed;
  return true;
}

export function releaseWebRealtimeInput(sessionId?: string): void {
  if (!sessionId || ownerSessionId === sessionId) ownerSessionId = undefined;
}

export function getWebRealtimeInputOwner(): string | undefined {
  return ownerSessionId;
}

export function clearWebRealtimeInputLockForTests(): void {
  ownerSessionId = undefined;
}

export function assertWebRealtimeInputOwner(sessionId?: string): boolean {
  if (!sessionId?.trim()) return false;
  return ownerSessionId === sessionId.trim();
}
