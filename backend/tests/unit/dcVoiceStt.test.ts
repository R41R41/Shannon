import { beforeEach, describe, expect, it, vi } from 'vitest';

const whisper = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock('../../src/services/llm/voice/voiceStt.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/llm/voice/voiceStt.js')>(),
  transcribeWavWithWhisper: whisper.transcribe,
}));

import { createDcVoiceStt } from '../../src/services/llm/voice/dcVoiceStt.js';
import type { VoiceTranscribeResult } from '../../src/services/integration/shannonCoreVoiceClient.js';

const wav = Buffer.alloc(44 + 32 * 1000); // 1 s of 16 kHz mono 16 bit
const whisperClients = { openaiClient: {}, groqClient: {}, groqApiKey: 'k' } as never;
const clientReturning = (result: VoiceTranscribeResult) => ({ transcribe: vi.fn(async () => result) });

describe('createDcVoiceStt: the head transcribes', () => {
  beforeEach(() => { whisper.transcribe.mockReset(); });

  it('passes the head\'s answer through with the length and the speaker, and never calls Whisper', async () => {
    const client = clientReturning({ status: 'ok', text: 'こんにちは', sttMs: 120 });
    const stt = createDcVoiceStt({ client, whisper: whisperClients });
    expect(await stt(wav, { durationMs: 900, speakerId: 'u1' })).toEqual({ status: 'ok', text: 'こんにちは', sttMs: 120 });
    expect(client.transcribe).toHaveBeenCalledWith(wav, 900, 'u1');
    await stt(wav);
    expect(client.transcribe).toHaveBeenLastCalledWith(wav, 1000, undefined); // the length is read from the WAV
    expect(whisper.transcribe).not.toHaveBeenCalled();
  });

  it('keeps empty, hallucination, limited and error apart so the log can say which', async () => {
    for (const status of ['empty', 'hallucination', 'limited', 'error'] as const) {
      const stt = createDcVoiceStt({ client: clientReturning({ status, sttMs: 3 }), whisper: whisperClients });
      expect(await stt(wav)).toEqual({ status, sttMs: 3 });
    }
  });

  it('drops the utterance, without another paid transcription, when the head has no key or cannot answer', async () => {
    const noKey = createDcVoiceStt({ client: clientReturning({ status: 'not_configured' }), whisper: whisperClients });
    expect(await noKey(wav)).toMatchObject({ status: 'not_configured' });
    for (const result of [
      { status: 'unavailable', reason: 'http', httpStatus: 503 },
      { status: 'unavailable', reason: 'timeout' },
      { status: 'unavailable', reason: 'network' },
    ] as const) {
      const stt = createDcVoiceStt({ client: clientReturning(result), whisper: whisperClients });
      expect(await stt(wav)).toMatchObject({ status: 'error' });
    }
    expect(whisper.transcribe).not.toHaveBeenCalled();
  });

  it('falls back to Whisper in the body only when the head answers 404 (it does not know the window yet)', async () => {
    whisper.transcribe.mockResolvedValueOnce('おはよう').mockResolvedValueOnce('ご視聴ありがとうございました').mockResolvedValueOnce('').mockRejectedValueOnce(new Error('boom'));
    const stt = createDcVoiceStt({ client: clientReturning({ status: 'unavailable', reason: 'http', httpStatus: 404 }), whisper: whisperClients });
    expect(await stt(wav)).toMatchObject({ status: 'ok', text: 'おはよう' });
    expect(await stt(wav)).toMatchObject({ status: 'hallucination' }); // the body's own list applies on this path only
    expect(await stt(wav)).toMatchObject({ status: 'empty' });
    expect(await stt(wav)).toMatchObject({ status: 'error' });
  });
});
