import type { BindingManifestPlanner, BindingManifestPlanSummary, BindingManifestV1, MigrationUserRecord } from '../../modules/identity/index.js';
import { planBindings } from '../../../scripts/user-binding-migration.mjs';

function toSummary(plan: ReturnType<typeof planBindings>): BindingManifestPlanSummary {
  return Object.freeze({
    projectId: plan.projectId,
    reviewedBy: plan.reviewedBy,
    operationCount: plan.operations.length,
    unboundAfter: plan.unboundAfter,
    sha256: plan.sha256,
    operations: Object.freeze(plan.operations.map((operation) => Object.freeze({
      userId: operation.userId,
      email: operation.email,
      after: Object.freeze({
        firebaseProjectId: operation.after.firebaseProjectId,
        firebaseUid: operation.after.firebaseUid,
        isAuthorized: operation.after.isAuthorized,
        isAdmin: operation.after.isAdmin,
      }),
    }))),
  });
}

export const reviewedBindingManifestPlanner: BindingManifestPlanner = (
  users: readonly MigrationUserRecord[],
  manifest: BindingManifestV1,
): BindingManifestPlanSummary => toSummary(planBindings([...users], manifest));
