import { CONFIG } from '../config/MinebotConfig.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:UiModChat');

/**
 * Shows something the bot said in ShannonUIMod's conversation and speech bubble.
 *
 * Only for words the bot also says in game chat, so the Mod never sees more than the players on
 * the server already do. A missing Mod is not an error.
 */
export async function notifyUiModChat(message: string, fetcher: typeof fetch = fetch): Promise<void> {
  const text = message.trim();
  if (!text) return;
  try {
    const response = await fetcher(`${CONFIG.UI_MOD_BASE_URL}/bot_chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ message: text }),
    });
    if (!response.ok) log.warn(`UI Mod chat notification failed: ${response.status}`);
  } catch {
    // The Mod is not running; game chat already carries the message.
  }
}

export interface UiModVoiceTranscript {
  /** What speech-to-text heard. */
  text: string;
  /** The speaker's Discord name. */
  discordName: string;
  /** Where the words went: an order to the bot, or conversation. */
  mode: 'chat' | 'minebot';
}

/**
 * Shows the speaker, in Minecraft, what the bot heard (ShannonUIMod's push-to-talk box).
 *
 * The same words are already posted to the Discord channel. The Mod delivers them only to the
 * online player with the resolved Minecraft name and drops them otherwise, so other players never
 * see someone else's voice.
 */
export async function notifyUiModVoiceTranscript(
  input: UiModVoiceTranscript,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const text = input.text.trim();
  if (!text || !input.discordName) return;
  try {
    const response = await fetcher(`${CONFIG.UI_MOD_BASE_URL}/voice_transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({
        text,
        speaker: input.discordName,
        mcUsername: CONFIG.resolveMinecraftName(input.discordName),
        mode: input.mode,
      }),
    });
    if (!response.ok) log.warn(`UI Mod voice transcript notification failed: ${response.status}`);
  } catch {
    // The Mod is not running; Discord already shows the transcript.
  }
}
