/**
 * dc-voice: voice one sentence into a playback segment. The head's ElevenLabs voice first; when it fails before any
 * audio (HTTP error, timeout, unreadable), VOICEPEAK says that sentence instead. A stream that breaks after some audio
 * is kept as it is (saying the sentence again would double it).
 */
import type { ShannonCoreVoiceClient } from '../../integration/shannonCoreVoiceClient.js';
import { wavToPcm48kStereo } from './pcm.js';
import type { SegmentWriter } from './speechPlayer.js';

export interface SentenceVoiceDeps {
  client: Pick<ShannonCoreVoiceClient, 'speech'>;
  /** VOICEPEAK: text -> WAV. */
  voicepeakWav: (text: string) => Promise<Buffer>;
  log?: (message: string) => void;
}

export type SentenceVoiceOutcome = 'head' | 'voicepeak' | 'failed' | 'aborted';

export async function voiceSentence(
  deps: SentenceVoiceDeps,
  writer: SegmentWriter,
  spec: { text: string; voiceText?: string; style?: string; signal?: AbortSignal },
): Promise<SentenceVoiceOutcome> {
  try {
    const speech = await deps.client.speech(spec.voiceText ?? spec.text, { style: spec.style, signal: spec.signal });
    if (speech.status === 'ok') {
      let bytes = 0;
      for await (const chunk of speech.chunks) {
        bytes += chunk.length;
        writer.writeMono24k(chunk);
      }
      if (bytes > 0) {
        writer.end();
        return 'head';
      }
      if (spec.signal?.aborted) {
        writer.end();
        return 'aborted';
      }
      deps.log?.('speech returned no audio; using VOICEPEAK for this sentence');
    } else if (spec.signal?.aborted || speech.reason === 'aborted') {
      writer.end();
      return 'aborted';
    } else {
      deps.log?.(`speech unavailable (${speech.reason}${speech.httpStatus ? ` ${speech.httpStatus}` : ''}); using VOICEPEAK for this sentence`);
    }
  } catch (error) {
    deps.log?.(`speech failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (spec.signal?.aborted) {
    writer.end();
    return 'aborted';
  }
  try {
    const wav = await deps.voicepeakWav(spec.text);
    const pcm = wavToPcm48kStereo(wav);
    if (pcm && pcm.length > 0) {
      writer.writeStereo48k(pcm);
      writer.end();
      return 'voicepeak';
    }
    deps.log?.('VOICEPEAK returned audio that could not be read');
  } catch (error) {
    deps.log?.(`VOICEPEAK failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  writer.end();
  return 'failed';
}
