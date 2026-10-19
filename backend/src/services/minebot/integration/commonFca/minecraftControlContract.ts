// Wire mirror of Shannon API contracts/minecraftControlContract.ts; update both sides together.
interface ActionLease { id: string; generation: number; holder: string }
import type { BodyActionReceipt, BodyCandidateDraft, BodyObservation, BodyOperation, BodyStopAcknowledgement, BodyStopRequest, BodyTaskContext } from './bodyControlContract.js';

/** Separate from the legacy game-chat/body request contract: no planner executes on this device. */
export const MINECRAFT_CONTROL_PATH = '/v1/body/minecraft/control';
export interface MinecraftSkillDefinition {
  name: string; description: string; inputSchema: Readonly<Record<string, unknown>>; readOnly: boolean;
  /** How long one run of the skill may take; the body runs it for min(this, the command's deadline). */
  maxDurationMs?: number;
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
  /** The skill's own failure kind and whether it said trying again could help (the API turns them into retry hints). */
  failureType?: string; recoverable?: boolean;
  action?: BodyActionReceipt; stop?: BodyStopAcknowledgement;
  /** Ephemeral pixels only: the companion stores an expiring reference, never this field in SQLite. */
  image?: { dataUrl: string; capturedAt: string };
}
/**
 * What changed in the body between polls, told while a command runs (session mb-arch, stage 1): a thing an unmet need wants came
 * into or went out of reach (`need.*`, subject = the need's id), and how the running command goes (`action.*`, subject = the
 * command's id): `action.progress` every few seconds, `action.stalled` once when its measure has not got better for a while.
 * The body only measures; whether to cut, queue or ignore is the API's. Numbered per connection; sent until acknowledged.
 */
export interface MinecraftBodyEvent {
  seq: number; at: string;
  kind: 'need.appeared' | 'need.gone' | 'action.progress' | 'action.stalled';
  subject: string;
  data: Readonly<Record<string, string | number | boolean | null>>;
}
export interface MinecraftControlPoll {
  schemaVersion: 1; serverId: string; connectionId: string;
  observation: BodyObservation; candidates: readonly BodyCandidateDraft[];
  /** Whole catalog on initial connection and changes. Not selected by a second game planner. */
  skills?: readonly MinecraftSkillDefinition[];
  receipts: readonly MinecraftControlReceipt[]; activeOperationIds: readonly string[];
  /** Oldest first, at most 32; absent while the API has not shown it reads them (an older API ignores the field). */
  events?: readonly MinecraftBodyEvent[];
}
export interface MinecraftControlReply {
  schemaVersion: 1; mode: 'common-fca';
  commands: readonly MinecraftControlCommand[]; cancel: readonly string[]; acknowledged: readonly string[];
  /** The highest event `seq` the API has taken; the body drops those. Absent from an API that does not read events. */
  eventsThrough?: number;
}
