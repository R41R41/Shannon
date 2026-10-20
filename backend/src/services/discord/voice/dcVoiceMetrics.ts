/**
 * dc-voice: measurement. One structured line per turn, and an event-loop delay line once a minute while a VC
 * conversation is running. Neither ever contains what was said, only lengths.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

export type TurnPath = 'head' | 'legacy' | 'filler_only' | 'none';

export interface TurnMetrics {
  id: string;
  user: string;
  /** last audio packet -> the stream ended (the silence wait). */
  endpointMs?: number;
  /** Whisper call duration. */
  sttMs?: number;
  /** turn request sent -> `decision` line read. */
  decisionMs?: number;
  /** last audio packet -> filler audio started. */
  fillerStartMs?: number;
  /** last audio packet -> the first real sentence started playing. */
  firstSentenceMs?: number;
  /** last audio packet -> the first sound of any kind (filler or sentence). */
  firstAudioMs?: number;
  /** last audio packet -> everything finished. */
  totalMs?: number;
  path: TurnPath;
  respond: boolean;
  inChars?: number;
  outChars?: number;
  /** Extra short tag, e.g. 'interrupted' or 'error:MODEL_UNAVAILABLE'. */
  note?: string;
}

export function formatTurnLog(metrics: TurnMetrics): string {
  const number = (value: number | undefined): string => (value === undefined || !Number.isFinite(value) ? '-' : String(Math.round(value)));
  const parts = [
    `[DcVoice] turn id=${metrics.id}`,
    `user=${metrics.user}`,
    `endpointMs=${number(metrics.endpointMs)}`,
    `sttMs=${number(metrics.sttMs)}`,
    `decisionMs=${number(metrics.decisionMs)}`,
    `fillerStartMs=${number(metrics.fillerStartMs)}`,
    `firstSentenceMs=${number(metrics.firstSentenceMs)}`,
    `firstAudioMs=${number(metrics.firstAudioMs)}`,
    `totalMs=${number(metrics.totalMs)}`,
    `path=${metrics.path}`,
    `respond=${metrics.respond}`,
    `inChars=${number(metrics.inChars)}`,
    `outChars=${number(metrics.outChars)}`,
  ];
  if (metrics.note) parts.push(`note=${metrics.note}`);
  return parts.join(' ');
}

export interface LoopSample { p50: number; p99: number; max: number; samples: number }

export function formatLoopLog(sample: LoopSample): string {
  const ms = (value: number): string => (value / 1e6).toFixed(1);
  return `[DcVoice] loop p50=${ms(sample.p50)}ms p99=${ms(sample.p99)}ms max=${ms(sample.max)}ms samples=${sample.samples}`;
}

/** Logs the event-loop delay every minute, but only while at least one VC conversation holds a reference. */
export class EventLoopDelayLogger {
  private references = 0;
  private histogram: IntervalHistogram | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly log: (line: string) => void,
    private readonly intervalMs = 60_000,
  ) {}

  /** Returns a release function. */
  acquire(): () => void {
    this.references += 1;
    if (this.references === 1) this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.references -= 1;
      if (this.references === 0) this.stop();
    };
  }

  get running(): boolean { return this.timer !== null; }

  /** Log now and reset the window (the timer calls this; tests may too). */
  flush(): LoopSample | null {
    if (!this.histogram) return null;
    const histogram = this.histogram;
    const sample: LoopSample = {
      p50: histogram.percentile(50),
      p99: histogram.percentile(99),
      max: histogram.max,
      samples: histogram.count,
    };
    histogram.reset();
    this.log(formatLoopLog(sample));
    return sample;
  }

  private start(): void {
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();
    this.timer = setInterval(() => this.flush(), this.intervalMs);
    this.timer.unref?.();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.histogram?.disable();
    this.histogram = null;
  }
}
