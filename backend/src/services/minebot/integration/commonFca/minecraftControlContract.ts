// Wire mirror of Shannon API contracts/minecraftControlContract.ts; update both sides together.
interface ActionLease { id: string; generation: number; holder: string }
import type { BodyActionReceipt, BodyCandidateDraft, BodyObservation, BodyOperation, BodyStopAcknowledgement, BodyStopRequest, BodyTaskContext } from './bodyControlContract.js';

/** Separate from the legacy game-chat/body request contract: no planner executes on this device. */
export const MINECRAFT_CONTROL_PATH = '/v1/body/minecraft/control';
export interface MinecraftSkillDefinition {
  name: string; description: string; inputSchema: Readonly<Record<string, unknown>>; readOnly: boolean;
}
export interface MinecraftControlCommand {
  schemaVersion: 1; id: string; serverId: string; connectionId: string;
  kind: 'skill' | 'reflex' | 'stop' | 'release' | 'capture';
  context: BodyTaskContext; lease: ActionLease; deadlineAt: string;
  skill?: string; arguments?: Readonly<Record<string, unknown>>;
  operation?: BodyOperation; stop?: BodyStopRequest;
}
export interface MinecraftControlReceipt {
  id: string; connectionId: string; outcome: 'completed' | 'failed' | 'cancelled' | 'unknown';
  inputsReleased: boolean; observedAt: string; result?: string;
  action?: BodyActionReceipt; stop?: BodyStopAcknowledgement;
  /** Ephemeral pixels only: the companion stores an expiring reference, never this field in SQLite. */
  image?: { dataUrl: string; capturedAt: string };
}
export interface MinecraftControlPoll {
  schemaVersion: 1; serverId: string; connectionId: string;
  observation: BodyObservation; candidates: readonly BodyCandidateDraft[];
  /** Whole catalog on initial connection and changes. Not selected by a second game planner. */
  skills?: readonly MinecraftSkillDefinition[];
  receipts: readonly MinecraftControlReceipt[]; activeOperationIds: readonly string[];
}
export interface MinecraftControlReply {
  schemaVersion: 1; mode: 'common-fca';
  commands: readonly MinecraftControlCommand[]; cancel: readonly string[]; acknowledged: readonly string[];
}
