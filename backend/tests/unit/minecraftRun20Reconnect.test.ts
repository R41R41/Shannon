import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The client with everything around it replaced: what is under test is what it does when the connection ends.
const state = vi.hoisted(() => ({ bots: [] as any[], agents: [] as any[], stopCompanion: true }));
const noop = vi.hoisted(() => () => {});
vi.mock('../../src/config/env.js', () => ({ config: {} }));
vi.mock('../../src/services/minebot/runtime/memoryContext.js', () => ({ bindMinecraftMemory: noop, revokeMinecraftMemory: noop }));
vi.mock('minecrafthawkeye', () => ({ default: { default: noop } }));
vi.mock('mineflayer', () => ({
  default: {
    createBot: () => {
      const bot: any = new EventEmitter();
      Object.assign(bot, { loadPlugin: noop, quit: vi.fn(), _client: new EventEmitter(), version: '1.21.11', players: {},
        entity: { position: { x: 0, y: 64, z: 0 } }, pathfinder: { isMoving: () => false, isMining: () => false, isBuilding: () => false } });
      state.bots.push(bot);
      return bot;
    },
  },
}));
vi.mock('mineflayer-cmd', () => ({ plugin: noop }));
vi.mock('mineflayer-collectblock', () => ({ plugin: noop }));
vi.mock('mineflayer-projectile', () => ({ plugin: noop }));
vi.mock('mineflayer-pvp', () => ({ plugin: noop }));
vi.mock('mineflayer-tool', () => ({ plugin: noop }));
vi.mock('mineflayer-pathfinder', () => ({ pathfinder: noop, default: { goals: {} } }));
vi.mock('../../src/services/common/BaseClient.js', () => ({ BaseClient: class { status = 'running'; constructor(public serviceName: string) {} } }));
vi.mock('../../src/services/runtime/minebotLifecycleRegistry.js', () => ({ emitMinebotError: noop, emitMinebotSpawned: noop, emitMinebotStopped: noop }));
vi.mock('../../src/services/runtime/logging.js', () => ({ logToWeb: async () => {} }));
vi.mock('../../src/services/runtime/serviceCommandRegistry.js', () => ({ registerServiceCommandHandler: noop }));
vi.mock('../../src/services/web/webNotificationHub.js', () => ({ emitWebServiceStatus: noop }));
vi.mock('../../src/services/minebot/config/MinebotConfig.js', () => ({
  CONFIG: { validateEnvironment: noop, MINECRAFT_BOT_USER_NAME: 'I_am_Shannon', MINECRAFT_BOT_PASSWORD: '', MINECRAFT_SERVERS: { 'shannon-home': 25565 },
    serverVersion: () => '1.21.11', getMemoryIdentity: () => ({}), companionBodyFor: () => null, MINECRAFT_HOST: 'localhost', CHECK_TIMEOUT_INTERVAL: 120000,
    IS_DEV: true, setCurrentUiModBaseUrl: noop, UI_MOD_BASE_URL: '' },
}));
vi.mock('../../src/services/minebot/skillAgent.js', () => ({
  SkillAgent: class {
    http = { stop: vi.fn(async () => {}) };
    runtime = { forceStop: vi.fn() };
    constructor(public bot: any) { state.agents.push(this); }
    async startAgent() { return { success: true }; }
    async stopCompanionBody() { return state.stopCompanion; }
    getHttpServer() { return this.http; }
    getTaskRuntime() { return this.runtime; }
  },
}));
vi.mock('../../src/services/minebot/types.js', () => ({ ConstantSkills: class {}, InstantSkills: class {} }));
vi.mock('../../src/services/minebot/utils/index.js', () => ({ Utils: class { setMovements = noop; } }));
vi.mock('../../src/services/minebot/utils/playerLoadedHandshake.js', () => ({ installPlayerLoadedHandshake : noop }));
vi.mock('../../src/services/minebot/utils/registryRepairs.js', () => ({ installRegistryRepairs : noop }));
vi.mock('../../src/services/minebot/utils/airSupplyDefault.js', () => ({ installAirSupplyDefault : noop }));
vi.mock('../../src/services/minebot/utils/edgeGuard.js', () => ({ edgeGuardPlugin : noop }));
vi.mock('../../src/services/minebot/utils/breathingReflex.js', () => ({ breathingReflexPlugin : noop }));
vi.mock('../../src/services/minebot/utils/exertionMeter.js', () => ({ exertionMeterPlugin : noop }));
vi.mock('../../src/services/minebot/utils/threatTracker.js', () => ({ threatTrackerPlugin : noop }));
vi.mock('../../src/services/minebot/utils/toolWear.js', () => ({ toolWearPlugin : noop }));
vi.mock('../../src/services/minebot/utils/landmarks.js', () => ({ landmarkWatcherPlugin : noop }));
vi.mock('../../src/services/minebot/utils/placeMemory.js', () => ({ placeMemoryPlugin : noop }));
vi.mock('../../src/services/minebot/utils/floorLayer.js', () => ({ loadFloorLayer : noop }));
vi.mock('../../src/services/minebot/utils/fireballDeflect.js', () => ({ fireballDeflectPlugin : noop }));
vi.mock('../../src/services/minebot/utils/shieldBlock.js', () => ({ shieldBlockPlugin : noop }));
vi.mock('../../src/services/minebot/utils/knockBrace.js', () => ({ knockBracePlugin : noop }));
vi.mock('../../src/services/minebot/utils/digConfirmation.js', () => ({ digConfirmationPlugin : noop }));
vi.mock('../../src/services/minebot/utils/serverRefusals.js', () => ({ serverRefusalPlugin : noop }));
vi.mock('../../src/services/minebot/utils/lavaSafety.js', () => ({ lavaDigGuardPlugin : noop, lavaReflexPlugin : noop }));
vi.mock('../../src/services/minebot/utils/gazeGuard.js', () => ({ gazeGuardPlugin : noop }));
vi.mock('../../src/services/minebot/utils/exposureGuard.js', () => ({ exposureDigGuardPlugin : noop }));
vi.mock('../../src/services/minebot/utils/promptPlace.js', () => ({ promptPlacePlugin : noop }));
vi.mock('../../src/services/minebot/utils/collisionTolerance.js', () => ({ installCollisionTolerance : noop }));
vi.mock('../../src/services/minebot/utils/motionRecorder.js', () => ({ installMotionRecorder : noop }));
vi.mock('../../src/services/minebot/utils/toolChoice.js', () => ({ installToolChoice : noop }));

import { MinebotClient } from '../../src/services/minebot/client.js';

async function loggedIn(client: any) {
  const started = client.startBot({ serviceCommand: 'start', serverName: 'shannon-home' });
  await vi.advanceTimersByTimeAsync(1_200);
  expect(await started).toBe(true);
}

describe('run 20: the body goes back in by itself when the connection ended without anyone stopping it', () => {
  beforeEach(() => { vi.useFakeTimers(); state.bots.length = 0; state.agents.length = 0; state.stopCompanion = true; });
  afterEach(() => { vi.useRealTimers(); });

  it('a kick for silence (disconnect.timeout) is answered by a new login after eight seconds', async () => {
    const client: any = new (MinebotClient as any)('minebot', false);
    await loggedIn(client);
    expect(state.bots).toHaveLength(1);
    state.bots[0].emit('kicked', JSON.stringify({ translate: 'disconnect.timeout' }));
    state.bots[0].emit('end', 'socketClosed');
    await vi.advanceTimersByTimeAsync(7_000);
    expect(state.bots).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.bots).toHaveLength(2);
    expect(state.agents).toHaveLength(2);
    expect(client.bot).toBe(state.bots[1]);
    expect(client.lifecycleState().phase).not.toBe('absent');
  });

  it('a connection that closed with no kick is answered the same way; a kick that says the body is not wanted is not', async () => {
    const client: any = new (MinebotClient as any)('minebot', false);
    await loggedIn(client);
    state.bots[0].emit('end', 'socketClosed');
    await vi.advanceTimersByTimeAsync(11_000);
    expect(state.bots).toHaveLength(2);
    state.bots[1].emit('kicked', JSON.stringify({ translate: 'multiplayer.disconnect.banned' }));
    state.bots[1].emit('end', 'socketClosed');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(state.bots).toHaveLength(2);
  });

  it('a stop that could not be confirmed on the dead connection does not keep the new login out', async () => {
    const client: any = new (MinebotClient as any)('minebot', false);
    await loggedIn(client);
    state.stopCompanion = false;
    state.bots[0].emit('end', 'read ECONNRESET');
    await vi.advanceTimersByTimeAsync(12_000);
    expect(state.bots).toHaveLength(2);
    expect(state.agents[0].http.stop).toHaveBeenCalled();
    expect(state.agents[0].runtime.forceStop).toHaveBeenCalled();
  });

  it('does not go back in after the service\'s own stop, nor after the body\'s own quit', async () => {
    const client: any = new (MinebotClient as any)('minebot', false);
    await loggedIn(client);
    client.explicitlyDisconnected = true;
    state.bots[0].emit('end', 'socketClosed');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(state.bots).toHaveLength(1);
    const second: any = new (MinebotClient as any)('minebot', false);
    await loggedIn(second);
    state.bots[1].emit('end', 'disconnect.quitting');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(state.bots).toHaveLength(2);
  });

  it('gives up after five tries in a short time', async () => {
    const client: any = new (MinebotClient as any)('minebot', false);
    await loggedIn(client);
    for (let i = 0; i < 5; i++) {
      state.bots[i].emit('end', 'socketClosed');
      await vi.advanceTimersByTimeAsync(100_000);
    }
    expect(state.bots).toHaveLength(6);
    state.bots[5].emit('end', 'socketClosed');
    await vi.advanceTimersByTimeAsync(200_000);
    expect(state.bots).toHaveLength(6);
  });
});
