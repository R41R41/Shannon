import { actionSignal } from '../execution/ActionExecution.js';

/**
 * A placement the server refuses is not answered: nothing says "no". The library waits five seconds for the
 * block to change, and nothing can call that wait off. A cell with a mob standing in it is refused, so the
 * wait came exactly when a mob was on the body: paid run L77t was sealing a shaft over itself with a wither
 * skeleton at its shoulder, the emergency layer cancelled the shelter to strike back, and the body stood for
 * 3.3 seconds more inside that wait (the action could not end, so the next could not begin). It was struck
 * four times in them and struck back once.
 *
 * Here the wait is the body's own: it ends when the server answers, when the answer is overdue (a placement
 * the server takes is answered within a tick or two), or at once when the action it belongs to is cancelled.
 * The library's own wait is left to run out behind, harmlessly: it only listens.
 */
export const PLACE_ANSWER_MS = 1500;

interface PlacingBot {
  _placeBlockWithOptions?: (reference: unknown, face: unknown, options?: unknown) => Promise<void>;
  placeBlock?: (reference: unknown, face: unknown) => Promise<void>;
  promptPlace?: { unanswered: number; interrupted: number };
}

export function installPromptPlace(target: unknown, answerMs = PLACE_ANSWER_MS): void {
  const bot = target as PlacingBot;
  if (bot.promptPlace || typeof bot._placeBlockWithOptions !== 'function') return;
  const native = bot._placeBlockWithOptions.bind(bot);
  const state = bot.promptPlace = { unanswered: 0, interrupted: 0 };
  const place = (reference: unknown, face: unknown, options?: unknown): Promise<void> => {
    // The action this call belongs to, read now: the wait below is outside the call's own chain.
    const signal = actionSignal(bot as object);
    const pending = native(reference, face, options);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      const abort = () => { state.interrupted++; finish(new Error('Action interrupted')); };
      const timer = setTimeout(() => {
        state.unanswered++;
        finish(new Error(`No block has been placed : the server did not answer within ${answerMs}ms (something may be standing in that cell)`));
      }, answerMs);
      pending.then(() => finish(), error => finish(error));
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
  };
  bot._placeBlockWithOptions = place;
  bot.placeBlock = (reference, face) => place(reference, face, { swingArm: 'right' });
}

export function promptPlacePlugin(bot: unknown): void { installPromptPlace(bot); }
