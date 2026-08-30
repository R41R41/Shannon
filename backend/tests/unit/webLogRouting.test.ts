import { describe, expect, it } from 'vitest';
import { shouldDeliverWebLog, webLogHistoryFilter } from '../../src/services/web/webNotificationBridge.js';

describe('shouldDeliverWebLog', () => {
  it('delivers system logs without sessionId to every connection', () => {
    expect(shouldDeliverWebLog({}, 'session-a')).toBe(true);
    expect(shouldDeliverWebLog({}, undefined)).toBe(true);
  });

  it('delivers conversation logs only to the bound session', () => {
    expect(shouldDeliverWebLog({ sessionId: 'session-a' }, 'session-a')).toBe(true);
    expect(shouldDeliverWebLog({ sessionId: 'session-a' }, 'session-b')).toBe(false);
    expect(shouldDeliverWebLog({ sessionId: 'session-a' }, undefined)).toBe(false);
  });
});

describe('webLogHistoryFilter', () => {
  it('includes system logs and the requested session only', () => {
    expect(webLogHistoryFilter('session-a')).toEqual({
      $or: [
        { sessionId: { $exists: false } },
        { sessionId: null },
        { sessionId: '' },
        { sessionId: 'session-a' },
      ],
    });
  });
});
