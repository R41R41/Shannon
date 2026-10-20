import { PermissionFlagsBits, type Client } from 'discord.js';
import type { LiveRoom, LiveSpeechItem, LiveSpeechReceipt, LiveSpeechSink } from '../common/liveSpeech.js';

/**
 * Where her live lines go (session dc-live): the voice channel she is in, else one text channel. The text channel is the only place this
 * posts without being answered to, so it is set by the owner (`MINEBOT_LIVE_DISCORD_CHANNEL=<guild>:<channel>`), checked on every line (the
 * channel is in that guild, the bot may see and write in it), and is never taken from anything a message says. A line goes with no mention
 * at all. Voice is the voice mouth's (`voice/voiceMouth.ts`): it decides whether someone is speaking and says the line when it is quiet;
 * without it, or with no voice channel joined, the line goes to the text channel.
 */
export interface LiveVoiceMouth {
  /** Whether she is in a voice channel with someone, whether someone speaks now, and since when someone last spoke. */
  state?(): { inVoice: boolean; humanSpeaking: boolean; sinceHumanMs: number | null };
  say(input: { text: string; source: string; key?: string; priority?: 'low' | 'normal' | 'high'; maxWaitMs?: number }):
    { id: string; accepted: boolean; reason?: string; done: Promise<string> };
}

export interface LiveTextTarget { guildId: string; channelId: string }

/** `MINEBOT_LIVE_DISCORD_CHANNEL`: `<guild id>:<channel id>`, digits only; anything else is no channel. */
export function liveTextTarget(value: string | undefined): LiveTextTarget | null {
  const match = /^(\d{1,25}):(\d{1,25})$/u.exec(value?.trim() ?? '');
  return match ? { guildId: match[1]!, channelId: match[2]! } : null;
}

const TEXT_QUIET_MS = 3_000;
const MAX_LINE = 400;

/** The voice mouth as the voice session builds it, when that module exists; null otherwise. A variable specifier keeps it optional. */
export async function loadVoiceMouth(): Promise<LiveVoiceMouth | null> {
  try {
    const specifier = './voice/voiceMouth.js';
    const module = await import(/* @vite-ignore */ specifier) as { getVoiceMouth?: () => LiveVoiceMouth };
    return module.getVoiceMouth?.() ?? null;
  } catch { return null; }
}

type Channel = {
  guildId?: string; isTextBased?(): boolean; isThread?(): boolean; send?(options: unknown): Promise<unknown>;
  permissionsFor?(user: unknown): { has(flag: bigint): boolean } | null;
};

export function createDiscordLiveSpeechSink(client: Pick<Client, 'channels' | 'user' | 'on'>, parts: {
  isRunning(): boolean; target: LiveTextTarget | null; voice?: () => Promise<LiveVoiceMouth | null>; now?: () => number;
}): LiveSpeechSink {
  const now = parts.now ?? Date.now;
  let humanAt: number | null = null, mouth: LiveVoiceMouth | null = null, loading: Promise<void> | null = null;
  const load = () => {
    loading ??= (parts.voice ?? loadVoiceMouth)().then(found => { mouth = found; }, () => { mouth = null; });
    return loading;
  };
  void load();
  if (parts.target) {
    // Someone wrote in the room she comments in: she keeps quiet for a moment (only the time is kept, never the words).
    client.on('messageCreate', message => {
      if (message.channelId === parts.target!.channelId && message.author?.bot !== true) humanAt = now();
    });
  }
  const sinceText = (): number | null => (humanAt === null ? null : Math.max(0, now() - humanAt));
  const earliest = (...values: Array<number | null | undefined>): number | null => {
    const known = values.filter((value): value is number => typeof value === 'number');
    return known.length ? Math.min(...known) : null;
  };

  async function post(item: LiveSpeechItem): Promise<LiveSpeechReceipt> {
    const target = parts.target;
    if (!target || !parts.isRunning()) return { id: item.id, outcome: 'declined', reason: 'no_channel' };
    const channel = client.channels.cache.get(target.channelId) as Channel | undefined;
    if (!channel || channel.guildId !== target.guildId || !channel.isTextBased?.() || typeof channel.send !== 'function') {
      return { id: item.id, outcome: 'declined', reason: 'no_channel' };
    }
    const bot = client.user ? channel.permissionsFor?.(client.user) : null;
    const write = channel.isThread?.() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
    if (!bot?.has(PermissionFlagsBits.ViewChannel) || !bot.has(write)) return { id: item.id, outcome: 'declined', reason: 'no_channel' };
    const quiet = sinceText();
    if (quiet !== null && quiet < TEXT_QUIET_MS) return { id: item.id, outcome: 'declined', reason: 'busy' };
    if (Date.parse(item.expiresAt) <= now()) return { id: item.id, outcome: 'declined', reason: 'expired' };
    await channel.send({ content: item.text.slice(0, MAX_LINE), allowedMentions: { parse: [], repliedUser: false } });
    return { id: item.id, outcome: 'posted', conversationId: `discord:${target.guildId}:${target.channelId}` };
  }

  async function voice(item: LiveSpeechItem): Promise<LiveSpeechReceipt | null> {
    await load();
    if (!mouth || mouth.state?.().inVoice === false) return null;
    const left = Date.parse(item.expiresAt) - now();
    const said = mouth.say({ text: item.text.slice(0, MAX_LINE), source: `minecraft:live:${item.kind}`, key: `live:${item.kind}`,
      priority: item.urgency === 'urgent' ? 'high' : 'normal', maxWaitMs: Math.max(1_000, Math.min(8_000, left)) });
    if (!said.accepted) return said.reason === 'not_in_voice' || said.reason === 'disabled' ? null : { id: item.id, outcome: 'declined', reason: 'busy' };
    const done = await said.done;
    if (done === 'spoken') return { id: item.id, outcome: 'spoken' };
    return done === 'not_in_voice' || done === 'disabled' ? null : { id: item.id, outcome: 'declined', reason: done === 'expired' ? 'expired' : 'busy' };
  }

  return {
    room(): LiveRoom {
      const state = mouth?.state?.();
      const voiceSince = state?.inVoice ? state.sinceHumanMs : null;
      return { voice: state?.inVoice === true, humanSpeaking: state?.inVoice === true && state.humanSpeaking === true, sinceHumanMs: earliest(voiceSince, sinceText()) };
    },
    async speak(item) {
      try {
        return await voice(item) ?? await post(item);
      } catch {
        return { id: item.id, outcome: 'failed', reason: 'error' };
      }
    },
  };
}
