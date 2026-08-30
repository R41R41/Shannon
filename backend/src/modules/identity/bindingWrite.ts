import type { RequestContext } from '../access/index.js';
import type { AudiencePolicyView, BindingStatus, ChannelBindingView, IdentityChannelKind, IdentityStatusSnapshot } from './types.js';

export type WritableChannelKind = Exclude<IdentityChannelKind, 'web'>;

export interface StoredChannelBinding {
  readonly externalId: string;
  readonly label: string;
  readonly linkedAtIso: string;
  readonly expiresAtIso?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface IdentityProfileRecord {
  readonly firebaseProjectId: string;
  readonly firebaseUid: string;
  readonly bindings: Readonly<Partial<Record<WritableChannelKind, StoredChannelBinding>>>;
  readonly audience: AudiencePolicyView;
  readonly revision: number;
}

export interface IdentityProfileRepository {
  find(context: RequestContext): Promise<IdentityProfileRecord | null>;
  save(context: RequestContext, profile: IdentityProfileRecord): Promise<IdentityProfileRecord>;
}

export const ALLOWED_MEMORY_CHANNELS = Object.freeze(['discord_text', 'web'] as const);
export type AllowedMemoryChannel = (typeof ALLOWED_MEMORY_CHANNELS)[number];

export interface LinkBindingInput {
  readonly confirm: true;
  readonly discordUserId?: string;
  readonly lineUserId?: string;
  readonly serverId?: string;
  readonly worldId?: string;
  readonly playerUuid?: string;
}

export interface UnlinkBindingInput {
  readonly confirm: true;
}

export interface AudienceUpdateInput {
  readonly confirm: true;
  readonly memoryChannels: readonly string[];
  readonly lineDeliveryEnabled: boolean;
  readonly radarPersonalFeed: boolean;
}

export class IdentityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityInputError';
  }
}

const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\s/.test(value);

const discordSnowflake = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{17,20}$/.test(value);

const lineUserId = (value: unknown): value is string =>
  typeof value === 'string' && /^U[a-f0-9]{32}$/i.test(value);

const worldId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) && !['default', 'unknown'].includes(value);

const assignedServerId = (value: unknown): value is string =>
  typeof value === 'string' && /^(dev|prod):[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);

const playerUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function parseWritableChannel(raw: unknown): WritableChannelKind {
  if (raw === 'discord' || raw === 'line' || raw === 'minecraft' || raw === 'radar') return raw;
  throw new IdentityInputError('INVALID_CHANNEL');
}

export function requireExplicitConfirm(raw: unknown): true {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new IdentityInputError('CONFIRM_REQUIRED');
  if ((raw as { confirm?: unknown }).confirm !== true) throw new IdentityInputError('CONFIRM_REQUIRED');
  return true;
}

export function parseLinkBindingInput(channel: WritableChannelKind, raw: unknown): LinkBindingInput {
  requireExplicitConfirm(raw);
  const body = raw as Record<string, unknown>;
  if (channel === 'discord') {
    if (!discordSnowflake(body.discordUserId)) throw new IdentityInputError('INVALID_DISCORD_USER_ID');
    return { confirm: true, discordUserId: body.discordUserId };
  }
  if (channel === 'line') {
    if (!lineUserId(body.lineUserId)) throw new IdentityInputError('INVALID_LINE_USER_ID');
    return { confirm: true, lineUserId: body.lineUserId };
  }
  if (channel === 'minecraft') {
    if (!assignedServerId(body.serverId) || !worldId(body.worldId)) throw new IdentityInputError('INVALID_MINECRAFT_BINDING');
    if (body.playerUuid !== undefined && body.playerUuid !== '' && !playerUuid(body.playerUuid)) {
      throw new IdentityInputError('INVALID_MINECRAFT_PLAYER_UUID');
    }
    return {
      confirm: true,
      serverId: body.serverId,
      worldId: body.worldId,
      playerUuid: typeof body.playerUuid === 'string' && body.playerUuid ? body.playerUuid : undefined,
    };
  }
  return { confirm: true };
}

export function parseAudienceUpdateInput(raw: unknown): AudienceUpdateInput {
  requireExplicitConfirm(raw);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new IdentityInputError('INVALID_AUDIENCE');
  const body = raw as Record<string, unknown>;
  if (!Array.isArray(body.memoryChannels) || typeof body.lineDeliveryEnabled !== 'boolean' || typeof body.radarPersonalFeed !== 'boolean') {
    throw new IdentityInputError('INVALID_AUDIENCE');
  }
  const memoryChannels = [...new Set(body.memoryChannels.map(String))];
  if (memoryChannels.some((channel) => !(ALLOWED_MEMORY_CHANNELS as readonly string[]).includes(channel))) {
    throw new IdentityInputError('INVALID_MEMORY_CHANNEL');
  }
  return Object.freeze({
    confirm: true,
    memoryChannels: Object.freeze(memoryChannels),
    lineDeliveryEnabled: body.lineDeliveryEnabled,
    radarPersonalFeed: body.radarPersonalFeed,
  });
}

export function defaultAudience(): AudiencePolicyView {
  return Object.freeze({
    memoryChannels: Object.freeze(['discord_text', 'web']),
    lineDeliveryEnabled: false,
    radarPersonalFeed: false,
  });
}

export function emptyProfile(context: RequestContext): IdentityProfileRecord {
  return Object.freeze({
    firebaseProjectId: context.principal.projectId,
    firebaseUid: context.principal.uid,
    bindings: Object.freeze({}),
    audience: defaultAudience(),
    revision: 0,
  });
}

function bindingStatus(stored: StoredChannelBinding | undefined, nowMs: number): BindingStatus {
  if (!stored) return 'unlinked';
  if (stored.expiresAtIso && Date.parse(stored.expiresAtIso) <= nowMs) return 'expired';
  return 'linked';
}

function maskExternalId(channel: WritableChannelKind, externalId: string): string {
  if (channel === 'discord') return externalId;
  if (externalId.length <= 8) return externalId;
  return `${externalId.slice(0, 4)}…${externalId.slice(-4)}`;
}

export function buildIdentityStatus(context: RequestContext, profile: IdentityProfileRecord | null, nowMs: number): IdentityStatusSnapshot {
  const stored = profile?.bindings ?? {};
  const audience = profile?.audience ?? defaultAudience();
  const bindingView = (channel: WritableChannelKind, fallback: string): ChannelBindingView => {
    const row = stored[channel];
    const status = bindingStatus(row, nowMs);
    const label = status === 'linked'
      ? row!.label
      : status === 'expired'
        ? `${fallback}: 期限切れ`
        : fallback;
    return Object.freeze({
      channel,
      status,
      label,
      expiresAtIso: row?.expiresAtIso,
    });
  };
  return Object.freeze({
    identity: Object.freeze({
      projectId: context.principal.projectId,
      uid: context.principal.uid,
      email: context.principal.email,
      name: context.principal.name,
    }),
    bindings: Object.freeze([
      Object.freeze({ channel: 'web', status: 'linked', label: 'Firebase ログイン' }),
      bindingView('discord', 'Discord 未連携'),
      bindingView('line', 'LINE 未連携'),
      bindingView('minecraft', 'Minecraft 未連携'),
      bindingView('radar', 'Radar 未連携'),
    ] satisfies ChannelBindingView[]),
    audience: Object.freeze({
      memoryChannels: Object.freeze([...audience.memoryChannels]),
      lineDeliveryEnabled: audience.lineDeliveryEnabled,
      radarPersonalFeed: audience.radarPersonalFeed,
    }),
  });
}

export function storedBindingForLink(
  channel: WritableChannelKind,
  input: LinkBindingInput,
  context: RequestContext,
  linkedAtIso: string,
): StoredChannelBinding {
  if (channel === 'discord') {
    return Object.freeze({
      externalId: input.discordUserId!,
      label: `Discord ${input.discordUserId}`,
      linkedAtIso,
    });
  }
  if (channel === 'line') {
    return Object.freeze({
      externalId: input.lineUserId!,
      label: `LINE ${maskExternalId('line', input.lineUserId!)}`,
      linkedAtIso,
    });
  }
  if (channel === 'minecraft') {
    const externalId = `${input.serverId}:${input.worldId}`;
    const metadata = input.playerUuid ? Object.freeze({ playerUuid: input.playerUuid }) : undefined;
    return Object.freeze({
      externalId,
      label: `Minecraft ${input.serverId}/${input.worldId}`,
      linkedAtIso,
      metadata,
    });
  }
  const externalId = `firebase:${context.principal.projectId}:${context.principal.uid}`;
  return Object.freeze({
    externalId,
    label: 'Radar owner（Firebase UID）',
    linkedAtIso,
  });
}

export function mergeProfileAfterLink(
  profile: IdentityProfileRecord,
  channel: WritableChannelKind,
  binding: StoredChannelBinding,
): IdentityProfileRecord {
  return Object.freeze({
    ...profile,
    bindings: Object.freeze({ ...profile.bindings, [channel]: binding }),
    revision: profile.revision + 1,
  });
}

export function mergeProfileAfterUnlink(
  profile: IdentityProfileRecord,
  channel: WritableChannelKind,
): IdentityProfileRecord {
  const next = { ...profile.bindings };
  delete next[channel];
  return Object.freeze({
    ...profile,
    bindings: Object.freeze(next),
    revision: profile.revision + 1,
  });
}

export function mergeProfileAfterAudience(
  profile: IdentityProfileRecord,
  audience: AudienceUpdateInput,
): IdentityProfileRecord {
  return Object.freeze({
    ...profile,
    audience: Object.freeze({
      memoryChannels: Object.freeze([...audience.memoryChannels]),
      lineDeliveryEnabled: audience.lineDeliveryEnabled,
      radarPersonalFeed: audience.radarPersonalFeed,
    }),
    revision: profile.revision + 1,
  });
}
