/**
 * dc-voice: barge-in. While Shannon is speaking a reply (or its filler), a person whose voice goes on for
 * `minVoiceMs` (0.4 s) cuts her off: playback stops at once, and the owner of the reply sends the head `said`
 * with `interrupted:true` and what was actually said.
 *
 * Voice during the first `graceMs` (0.5 s) of Shannon's speech does not count (a reflexive "un" is not an
 * interruption): the voiced time is counted from the later of "the person's run of speech began" and
 * "Shannon's speech began + grace".
 *
 * A mouth line is not handled here: the mouth stops itself the moment anybody starts talking (rule 3). A short
 * backchannel is meant to overlap speech and is never cut.
 */
import type { PlaybackKind, PlaybackReport, SpeechPlayer } from './speechPlayer.js';
import type { SpeakerTracker } from './speakerTracker.js';

export interface BargeInOptions {
  tracker: SpeakerTracker;
  player: SpeechPlayer;
  /** Only people the bot is listening to can interrupt (PTT mode: the PTT person). */
  shouldListen: (userId: string) => boolean;
  /** Called after playback was stopped. */
  onBargeIn?: (event: { userId: string; report: PlaybackReport }) => void;
  minVoiceMs?: number;
  graceMs?: number;
  now?: () => number;
}

const INTERRUPTIBLE: ReadonlySet<PlaybackKind> = new Set(['reply']);

export class BargeInMonitor {
  private readonly minVoiceMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly offs: Array<() => void> = [];

  constructor(private readonly options: BargeInOptions) {
    this.minVoiceMs = options.minVoiceMs ?? 400;
    this.graceMs = options.graceMs ?? 500;
    this.now = options.now ?? Date.now;
    this.offs.push(options.tracker.on('start', userId => this.watch(userId)));
    this.offs.push(options.tracker.on('end', userId => { this.checkSoon(userId); }));
    // Shannon starts speaking while somebody is already talking: they may interrupt too.
    this.offs.push(options.player.onSpeakingChange((speaking) => {
      if (speaking) for (const userId of options.tracker.speakingUsers()) this.watch(userId);
    }));
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private speakingReply(): { since: number } | null {
    const speaking = this.options.player.speaking();
    return speaking && INTERRUPTIBLE.has(speaking.kind) ? { since: speaking.since } : null;
  }

  private watch(userId: string): void {
    if (!this.options.shouldListen(userId)) return;
    if (this.timers.has(userId)) return;
    this.check(userId);
  }

  /** A pause in the voice: re-evaluate (the run may have been a short blip). */
  private checkSoon(userId: string): void {
    if (this.timers.has(userId)) this.check(userId);
  }

  private check(userId: string): void {
    const existing = this.timers.get(userId);
    if (existing) { clearTimeout(existing); this.timers.delete(userId); }
    const shannon = this.speakingReply();
    if (!shannon) return;
    const runStart = this.options.tracker.runStart(userId);
    if (runStart === undefined) return; // the person fell silent (longer than a breath)
    const voicedFrom = Math.max(runStart, shannon.since + this.graceMs);
    const remaining = voicedFrom + this.minVoiceMs - this.now();
    if (remaining <= 0) {
      if (!this.options.tracker.isSpeaking(userId)) return;
      const report = this.options.player.stop('barge_in');
      if (report) this.options.onBargeIn?.({ userId, report });
      return;
    }
    const timer = setTimeout(() => { this.timers.delete(userId); this.check(userId); }, remaining + 1);
    timer.unref?.();
    this.timers.set(userId, timer);
  }
}
