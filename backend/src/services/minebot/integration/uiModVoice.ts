import { CONFIG } from '../config/MinebotConfig.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:UiModVoice');

export interface UiModVoiceTranscript {
  /** What speech-to-text heard. */
  text: string;
  /** The speaker's Discord name. */
  discordName: string;
  /** Where the words went: an order to the bot, or conversation. */
  mode: 'chat' | 'minebot';
}

/**
 * Shows the speaker, in Minecraft, what was heard (ShannonUIMod's push-to-talk box).
 *
 * The same words are already posted to the Discord channel. The mod delivers them only to the online player with the
 * resolved Minecraft name and drops them otherwise, so other players never see someone else's voice. A missing mod is
 * not an error.
 */
export async function notifyUiModVoiceTranscript(input: UiModVoiceTranscript, fetcher: typeof fetch = fetch): Promise<void> {
  const text = input.text.trim();
  if (!text || !input.discordName) return;
  try {
    const response = await fetcher(`${CONFIG.UI_MOD_BASE_URL}/voice_transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text, speaker: input.discordName, mcUsername: CONFIG.resolveMinecraftName(input.discordName), mode: input.mode }),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) log.warn(`UI Mod voice transcript notification failed: ${response.status}`);
  } catch {
    // The mod is not running; Discord already shows the transcript.
  }
}
