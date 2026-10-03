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
