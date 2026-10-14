import { CommonFcaControlLoop } from './controlLoop.js';
import { NativeCommonFcaBody } from './nativeBody.js';
import path from 'node:path';
import { createBodyImageCapture } from './imageCapture.js';
import { minecraftMemoryContext } from '../../runtime/memoryContext.js';

const WORLD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function createCommonFcaBody(bot: any, settings: { url: string; serverId: string }, token: string,
  rendererDirectory?: string): CommonFcaControlLoop {
  const images = createBodyImageCapture(bot, { rendererDirectory });
  const actuator = new NativeCommonFcaBody(bot, { serverId: settings.serverId,
    capture: signal => images.capture(signal), disposeCapture: () => images.dispose(),
    rendererConfigured: () => images.configured });
  // The body is built before the bot spawns; the renderer needs the spawned world, so it starts on spawn. `bot.entity`
  // exists from the login packet already; health arrives with the same packet that emits 'spawn'.
  if (bot.entity && (bot.health ?? 0) > 0) images.prepare(); else bot.once('spawn', () => images.prepare());
  // Places the body has seen (a portal, a fortress, its base) are kept per world, so a Spot restart no longer forgets
  // them. Only for a world the operator has named, with a new name whenever the world is reset: the protocol cannot
  // tell a reset world from the old one, and a spawn point is not an identity. MINEBOT_PLACES_WORLD_ID names it for
  // the places alone; the full memory identity (MINECRAFT_MEMORY_IDENTITIES) also turns on query caching and world
  // stores keyed by server only, which the API-driven body does not want.
  const persistPlaces = () => {
    const placesWorld = process.env.MINEBOT_PLACES_WORLD_ID?.trim();
    const world = minecraftMemoryContext(bot);
    const worldId = placesWorld && WORLD_ID.test(placesWorld) ? placesWorld : world?.worldId;
    if (!worldId || typeof bot.placeMemory?.persistTo !== 'function') return;
    bot.placeMemory.persistTo(path.resolve('saves/minecraft/places', placesFile(world?.serverId ?? settings.serverId, worldId)));
  };
  if (bot.entity && (bot.health ?? 0) > 0) persistPlaces(); else bot.once('spawn', persistPlaces);
  const loop = new CommonFcaControlLoop({ baseUrl: settings.url, token, serverId: settings.serverId, actuator });
  const end = () => { void loop.stop(); };
  bot.once('end', end);
  return loop;
}

/** The place memory's file for a named server and world. */
export function placesFile(serverId: string, worldId: string): string {
  const safe = (value: string) => String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return `${safe(serverId)}--${safe(worldId)}.json`;
}
