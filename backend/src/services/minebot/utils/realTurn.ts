/**
 * A real turn of the event loop (setImmediate), not a microtask. A loop that only awaits promises that are already settled (a skill
 * calling a skill that refuses at once) never lets a timer fire: no abort, no time-out, no keep-alive, no Discord heartbeat. Run 22
 * held the process at 100% CPU for 200 s that way. Loops that may go round without real I/O await this once a round.
 *
 * Taken from node:timers, not the global: a test's fake timers replace the global and would never let it resolve.
 */
import { setImmediate as nativeSetImmediate } from 'node:timers';

export function realTurn(): Promise<void> {
  return new Promise(resolve => nativeSetImmediate(resolve));
}
