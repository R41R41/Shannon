/**
 * dc-voice: the speaking mouth. Public entry for the rest of the program (event reporters, Minebot, ...):
 *
 *   import { getVoiceMouth } from '../discord/voice/voiceMouth.js';
 *   getVoiceMouth().say({ text: 'ダイヤ見つけた！', source: 'minecraft:milestone', priority: 'normal' });
 *   getVoiceMouth().setSituation({ text: '鉄を探して洞窟を下りている。', ttlMs: 60_000 });
 *
 * Never throws. With `SHANNON_DC_VOICE` (and `SHANNON_DC_VOICE_MOUTH`) off, or when the bot is not in a VC that is
 * served through the head, `say` just reports `accepted:false`. The logic is in voiceMouthCore.ts.
 */
import { config } from '../../../config/env.js';
import { createLogger } from '../../../utils/logger.js';
import { VoiceMouth } from './voiceMouthCore.js';

export type {
  MouthDone,
  MouthHost,
  MouthLineHandle,
  MouthSayInput,
  MouthSayResult,
} from './voiceMouthCore.js';
export { VoiceMouth } from './voiceMouthCore.js';

const logger = createLogger('Discord:VoiceMouth');

let instance: VoiceMouth | null = null;

export function getVoiceMouth(): VoiceMouth {
  instance ??= new VoiceMouth({
    enabled: () => config.dcVoice.enabled && config.dcVoice.mouth,
    log: (line) => logger.info(line, 'cyan'),
  });
  return instance;
}

/** Tests only. */
export function resetVoiceMouthForTests(replacement?: VoiceMouth): void {
  instance = replacement ?? null;
}
