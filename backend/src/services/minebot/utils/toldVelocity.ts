import { Vec3 } from 'vec3';

/**
 * The speed the server told of an entity, in blocks a tick.
 *
 * The client library's own `entity.velocity` cannot be used for this on 1.21.9 and later: there the server
 * sends a speed in blocks a tick, and the library still divides it by 8000 as it did when speeds came as
 * whole numbers, so an arrow leaving a bow at 1.6 is held as 0.0002. (Before the fix in
 * patches/minecraft-protocol the number was noise as well: the bytes were read in the wrong order.) A reflex
 * that has half a second to meet an arrow needs the speed from the one packet that says it, when the arrow is
 * shot. This keeps what the packets said, untouched.
 *
 * The library's value is left as it is: the body's own knockback goes through it, and that is a change of its
 * own.
 */
interface TellingBot {
  _client?: { on(event: string, listener: (packet: any) => void): unknown };
  on?(event: string, listener: (...args: any[]) => void): unknown;
  toldVelocities?: Map<number, Vec3>;
}

const NOTCH_UNITS = 8000;

export function installToldVelocity(bot: TellingBot): void {
  if (bot.toldVelocities || typeof bot._client?.on !== 'function') return;
  const told = bot.toldVelocities = new Map<number, Vec3>();
  const note = (packet: any) => {
    if (typeof packet?.entityId !== 'number') return;
    const velocity = packet.velocity && typeof packet.velocity.x === 'number' ? new Vec3(packet.velocity.x, packet.velocity.y, packet.velocity.z)
      : typeof packet.velocityX === 'number' ? new Vec3(packet.velocityX / NOTCH_UNITS, packet.velocityY / NOTCH_UNITS, packet.velocityZ / NOTCH_UNITS) : null;
    if (velocity) told.set(packet.entityId, velocity);
  };
  bot._client!.on('spawn_entity', note);
  bot._client!.on('entity_velocity', note);
  bot.on?.('entityGone', (entity: { id?: number }) => { if (typeof entity?.id === 'number') told.delete(entity.id); });
}

/** What the server last said of this entity's speed, or null when it has said nothing. */
export function toldVelocity(bot: TellingBot, entityId: number): Vec3 | null {
  return bot.toldVelocities?.get(entityId) ?? null;
}
