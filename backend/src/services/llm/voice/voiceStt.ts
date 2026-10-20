import { File } from 'node:buffer';
import type OpenAI from 'openai';

/**
 * Whisper speech-to-text for Discord voice, shared by the legacy VoiceProcessor and the dc-voice path.
 * (Moved out of VoiceProcessor unchanged: Groq whisper-large-v3-turbo when a Groq key exists, else OpenAI whisper-1.)
 */

/** Phrases Whisper invents out of silence/noise; an utterance containing one is dropped. */
export const WHISPER_HALLUCINATIONS: readonly string[] = [
  'ご視聴ありがとうございました',
  'ご視聴いただきありがとうございます',
  'ご視聴頂きありがとうございました',
  'チャンネル登録よろしくお願いします',
  '字幕は自動生成されています',
  'ご視聴ありがとうございます',
  'おやすみなさい',
  'Thanks for watching',
  'Thank you for watching',
  'Subscribe to my channel',
  'Subtitles by',
  'はじめしゃちょー',
  'エンディング',
  'チャンネル登録',
  '高評価',
  'いいねボタン',
  'お気に入り登録',
  '次の動画',
  '次回の動画',
  '次回へつづき',
  'お楽しみに',
  'ご覧いただき',
  'グッドボタン',
  'よろしくお願いします',
  '最後までご視聴',
];

export function isWhisperHallucination(text: string): boolean {
  return WHISPER_HALLUCINATIONS.some(phrase => text.includes(phrase));
}

export interface WhisperClients {
  openaiClient: OpenAI;
  groqClient: OpenAI;
  groqApiKey?: string;
}

/** Transcribe a WAV. Throws on an API failure (callers decide how to log it). */
export async function transcribeWavWithWhisper(clients: WhisperClients, wav: Buffer): Promise<string> {
  const audioFile = new File([new Uint8Array(wav)], 'voice.wav', { type: 'audio/wav' });

  const sttClient = clients.groqApiKey ? clients.groqClient : clients.openaiClient;
  const sttModel = clients.groqApiKey ? 'whisper-large-v3-turbo' : 'whisper-1';
  const transcription = await sttClient.audio.transcriptions.create({
    model: sttModel,
    file: audioFile,
    language: 'ja',
    prompt: 'シャノンとの日常会話です。',
  });
  return transcription.text.trim();
}
