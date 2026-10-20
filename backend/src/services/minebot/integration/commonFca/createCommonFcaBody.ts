import { CommonFcaControlLoop, type CommonFcaObserver } from './controlLoop.js';
import { NativeCommonFcaBody } from './nativeBody.js';
import path from 'node:path';
import { createBodyImageCapture } from './imageCapture.js';
import { minecraftMemoryContext } from '../../runtime/memoryContext.js';
import { logger } from '../../../../utils/logger.js';

import { resolvePlacesWorldId, serverDirectory } from '../../../minecraft/freshWorld.js';

export function createCommonFcaBody(bot: any, settings: { url: string; serverId: string; serverName?: string }, token: string,
  rendererDirectory?: string, observer?: CommonFcaObserver): CommonFcaControlLoop {
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
  // A new world is named by the file `<server dir>/world-id` (written by a fresh-world start), which is read at every spawn so a
  // world made while this process lives is picked up without a restart. Priority: valid file, valid env, memory context.
  const persistPlaces = () => {
    const world = minecraftMemoryContext(bot);
    const serverDir = serverDirectory(settings.serverName ?? bot.connectedServerName);
    // A world-id file that exists but cannot be used would silently file a new world's places under the old name: say so.
    const worldId = resolvePlacesWorldId(serverDir, process.env.MINEBOT_PLACES_WORLD_ID, world?.worldId,
      reason => logger.warn(`world-id file in ${settings.serverName ?? bot.connectedServerName ?? 'the server directory'} is not usable (${reason}); falling back to MINEBOT_PLACES_WORLD_ID or the memory context's world id`));
    if (!worldId || typeof bot.placeMemory?.persistTo !== 'function') return;
    bot.placeMemory.persistTo(path.resolve('saves/minecraft/places', placesFile(world?.serverId ?? settings.serverId, worldId)));
  };
  if (bot.entity && (bot.health ?? 0) > 0) persistPlaces(); else bot.once('spawn', persistPlaces);
  const loop = new CommonFcaControlLoop({ baseUrl: settings.url, token, serverId: settings.serverId, actuator, observer });
  // Idle work (the idle pickup) asks this before it starts: a body with a command, an owner or a hold is not idle.
  bot.fcaLeaseHeld = () => loop.leaseHeld;
  const end = () => { void loop.stop(); };
  bot.once('end', end);
  retirePrevious(settings.serverId, loop);
  return loop;
}

/**
 * One control loop per server in a process. A body process kept from one run to the next (a practice ground on run 19's process,
 * 2026-10-20) can be logged in again; a loop of the earlier connection that is still polling would send its frames and its catalog
 * beside the new one, and the API would take each in turn (a step saw dig-block-at change under it: FCA_BODY_CATALOG_CHANGED). The
 * earlier loop is stopped when a new one is made, whether or not its bot said 'end'.
 */
const liveLoops = new Map<string, Pick<CommonFcaControlLoop, 'stopped' | 'stop'>>();
export function retirePrevious(serverId: string, loop: Pick<CommonFcaControlLoop, 'stopped' | 'stop'>): void {
  const previous = liveLoops.get(serverId);
  liveLoops.set(serverId, loop);
  if (!previous || previous === loop || previous.stopped) return;
  logger.warn(`common FCA: the control loop of an earlier connection to ${serverId} was still open; stopping it`);
  void previous.stop().catch(() => false);
}

/** The place memory's file for a named server and world. */
export function placesFile(serverId: string, worldId: string): string {
  const safe = (value: string) => String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return `${safe(serverId)}--${safe(worldId)}.json`;
}
