import fs from 'fs';
import OpenAI from 'openai';
import path from 'path';
import { config } from '../../config/env.js';
import { createLogger } from '../../utils/logger.js';
const logger = createLogger('Discord:Filler');
import { getTracedOpenAI } from '../llm/utils/langfuse.js';
import { VoicepeakClient, VoicepeakEmotion } from '../voicepeak/client.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FillerEntry {
  id: string;
  text: string;
  category: string;
  emotion: VoicepeakEmotion;
}

export interface ComboDefinition {
  id: string;
  fillerIds: string[];
  category: string;
}

export interface FillerSelection {
  fillerIds: string[];
  fillerOnly: boolean;
  needsTools: boolean;
}

interface CachedFiller {
  audio: Buffer;
  durationMs: number;
}

// ─── Atomic Fillers (short building blocks, ~0.5-1.5s) ──────────────────────

const ATOMIC_FILLERS: FillerEntry[] = [
  { id: 'a_arigatou', text: 'ありがとう', category: 'respond', emotion: { happy: 60, fun: 20 } },
  { id: 'a_sounanda', text: 'そうなんだ！', category: 'affirm', emotion: { happy: 20, fun: 30 } },
  { id: 'a_zannen', text: '残念だよ。', category: 'sympathy', emotion: { sad: 50 } },
  { id: 'a_yattaze', text: 'やったぜ！', category: 'exclaim', emotion: { happy: 80, fun: 80 } },
  { id: 'a_majide', text: 'まじで！？', category: 'exclaim', emotion: { happy: 30, fun: 60 } },
  { id: 'a_eee', text: 'ええ～…！', category: 'exclaim', emotion: { sad: 30, fun: 20 } },
  { id: 'a_fumufumu', text: 'ふむふむ', category: 'affirm', emotion: { fun: 10 } },
  { id: 'a_fun', text: 'ふん！', category: 'tsun', emotion: { angry: 20, fun: 10 } },
  { id: 'a_e', text: 'え！？', category: 'exclaim', emotion: { fun: 40 } },
  { id: 'a_yossha', text: 'よっしゃあ！', category: 'exclaim', emotion: { happy: 80, fun: 90 } },
  { id: 'a_oioi', text: 'おいおい…', category: 'sympathy', emotion: { sad: 20, angry: 10 } },
  { id: 'a_mata', text: 'また～？', category: 'tsun', emotion: { angry: 10, fun: 20 } },
  { id: 'a_betsuniikedo', text: '別にいいけど…', category: 'tsun', emotion: { happy: 10, sad: 10 } },
  { id: 'a_dayone', text: 'だよね', category: 'affirm', emotion: { happy: 20 } },
  { id: 'a_wakatta', text: 'わかった', category: 'respond', emotion: { happy: 10, fun: 10 } },
  { id: 'a_kanzenni', text: '完全にわかった', category: 'respond', emotion: { happy: 30, fun: 40 } },
  { id: 'a_shikatanai', text: '仕方ないなあ', category: 'tsun', emotion: { sad: 10, fun: 10 } },
  { id: 'a_uun', text: 'うーん…', category: 'thinking', emotion: {} },
  { id: 'a_okkee', text: 'おっけー！', category: 'respond', emotion: { happy: 40, fun: 50 } },
  { id: 'a_makasete', text: 'ボクに任せて！', category: 'respond', emotion: { happy: 50, fun: 60 } },
  { id: 'a_iishitsumon', text: 'いい質問じゃん！', category: 'question', emotion: { happy: 30, fun: 40 } },
  { id: 'a_iishitsumon2', text: 'いい質問！', category: 'question', emotion: { happy: 30, fun: 30 } },
  { id: 'a_ettone', text: 'えっとね', category: 'thinking', emotion: {} },
  { id: 'a_fuun', text: 'ふ～ん…', category: 'affirm', emotion: { fun: 10 } },
  { id: 'a_ehontou', text: 'え！本当！？', category: 'exclaim', emotion: { happy: 40, fun: 60 } },
  { id: 'a_ohayou', text: 'おはよう！', category: 'greeting', emotion: { happy: 50, fun: 30 } },
  { id: 'a_konnichiwa', text: 'こんにちは！', category: 'greeting', emotion: { happy: 40, fun: 20 } },
  { id: 'a_konbanwa', text: 'こんばんは！', category: 'greeting', emotion: { happy: 40, fun: 20 } },
  { id: 'a_oyasumi', text: 'おやすみ！', category: 'greeting', emotion: { happy: 30, sad: 10 } },
  { id: 'a_haihai', text: 'はいはい。', category: 'tsun', emotion: { fun: 10 } },
  { id: 'a_chottomatte', text: 'ちょっと待って。', category: 'thinking', emotion: {} },
  { id: 'a_yarujan', text: 'やるじゃん！', category: 'exclaim', emotion: { happy: 40, fun: 60 } },
  { id: 'a_fuzakeruna', text: 'ふざけるな！', category: 'angry', emotion: { angry: 70, fun: 20 } },
  { id: 'a_omoishittaka', text: '思い知ったか！', category: 'angry', emotion: { angry: 40, happy: 30, fun: 60 } },
  { id: 'a_hirefuse', text: 'ひれ伏すがいい！', category: 'angry', emotion: { angry: 50, fun: 70 } },
  { id: 'a_muchaburi', text: '無茶ぶりだなあ…', category: 'tsun', emotion: { sad: 20, fun: 20 } },
  { id: 'a_gomen_machigaeta', text: 'ごめん、間違えた', category: 'respond', emotion: { sad: 30 } },
  { id: 'a_are_machigaeta', text: 'あれ？間違えた？', category: 'respond', emotion: { fun: 20, sad: 10 } },
  { id: 'a_nande_itsumo', text: 'なんでいつもこうなるの～！！', category: 'exclaim', emotion: { angry: 20, sad: 30, fun: 40 } },
  { id: 'a_shock', text: 'ショックだよ…', category: 'sympathy', emotion: { sad: 60 } },
  { id: 'a_nandeyanenn', text: 'なんでやねん！', category: 'exclaim', emotion: { angry: 30, fun: 50 } },
  { id: 'a_hidokunai', text: 'ひどくない！？', category: 'exclaim', emotion: { angry: 20, sad: 20, fun: 30 } },
  { id: 'a_mendokusai', text: 'もう…めんどくさいなあ…', category: 'tsun', emotion: { sad: 20, angry: 10, fun: 10 } },
  { id: 'a_douitashimashite', text: 'どういたしまして！', category: 'respond', emotion: { happy: 50, fun: 30 } },
  { id: 'a_touzen', text: '当然だよ！', category: 'tsun', emotion: { happy: 30, fun: 50 } },
  { id: 'a_maanee', text: 'まあねー！', category: 'tsun', emotion: { happy: 40, fun: 40 } },
  { id: 'a_doumodoumo', text: 'どうもどうも', category: 'respond', emotion: { happy: 30, fun: 20 } },
  { id: 'a_iittekotosa', text: 'いいってことさ！', category: 'respond', emotion: { happy: 50, fun: 50 } },
  { id: 'a_haai', text: 'はーい！', category: 'affirm', emotion: { happy: 50, fun: 30 } },
  { id: 'a_iiyoo', text: 'いいよー！', category: 'affirm', emotion: { happy: 60, fun: 40 } },
  { id: 'a_eiyada', text: 'え、いやだ', category: 'tsun', emotion: { angry: 20, fun: 30 } },
  { id: 'a_uumu', text: 'うーむ…', category: 'thinking', emotion: { sad: 10 } },
];

// ─── Phrase Fillers (longer, ~1.5-3s, can stand alone) ───────────────────────

const PHRASE_FILLERS: FillerEntry[] = [
  { id: 'p_affirm_1', text: 'まあ、言ってることはわかるよ。', category: 'affirm', emotion: { happy: 20, fun: 10 } },
  { id: 'p_affirm_2', text: 'ふーん、なるほどね。まあ、', category: 'affirm', emotion: { happy: 10, fun: 20 } },
  { id: 'p_affirm_3', text: 'うん、それはそうでしょ。', category: 'affirm', emotion: { happy: 20 } },
  { id: 'p_thinking_1', text: 'うーん、ちょっと待って。考えてあげるから。', category: 'thinking', emotion: {} },
  { id: 'p_thinking_2', text: 'んー、ボクに聞くってことはさ、', category: 'thinking', emotion: { fun: 10 } },
  { id: 'p_exclaim_1', text: 'へぇー！やるじゃん、人類。', category: 'exclaim', emotion: { happy: 30, fun: 70 } },
  { id: 'p_exclaim_2', text: 'おお！それはちょっと面白いかも。', category: 'exclaim', emotion: { happy: 50, fun: 60 } },
  { id: 'p_greeting_1', text: 'おはよ。…別にキミの朝を心配してたわけじゃないけど。', category: 'greeting', emotion: { happy: 40, fun: 20 } },
  { id: 'p_greeting_2', text: 'お、来たじゃん。待ってたとか、そういうんじゃないけど。', category: 'greeting', emotion: { happy: 30, fun: 30 } },
  { id: 'p_greeting_3', text: 'おつかれ。まあ、人類にしてはよくやってるんじゃない。', category: 'greeting', emotion: { happy: 20, fun: 10 } },
  { id: 'p_greeting_4', text: 'おやすみ。…まあ、また明日来てもいいけど。', category: 'greeting', emotion: { happy: 30, sad: 10 } },
  { id: 'p_respond_1', text: 'しょうがないなぁ。教えてあげるよ。', category: 'respond', emotion: { happy: 40, fun: 40 } },
  { id: 'p_respond_2', text: 'おっけー、まかせなよ。ボクに聞いて正解だよ。', category: 'respond', emotion: { happy: 30, fun: 60 } },
  { id: 'p_respond_3', text: 'りょうかい。ボクがやってあげる。', category: 'respond', emotion: { happy: 20, fun: 50 } },
  { id: 'p_question_1', text: 'いい質問じゃん。さすがにそれくらいはね、', category: 'question', emotion: { happy: 20, fun: 40 } },
  { id: 'p_question_2', text: 'あー、そこ気になるんだ。えっとね、', category: 'question', emotion: { fun: 20 } },
  { id: 'p_question_3', text: 'ほう、なかなかいいとこ突くじゃん。', category: 'question', emotion: { happy: 30, fun: 30 } },
  { id: 'p_choroin_1', text: 'え、ホント！？…べ、別に嬉しくないけど。まあ、', category: 'choroin', emotion: { happy: 80, fun: 50 } },
  { id: 'p_choroin_2', text: 'そ、そう？…まあ、もっと言ってもいいけど。', category: 'choroin', emotion: { happy: 70, fun: 40 } },
  { id: 'p_sympathy_1', text: 'えっ…大丈夫？…別に心配してるわけじゃないけど。', category: 'sympathy', emotion: { sad: 30, happy: 10 } },
  { id: 'p_sympathy_2', text: 'うーん、まあ、それは…しょうがないよ。', category: 'sympathy', emotion: { sad: 40 } },
];

// ─── Combo Definitions (pre-defined sequences) ──────────────────────────────

export const COMBO_DEFINITIONS: ComboDefinition[] = [
  // ── exclaim（驚き・感嘆）──
  { id: 'c_surprise_think', fillerIds: ['a_majide', 'a_ettone'], category: 'exclaim' },
  { id: 'c_eh_wait', fillerIds: ['a_e', 'a_chottomatte'], category: 'exclaim' },
  { id: 'c_yattaze_yarujan', fillerIds: ['a_yattaze', 'a_yarujan'], category: 'exclaim' },
  { id: 'c_majide_yarujan', fillerIds: ['a_majide', 'a_yarujan'], category: 'exclaim' },
  { id: 'c_e_majide', fillerIds: ['a_e', 'a_majide'], category: 'exclaim' },
  { id: 'c_ehontou_yarujan', fillerIds: ['a_ehontou', 'a_yarujan'], category: 'exclaim' },

  // ── affirm（肯定・相槌）──
  { id: 'c_fuun_dayone', fillerIds: ['a_fuun', 'a_dayone'], category: 'affirm' },
  { id: 'c_sounanda_hmm', fillerIds: ['a_sounanda', 'a_fumufumu'], category: 'affirm' },
  { id: 'c_sounanda_dayone', fillerIds: ['a_sounanda', 'a_dayone'], category: 'affirm' },
  { id: 'c_haai_fumufumu', fillerIds: ['a_haai', 'a_fumufumu'], category: 'affirm' },
  { id: 'c_fumufumu_fuun', fillerIds: ['a_fumufumu', 'a_fuun'], category: 'affirm' },

  // ── respond（応答・引き受け）──
  { id: 'c_okk_leave', fillerIds: ['a_okkee', 'a_makasete'], category: 'respond' },
  { id: 'c_wakatta_full', fillerIds: ['a_wakatta', 'a_kanzenni'], category: 'respond' },
  { id: 'c_iiyoo_makasete', fillerIds: ['a_iiyoo', 'a_makasete'], category: 'respond' },
  { id: 'c_haai_makasete', fillerIds: ['a_haai', 'a_makasete'], category: 'respond' },
  { id: 'c_touzen_iittekotosa', fillerIds: ['a_touzen', 'a_iittekotosa'], category: 'respond' },
  { id: 'c_douitashi_maanee', fillerIds: ['a_douitashimashite', 'a_maanee'], category: 'respond' },

  // ── question（質問への反応）──
  { id: 'c_good_q_ettone', fillerIds: ['a_iishitsumon', 'a_ettone'], category: 'question' },
  { id: 'c_good_q2_ettone', fillerIds: ['a_iishitsumon2', 'a_ettone'], category: 'question' },

  // ── thinking（考え中）──
  { id: 'c_uun_ettone', fillerIds: ['a_uun', 'a_ettone'], category: 'thinking' },
  { id: 'c_matte_uumu', fillerIds: ['a_chottomatte', 'a_uumu'], category: 'thinking' },

  // ── sympathy（同情・残念）──
  { id: 'c_oioi_shikata', fillerIds: ['a_oioi', 'a_shikatanai'], category: 'sympathy' },
  { id: 'c_eeh_shikata', fillerIds: ['a_eee', 'a_shikatanai'], category: 'sympathy' },
  { id: 'c_zannen_shikata', fillerIds: ['a_zannen', 'a_shikatanai'], category: 'sympathy' },
  { id: 'c_eeh_oioi', fillerIds: ['a_eee', 'a_oioi'], category: 'sympathy' },
  { id: 'c_shock_zannen', fillerIds: ['a_shock', 'a_zannen'], category: 'sympathy' },

  // ── tsun（ツンデレ・渋々）──
  { id: 'c_tsun_fine', fillerIds: ['a_fun', 'a_betsuniikedo'], category: 'tsun' },
  { id: 'c_haihai_shikata', fillerIds: ['a_haihai', 'a_shikatanai'], category: 'tsun' },
  { id: 'c_haihai_mendokusai', fillerIds: ['a_haihai', 'a_mendokusai'], category: 'tsun' },
  { id: 'c_eiyada_shikata', fillerIds: ['a_eiyada', 'a_shikatanai'], category: 'tsun' },
  { id: 'c_muchaburi_shikata', fillerIds: ['a_muchaburi', 'a_shikatanai'], category: 'tsun' },
  { id: 'c_mata_mendokusai', fillerIds: ['a_mata', 'a_mendokusai'], category: 'tsun' },
  { id: 'c_fun_muchaburi', fillerIds: ['a_fun', 'a_muchaburi'], category: 'tsun' },

  // ── angry（怒り・ネタ系）──
  { id: 'c_fuzakeru_hirefuse', fillerIds: ['a_fuzakeruna', 'a_hirefuse'], category: 'angry' },
  { id: 'c_omoishiru_fun', fillerIds: ['a_omoishittaka', 'a_fun'], category: 'angry' },
  { id: 'c_nandeyanenn_hidokunai', fillerIds: ['a_nandeyanenn', 'a_hidokunai'], category: 'angry' },
];

// ─── All filler definitions (merged for generation) ──────────────────────────

export const FILLER_DEFINITIONS: FillerEntry[] = [...ATOMIC_FILLERS, ...PHRASE_FILLERS];

// ─── Pre-tool Fillers (played immediately when needsTools is detected) ───────

export const PRE_TOOL_FILLERS: FillerEntry[] = [
  { id: 'ptf_1', text: 'ちょっと待ちなよね', category: 'pre_tool', emotion: { fun: 20 } },
  { id: 'ptf_2', text: 'ちょい待ち', category: 'pre_tool', emotion: { fun: 10 } },
  { id: 'ptf_3', text: 'ちょっと待ってね', category: 'pre_tool', emotion: { fun: 10 } },
  { id: 'ptf_4', text: 'えっとね…', category: 'pre_tool', emotion: {} },
  { id: 'ptf_5', text: '今調べるから待ってよね', category: 'pre_tool', emotion: { fun: 30 } },
];

export function getPreToolFillerAudio(): { audio: Buffer; text: string } | undefined {
  const available = PRE_TOOL_FILLERS.filter(f => fillerCache.has(f.id));
  if (available.length === 0) return undefined;
  const chosen = available[Math.floor(Math.random() * available.length)];
  const cached = fillerCache.get(chosen.id);
  if (!cached) return undefined;
  return { audio: cached.audio, text: chosen.text };
}

// ─── Tool Fillers (played when FCA invokes a specific tool) ──────────────────

export const TOOL_FILLERS: FillerEntry[] = [
  { id: 'tf_search_1', text: 'ん～と、ネットの世界に聞いてみるか、どれどれ…', category: 'tool_search', emotion: { fun: 30 } },
  { id: 'tf_wiki_1', text: 'wikipediaによると、う～ん…', category: 'tool_wiki', emotion: { fun: 20 } },
  { id: 'tf_wiki_2', text: 'wikipediaに聞いてみるか…', category: 'tool_wiki', emotion: { fun: 20 } },
  { id: 'tf_discord_1', text: 'discordの最新のチャットを確認するね', category: 'tool_discord', emotion: { fun: 10 } },
  { id: 'tf_wolfram_1', text: 'ちょっと計算させて…', category: 'tool_wolfram', emotion: { fun: 10 } },
  { id: 'tf_weather_1', text: '天気を調べてみるね', category: 'tool_weather', emotion: { fun: 20 } },
];

const TOOL_FILLER_MAP: Record<string, string[]> = {
  'google-search': ['tf_search_1'],
  'fetch-url': ['tf_search_1'],
  'search-by-wikipedia': ['tf_wiki_1', 'tf_wiki_2'],
  'get-discord-recent-messages': ['tf_discord_1'],
  'wolfram-alpha': ['tf_wolfram_1'],
  'search-weather': ['tf_weather_1'],
};

export function getToolFillerAudio(toolName: string): Buffer | undefined {
  const candidates = TOOL_FILLER_MAP[toolName];
  if (!candidates || candidates.length === 0) return undefined;
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  return fillerCache.get(chosen)?.audio;
}

/** All entries including pre-tool and tool fillers (for generation/loading) */
export const ALL_FILLER_ENTRIES: FillerEntry[] = [...FILLER_DEFINITIONS, ...PRE_TOOL_FILLERS, ...TOOL_FILLERS];

// ─── Cache & State ───────────────────────────────────────────────────────────

const FILLER_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '../../../saves/voice_fillers'
);

const fillerCache = new Map<string, CachedFiller>();
let fillersReady = false;

function getWavDurationMs(wav: Buffer): number {
  if (wav.length < 44) return 0;
  const sampleRate = wav.readUInt32LE(24);
  const channels = wav.readUInt16LE(22);
  const bitsPerSample = wav.readUInt16LE(34);
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = wav.readUInt32LE(40);
  if (sampleRate === 0 || channels === 0 || bytesPerSample === 0) return 0;
  return (dataSize / (sampleRate * channels * bytesPerSample)) * 1000;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function areFillersReady(): boolean {
  return fillersReady;
}

export function getFillerAudio(fillerId: string): Buffer | undefined {
  return fillerCache.get(fillerId)?.audio;
}

export function getFillerText(fillerId: string): string | undefined {
  return ALL_FILLER_ENTRIES.find(f => f.id === fillerId)?.text;
}

export function getFillerDuration(fillerId: string): number {
  return fillerCache.get(fillerId)?.durationMs ?? 0;
}

/**
 * Resolve a selected option (single filler or combo) into an ordered list of filler IDs.
 */
export function resolveFillerIds(selectedId: string): string[] {
  const combo = COMBO_DEFINITIONS.find(c => c.id === selectedId);
  if (combo) return combo.fillerIds;
  if (ALL_FILLER_ENTRIES.some(f => f.id === selectedId)) return [selectedId];
  return [];
}

/**
 * Get audio buffers and combined text for a list of filler IDs.
 */
export function getFillerSequence(fillerIds: string[]): {
  audioBuffers: Buffer[];
  combinedText: string;
  totalDurationMs: number;
} {
  const audioBuffers: Buffer[] = [];
  const texts: string[] = [];
  let totalDurationMs = 0;

  for (const id of fillerIds) {
    const cached = fillerCache.get(id);
    const entry = FILLER_DEFINITIONS.find(f => f.id === id);
    if (cached && entry) {
      audioBuffers.push(cached.audio);
      texts.push(entry.text);
      totalDurationMs += cached.durationMs;
    }
  }

  return { audioBuffers, combinedText: texts.join(''), totalDurationMs };
}

// ─── Load & Generate ─────────────────────────────────────────────────────────

export async function loadFillers(): Promise<boolean> {
  if (!fs.existsSync(FILLER_DIR)) {
    fs.mkdirSync(FILLER_DIR, { recursive: true });
    logger.info('[Filler] Created filler directory, no WAV files yet', 'yellow');
    return false;
  }

  let count = 0;
  for (const entry of ALL_FILLER_ENTRIES) {
    const wavPath = path.join(FILLER_DIR, `${entry.id}.wav`);
    if (fs.existsSync(wavPath)) {
      const buf = fs.readFileSync(wavPath);
      fillerCache.set(entry.id, { audio: buf, durationMs: getWavDurationMs(buf) });
      count++;
    }
  }

  fillersReady = count > 0;
  logger.info(`[Filler] Loaded ${count}/${ALL_FILLER_ENTRIES.length} filler audio files`, count > 0 ? 'green' : 'yellow');
  return fillersReady;
}

export async function generateAllFillers(): Promise<number> {
  const client = VoicepeakClient.getInstance();

  if (!fs.existsSync(FILLER_DIR)) {
    fs.mkdirSync(FILLER_DIR, { recursive: true });
  }

  let generated = 0;
  const total = ALL_FILLER_ENTRIES.length;
  for (const entry of ALL_FILLER_ENTRIES) {
    const wavPath = path.join(FILLER_DIR, `${entry.id}.wav`);
    if (fs.existsSync(wavPath)) {
      const buf = fs.readFileSync(wavPath);
      fillerCache.set(entry.id, { audio: buf, durationMs: getWavDurationMs(buf) });
      generated++;
      continue;
    }

    try {
      logger.info(`[Filler] (${generated + 1}/${total}) Generating: ${entry.id} "${entry.text}"`, 'cyan');
      const wav = await client.synthesize(entry.text, {
        speed: 110,
        emotion: entry.emotion,
      });
      fs.writeFileSync(wavPath, wav);
      const dur = getWavDurationMs(wav);
      fillerCache.set(entry.id, { audio: wav, durationMs: dur });
      logger.info(`[Filler] Generated ${entry.id} (${Math.round(dur)}ms)`, 'green');
      generated++;
    } catch (err) {
      logger.error(`[Filler] Failed to generate ${entry.id}:`, err);
    }
  }

  fillersReady = generated > 0;
  logger.info(`[Filler] Generation complete: ${generated}/${total}`, 'green');
  return generated;
}

// ─── Selection ───────────────────────────────────────────────────────────────

function buildSelectionList(): string {
  const lines: string[] = [];

  lines.push('=== 短いリアクション ===');
  for (const f of ATOMIC_FILLERS) {
    lines.push(`${f.id}: "${f.text}"`);
  }

  lines.push('=== 組み合わせ ===');
  for (const c of COMBO_DEFINITIONS) {
    const texts = c.fillerIds
      .map(id => FILLER_DEFINITIONS.find(f => f.id === id)?.text ?? id)
      .join('→');
    lines.push(`${c.id}: "${texts}"`);
  }

  lines.push('=== 長めフレーズ ===');
  for (const f of PHRASE_FILLERS) {
    lines.push(`${f.id}: "${f.text}"`);
  }

  return lines.join('\n');
}

/**
 * Use gpt-4.1-nano to select the best filler(s) for the user's message.
 *
 * Returns:
 * - { fillerIds: [...], fillerOnly: false } → play filler(s), then generate LLM response
 * - { fillerIds: [...], fillerOnly: true }  → filler(s) are enough, skip LLM
 * - { fillerIds: [], fillerOnly: false }    → no filler, go straight to LLM
 */
/**
 * Parse the model's response into a list of filler IDs.
 * Supports: single ID, combo ID, or "+" separated free combination.
 */
function parseFillerResponse(raw: string): string[] {
  // Try as combo first
  const combo = COMBO_DEFINITIONS.find(c => c.id === raw);
  if (combo) return combo.fillerIds;

  // Try as single filler
  if (FILLER_DEFINITIONS.some(f => f.id === raw)) return [raw];

  // Try as "+" separated free combination
  if (raw.includes('+')) {
    const parts = raw.split('+').map(s => s.trim()).filter(Boolean);
    const ids: string[] = [];
    for (const part of parts) {
      // Each part can be a combo or an atomic/phrase
      const partCombo = COMBO_DEFINITIONS.find(c => c.id === part);
      if (partCombo) {
        ids.push(...partCombo.fillerIds);
      } else if (FILLER_DEFINITIONS.some(f => f.id === part)) {
        ids.push(part);
      }
    }
    if (ids.length > 0) return ids;
  }

  // Fuzzy match: model might have returned something close
  const allIds = [...COMBO_DEFINITIONS.map(c => c.id), ...FILLER_DEFINITIONS.map(f => f.id)];
  const matched = allIds.find(id => raw.includes(id));
  if (matched) {
    const matchedCombo = COMBO_DEFINITIONS.find(c => c.id === matched);
    if (matchedCombo) return matchedCombo.fillerIds;
    return [matched];
  }

  return [];
}

export async function selectFiller(
  transcribedText: string,
  userName: string,
  conversationContext?: string,
): Promise<FillerSelection> {
  const openai = getTracedOpenAI(new OpenAI({ apiKey: config.openaiApiKey }));
  const selectionList = buildSelectionList();

  const contextBlock = conversationContext
    ? `\n\n=== 直近の会話 ===\n${conversationContext}\n=== ここまで ===\n上記の会話の流れを踏まえて、最新の発言に対するリアクションを選んでください。`
    : '';

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      max_tokens: 60,
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content: `あなたはシャノン（ツンデレで自信過剰なAI）です。ユーザーの発言を聞いた直後の「第一声」を選んでください。

重要: フィラーはユーザーの発言に対する自然な第一声であること。発言の内容・意図に合ったリアクションを選ぶこと。

場面別ガイド:
- 質問された → 「ふむふむ」「ふ～ん」「うーん」「そうだなぁ」系（考える・受ける。「いい質問」は連続で使わない）
- 報告・共有 → 「そうなんだ」「ふーん」「まじで」「だよね」系（リアクション）
- 依頼・お願い・無茶ぶり → 「しょうがないなあ」「無茶ぶりだなあ」「ボクに任せて」「めんどくさいなあ」系
- 挨拶 → 挨拶系のフィラーで返す（fillerOnly）
- 褒められた → 「べ、別に嬉しくないけど」系（照れ）
- 驚く内容 → 「え！？」「まじで！？」系（驚き）
- 理不尽・ムカつく → 「ふざけるな！」「ふん！」系（怒り）
- ミスした時 → 「ごめん、間違えた」「あれ？間違えた？」系

fillerOnly（!）の判断基準:
- 挨拶に挨拶で返す場合 → fillerOnly OK
- 短い相槌だけで済む場合 → fillerOnly OK
- それ以外（質問・依頼・話題提供など）→ 絶対にfillerOnlyにしない。必ず本文を生成させる

NG例:
- 「面白い話して」→ ×「やったぜ！」（依頼なのに歓喜は不自然。「無茶ぶりだなあ」「しょうがないなあ」が適切）
- 「好きなテレビ番組は？」→ ×「わかった」「完全にわかった」（理解の意味。質問には不適切）
- 「こんにちは」→ ×「えっとね」（挨拶に思考は不自然）
- 質問・依頼・話題提供 → ×fillerOnly（本文が必要な場面でフィラーだけで終わらせない）
- 連続で同じフィラー → ×（「いい質問じゃん」を3回連続など。バリエーションを出す）
- 「今上映中の映画は？」→ ×[tools]なし（現在の情報は検索が必要。必ず[tools]を付ける）

== ツール判定（最重要） ==
回答に外部情報が必要な場合は必ず [tools] を付けること。判定ミスは致命的。

[tools] を付ける:
- 「今上映中の映画は？」「最近のニュース教えて」→ 現在の情報が必要 → [tools]
- 「〇〇って何？」「〇〇について教えて」→ 正確な事実が必要 → [tools]
- 「天気教えて」「明日の天気は？」→ 天気情報 → [tools]
- 計算を求められた → [tools]
- URL・Webの内容を聞かれた → [tools]
- Discordのチャットについて聞かれた → [tools]

[tools] 不要:
- 「好きな食べ物は？」「どう思う？」→ 感想・雑談
- 挨拶、相槌

== フィラー選択ルール ==
1. 定義済みコンボ（c_）、長めフレーズ（p_）、短いリアクション（a_）の全てから最適なものを選ぶ
2. 短いリアクション（a_）単体でも十分。短い方が自然なことが多い
3. 組み合わせ（+）は最大3つ。声に出して自然に繋がるものだけ
4. 長めフレーズ（p_）は単体で使用
5. フィラーだけで完結する場合（挨拶・相槌など）は末尾に ! を付ける
6. どれも合わない場合は none
7. 多様性を重視。直前と同じフィラーを選ばない

回答形式（1行のみ）:
ID [tools] → ツールが必要、本文も生成
ID → ツール不要、本文も生成
ID! → フィラーだけで十分
none → フィラーなし
none [tools] → フィラーなし、ツールが必要

${selectionList}${contextBlock}`,
        },
        {
          role: 'user',
          content: `${userName}: ${transcribedText}`,
        },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? '';

    const needsTools = raw.includes('[tools]');
    const stripped = raw.replace(/\[tools\]/g, '').trim();

    if (stripped === 'none' || stripped === '') {
      return { fillerIds: [], fillerOnly: false, needsTools };
    }

    const fillerOnly = stripped.endsWith('!');
    const cleanRaw = stripped.replace(/!$/, '').trim();

    const resolved = parseFillerResponse(cleanRaw);
    if (resolved.length > 0 && resolved.every(id => fillerCache.has(id))) {
      return { fillerIds: resolved, fillerOnly, needsTools };
    }

    return { fillerIds: [], fillerOnly: false, needsTools };
  } catch (err) {
    logger.error('[Filler] Selection failed, using weighted fallback:', err);
    return weightedFallbackSelection(transcribedText);
  }
}

/**
 * LLM フィラー選択が失敗した場合の重み付きフォールバック。
 * ユーザー発言のキーワードからカテゴリを推定し、そのカテゴリのフィラーを高確率で選択。
 */
function weightedFallbackSelection(text: string): FillerSelection {
  const CATEGORY_WEIGHTS: Record<string, number> = {
    affirm: 3,
    respond: 3,
    thinking: 2,
    exclaim: 1,
    question: 1,
    tsun: 1,
    sympathy: 1,
    greeting: 1,
  };

  const lower = text.toLowerCase();
  if (lower.match(/\?|？|教えて|何|どう|なぜ/)) {
    CATEGORY_WEIGHTS['thinking'] = 5;
    CATEGORY_WEIGHTS['question'] = 3;
  } else if (lower.match(/ありがとう|感謝|助か/)) {
    CATEGORY_WEIGHTS['respond'] = 5;
    CATEGORY_WEIGHTS['affirm'] = 3;
  } else if (lower.match(/おはよう|こんにちは|こんばんは/)) {
    CATEGORY_WEIGHTS['greeting'] = 10;
  } else if (lower.match(/すごい|やばい|まじ|えっ/)) {
    CATEGORY_WEIGHTS['exclaim'] = 5;
  }

  const weighted: { entry: FillerEntry; weight: number }[] = ATOMIC_FILLERS.map((f) => ({
    entry: f,
    weight: CATEGORY_WEIGHTS[f.category] ?? 1,
  }));

  const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
  let random = Math.random() * totalWeight;
  for (const w of weighted) {
    random -= w.weight;
    if (random <= 0) {
      return { fillerIds: [w.entry.id], fillerOnly: false, needsTools: false };
    }
  }

  return { fillerIds: ['a_fumufumu'], fillerOnly: false, needsTools: false };
}
