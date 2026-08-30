import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireWebRealtimeInput,
  assertWebRealtimeInputOwner,
  clearWebRealtimeInputLockForTests,
  getWebRealtimeInputOwner,
  releaseWebRealtimeInput,
} from '../../src/services/web/webRealtimeInputLock.js';

afterEach(() => {
  clearWebRealtimeInputLockForTests();
});

describe('webRealtimeInputLock', () => {
  it('allows one active session and rejects concurrent owners', () => {
    expect(acquireWebRealtimeInput('session-a')).toBe(true);
    expect(getWebRealtimeInputOwner()).toBe('session-a');
    expect(acquireWebRealtimeInput('session-b')).toBe(false);
    expect(assertWebRealtimeInputOwner('session-a')).toBe(true);
    expect(assertWebRealtimeInputOwner('session-b')).toBe(false);
  });

  it('releases the lock for the owning session only', () => {
    acquireWebRealtimeInput('session-a');
    releaseWebRealtimeInput('session-b');
    expect(getWebRealtimeInputOwner()).toBe('session-a');
    releaseWebRealtimeInput('session-a');
    expect(getWebRealtimeInputOwner()).toBeUndefined();
    expect(acquireWebRealtimeInput('session-b')).toBe(true);
  });
});
