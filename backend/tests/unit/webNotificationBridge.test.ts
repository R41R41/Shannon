import { describe, expect, it } from 'vitest';
import { shouldDeliverWebLog, shouldDeliverWebNotification } from '../../src/services/web/webNotificationBridge.js';

describe('shouldDeliverWebNotification', () => {
  it('drops session-scoped payloads without a sessionId', () => {
    expect(shouldDeliverWebNotification({}, 'session-a')).toBe(false);
    expect(shouldDeliverWebNotification({}, undefined)).toBe(false);
  });

  it('delivers scoped payloads only to the bound session', () => {
    expect(shouldDeliverWebNotification({ sessionId: 'session-a' }, 'session-a')).toBe(true);
    expect(shouldDeliverWebNotification({ sessionId: 'session-a' }, 'session-b')).toBe(false);
    expect(shouldDeliverWebNotification({ sessionId: 'session-a' }, undefined)).toBe(false);
  });
});

describe('shouldDeliverWebLog', () => {
  it('delivers system logs without sessionId to every connection', () => {
    expect(shouldDeliverWebLog({}, 'session-a')).toBe(true);
    expect(shouldDeliverWebLog({}, undefined)).toBe(true);
  });

  it('delivers conversation logs only to the bound session', () => {
    expect(shouldDeliverWebLog({ sessionId: 'session-a' }, 'session-a')).toBe(true);
    expect(shouldDeliverWebLog({ sessionId: 'session-a' }, 'session-b')).toBe(false);
  });
});
