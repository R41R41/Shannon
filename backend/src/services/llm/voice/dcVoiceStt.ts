/**
 * dc-voice: speech-to-text for one captured utterance (WAV in, text out), using the same Whisper call and the
 * same hallucination filter as the legacy VoiceProcessor (voiceStt.ts).
 */
import OpenAI from 'openai';
import { config } from '../../../config/env.js';
import { classifyError, formatErrorForLog } from '../../../errors/index.js';
import { logger } from '../../../utils/logger.js';
import { getTracedOpenAI } from '../utils/langfuse.js';
import { isWhisperHallucination, transcribeWavWithWhisper, type WhisperClients } from './voiceStt.js';

export type DcVoiceSttResult =
  | { status: 'ok'; text: string; sttMs: number }
  | { status: 'empty' | 'hallucination' | 'error'; sttMs: number };

export type DcVoiceStt = (wav: Buffer) => Promise<DcVoiceSttResult>;

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

export function createDcVoiceStt(clients?: WhisperClients): DcVoiceStt {
  return async (wav) => {
    const startedAt = Date.now();
    let text: string;
    try {
      text = await transcribeWavWithWhisper(clients ?? clientsFromConfig(), wav);
    } catch (error) {
      logger.error(`[DcVoice] Whisper STT failed: ${formatErrorForLog(classifyError(error, 'llm'))}`);
      return { status: 'error', sttMs: Date.now() - startedAt };
    }
    const sttMs = Date.now() - startedAt;
    if (!text) return { status: 'empty', sttMs };
    if (isWhisperHallucination(text)) return { status: 'hallucination', sttMs };
    return { status: 'ok', text, sttMs };
  };
}
