/**
 * ゲーム内チャットは **1通・短い文字列のみ**送る（長文・複数通はキック要因になりやすい）。
 * 全文は UI Mod 通知や task-complete 等で扱う。
 */

import { CONFIG } from '../config/MinebotConfig.js';
import type { CustomBot } from '../types/CustomBot.js';

/**
 * 改行・連続空白を潰し、maxChars を超えたら末尾を「…」で省略（1行）。
 */
export function truncateForGameChat(text: string, maxChars: number): string {
  const singleLine = text
    .replace(/\r\n/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  const ellipsis = '…';
  const take = Math.max(1, maxChars - ellipsis.length);
  return singleLine.slice(0, take) + ellipsis;
}

/**
 * 短く整形した文字列を **1回だけ** bot.chat する。
 */
export function sendGameChatLimited(
  bot: CustomBot,
  message: string,
  maxChars: number = CONFIG.MINECRAFT_CHAT_MAX_CHARS,
): string {
  const out = truncateForGameChat(message, maxChars);
  if (out.length > 0) {
    bot.chat(out);
  }
  return out;
}
