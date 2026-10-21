/**
 * How the body came to stand where it stands: the first arrival of a connection (`login`), the arrival of a body that went back in by itself
 * after the connection dropped (`reconnect`), after a death (`respawn`), through a portal (`portal`).
 *
 * Run 24, in the Nether: the connection dropped for silence and the body went back in 12 s later at the place it had been; the mind took the
 * arrival for a respawn after a death and had a shelter dug, on magma (three escapes from the lava, 10 s). The mineflayer events cannot
 * tell them apart ('respawn' and 'spawn' come for all of them); the body knows, so it says: world.arrival, for two minutes.
 */
export type ArrivalKind = 'login' | 'reconnect' | 'respawn' | 'portal';
export interface Arrival { kind: ArrivalKind; at: number }

interface NotedBot {
  on(event: string, listener: (...args: any[]) => void): unknown;
  arrival?: Arrival;
}

export function installArrivalNote(bot: NotedBot, first: 'login' | 'reconnect', now: () => number = Date.now): void {
  let died = false;
  let spawns = 0;
  bot.arrival = { kind: first, at: now() };
  bot.on('death', () => { died = true; });
  bot.on('spawn', () => {
    spawns++;
    if (died) { died = false; bot.arrival = { kind: 'respawn', at: now() }; return; }
    // The first spawn of the connection is the arrival already noted (its time is the spawn's); a later one with no death is a dimension change.
    if (spawns === 1) bot.arrival = { kind: first, at: now() };
    else bot.arrival = { kind: 'portal', at: now() };
  });
}
