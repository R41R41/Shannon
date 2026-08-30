import type { BindingManifestV1, MigrationUserRecord } from '../src/modules/identity/index.js';

export interface BindingManifestPlanOperation {
  userId: string;
  email: string;
  before: Record<string, unknown>;
  after: {
    firebaseProjectId: string;
    firebaseUid: string;
    isAuthorized: boolean;
    isAdmin: boolean;
  };
}

export interface BindingManifestPlan {
  version: 1;
  projectId: string;
  reviewedBy: string;
  operations: BindingManifestPlanOperation[];
  unboundAfter: number;
  sha256: string;
}

export function planBindings(
  users: MigrationUserRecord[],
  manifest: BindingManifestV1,
): BindingManifestPlan;

export function verifyIdentities(
  plan: BindingManifestPlan,
  getUser: (uid: string) => Promise<{ uid: string; email: string; emailVerified: boolean; disabled: boolean }>,
): Promise<void>;
