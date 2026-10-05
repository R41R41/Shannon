import { describe, expect, it, vi } from 'vitest';
import { installPromptPlace } from '../../src/services/minebot/utils/promptPlace.js';
import { cancelNonSurvivalActions, executeAction } from '../../src/services/minebot/execution/ActionExecution.js';

/** A body whose library waits `nativeMs` for the server to answer a placement, as mineflayer does (five seconds when refused). */
function body(nativeMs: number, outcome: 'placed' | 'refused' = 'placed') {
  const bot: any = { placed: 0, clearControlStates() {}, stopDigging() {}, deactivateItem() {}, pathfinder: { stop() {}, setGoal() {} } };
  bot._placeBlockWithOptions = () => new Promise<void>((resolve, reject) => setTimeout(() => {
    if (outcome === 'placed') { bot.placed++; resolve(); } else reject(new Error('No block has been placed : the block is still air'));
  }, nativeMs));
  bot.placeBlock = (reference: unknown, face: unknown) => bot._placeBlockWithOptions(reference, face);
  return bot;
}

describe('a placement the server does not answer does not hold the body (paid run L77t stood 3.3 seconds inside one, struck four times)', () => {
  it('passes a placement the server takes straight through, and a refusal the library reports', async () => {
    const taken = body(20);
    installPromptPlace(taken, 200);
    await expect(taken.placeBlock({}, {})).resolves.toBeUndefined();
    expect(taken.placed).toBe(1);
    const refused = body(20, 'refused');
    installPromptPlace(refused, 200);
    await expect(refused._placeBlockWithOptions({}, {}, {})).rejects.toThrow('still air');
    expect(refused.promptPlace).toEqual({ unanswered: 0, interrupted: 0 });
  });

  it('gives up on an answer that is overdue, long before the library does', async () => {
    const bot = body(5000, 'refused');
    installPromptPlace(bot, 120);
    const began = Date.now();
    await expect(bot.placeBlock({}, {})).rejects.toThrow('did not answer');
    expect(Date.now() - began).toBeLessThan(600);
    expect(bot.promptPlace.unanswered).toBe(1);
  });

  it('lets go at once when the action it belongs to is cancelled, so that the next action can begin', async () => {
    const bot = body(5000, 'refused');
    installPromptPlace(bot, 3000);
    let seenError = '';
    const sealing = executeAction(bot, 'dig-shelter', 20_000, async () => {
      try { await bot.placeBlock({}, {}); } catch (error) { seenError = String(error); throw error; }
      return { success: true, result: 'sealed' };
    }, { waitForQuiescence: true });
    await new Promise(resolve => setTimeout(resolve, 80));
    const cancelledAt = Date.now();
    cancelNonSurvivalActions(bot, 'emergency_counterattack');
    let nextStartedAt = 0;
    await executeAction(bot, 'attack-nearest', 5000, async () => { nextStartedAt = Date.now(); return { success: true, result: 'struck' }; }, { priority: 200, waitForQuiescence: true });
    expect(nextStartedAt - cancelledAt).toBeLessThan(300);
    expect((await sealing).failureType).toBe('interrupted');
    expect(seenError).toContain('Action interrupted');
    expect(bot.promptPlace.interrupted).toBe(1);
  });

  it('is put on once', () => {
    const bot = body(10);
    installPromptPlace(bot);
    const wrapped = bot.placeBlock;
    installPromptPlace(bot);
    expect(bot.placeBlock).toBe(wrapped);
    vi.useRealTimers();
  });
});
