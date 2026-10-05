import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mineflayer from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import { plugin as collectBlock } from 'mineflayer-collectblock';
import { plugin as projectile } from 'mineflayer-projectile';
import { plugin as pvp } from 'mineflayer-pvp';
import { plugin as toolPlugin } from 'mineflayer-tool';
import { ConstantSkills, InstantSkills, type CustomBot } from '../types.js';
import { Utils } from '../utils/index.js';
import { installPlayerLoadedHandshake } from '../utils/playerLoadedHandshake.js';
import { installTierToolMaterialRepair } from '../utils/registryRepairs.js';
import { installAirSupplyDefault } from '../utils/airSupplyDefault.js';
import { edgeGuardPlugin } from '../utils/edgeGuard.js';
import { breathingReflexPlugin } from '../utils/breathingReflex.js';
import { exertionMeterPlugin } from '../utils/exertionMeter.js';
import { threatTrackerPlugin } from '../utils/threatTracker.js';
import { toolWearPlugin } from '../utils/toolWear.js';
import { landmarkWatcherPlugin } from '../utils/landmarks.js';
import { placeMemoryPlugin } from '../utils/placeMemory.js';
import { fireballDeflectPlugin } from '../utils/fireballDeflect.js';
import { shieldBlockPlugin } from '../utils/shieldBlock.js';
import { knockBracePlugin } from '../utils/knockBrace.js';
import { digConfirmationPlugin } from '../utils/digConfirmation.js';
import { serverRefusalPlugin } from '../utils/serverRefusals.js';
import { lavaDigGuardPlugin, lavaReflexPlugin } from '../utils/lavaSafety.js';
import { gazeGuardPlugin } from '../utils/gazeGuard.js';
import { exposureDigGuardPlugin } from '../utils/exposureGuard.js';
import { promptPlacePlugin } from '../utils/promptPlace.js';
import { installCollisionTolerance } from '../utils/collisionTolerance.js';
import { installToolChoice } from '../utils/toolChoice.js';

installCollisionTolerance();
import { installMotionRecorder } from '../utils/motionRecorder.js';

/**
 * A real Minecraft account, for a lab server that checks logins (one people join from outside). The tokens are
 * read from `profilesFolder`, where scripts/lab/minecraft-account-login.mjs left them after the owner approved
 * the sign-in.
 */
export interface ProbeAccount { email: string; profilesFolder: string }

export async function createProbeBot(port: number, username = 'ShannonProbe', account?: ProbeAccount): Promise<CustomBot> {
  if (!account && !/^[A-Za-z0-9_]{1,16}$/.test(username)) throw new Error('ISOLATED_USERNAME_INVALID');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || (port >= 25565 && port <= 25569)) {
    throw new Error('Invalid isolated probe port');
  }
  const bot = mineflayer.createBot({ host: '127.0.0.1', port, version: '1.21.11', checkTimeoutInterval: 180000,
    ...(account
      ? { username: account.email, auth: 'microsoft' as const, profilesFolder: account.profilesFolder,
        // A run never waits for the owner to approve a sign-in (it would sit there polling Microsoft).
        onMsaCode: () => { console.error('PROBE_ACCOUNT_SIGN_IN_REQUIRED'); process.exit(78); } }
      : { username, auth: 'offline' as const }) }) as CustomBot;
  installPlayerLoadedHandshake(bot);
  installTierToolMaterialRepair(bot);
  installAirSupplyDefault(bot);
  installMotionRecorder(bot);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Spawn timeout')), 30000);
    bot.once('spawn', () => { clearTimeout(timer); resolve(); });
    bot.once('error', error => { clearTimeout(timer); reject(error); });
    bot.once('kicked', reason => { clearTimeout(timer); reject(new Error(String(reason))); });
  });
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(collectBlock);
  bot.loadPlugin(projectile);
  bot.loadPlugin(pvp);
  bot.loadPlugin(toolPlugin);
  installToolChoice(bot);
  bot.loadPlugin(edgeGuardPlugin);
  bot.loadPlugin(breathingReflexPlugin);
  bot.loadPlugin(exertionMeterPlugin);
  bot.loadPlugin(threatTrackerPlugin);
  bot.loadPlugin(toolWearPlugin);
  bot.loadPlugin(landmarkWatcherPlugin);
  bot.loadPlugin(placeMemoryPlugin);
  bot.loadPlugin(digConfirmationPlugin);
  bot.loadPlugin(serverRefusalPlugin);
  bot.loadPlugin(lavaDigGuardPlugin);
  bot.loadPlugin(exposureDigGuardPlugin);
  bot.loadPlugin(promptPlacePlugin);
  bot.loadPlugin(lavaReflexPlugin);
  bot.loadPlugin(gazeGuardPlugin);
  bot.loadPlugin(fireballDeflectPlugin);
  bot.loadPlugin(shieldBlockPlugin);
  bot.loadPlugin(knockBracePlugin);
  Object.assign(bot, {
    isTest: true, chatMode: false, connectedServerName: 'isolated-progressive-probe',
    attackEntity: null, runFromEntity: null, goal: null, interruptExecution: false,
    executingSkill: false, activeFurnaces: [], instantSkills: new InstantSkills(),
    constantSkills: new ConstantSkills(),
    selfState: { botPosition: null, botHealth: '20/20', botFoodLevel: '20/20',
      botExperienceLevel: 0, botTotalExperience: 0, botExperienceBarProgress: 0,
      botHeldItem: '', lookingAt: null, inventory: [] },
    environmentState: { senderName: '', senderPosition: null, weather: '', time: '',
      biome: '', dimension: null, bossbar: null },
  });
  bot.utils = new Utils(bot);
  const minebot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const kind of ['instant', 'constant'] as const) {
    const directory = path.join(minebot, `${kind}Skills`);
    for (const file of fs.readdirSync(directory).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort()) {
      const module = await import(pathToFileURL(path.join(directory, file)).href);
      const skill = new module.default(bot);
      if (kind === 'instant') bot.instantSkills.addSkill(skill);
      else bot.constantSkills.addSkill(skill);
    }
  }
  return bot;
}

export function closeProbeBot(bot: CustomBot): void {
  bot.interruptExecution = true;
  bot.pathfinder?.stop();
  bot.clearControlStates();
  bot.constantSkills.destroy();
  bot.end('isolated progressive trial complete');
}
