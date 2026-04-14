import { Express } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';
import { getBackendRoot } from '../utils/backendRoot.js';
import { logger } from '../utils/logger.js';
import { EventBus } from '../services/eventBus/eventBus.js';

const SOUNDS_DIR = join(getBackendRoot(), 'assets', 'overlay-sounds');

// Pre-generate synthetic sounds as WAV buffers
function generateBeepWav(freq = 1000, durationSec = 0.08, volume = 0.15, sampleRate = 48000): Buffer {
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2; // 16-bit mono
  const header = Buffer.alloc(44);
  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  const data = Buffer.alloc(dataSize);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Square wave
    const val = Math.sin(2 * Math.PI * freq * t) > 0 ? volume : -volume;
    const sample = Math.max(-1, Math.min(1, val));
    data.writeInt16LE(Math.floor(sample * 32767), i * 2);
  }

  return Buffer.concat([header, data]);
}

function generateFlatlineWav(freq = 940, durationSec = 8, volume = 0.3, sampleRate = 48000): Buffer {
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  const fadeStart = (durationSec - 1.5) * sampleRate;
  const data = Buffer.alloc(dataSize);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let amp = volume;
    if (i > fadeStart) {
      amp *= 1 - (i - fadeStart) / (numSamples - fadeStart);
    }
    const val = Math.sin(2 * Math.PI * freq * t) * amp;
    data.writeInt16LE(Math.floor(Math.max(-1, Math.min(1, val)) * 32767), i * 2);
  }

  return Buffer.concat([header, data]);
}

// Cache synthesized sounds
const beepWav = generateBeepWav(1000, 0.08, 0.15);
const flatlineWav = generateFlatlineWav(940, 8, 0.3);

type SoundType = 'alarm' | 'beep' | 'flatline' | 'recovery' | 'voice1' | 'voice3' | 'voice15';

function loadSoundFile(name: string): Buffer | null {
  const path = join(SOUNDS_DIR, name);
  if (!existsSync(path)) {
    logger.warn(`[OverlaySound] File not found: ${path}`);
    return null;
  }
  return readFileSync(path);
}

const soundMap: Record<SoundType, () => Buffer | null> = {
  alarm: () => loadSoundFile('alarm.mp3'),
  beep: () => beepWav,
  flatline: () => flatlineWav,
  recovery: () => loadSoundFile('recovery.wav'),
  voice1: () => loadSoundFile('voice1.wav'),
  voice3: () => loadSoundFile('voice3.wav'),
  voice15: () => loadSoundFile('voice15.wav'),
};

// Lazy reference to DiscordBot (avoids circular import)
function getDiscordVoiceManager() {
  try {
    // DiscordBot is a singleton — safe to import dynamically
    const { DiscordBot } = require('../services/discord/client.js');
    const bot = DiscordBot.getInstance();
    return bot?.voiceManager ?? null;
  } catch {
    return null;
  }
}

export function registerOverlaySoundRoutes(app: Express, eventBus: EventBus) {
  // Voice channel join
  app.post('/overlay/voice-join', async (req, res) => {
    const { channelId } = req.body as { channelId: string };
    if (!channelId) {
      res.status(400).json({ error: 'channelId is required' });
      return;
    }
    const vm = getDiscordVoiceManager();
    if (!vm) {
      res.status(503).json({ error: 'Discord not available' });
      return;
    }
    const result = await vm.joinChannel(channelId);
    res.json(result);
  });

  // Voice channel leave
  app.post('/overlay/voice-leave', async (_req, res) => {
    const vm = getDiscordVoiceManager();
    if (!vm) {
      res.status(503).json({ error: 'Discord not available' });
      return;
    }
    vm.leaveAllChannels();
    res.json({ ok: true });
  });

  // Voice channel status
  app.get('/overlay/voice-status', (_req, res) => {
    const vm = getDiscordVoiceManager();
    if (!vm) {
      res.json({ connected: false, channels: [] });
      return;
    }
    const channels = vm.getConnectedChannels();
    res.json({ connected: channels.length > 0, channels });
  });

  // List available voice channels
  app.get('/overlay/voice-channels', async (_req, res) => {
    try {
      const { DiscordBot } = require('../services/discord/client.js');
      const bot = DiscordBot.getInstance();
      const client = bot?.client;
      if (!client) {
        res.json({ channels: [] });
        return;
      }
      const channels: { id: string; name: string; guild: string }[] = [];
      for (const guild of client.guilds.cache.values()) {
        for (const channel of guild.channels.cache.values()) {
          if (channel.isVoiceBased() && !channel.isThread()) {
            channels.push({ id: channel.id, name: channel.name, guild: guild.name });
          }
        }
      }
      res.json({ channels });
    } catch {
      res.json({ channels: [] });
    }
  });

  app.post('/overlay/play-sound', async (req, res) => {
    const { sound, repeat } = req.body as { sound: SoundType; repeat?: number };

    if (!sound || !soundMap[sound]) {
      res.status(400).json({ error: `Unknown sound: ${sound}` });
      return;
    }

    const buf = soundMap[sound]();
    if (!buf) {
      res.status(404).json({ error: `Sound file not available: ${sound}` });
      return;
    }

    logger.info(`[OverlaySound] Playing: ${sound}${repeat && repeat > 1 ? ` x${repeat}` : ''}`);

    // Play through Discord voice via event bus
    const repeatCount = Math.min(repeat || 1, 5);
    for (let i = 0; i < repeatCount; i++) {
      eventBus.publish({
        type: 'overlay:play_sound',
        data: { buffer: buf, sound },
        source: 'overlay',
      } as any);
      // Small gap between repeats
      if (i < repeatCount - 1) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    res.json({ ok: true, sound, repeat: repeatCount });
  });
}
