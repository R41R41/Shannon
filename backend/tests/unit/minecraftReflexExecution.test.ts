import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { executeDirectReflex } from '../../src/services/minebot/cognition/DirectReflexExecutor.js';
import { captureWorldObservation } from '../../src/services/minebot/cognition/worldFrame.js';
import { currentAction, executeAction } from '../../src/services/minebot/execution/ActionExecution.js';
import { EventReactionSystem } from '../../src/services/minebot/eventReaction/EventReactionSystem.js';
const fixture = (): any => Object.assign(new EventEmitter(), { entity: { position: new Vec3(0, 64, 0), isInWater: true },
  health: 20, food: 20, oxygenLevel: 5, game: { dimension: 'overworld' }, inventory: { items: () => [] }, entities: {},
  executingSkill: false, interruptExecution: false, pathfinder: { stop: vi.fn(), setGoal: vi.fn() }, clearControlStates: vi.fn(),
  instantSkills: { getSkill: () => undefined, getSkills: () => [] }, constantSkills: { getSkills: () => [], getSkill: () => undefined } });
const decision = (): any => ({ id: 'reflex', eventType: 'suffocation', evaluatedAt: new Date().toISOString(), source: 'jev',
  shouldPreemptProbability: 0.99, immediateAction: 'SURFACE', urgency: 'CRITICAL', confidence: 0.99, capabilityAvailable: true,
  confidenceKind: 'provider_distribution', decisionEvidence: { choice: 'SURFACE', providerConfidence: 0.99, probabilities: { SURFACE: 1 } } });
describe('bounded direct reflex and planner handoff', () => {
  it('invokes forced surfacing through owned execution, not generated arguments', async () => {
    const bot = fixture(); const run = vi.fn(async (force: boolean) => { expect(force).toBe(true); expect(currentAction(bot)?.physical).toBe(true); bot.oxygenLevel = 20; });
    bot.constantSkills.getSkill = () => ({ status: true, run });
    expect((await executeDirectReflex(bot, decision(), captureWorldObservation(bot), Date.now())).applied).toBe(true);
    expect(run).toHaveBeenCalledOnce(); expect(bot.executingSkill).toBe(false);
  });
  it.each(['expired', 'changed', 'disabled', 'self_reported', 'flat', 'stale'])('rejects %s reflex evidence before any motor call', async kind => {
    const bot = fixture(); const run = vi.fn(async () => {}); bot.constantSkills.getSkill = () => ({ status: kind !== 'disabled', run });
    const world = captureWorldObservation(bot); const value = decision();
    if (kind === 'changed') bot.health = 2;
    if (kind === 'self_reported') { value.source = 'openai'; value.confidenceKind = 'self_reported'; }
    if (kind === 'flat') value.decisionEvidence.probabilities.SURFACE = 0.14;
    if (kind === 'stale') value.stale = true;
    const result = await executeDirectReflex(bot, value, world, Date.now() - (kind === 'expired' ? 2000 : 0));
    expect(result.applied).toBe(false); expect(run).not.toHaveBeenCalled();
  });
  it('keeps containment during planner queries, then hands off before physical movement', async () => {
    const bot = fixture(); bot.entity.isInWater = false;
    bot.entities = { 2: { id: 2, name: 'zombie', position: new Vec3(7, 64, 0) } };
    bot.instantSkills.getSkill = (name: string) => ['get-position', 'flee-from'].includes(name) ? {} : undefined;
    let system: any;
    const runtime: any = { isReady: () => true, isInEmergencyMode: () => false, isRunning: () => true,
      interruptForEmergency: async () => { await new Promise(resolve => setTimeout(resolve, 5)); }, setEmergencyTask: vi.fn(),
      invoke: async (input: any) => {
        input.onToolStarting('recall-memory'); expect(system.fleeController?.signal.aborted).toBe(false);
        input.onToolStarting('get-position'); expect(system.fleeController?.signal.aborted).toBe(false);
        input.onToolStarting('flee-from', { target: 'hostile' }); expect(system.fleeController).toBeNull();
        const result = await executeAction(bot, 'flee-from', 1000, async () => {
          expect(currentAction(bot)?.progress.capability).toBe('flee-from'); return { success: true, result: 'moved' };
        }); expect(result.success).toBe(true);
        bot.entities = {};
      }, resumePreviousTask: vi.fn(async () => {}) };
    system = new EventReactionSystem(bot, runtime); system.reflexPolicy = null;
    try {
      const result = await system.handleEmergencyEvent({ timestamp: Date.now(), eventType: 'hostile_approach',
        threatLevel: 'critical', mobType: 'zombie', mobCount: 1,
        allHostiles: [{ mobType: 'zombie', distance: 7 }] });
      expect(result.handled).toBe(true); expect(runtime.resumePreviousTask).toHaveBeenCalledOnce();
    } finally { system.destroy(); }
  });
});
