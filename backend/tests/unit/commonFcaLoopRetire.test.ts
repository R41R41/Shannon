import { describe, expect, it } from 'vitest';
import { retirePrevious } from '../../src/services/minebot/integration/commonFca/createCommonFcaBody.js';

/** mb-arch: one control loop per server in a process; a newer connection's loop stops the one before it. */
const loop = () => {
  const made = { stopped: false, stops: 0, async stop() { made.stops += 1; made.stopped = true; return true; } };
  return made;
};

describe('one control loop per server (mb-arch)', () => {
  it('stops an earlier loop still open when a new one is made, and leaves a stopped one alone', () => {
    const first = loop(), second = loop(), third = loop();
    retirePrevious('retire-world', first);
    expect(first.stops).toBe(0);
    retirePrevious('retire-world', second);
    expect(first.stops).toBe(1);
    second.stopped = true;
    retirePrevious('retire-world', third);
    expect(second.stops).toBe(0);
    retirePrevious('other-world', loop());
    expect(third.stops).toBe(0);
  });
});