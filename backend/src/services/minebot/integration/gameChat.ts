// Who spoke to the body in game chat. Shared by the lab run (scripts/minecraft-campaign-live-probe.ts) and the
// production bot's companion body mode (skillAgent.ts): the speaker is the sender UUID of a player chat packet,
// never a name parsed out of the text.

const ADDRESS = /^\s*(シャノン|しゃのん|shannon)/i;

/** A line of game chat meant for Shannon: it starts with her name. */
export function isAddressedToShannon(message: string | null | undefined): boolean {
  return ADDRESS.test(message ?? '');
}

/**
 * The fields of minecraft-protocol's client 'playerChat' event (src/client/chat.js) this reads. A real player
 * chat packet (player_chat) carries `sender`, the UUID the server says sent it, and `plainMessage`, what that
 * player typed. Disguised chat (profileless_chat: /say from a command block or the console) is emitted on the
 * same event without `sender`; system chat (system_chat) is a different event.
 */
export interface PlayerChatEvent {
  sender?: unknown;
  plainMessage?: unknown;
}

/** Who spoke in game chat and what they said: the UUID decides who it is, the name is only for display. */
export interface GameChatSpeaker {
  uuid: string;
  name: string;
  message: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A line of game chat with the server-attested sender, or null when there is none. Only player chat packets
 * name a sender; mineflayer's 'chat' event instead parses the rendered text of every chat and system message
 * with a pattern like `<name> text`, so whoever can make a message look like that (a server that sends player
 * chat as system chat, a nickname or chat plugin, a team name or prefix, disguised chat from /say) could speak
 * as someone else. The owner is told apart by UUID alone (CompanionBodyClient), so the speaker must come
 * from here. `nameOf` maps the UUID to the player's current name from the player list; a sender who is not in
 * the list is not answered. The message is what the player sent (`plainMessage`), never the server's decoration.
 */
export function gameChatSpeaker(event: PlayerChatEvent | null | undefined,
  nameOf: (uuid: string) => string | undefined): GameChatSpeaker | null {
  const sender = typeof event?.sender === 'string' ? event.sender.toLowerCase() : '';
  if (!UUID.test(sender) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(sender)) return null;
  const message = typeof event?.plainMessage === 'string' ? event.plainMessage : '';
  if (!message.trim()) return null;
  const name = nameOf(sender);
  if (!name) return null;
  return { uuid: sender, name, message };
}

/** The current name of the player with this UUID, from mineflayer's `bot.players` (keyed by name). */
export function playerNameByUuid(players: Record<string, { uuid?: unknown; username?: unknown } | undefined> | null | undefined,
  uuid: string): string | undefined {
  const wanted = uuid.toLowerCase();
  for (const [name, player] of Object.entries(players ?? {})) {
    if (typeof player?.uuid === 'string' && player.uuid.toLowerCase() === wanted) {
      return typeof player.username === 'string' && player.username ? player.username : name;
    }
  }
  return undefined;
}

/** The UUID of the player with this name, from the player list (for the UI mod, a trusted local client that sends a name). */
export function playerUuidByName(players: Record<string, { uuid?: unknown } | undefined> | null | undefined,
  name: string): string | undefined {
  const uuid = players?.[name]?.uuid;
  return typeof uuid === 'string' && UUID.test(uuid) ? uuid.toLowerCase() : undefined;
}

/** The parts of a mineflayer bot the game chat listener reads. */
export interface PlayerChatBot {
  username?: string;
  player?: { uuid?: unknown } | null;
  players?: Record<string, { uuid?: unknown; username?: unknown } | undefined> | null;
  _client: { on(event: 'playerChat', listener: (event: unknown) => void): unknown;
    removeListener(event: 'playerChat', listener: (event: unknown) => void): unknown };
}

/**
 * Listens to player chat packets only. `self` is true for the body's own lines (by UUID, or by name when the
 * body's own UUID is not known yet). System chat, disguised chat and any sender missing from the player list
 * never reach `onChat`. Returns the function that stops listening.
 */
export function listenToPlayerChat(bot: PlayerChatBot,
  onChat: (speaker: GameChatSpeaker & { self: boolean }) => void): () => void {
  const listener = (event: unknown) => {
    const heard = gameChatSpeaker(event as PlayerChatEvent, uuid => playerNameByUuid(bot.players, uuid));
    if (!heard) return;
    const selfUuid = typeof bot.player?.uuid === 'string' ? bot.player.uuid.toLowerCase() : '';
    onChat({ ...heard, self: selfUuid ? heard.uuid === selfUuid : heard.name === bot.username });
  };
  bot._client.on('playerChat', listener);
  return () => { bot._client.removeListener('playerChat', listener); };
}
