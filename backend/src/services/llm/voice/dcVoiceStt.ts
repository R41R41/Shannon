/**
 * dc-voice: speech-to-text for one captured utterance (WAV in, text out).
 *
 * The head transcribes (Groq whisper-large-v3-turbo, the same as Windows' listening): it holds the key and the day's/minute's
 * cap shared with Windows, and drops Whisper's set phrases for silence and noise. The body does not call Groq.
 * Only a head that does not know the window yet (404: it is deployed before the body, so there is a gap) falls back to
 * the old in-body Whisper call (`transcribeWavWithWhisper`, with its hallucination list). A head that has no Groq key
 * (`not_configured`), a cap reached (`limited`) or a failed call (`error`) drops the utterance: it is never quietly moved
 * to another paid transcription.
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
  return async (wav, meta) => {
    if (!client) return whisperInBody(deps.whisper ?? clientsFromConfig(), wav);
    const startedAt = Date.now();
    const result = await client.transcribe(wav, meta?.durationMs ?? wavDurationMs(wav), meta?.speakerId);
    switch (result.status) {
      case 'ok':
      case 'empty':
      case 'hallucination':
      case 'limited':
      case 'error':
        return result;
      case 'not_configured':
        logger.warn('[DcVoice] the head has no Groq key (LISTEN_NOT_CONFIGURED); this utterance is dropped');
        return { status: 'not_configured', sttMs: Date.now() - startedAt };
      case 'unavailable':
        // An older head does not know the window: the old call in the body, for the gap while the head is deployed first.
        if (result.httpStatus === 404) return whisperInBody(deps.whisper ?? clientsFromConfig(), wav);
        logger.warn(`[DcVoice] the head's transcribe is unavailable (${result.reason}${result.httpStatus ? ` ${result.httpStatus}` : ''}); this utterance is dropped`);
        return { status: 'error', sttMs: Date.now() - startedAt };
    }
  };
}
