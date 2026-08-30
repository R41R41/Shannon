import type { Color, MemoryZone } from '@shannon/common';
import { getWebNotificationHub } from '../web/webNotificationHub.js';

export async function logToWeb(
  memoryZone: MemoryZone,
  color: Color,
  content: string,
  isSave = false,
  sessionId?: string,
): Promise<void> {
  await getWebNotificationHub().log(memoryZone, color, content, isSave, sessionId);
}
