import { CommonFcaControlLoop } from './controlLoop.js';
import { NativeCommonFcaBody } from './nativeBody.js';
import path from 'node:path';
import { createBodyImageCapture } from './imageCapture.js';

export function createCommonFcaBody(bot: any, settings: { url: string; serverId: string }, token: string,
  rendererDirectory?: string): CommonFcaControlLoop {
  const images = createBodyImageCapture(bot, { rendererDirectory });
  const actuator = new NativeCommonFcaBody(bot, { serverId: settings.serverId,
    capture: signal => images.capture(signal), disposeCapture: () => images.dispose(),
    rendererConfigured: () => images.configured });
  // The body is built before the bot spawns; the renderer needs the spawned world, so it starts on spawn. `bot.entity`
  // exists from the login packet already; health arrives with the same packet that emits 'spawn'.
  if (bot.entity && (bot.health ?? 0) > 0) images.prepare(); else bot.once('spawn', () => images.prepare());
  // Places the body has seen (a portal, a fortress, its base) are kept per world: the server's spawn point stands for
  // the world, so a regenerated one (another seed) starts with an empty memory. A Spot restart no longer forgets them.
  const persistPlaces = () => {
    const spawn = bot.spawnPoint;
    if (!spawn || typeof bot.placeMemory?.persistTo !== 'function') return;
    bot.placeMemory.persistTo(path.resolve('saves/minecraft/places', placesFile(settings.serverId, spawn)));
  };
  if (bot.spawnPoint) persistPlaces(); else bot.once('spawn', persistPlaces);
  const loop = new CommonFcaControlLoop({ baseUrl: settings.url, token, serverId: settings.serverId, actuator });
  const end = () => { void loop.stop(); };
  bot.once('end', end);
  return loop;
}

/** The place memory's file for a server and the world its spawn point stands for. */
export function placesFile(serverId: string, spawn: { x: number; y: number; z: number }): string {
  const id = String(serverId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return `${id}-spawn_${Math.floor(spawn.x)}_${Math.floor(spawn.y)}_${Math.floor(spawn.z)}.json`;
}
