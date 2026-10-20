/**
 * dc-voice: VoiceManager keeps the legacy voice path byte-for-byte when the head does not serve the VC, and only
 * takes the new per-person path when SHANNON_DC_VOICE is on, the head is configured, the conversation is bound and
 * the voice mode is not 'minebot'. The Discord client and connection are fakes.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createShannonCoreVoiceClient } from '../../src/services/integration/shannonCoreVoiceClient.js';
import { FakeReceiver, fakeStt, sleep, waitFor } from '../helpers/dcVoiceFakes.js';

const hoisted = vi.hoisted(() => ({
  config: {
    dcVoice: { enabled: false, openMic: true, mouth: true, backchannel: false },
    shannonCoreBridge: {},
    groq: {},
  },
  deliver: vi.fn(),
  configuredClient: { value: null as unknown },
}));

vi.mock('../../src/config/env.js', () => ({ config: hoisted.config }));
vi.mock('../../src/utils/logger.js', () => {
  const noop = () => undefined;
  const named = { info: noop, warn: noop, error: noop, debug: noop, success: noop };
  return { createLogger: () => named, logger: named };
});
vi.mock('../../src/utils/discord.js', () => ({ getDiscordMemoryZone: async () => 'zone' }));
vi.mock('../../src/services/discord/utils.js', () => ({ sendLongMessage: async () => undefined }));
vi.mock('../../src/services/discord/voiceFiller.js', () => ({ loadFillers: async () => false, generateAllFillers: async () => 0 }));
vi.mock('../../src/services/runtime/llmInboundDispatch.js', () => ({ deliverDiscordMessageToLlm: hoisted.deliver }));
vi.mock('../../src/services/runtime/minebotInboundRegistry.js', () => ({ dispatchMinebotVoiceChat: () => undefined }));
vi.mock('../../src/services/voicepeak/client.js', () => ({ VoicepeakClient: { getInstance: () => ({ synthesize: async () => Buffer.alloc(0) }) } }));
vi.mock('../../src/services/llm/voice/dcVoiceStt.js', () => ({ createDcVoiceStt: () => fakeSttForManager }));
vi.mock('../../src/services/integration/configuredShannonCoreVoiceClient.js', () => ({
  getConfiguredShannonCoreVoiceClient: async () => hoisted.configuredClient.value,
}));

const fakeSttForManager = fakeStt({ 1: 'こんにちは' });

const configuration = {
  url: 'http://127.0.0.1:4319/v1/platform/turns',
  token: 'a'.repeat(32),
  bindingsJson: JSON.stringify([{ platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: '7' }]),
  timeoutMs: 3_000,
};

type Manager = import('../../src/services/discord/voice/VoiceManager.js').VoiceManager;
let manager: Manager;
let VoiceManagerClass: typeof import('../../src/services/discord/voice/VoiceManager.js').VoiceManager;

beforeAll(async () => {
  ({ VoiceManager: VoiceManagerClass } = await import('../../src/services/discord/voice/VoiceManager.js'));
  const client = { users: { cache: new Map() }, guilds: { cache: new Map() }, channels: { cache: new Map() } };
  manager = new VoiceManagerClass(client as never, {
    getUserNickname: (user: { id: string }) => `nick-${user.id}`,
    shouldSkipGuild: () => false,
    getRecentMessages: async () => [],
  } as never);
  vi.spyOn(manager, 'decodeOpusBuffers').mockImplementation((packets: Buffer[]) => Buffer.alloc(packets.length * 3_840, 0));
});

afterEach(() => {
  hoisted.config.dcVoice = { enabled: false, openMic: true, mouth: true, backchannel: false };
  hoisted.configuredClient.value = null;
  hoisted.deliver.mockClear();
});

/** Fake AudioPlayer the manager's playback code can attach to. */
function fakeAudioPlayer() {
  const player = new EventEmitter() as EventEmitter & { play: () => void; stop: () => boolean };
  player.play = () => undefined;
  player.stop = () => true;
  return player;
}

function connect(guildId: string, textChannelId = '201') {
  const receiver = new FakeReceiver();
  const connection = { receiver, joinConfig: { channelId: 'v1' }, state: { status: 'ready' }, on: vi.fn(), destroy: vi.fn() };
  const internals = manager as unknown as {
    voiceConnections: Map<string, unknown>;
    audioPlayers: Map<string, unknown>;
    activeVoiceUsers: Map<string, string | null>;
    dcSessions: Map<string, unknown>;
  };
  internals.voiceConnections.set(guildId, connection);
  internals.audioPlayers.set(guildId, fakeAudioPlayer());
  internals.activeVoiceUsers.set(guildId, null);
  manager.setupVoiceReceiver(connection as never, guildId, textChannelId);
  return { receiver, connection, internals, ptt: (userId: string | null) => internals.activeVoiceUsers.set(guildId, userId) };
}

const speakTo = (receiver: FakeReceiver, userId: string, packets = 40) => {
  receiver.speak(userId);
  receiver.feed(userId, packets, 1);
  receiver.quiet(userId);
  receiver.end(userId);
};

describe('VoiceManager: switch off = the legacy path, unchanged', () => {
  it('listens only to the push-to-talk person, waits 1000 ms of silence, and hands the WAV to the old pipeline', async () => {
    const c = connect('g-off');
    await sleep(20);
    expect(c.internals.dcSessions.has('g-off')).toBe(false);
    c.ptt('u1');

    c.receiver.speak('u2'); // not the PTT person
    expect(c.receiver.subscriptions).toHaveLength(0);

    speakTo(c.receiver, 'u1');
    expect(c.receiver.subscriptions).toHaveLength(1);
    expect(c.receiver.subscriptions[0]!.options.end).toEqual({ behavior: 1, duration: 1_000 }); // EndBehaviorType.AfterSilence
    expect(hoisted.deliver).not.toHaveBeenCalled(); // the old extra 300 ms wait is still there
    await waitFor(() => hoisted.deliver.mock.calls.length === 1, 2_000, 'the old pipeline');
    expect(hoisted.deliver.mock.calls[0]![0]).toMatchObject({
      type: 'voice', text: '', guildId: 'g-off', channelId: '201', voiceChannelId: 'v1', userId: 'u1', userName: 'Unknown',
    });
    expect((hoisted.deliver.mock.calls[0]![0] as { audioBuffer: Buffer }).audioBuffer.length).toBeGreaterThan(44);
    expect(manager.getActiveSpeakers('g-off')).toEqual([]);
  });

  it('is the same when the switch is on but the conversation is not bound to the head', async () => {
    hoisted.config.dcVoice = { enabled: true, openMic: true, mouth: true, backchannel: false };
    hoisted.configuredClient.value = createShannonCoreVoiceClient(configuration);
    const c = connect('999', '300'); // discord:999:300 does not match discord:111:
    await sleep(30);
    expect(c.internals.dcSessions.has('999')).toBe(false);
    c.ptt('u1');
    speakTo(c.receiver, 'u1');
    expect(c.receiver.subscriptions[0]!.options.end.duration).toBe(1_000);
    await waitFor(() => hoisted.deliver.mock.calls.length === 1, 2_000, 'the old pipeline');
  });

  it('is the same when the switch is on but the head URL / token are not configured', async () => {
    hoisted.config.dcVoice = { enabled: true, openMic: true, mouth: true, backchannel: false };
    hoisted.configuredClient.value = null;
    const c = connect('888', '300');
    await sleep(30);
    expect(c.internals.dcSessions.has('888')).toBe(false);
    c.ptt('u1');
    speakTo(c.receiver, 'u1');
    await waitFor(() => hoisted.deliver.mock.calls.length === 1, 2_000, 'the old pipeline');
  });
});

describe('VoiceManager: served by the head', () => {
  function enable(extra: Partial<typeof hoisted.config.dcVoice> = {}) {
    hoisted.config.dcVoice = { enabled: true, openMic: true, mouth: false, backchannel: false, ...extra };
    hoisted.configuredClient.value = createShannonCoreVoiceClient(configuration);
  }

  it('hears everybody person by person with 600 ms of silence, and the legacy receiver stays out of it', async () => {
    enable();
    const c = connect('111', '201'); // discord:111:201 is bound
    await waitFor(() => c.internals.dcSessions.has('111'), 1_000, 'the new session');

    c.receiver.speak('u2'); // nobody pressed push-to-talk
    c.receiver.speak('u3');
    expect(c.receiver.subscriptions.map(s => [s.userId, s.options.end.duration])).toEqual([['u2', 600], ['u3', 600]]);
    expect(manager.getActiveSpeakers('111').sort()).toEqual(['u2', 'u3']);

    c.ptt('u2');
    c.receiver.quiet('u2');
    c.receiver.feed('u2', 40, 1);
    c.receiver.end('u2');
    await sleep(400);
    expect(hoisted.deliver).not.toHaveBeenCalled(); // the old pipeline got nothing
  });

  it('push-to-talk mode on a bound VC: only the pressed person is transcribed', async () => {
    enable({ openMic: false });
    const c = connect('111', '202');
    await waitFor(() => c.internals.dcSessions.has('111'), 1_000, 'the new session');
    c.receiver.speak('u3');
    expect(c.receiver.subscriptions).toHaveLength(0);
    c.ptt('u2');
    c.receiver.speak('u2');
    expect(c.receiver.subscriptions.map(s => s.userId)).toEqual(['u2']);
    expect(manager.getActiveSpeakers('111').sort()).toEqual(['u2', 'u3']); // everybody is still tracked
  });

  it('goes back to the legacy receiver while the voice mode is minebot', async () => {
    enable();
    const c = connect('111', '203');
    await waitFor(() => c.internals.dcSessions.has('111'), 1_000, 'the new session');
    manager.handleVoiceModeCommand('111', 'minebot');
    c.ptt('u1');
    speakTo(c.receiver, 'u1');
    expect(c.receiver.subscriptions).toHaveLength(1);
    expect(c.receiver.subscriptions[0]!.options.end.duration).toBe(1_000);
    await waitFor(() => hoisted.deliver.mock.calls.length === 1, 2_000, 'the old pipeline');
    manager.handleVoiceModeCommand('111', 'chat');
  });

  it('a re-created connection (auto-rejoin after a restart) gets a fresh receiver attached', async () => {
    enable();
    const first = connect('111', '204');
    await waitFor(() => first.internals.dcSessions.has('111'), 1_000, 'the first session');
    const before = first.internals.dcSessions.get('111');
    const second = connect('111', '204'); // what autoRejoinVoice does on Ready
    await waitFor(() => second.internals.dcSessions.get('111') !== before && second.internals.dcSessions.has('111'), 1_000, 'a new session');
    second.receiver.speak('u9');
    expect(second.receiver.subscriptions.map(s => s.userId)).toEqual(['u9']);
    first.receiver.speak('u8'); // the old receiver is no longer served
    expect(first.receiver.subscriptions).toHaveLength(0);
  });

  it('cleaning up the connection ends the session', async () => {
    enable();
    const c = connect('111', '205');
    await waitFor(() => c.internals.dcSessions.has('111'), 1_000, 'the new session');
    manager.cleanupVoiceConnection('111');
    expect(c.internals.dcSessions.has('111')).toBe(false);
    c.receiver.speak('u2');
    expect(c.receiver.subscriptions).toHaveLength(0);
  });
});
