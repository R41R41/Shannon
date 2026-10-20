/**
 * dc-voice: a quiet backchannel ("うん") while one person talks for a long time. Off by default
 * (SHANNON_DC_VOICE_BACKCHANNEL). It fires only when
 *  - that person has been talking for 3.5 s or more (their collection is still open) and just drew a short breath,
 *  - they are the only person in the VC,
 *  - Shannon was in the conversation within the 20 s before they started (not talking into the void),
 *  - Shannon is silent now, and the last backchannel was 10 s or more ago.
 * The clip is a pre-voiced filler (`un` or the like), played small, and is never cut by the speaker's voice.
 */
import type { FillerSource } from './speechFillerStore.js';
import type { SpeakerTracker } from './speakerTracker.js';
import type { SpeechPlayer } from './speechPlayer.js';

export interface BackchannelOptions {
  tracker: SpeakerTracker;
  collector: { collectingMs(userId: string): number };
  player: SpeechPlayer;
  fillers: FillerSource;
  shouldListen: (userId: string) => boolean;
  /** Number of people (bots excluded) in the VC. */
  humanCount: () => number;
  /** Epoch ms when Shannon last spoke, or last took a person's turn; 0 if never. */
  lastConversationAt: () => number;
  minSpeechMs?: number;
  cooldownMs?: number;
  addressedWindowMs?: number;
  gain?: number;
  now?: () => number;
  log?: (line: string) => void;
}

const PREFERRED_IDS = ['un', 'hai', 'fun', 'ee'];

export class BackchannelMonitor {
  private lastAt = 0;
  private readonly off: () => void;
  private readonly now: () => number;

  constructor(private readonly options: BackchannelOptions) {
    this.now = options.now ?? Date.now;
    this.off = options.tracker.on('end', userId => this.onPause(userId));
  }

  dispose(): void { this.off(); }

  /** Returns true when a backchannel was played (also used by tests). */
  onPause(userId: string): boolean {
    const o = this.options;
    const now = this.now();
    if (!o.shouldListen(userId)) return false;
    const speechMs = o.collector.collectingMs(userId);
    if (speechMs < (o.minSpeechMs ?? 3_500)) return false;
    if (o.humanCount() !== 1) return false;
    if (o.player.current() !== null) return false;
    if (this.lastAt > 0 && now - this.lastAt < (o.cooldownMs ?? 10_000)) return false;
    const lastConversationAt = o.lastConversationAt();
    const speechStartedAt = now - speechMs;
    if (lastConversationAt <= 0 || speechStartedAt - lastConversationAt > (o.addressedWindowMs ?? 20_000)) return false;
    const filler = this.pick();
    if (!filler) return false;
    this.lastAt = now;
    const session = o.player.open('backchannel');
    const writer = session.addSegment(filler.text, 'filler', { gain: o.gain ?? 0.35 });
    writer.writeMono24k(filler.pcm);
    writer.end();
    session.finish();
    o.log?.(`[DcVoice] backchannel user=${userId} speechMs=${Math.round(speechMs)} clip=${filler.id}`);
    return true;
  }

  private pick() {
    const fillers = this.options.fillers;
    for (const id of PREFERRED_IDS) {
      const found = fillers.get(id);
      if (found) return found;
    }
    return undefined;
  }
}
