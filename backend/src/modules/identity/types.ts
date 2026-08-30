export type IdentityChannelKind = 'web' | 'discord' | 'line' | 'minecraft' | 'radar';
export type BindingStatus = 'linked' | 'unlinked' | 'expired';

export interface ChannelBindingView {
  readonly channel: IdentityChannelKind;
  readonly status: BindingStatus;
  readonly label: string;
  readonly expiresAtIso?: string;
}

export interface AudiencePolicyView {
  readonly memoryChannels: readonly string[];
  readonly radarPersonalFeed: boolean;
  readonly lineDeliveryEnabled: boolean;
}

export interface IdentityStatusSnapshot {
  readonly identity: Readonly<{ projectId: string; uid: string; email: string; name: string }>;
  readonly bindings: readonly ChannelBindingView[];
  readonly audience: AudiencePolicyView;
}

export interface BindingManifestV1 {
  readonly version: 1;
  readonly projectId: string;
  readonly reviewedBy: string;
  readonly bindings: readonly Readonly<{
    readonly userId: string;
    readonly uid: string;
    readonly isAuthorized: boolean;
    readonly isAdmin: boolean;
  }>[];
}

export interface BindingManifestPlanSummary {
  readonly projectId: string;
  readonly reviewedBy: string;
  readonly operationCount: number;
  readonly unboundAfter: number;
  readonly sha256: string;
  readonly operations: readonly Readonly<{
    readonly userId: string;
    readonly email: string;
    readonly after: Readonly<{ firebaseProjectId: string; firebaseUid: string; isAuthorized: boolean; isAdmin: boolean }>;
  }>[];
}

export interface MigrationUserRecord {
  readonly _id: string;
  readonly email: string;
  readonly firebaseUid?: string | null;
  readonly firebaseProjectId?: string | null;
  readonly isAuthorized?: boolean;
  readonly isAdmin?: boolean;
}

export type BindingManifestPlanner = (
  users: readonly MigrationUserRecord[],
  manifest: BindingManifestV1,
) => BindingManifestPlanSummary;
