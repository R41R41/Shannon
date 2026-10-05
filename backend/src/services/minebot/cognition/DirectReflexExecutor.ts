import { executeAction, withActionSignal } from '../execution/ActionExecution.js';
import type { ReflexDecision, WorldObservation } from './types.js';
import { captureWorldObservation } from './worldFrame.js';
import { supportsControl } from './decisionEvidence.js';
import type { SkillResult } from '../types/skillParams.js';
export interface ReflexMotorBot {
  executingSkill: boolean;
  interruptExecution: boolean;
  constantSkills: { getSkill(name: string): { status: boolean; run(...args: any[]): Promise<void> } | undefined };
  instantSkills: { getSkill(name: string): { run(...args: any[]): Promise<SkillResult> } | undefined };
}

export function reflexFactsDigest(world: WorldObservation): string {
  return JSON.stringify([world.dimension, world.health, world.food, world.oxygen, world.isInWater, world.activeEffects,
    (world.nearbyThreats ?? world.nearbyEntities.filter(entity => entity.kind === 'hostile')).map(entity => [entity.name, Math.floor(entity.distance)]), world.inventory]);
}

/** No generated arguments, commands, target identifiers or arbitrary tool dispatch. */
export async function executeDirectReflex(bot: ReflexMotorBot, decision: ReflexDecision, observed: WorldObservation, requestedAt: number): Promise<{ applied: boolean; reason: string }> {
  if (decision.source !== 'jev' || decision.stale || decision.confidenceKind !== 'provider_distribution' || !decision.decisionEvidence
    || !Number.isFinite(decision.confidence) || decision.confidence < 0.66 || !supportsControl(decision.decisionEvidence)
    || !decision.capabilityAvailable || !Number.isFinite(decision.shouldPreemptProbability) || decision.shouldPreemptProbability < 0.66) return { applied: false, reason: 'insufficient_evidence' };
  if (Date.now() - requestedAt > 1500 || reflexFactsDigest(observed) !== reflexFactsDigest(captureWorldObservation(bot))) return { applied: false, reason: 'stale' };
  const action = decision.immediateAction;
  const capability = action === 'SURFACE' ? 'auto-swim' : action === 'EAT' ? 'auto-eat' : action === 'STOP_MOVEMENT' ? 'stop-movement' : null;
  // Composite multi-threat FLEE uses the existing owned containment, not a
  // single arbitrary nearest-target command. Shelter needs an implemented catalog entry.
  if (!capability) return { applied: false, reason: action === 'FLEE' ? 'owned_flee_containment' : 'requires_planner' };
  const constant = bot.constantSkills.getSkill(capability);
  const instant = bot.instantSkills.getSkill(capability);
  if ((!constant || !constant.status) && !instant) return { applied: false, reason: 'capability_unavailable' };
  const result = await withActionSignal(bot, undefined, () => executeAction(bot, capability, 5000, async () => {
    if (Date.now() - requestedAt > 1500 || reflexFactsDigest(observed) !== reflexFactsDigest(captureWorldObservation(bot))) return { success: false, result: 'stale' };
    if (constant?.status) await constant.run(...(action === 'SURFACE' ? [true] : []));
    else if (instant) return instant.run();
    return { success: true, result: capability };
  }, { priority: 150 }));
  return { applied: result.success, reason: result.result };
}
