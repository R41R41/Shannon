import { createLogger } from '../../../utils/logger.js';
import { combatKnowledgePlugin } from './combatKnowledge.js';
import { describeFloorConfig, floorConfig, type FloorConfig } from './floorConfig.js';
import { installFloorReflexes } from './floorReflexes.js';
import { reflexLedgerPlugin } from './reflexLedger.js';

const log = createLogger('Minebot:FloorLayer');

/**
 * What common-FCA mode loads for the body's own reflexes, in one place (P8): the reflex ledger always, then by the switch
 * (`floorConfig`, read once, here) the floor and the combat-knowledge providers. `client.ts` calls this when
 * `MINEBOT_COMMON_FCA=on`; it takes the bot's `loadPlugin` and nothing else of the client, so a test can run it against a fake bot and see
 * what each setting really installs (the plugins get the config read here, not a second read of the environment).
 */
export function loadFloorLayer(bot: { loadPlugin(plugin: (bot: any) => void): void }, env: Record<string, string | undefined> = process.env): FloorConfig {
  const reflexes = floorConfig(env);
  log.info(describeFloorConfig(reflexes));
  // A setting that was not understood is an error in the journal, not a warning: it decides what the body does.
  for (const warning of reflexes.warnings) { if (warning.startsWith('‼')) log.error(`🧱 ${warning}`); else log.warn(`🧱 ${warning}`); }
  bot.loadPlugin(reflexLedgerPlugin);
  if (reflexes.floor) bot.loadPlugin(target => installFloorReflexes(target, reflexes));
  if (reflexes.combatKnowledge) bot.loadPlugin(combatKnowledgePlugin);
  return reflexes;
}
