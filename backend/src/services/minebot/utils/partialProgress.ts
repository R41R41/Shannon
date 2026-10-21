/**
 * A skill that did part of what it was asked (obsidian made 6 of 10, 3 of 4 when the lava ran out; ore mined 5 of 8) says so in a fixed way,
 * so that the API can tell a call that moved things on from one that got nowhere, and does not count it among the failures that stop a task
 * (run 23: obsidian 6, then 3, each "failed", and a task stopped for five failures with 9 of 10 made).
 *
 * The wire has only completed / failed / cancelled / unknown (contracts/minecraftControlContract.ts), so the kind is carried in the two
 * fields it already has:
 *   - `failureType: 'partial_completion'` with `success: false`, and only when at least one was made (nothing made is another code);
 *   - the result ends with `［進み: <what> <made>/<wanted>］` (this call's own count, `made` at least 1 and under `wanted`).
 */
export const PARTIAL_FAILURE = 'partial_completion';

export function progressTrailer(what: string, made: number, wanted: number): string {
  return `［進み: ${what} ${Math.max(0, Math.floor(made))}/${Math.floor(wanted)}］`;
}

/**
 * The progress a result states (the last trailer in it: a note of the body's own, such as a tool made on the way, may follow it), or null.
 * The API reads the same trailer.
 */
export function progressOf(text: string): { what: string; made: number; wanted: number } | null {
  const all = [...text.matchAll(/［進み: ([^\s/］]{1,60}) (\d{1,6})\/(\d{1,6})］/gu)];
  const match = all[all.length - 1];
  return match ? { what: match[1], made: Number(match[2]), wanted: Number(match[3]) } : null;
}
