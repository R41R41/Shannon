/**
 * The dimension the body is in, kept right through a portal.
 *
 * mineflayer reads the dimension from the login and respawn packets by the number of its entry in the registry; a number it cannot find
 * leaves `bot.game.dimension` empty or as it was, and every line that asks "is this the Nether" (the observation's `dimension`, the water
 * that cannot be poured there, the goal's milestones) answers for the dimension before the gate. The server also names the world in the same
 * packet (`worldState.name`, "minecraft:the_nether"): when the name is there and differs, it is the dimension. `bot.dimensionChange`
 * remembers the last change, for the observation (seconds since).
 */
interface Packet { worldState?: { name?: unknown; dimension?: unknown; worldName?: unknown }; name?: unknown; dimension?: unknown; worldName?: unknown }
interface KeptBot {
  _client?: { on(event: string, listener: (packet: Packet) => void): unknown };
  game?: { dimension?: unknown };
  dimensionChange?: { to: string; at: number };
}

const clean = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim().replace(/^minecraft:/u, '') : null);

/** The dimension a login or respawn packet names, if it names one as text. */
export function dimensionOfPacket(packet: Packet): string | null {
  const state = packet?.worldState ?? packet;
  return clean(state?.name) ?? clean(state?.dimension) ?? clean(state?.worldName) ?? clean(packet?.dimension);
}

export function installDimensionKeeper(bot: KeptBot, now: () => number = Date.now): void {
  const client = bot._client;
  if (!client || typeof client.on !== 'function') return;
  const apply = (packet: Packet) => {
    const named = dimensionOfPacket(packet);
    if (!named) return;
    if (!bot.game) bot.game = {};
    const before = clean(bot.game.dimension);
    if (before !== named) bot.game.dimension = named;
    if (before !== named) bot.dimensionChange = { to: named, at: now() };
  };
  // After mineflayer's own handler (registered when the bot was made): what it left stands unless the packet names the world differently.
  client.on('login', apply);
  client.on('respawn', apply);
}
