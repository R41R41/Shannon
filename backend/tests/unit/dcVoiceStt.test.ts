import { beforeEach, describe, expect, it, vi } from 'vitest';

const whisper = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock('../../src/config/env.js', () => ({ config: { openaiApiKey: 'test-key', groq: { apiKey: '' } } }));
vi.mock('../../src/services/llm/utils/langfuse.js', () => ({ getTracedOpenAI: <T>(client: T) => client }));
vi.mock('../../src/services/llm/voice/voiceStt.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/llm/voice/voiceStt.js')>(),
  transcribeWavWithWhisper: whisper.transcribe,
}));

import { createDcVoiceStt } from '../../src/services/llm/voice/dcVoiceStt.js';
import type { VoiceTranscribeResult } from '../../src/services/integration/shannonCoreVoiceClient.js';

const wav = Buffer.alloc(44 + 32 * 1000); // 1 s of 16 kHz mono 16 bit
const whisperClients = { openaiClient: {}, groqClient: {}, groqApiKey: '' } as never;
const clientReturning = (result: VoiceTranscribeResult) => ({ transcribe: vi.fn(async () => result) });

/** Owner 2026-10-26: Groq through the head while it works, the body's own Whisper (the way it was) when it does not. */
describe('createDcVoiceStt: the head transcribes with Groq, the body falls back to its Whisper', () => {
  beforeEach(() => { whisper.transcribe.mockReset(); });

  it('passes the head\'s answer through with the length and the speaker, and never calls Whisper', async () => {
    const client = clientReturning({ status: 'ok', text: 'こんにちは', sttMs: 120 });
    const stt = createDcVoiceStt({ client, whisper: whisperClients });
    expect(await stt(wav, { durationMs: 900, speakerId: 'u1' })).toEqual({ status: 'ok', text: 'こんにちは', sttMs: 120 });
    expect(client.transcribe).toHaveBeenCalledWith(wav, 900, 'u1');
    await stt(wav);
    expect(client.transcribe).toHaveBeenLastCalledWith(wav, 1000, undefined); // the length is read from the WAV
    for (const status of ['empty', 'hallucination'] as const) {
      expect(await createDcVoiceStt({ client: clientReturning({ status, sttMs: 3 }), whisper: whisperClients })(wav)).toEqual({ status, sttMs: 3 });
    }
    expect(whisper.transcribe).not.toHaveBeenCalled();
  });

  it('transcribes with the body\'s Whisper whenever the head cannot use Groq', async () => {
    const results: VoiceTranscribeResult[] = [
      { status: 'not_configured' },
      { status: 'limited', sttMs: 0 },
      { status: 'error', sttMs: 3 },
      { status: 'unavailable', reason: 'groq', httpStatus: 200 },
      { status: 'unavailable', reason: 'http', httpStatus: 404 },
      { status: 'unavailable', reason: 'timeout' },
    ];
    for (const result of results) {
      whisper.transcribe.mockResolvedValueOnce('おはよう');
      const stt = createDcVoiceStt({ client: clientReturning(result), whisper: whisperClients });
      expect(await stt(wav), JSON.stringify(result)).toMatchObject({ status: 'ok', text: 'おはよう' });
    }
    expect(whisper.transcribe).toHaveBeenCalledTimes(results.length);
  });

  it('keeps the body\'s own filter on the Whisper way, and is back on Groq with the head\'s next answer', async () => {
    whisper.transcribe.mockResolvedValueOnce('ご視聴ありがとうございました').mockResolvedValueOnce('').mockRejectedValueOnce(new Error('boom'));
    const answers: VoiceTranscribeResult[] = [
      { status: 'unavailable', reason: 'groq', httpStatus: 200 },
      { status: 'unavailable', reason: 'groq', httpStatus: 200 },
      { status: 'unavailable', reason: 'groq', httpStatus: 200 },
      { status: 'ok', text: 'ただいま', sttMs: 80 },
    ];
    const client = { transcribe: vi.fn(async () => answers.shift()!) };
    const stt = createDcVoiceStt({ client, whisper: whisperClients });
    expect(await stt(wav)).toMatchObject({ status: 'hallucination' });
    expect(await stt(wav)).toMatchObject({ status: 'empty' });
    expect(await stt(wav)).toMatchObject({ status: 'error' });
    expect(await stt(wav)).toMatchObject({ status: 'ok', text: 'ただいま' });
    expect(whisper.transcribe).toHaveBeenCalledTimes(3);
  });
});
