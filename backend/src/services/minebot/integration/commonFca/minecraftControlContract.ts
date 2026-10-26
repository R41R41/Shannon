// Wire mirror of Shannon API contracts/minecraftControlContract.ts; update both sides together.
interface ActionLease { id: string; generation: number; holder: string }
import type { LiveRoom, LiveSpeechItem, LiveSpeechReceipt } from '../../../common/liveSpeech.js';
import type { BodyActionReceipt, BodyCandidateDraft, BodyObservation, BodyOperation, BodyStopAcknowledgement, BodyStopRequest, BodyTaskContext } from './bodyControlContract.js';

/** Separate from the legacy game-chat/body request contract: no planner executes on this device. */
export const MINECRAFT_CONTROL_PATH = '/v1/body/minecraft/control';
export interface MinecraftSkillDefinition {
  name: string; description: string; inputSchema: Readonly<Record<string, unknown>>; readOnly: boolean;
  /** How long one run of the skill may take; the body runs it for min(this, the command's deadline). */
  maxDurationMs?: number;
}
/**
 * The task queue's envelope of an `act` command (the head's `tq/contract.md` section 2): the item's id, the item that must precede it, the plan node
 * it is for, the condition checked once right before it starts (`ActCondition`, `utils/actConditions.ts`), its own run limit counted from its
 * start, and the time it must have started by. A command without it runs as before.
 */
export interface MinecraftQueueEnvelope {
  item: string; after: string | null; node: string | null; pre?: unknown; maxMs: number; startBy: string;
}
export interface MinecraftControlCommand {
  schemaVersion: 1; id: string; serverId: string; connectionId: string;
  kind: 'skill' | 'reflex' | 'stop' | 'release' | 'capture';
  context: BodyTaskContext; lease: ActionLease; deadlineAt: string;
  skill?: string; arguments?: Readonly<Record<string, unknown>>;
  operation?: BodyOperation; stop?: BodyStopRequest;
  queue?: MinecraftQueueEnvelope;
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
  kind: 'need.appeared' | 'need.gone' | 'action.progress' | 'action.stalled' | 'furnace.done';
  subject: string;
  data: Readonly<Record<string, string | number | boolean | null>>;
}
export interface MinecraftQueueProgress { id: string; hand: number; of: number; iteration: number; repeat: number }
export interface MinecraftControlPoll {
  schemaVersion: 1; serverId: string; connectionId: string;
  observation: BodyObservation; candidates: readonly BodyCandidateDraft[];
  /** Whole catalog on initial connection and changes. Not selected by a second game planner. */
  skills?: readonly MinecraftSkillDefinition[];
  receipts: readonly MinecraftControlReceipt[]; activeOperationIds: readonly string[];
  /** The ids of the queue's waiting items, in order (task queue); absent from an older body. */
  queuedOperationIds?: readonly string[];
  /** How far the running queue item is: the hand of its pass, the pass of its repeat (task queue). */
  queue?: MinecraftQueueProgress;
  /** Oldest first, at most 32; absent while the API has not shown it reads them (an older API ignores the field). */
  events?: readonly MinecraftBodyEvent[];
  /** What the body did with the live lines it was handed, and the room it plays in; only when a Discord sink is registered (session dc-live). */
  speechReceipts?: readonly LiveSpeechReceipt[];
  liveRoom?: LiveRoom;
}
export interface MinecraftControlReply {
  schemaVersion: 1; mode: 'common-fca';
  commands: readonly MinecraftControlCommand[]; cancel: readonly string[]; acknowledged: readonly string[];
  /** The highest event `seq` the API has taken; the body drops those. Absent from an API that does not read events. */
  eventsThrough?: number;
  /** A line of hers for the room (at most one at a time), while the API's SHANNON_MINECRAFT_LIVE_SPEECH is on. An older body ignores it. */
  speech?: readonly LiveSpeechItem[];
}
