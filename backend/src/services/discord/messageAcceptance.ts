export interface DesignatedDiscordChannel {
  guildId: string | null;
  channelId: string | null;
}

export interface DiscordMessageAcceptanceInput {
  guildId: string | null;
  parentChannelId: string;
  isBotMentioned: boolean;
  designatedChannels: readonly DesignatedDiscordChannel[];
}

/**
 * Keeps each configured conversation channel open for ordinary messages while
 * allowing an explicit bot mention to start the same flow elsewhere in that guild.
 */
export function acceptsDiscordMessage({
  guildId,
  parentChannelId,
  isBotMentioned,
  designatedChannels,
}: DiscordMessageAcceptanceInput): boolean {
  const designatedChannel = designatedChannels.find(
    (entry) => Boolean(entry.guildId) && entry.guildId === guildId,
  );

  if (!designatedChannel) return true;

  return parentChannelId === designatedChannel.channelId || isBotMentioned;
}
