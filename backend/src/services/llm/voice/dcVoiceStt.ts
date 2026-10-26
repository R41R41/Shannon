/**
 * dc-voice: speech-to-text for one captured utterance (WAV in, text out).
 *
 * The head transcribes (Groq whisper-large-v3-turbo, the same as Windows' listening): it holds the key and the day's/minute's
 * cap shared with Windows, and drops Whisper's set phrases for silence and noise. The body does not call Groq.
 * When the head cannot use Groq (no key: `not_configured`; Groq's free tier or limit used up, or no answer: `unavailable`;
 * the shared cap: `limited`; a failed call: `error`; an older head: 404), the utterance is transcribed the way it was before:
 * the in-body Whisper call (`transcribeWavWithWhisper`, OpenAI whisper-1 without a Groq key in the body). Owner 2026-10-26:
 * 「無料枠で動くうちは使って、切れていたら今の方式に切り替える」. The head says when Groq may be asked again; the body asks the
 * head each time (on the same machine), so it is back on Groq with the head's next answer. Each change of way is one log line.
 * Nothing moves to a way dearer than the one it had.
 */
import OpenAI from 'openai';
import { config } from '../../../config/env.js';
import { classifyError, formatErrorForLog } from '../../../errors/index.js';
import type { ShannonCoreVoiceClient } from '../../integration/shannonCoreVoiceClient.js';
import { logger } from '../../../utils/logger.js';
import { getTracedOpenAI } from '../utils/langfuse.js';
import { isWhisperHallucination, transcribeWavWithWhisper, type WhisperClients } from './voiceStt.js';

export type DcVoiceSttResult =
  | { status: 'ok'; text: string; sttMs: number }
  | { status: 'empty' | 'hallucination' | 'limited' | 'not_configured' | 'error'; sttMs: number };

/** `meta` lets the head count the utterance's length and tell speakers apart; without it the length is read from the WAV. */
export type DcVoiceStt = (wav: Buffer, meta?: { durationMs?: number; speakerId?: string }) => Promise<DcVoiceSttResult>;

export interface DcVoiceSttDeps {
  /** The head's client; null (or without `transcribe`) goes straight to the old Whisper call. */
  client?: Pick<ShannonCoreVoiceClient, 'transcribe'> | null;
  /** For the old Whisper call (tests); the config's by default. */
  whisper?: WhisperClients;
}

let defaultClients: WhisperClients | null = null;

function clientsFromConfig(): WhisperClients {
  defaultClients ??= {
    openaiClient: getTracedOpenAI(new OpenAI({ apiKey: config.openaiApiKey })),
    groqClient: getTracedOpenAI(new OpenAI({
      apiKey: config.groq.apiKey || config.openaiApiKey,
      baseURL: config.groq.apiKey ? 'https://api.groq.com/openai/v1' : undefined,
    })),
    groqApiKey: config.groq.apiKey,
  };
  return defaultClients;
}

/** 16 kHz mono 16 bit WAV with a 44-byte header: 32 bytes per ms. */
function wavDurationMs(wav: Buffer): number {
  return Math.max(0, Math.round((wav.length - 44) / 32));
}

async function whisperInBody(clients: WhisperClients, wav: Buffer): Promise<DcVoiceSttResult> {
  const startedAt = Date.now();
  let text: string;
  try {
    text = await transcribeWavWithWhisper(clients, wav);
  } catch (error) {
    logger.error(`[DcVoice] Whisper STT failed: ${formatErrorForLog(classifyError(error, 'llm'))}`);
    return { status: 'error', sttMs: Date.now() - startedAt };
  }
  const sttMs = Date.now() - startedAt;
  if (!text) return { status: 'empty', sttMs };
  if (isWhisperHallucination(text)) return { status: 'hallucination', sttMs };
  return { status: 'ok', text, sttMs };
}

export function createDcVoiceStt(deps: DcVoiceSttDeps = {}): DcVoiceStt {
  const client = deps.client ?? null;
  /** The way the last utterance went, to log only its changes. */
  let way: 'groq' | 'whisper' | null = null;
  const went = (next: 'groq' | 'whisper', reason: string) => {
    if (next === way) return;
    way = next;
    logger.info(`[DcVoice] stt way=${next}${next === 'whisper' ? ` reason=${reason}` : ''}`);
  };
  return async (wav, meta) => {
    if (!client) {
      went('whisper', 'no_head');
      return whisperInBody(deps.whisper ?? clientsFromConfig(), wav);
    }
    const result = await client.transcribe(wav, meta?.durationMs ?? wavDurationMs(wav), meta?.speakerId);
    switch (result.status) {
      case 'ok':
      case 'empty':
      case 'hallucination':
        went('groq', '');
        return result;
      case 'limited':
      case 'error':
      case 'not_configured':
        went('whisper', result.status);
        return whisperInBody(deps.whisper ?? clientsFromConfig(), wav);
      case 'unavailable':
        went('whisper', `${result.reason}${result.httpStatus ? `_${result.httpStatus}` : ''}`);
        return whisperInBody(deps.whisper ?? clientsFromConfig(), wav);
    }
  };
}
