/** Active Discord voice run scoped to one guild/text channel/user. SDK-free registry. */

export interface DiscordVoiceSession {
  readonly guildId: string;
  readonly textChannelId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly expiresAt: number;
}

const sessions = new Map<string, DiscordVoiceSession>();

export function registerDiscordVoiceSession(session: DiscordVoiceSession): void {
  if (!session.guildId || !session.textChannelId || !session.userId || !session.requestId) {
    throw new Error('DISCORD_VOICE_SESSION_INVALID');
  }
  sessions.set(session.textChannelId, session);
}

export function clearDiscordVoiceSession(textChannelId: string, requestId?: string): void {
  const current = sessions.get(textChannelId);
  if (!current) return;
  if (requestId && current.requestId !== requestId) return;
  sessions.delete(textChannelId);
}

export function getDiscordVoiceSession(textChannelId: string, now = Date.now()): DiscordVoiceSession | undefined {
  const current = sessions.get(textChannelId);
  if (!current) return undefined;
  if (current.expiresAt <= now) {
    sessions.delete(textChannelId);
    return undefined;
  }
  return current;
}

export function authorizeDiscordVoiceOutbound(
  input: { guildId: string; channelId: string },
  now = Date.now(),
): DiscordVoiceSession | undefined {
  const session = getDiscordVoiceSession(input.channelId, now);
  if (!session || session.guildId !== input.guildId) return undefined;
  return session;
}

export function clearDiscordVoiceSessionsForTests(): void {
  sessions.clear();
}
