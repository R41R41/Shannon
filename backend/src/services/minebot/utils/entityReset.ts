/**
 * mineflayer 4.35 empties `bot.entities` on login only. A respawn packet (a portal to another dimension, a death) makes the vanilla client
 * throw its old level away, and with it every entity of it; the server does not send removals for them, so here they stayed in the list at
 * their old coordinates (lab: a lit creeper of the overworld set the floor reflex off in the End 24 to 26 times in a run). Every respawn
 * packet now drops the entities of the old level, the body's own kept; the server sends the new level's entities after it.
 */
interface ResetBody {
  entity?: { id?: number };
  entities?: Record<string, any>;
  emit(event: string, ...args: unknown[]): unknown;
  _client: { on(event: string, listener: (packet: unknown) => void): unknown };
  __entityReset?: boolean;
}

/** Drops every entity but the body's own; returns how many went. */
export function clearOtherEntities(bot: ResetBody): number {
  const entities = bot.entities;
  if (!entities) return 0;
  const selfId = bot.entity?.id;
  let dropped = 0;
  for (const key of Object.keys(entities)) {
    const entity = entities[key];
    if (!entity || (selfId !== undefined && entity.id === selfId) || entity === bot.entity) continue;
    delete entities[key];
    dropped++;
    try { bot.emit('entityGone', entity); } catch { /* a listener's failure does not keep the rest */ }
  }
  return dropped;
}

export function entityResetPlugin(bot: unknown): void {
  const body = bot as ResetBody;
  if (body.__entityReset) return;
  body.__entityReset = true;
  body._client.on('respawn', () => { try { clearOtherEntities(body); } catch { /* the list stays as it was */ } });
}
