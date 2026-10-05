import type { CampaignGoalGraph } from './CampaignGoalGraph.js';
import type { GoalVerifier } from './GoalVerifier.js';

/**
 * Re-check only the bounded visible frontier against the current native world.
 * A planner can leave an action pending after another branch supplied the same
 * resource, or after a segment restart. Neither needs another physical action
 * or a model claim of completion. Methods with native contracts must still
 * pass that contract; empty-contract methods derive proof only from children.
 */
export function reconcileCampaignReadyActions(
  campaign: CampaignGoalGraph,
  verifier: GoalVerifier,
  maxCandidates = 32,
): string[] {
  const verified: string[] = [];
  for (const node of campaign.projection(undefined, maxCandidates).ready) {
    if (node.kind === 'outcome' || !node.postconditions.length || !campaign.isActionable(node.id)) continue;
    const proof = verifier.verify({ goal: node.goal, predicates: node.postconditions });
    if (proof.status === 'verified'
      && campaign.recordProof(node.id, proof, `native:frontier:${proof.checkedAt}:${node.id}`)) verified.push(node.id);
  }
  return verified;
}
