export interface ActionLease { id: string; holder: string; generation: number }

/** Always-on operator channel; independent of world-body presence and paid game planning. */
export const MINECRAFT_LIFECYCLE_PATH = '/v1/body/minecraft/lifecycle';
/** `set_day` (2026-10-14, owner): one fixed guarded `time set day`, refused while anyone else is in the world. */
export const MINECRAFT_LIFECYCLE_ACTIONS = ['start', 'stop', 'login', 'logout', 'set_day'] as const;
export type MinecraftLifecycleAction = typeof MINECRAFT_LIFECYCLE_ACTIONS[number];
export interface MinecraftLifecycleState {
  serverId: string; observedAt: string;
  running: 'running' | 'stopped' | 'unknown'; bot: 'joined' | 'absent' | 'unknown';
  /** Authoritative count after excluding only the configured bot's authenticated UUID. Null means unknown. */
  otherPlayers: number | null;
}
export interface MinecraftLifecycleAuthority {
  scopeKey: string; origin: 'owner_request' | 'own_time';
  /**
   * Original execution and provenance. The operator never makes up an authority: an operator-CLI command is an `owner_request` that the
   * API admitted under its own action and audit row (the same as a conversation's or the Ops page's), and a start follows the owner's
   * 「新しいワールドで始める」 switch unless `--keep-world` was given; her own time is `own_time`.
   */
  executionId: string; lease: ActionLease; sourceIds: readonly string[];
}
/**
 * Optional, `start` only. `freshWorld: true` (strictly the boolean true) asks for a new world before the start: the world
 * directory is moved aside (renamed, kept under another name, never deleted) and a new places-world id written, only if the
 * server is proven stopped and the command is the owner's own request (`authority.origin === 'owner_request'`; the operator's
 * path uses that origin too, her own time does not). Anything else (absent, another value, unknown keys, any other action) is an
 * ordinary command. The API attaches it only to a body whose polls advertise `capabilities: ['freshWorld']`.
 */
export interface MinecraftLifecycleOptions { freshWorld?: boolean }
export interface MinecraftLifecycleCommand {
  schemaVersion: 1; id: string; connectionId: string; serverId: string;
  action: MinecraftLifecycleAction; authority: MinecraftLifecycleAuthority; issuedAt: string; deadlineAt: string;
  options?: MinecraftLifecycleOptions;
}
/** True for a `start` that carries `options.freshWorld === true`. */
export function wantsFreshWorld(command: Pick<MinecraftLifecycleCommand, 'action' | 'options'>): boolean {
  return command.action === 'start' && !!command.options && typeof command.options === 'object' && command.options.freshWorld === true;
}
export interface MinecraftLifecycleReceipt {
  id: string; connectionId: string; serverId: string; action: MinecraftLifecycleAction;
  outcome: 'completed' | 'refused' | 'cancelled' | 'unknown';
  code: 'changed' | 'already_running' | 'already_stopped' | 'already_joined' | 'already_absent'
    | 'players_present' | 'state_unknown' | 'authority_revoked' | 'deadline' | 'error';
  observedAt: string; inputsReleased: boolean; state: MinecraftLifecycleState;
  /** Successful stop must be one atomic runtime decision under a join barrier, including a fresh player check. */
  stopGuard?: { admissionClosed: true; otherPlayers: 0; checkedAt: string };
  /**
   * Only on a `start` whose world was really prepared (`options.freshWorld`): the new world's id, and the name (in the server
   * directory) the previous world was kept under, or null when there was no world directory. Receivers that predate these ignore them.
   */
  worldId?: string; movedTo?: string | null;
}
/** Poll `capabilities`: what this body can do beyond the base protocol. Unknown names are ignored by the receiver. */
export const LIFECYCLE_CAPABILITY_FRESH_WORLD = 'freshWorld';
export interface MinecraftLifecyclePoll {
  schemaVersion: 1; connectionId: string; sequence: number;
  states: readonly MinecraftLifecycleState[]; receipts: readonly MinecraftLifecycleReceipt[];
  /** Optional: absent from a body that predates it (then it has none). Sent in every poll, so the API knows the connected body's. */
  capabilities?: readonly string[];
}
export interface MinecraftLifecycleReply {
  schemaVersion: 1; commands: readonly MinecraftLifecycleCommand[]; cancel: readonly string[]; acknowledged: readonly string[];
}
export interface MinecraftLifecycleRequest {
  id: string; serverId: string; action: MinecraftLifecycleAction; authority: MinecraftLifecycleAuthority;
}
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u.test(v);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fresh = (v: unknown, now: number): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && now - Date.parse(v) >= -1000 && now - Date.parse(v) <= 3000;
const recorded = (v: unknown, now: number): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && Date.parse(v) <= now + 1000;
export function validLifecycleState(v: unknown, now: number, historical = false): v is MinecraftLifecycleState {
  return record(v) && id(v.serverId) && (historical ? recorded(v.observedAt, now) : fresh(v.observedAt, now)) && ['running', 'stopped', 'unknown'].includes(String(v.running))
    && ['joined', 'absent', 'unknown'].includes(String(v.bot))
    && (v.otherPlayers === null || Number.isSafeInteger(v.otherPlayers) && Number(v.otherPlayers) >= 0 && Number(v.otherPlayers) <= 10000);
}
/** The shapes the API accepts for a receipt's `worldId` and `movedTo` (the same patterns, `minecraftLifecycleContract.ts` of the API). */
export const RECEIPT_WORLD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const RECEIPT_MOVED_TO = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
/**
 * A receipt as it may be sent: a `worldId` or `movedTo` that does not match what the API accepts is left out (the receipt itself is
 * kept), so one odd value can never make the API refuse the whole poll. The same receipt comes back unchanged when both are fine.
 */
export function sendableReceipt<T extends Pick<MinecraftLifecycleReceipt, 'worldId' | 'movedTo'>>(receipt: T): T {
  const badId = receipt.worldId !== undefined && !(typeof receipt.worldId === 'string' && RECEIPT_WORLD_ID.test(receipt.worldId));
  const badMoved = receipt.movedTo !== undefined && receipt.movedTo !== null && !(typeof receipt.movedTo === 'string' && RECEIPT_MOVED_TO.test(receipt.movedTo));
  if (!badId && !badMoved) return receipt;
  const { worldId, movedTo, ...rest } = receipt;
  return { ...rest, ...(badId ? {} : worldId !== undefined ? { worldId } : {}), ...(badMoved ? {} : movedTo !== undefined ? { movedTo } : {}) } as T;
}
export function validLifecyclePoll(v: unknown, now: number): v is MinecraftLifecyclePoll {
  return record(v) && v.schemaVersion === 1 && id(v.connectionId) && Number.isSafeInteger(v.sequence) && Number(v.sequence) >= 0
    && Array.isArray(v.states) && v.states.length >= 1 && v.states.length <= 16 && v.states.every(s => validLifecycleState(s, now))
    && new Set(v.states.map(s => s.serverId)).size === v.states.length
    && Array.isArray(v.receipts) && v.receipts.length <= 16 && v.receipts.every(r => record(r) && id(r.id) && id(r.connectionId)
      && id(r.serverId) && MINECRAFT_LIFECYCLE_ACTIONS.includes(r.action as MinecraftLifecycleAction)
      && ['completed', 'refused', 'cancelled', 'unknown'].includes(String(r.outcome))
      && ['changed', 'already_running', 'already_stopped', 'already_joined', 'already_absent', 'players_present', 'state_unknown', 'authority_revoked', 'deadline', 'error'].includes(String(r.code))
      && typeof r.inputsReleased === 'boolean' && recorded(r.observedAt, now) && validLifecycleState(r.state, now, true)
      && (r.stopGuard === undefined || record(r.stopGuard) && r.stopGuard.admissionClosed === true && r.stopGuard.otherPlayers === 0 && recorded(r.stopGuard.checkedAt, now))
      && (r.worldId === undefined || typeof r.worldId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(r.worldId))
      && (r.movedTo === undefined || r.movedTo === null || typeof r.movedTo === 'string' && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(r.movedTo)))
    && (v.capabilities === undefined || Array.isArray(v.capabilities) && v.capabilities.length <= 64);
}
/** The capability names a poll advertises: only well-formed strings count, anything else is ignored (never a reason to refuse the poll). */
export function lifecycleCapabilities(poll: Pick<MinecraftLifecyclePoll, 'capabilities'> | null | undefined): ReadonlySet<string> {
  const names = Array.isArray(poll?.capabilities) ? poll.capabilities : [];
  return new Set(names.filter((name): name is string => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(name)));
}
