#!/usr/bin/env node
/**
 * Loads every current Minebot skill from source and runs one or more practical
 * SelfTestRunner suites against an explicitly isolated Minecraft server.
 *
 * Unlike the small command-oracle smoke probe, this runner loads the same
 * Mineflayer plugins and the complete InstantSkill/ConstantSkill catalogue so
 * large scenarios can exercise production implementations without starting
 * Shannon's LLM or service runtime.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mineHawkEyePackage from 'minecrafthawkeye';
import mineflayer from 'mineflayer';
import { plugin as collectBlock } from 'mineflayer-collectblock';
import { pathfinder } from 'mineflayer-pathfinder';
import { plugin as projectile } from 'mineflayer-projectile';
import { plugin as pvp } from 'mineflayer-pvp';
import { plugin as toolPlugin } from 'mineflayer-tool';
import { SelfTestRunner } from '../src/services/llm/graph/cognitive/selfImprove/SelfTestRunner.js';
import type { ConstantSkill, CustomBot, InstantSkill } from '../src/services/minebot/types.js';
import { ConstantSkills, InstantSkills } from '../src/services/minebot/types.js';
import { Utils } from '../src/services/minebot/utils/index.js';

const host = process.env.MINECRAFT_PROBE_HOST?.trim() || '127.0.0.1';
const port = positiveInteger(process.env.MINECRAFT_PROBE_PORT) ?? 25_577;
const version = process.env.MINECRAFT_PROBE_VERSION?.trim() || '1.21.11';
const username = process.env.MINECRAFT_PROBE_USERNAME?.trim() || 'ShannonProbe';
const actorUsername = process.env.MINECRAFT_PROBE_ACTOR_USERNAME?.trim() || 'ProbeActor';
const timeoutMilliseconds = positiveInteger(process.env.MINECRAFT_PROBE_TIMEOUT_MS) ?? 600_000;
const sharedServerAllowed = process.env.MINECRAFT_PROBE_ALLOW_SHARED_SERVER === 'true';
const suites = (process.env.MINECRAFT_PRACTICAL_SUITES ?? '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const selectedSkillNames = (process.env.MINECRAFT_PRACTICAL_SKILL_NAMES ?? '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

if (suites.length === 0) {
  throw new Error('MINECRAFT_PRACTICAL_SUITES must list at least one practical suite');
}
if (username.length < 1 || username.length > 16) {
  throw new Error('MINECRAFT_PROBE_USERNAME must be 1-16 characters');
}
if (!/^[A-Za-z0-9_]{1,16}$/.test(actorUsername)) {
  throw new Error('MINECRAFT_PROBE_ACTOR_USERNAME must be 1-16 characters');
}
if (!suites.every(name => /^practical-[a-z0-9-]+$/.test(name))) {
  throw new Error('Only practical-* suites are permitted by this destructive probe');
}
if (!sharedServerAllowed && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
  throw new Error('Practical probe only permits a loopback server by default');
}
if (!sharedServerAllowed && port >= 25_565 && port <= 25_569) {
  throw new Error('Practical probe refuses known shared Minecraft ports by default');
}

const bot = mineflayer.createBot({
  host,
  port,
  username,
  auth: 'offline',
  version,
  checkTimeoutInterval: timeoutMilliseconds,
}) as CustomBot;
let actor: ReturnType<typeof mineflayer.createBot> | null = null;

bot.loadPlugin(pathfinder);
bot.loadPlugin(collectBlock);
bot.loadPlugin(projectile);
bot.loadPlugin(pvp);
bot.loadPlugin(toolPlugin);
try {
  bot.loadPlugin(mineHawkEyePackage.default);
} catch (error) {
  process.stderr.write(`MINECRAFT_PRACTICAL_HAWKEYE_LOAD_WARNING ${messageOf(error)}\n`);
}

bot.isTest = true;
bot.chatMode = false;
bot.connectedServerName = 'isolated-practical-skills-probe';
bot.attackEntity = null;
bot.runFromEntity = null;
bot.goal = null;
bot.interruptExecution = false;
bot.executingSkill = false;
bot.activeFurnaces = [];
bot.instantSkills = new InstantSkills();
bot.constantSkills = new ConstantSkills();
bot.utils = new Utils(bot);
bot.selfState = {
  botPosition: null,
  botHealth: '20/20',
  botFoodLevel: '20/20',
  botExperienceLevel: 0,
  botTotalExperience: 0,
  botExperienceBarProgress: 0,
  botHeldItem: '',
  lookingAt: null,
  inventory: [],
};
bot.environmentState = {
  senderName: '',
  senderPosition: null,
  weather: '',
  time: '',
  biome: '',
  dimension: null,
  bossbar: null,
};

const timeout = setTimeout(() => finish(1, 'MINECRAFT_PRACTICAL_PROBE_TIMEOUT'), timeoutMilliseconds);
bot.once('error', error => finish(1, `MINECRAFT_PRACTICAL_PROBE_ERROR ${error.message}`));
bot.once('kicked', reason => finish(1, `MINECRAFT_PRACTICAL_PROBE_KICKED ${stringifyReason(reason)}`));
bot.once('spawn', async () => {
  const startedAt = Date.now();
  try {
    // A preceding portal test can persist the offline test player's logout
    // dimension. Every destructive probe must start from its isolated
    // overworld fixture, independent of prior runs.
    bot.chat('/execute in minecraft:overworld run tp @s 0 100 0');
    await new Promise(resolve => setTimeout(resolve, 1500));
    actor = await createActor();
    // Keep the supporting player out of ordinary physical scenarios. Suites
    // that exercise player-facing skills explicitly teleport it into place.
    bot.chat(`/tp ${actorUsername} 30 100 30`);
    await new Promise(resolve => setTimeout(resolve, 500));
    const loaded = await loadAllSkills(bot);
    const report = await new SelfTestRunner().runMultiple(bot, suites, {
      autoFix: false,
      trigger: 'manual',
      skillNames: selectedSkillNames.length > 0 ? selectedSkillNames : undefined,
    });
    const testedNames = report.skillReports.map(skill => skill.skillName).sort();
    const assertions = report.skillReports.flatMap(skill =>
      skill.initialTestResults.flatMap(result => result.serverAssertions ?? []),
    );
    const output = {
      ok: report.summary.totalTested > 0
        && report.summary.unfixable === 0
        && report.summary.skipped === 0
        && report.summary.passed === report.summary.totalTested
        && assertions.every(assertion => assertion.passed),
      probe: 'minecraft-practical-skills-live-probe',
      server: { host, port, version },
      suites,
      loaded,
      testedSkillNames: testedNames,
      untestedLoadedSkillNames: [...loaded.instant, ...loaded.constant]
        .filter(name => !testedNames.includes(name))
        .sort(),
      summary: report.summary,
      skills: report.skillReports.map(skill => ({
        skillName: skill.skillName,
        finalStatus: skill.finalStatus,
        tests: skill.initialTestResults.map(result => ({
          description: result.testCase.description,
          passed: result.passed,
          skillSuccess: result.skillResult?.success ?? null,
          result: result.skillResult?.result ?? null,
          error: result.errorMessage,
          durationMs: result.durationMs,
          assertions: (result.serverAssertions ?? []).map(assertion => ({
            assertion: assertion.assertion,
            passed: assertion.passed,
            durationMs: assertion.durationMs,
            error: assertion.error,
          })),
        })),
      })),
      totalDurationMs: Date.now() - startedAt,
    };
    process.stdout.write(`MINECRAFT_PRACTICAL_SKILLS_REPORT ${JSON.stringify(output)}\n`);
    finish(output.ok ? 0 : 1);
  } catch (error) {
    process.stdout.write(`MINECRAFT_PRACTICAL_SKILLS_REPORT ${JSON.stringify({
      ok: false,
      probe: 'minecraft-practical-skills-live-probe',
      server: { host, port, version },
      suites,
      fatalError: messageOf(error),
      totalDurationMs: Date.now() - startedAt,
    })}\n`);
    finish(1);
  }
});

async function loadAllSkills(targetBot: CustomBot): Promise<{ instant: string[]; constant: string[] }> {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const minebotDirectory = path.resolve(scriptDirectory, '../src/services/minebot');
  const instant = await loadDirectory<InstantSkill>(path.join(minebotDirectory, 'instantSkills'), targetBot);
  const constant = await loadDirectory<ConstantSkill>(path.join(minebotDirectory, 'constantSkills'), targetBot);
  for (const skill of instant) targetBot.instantSkills.addSkill(skill);
  for (const skill of constant) targetBot.constantSkills.addSkill(skill);
  return {
    instant: instant.map(skill => skill.skillName).sort(),
    constant: constant.map(skill => skill.skillName).sort(),
  };
}

async function loadDirectory<T extends { skillName: string }>(directory: string, targetBot: CustomBot): Promise<T[]> {
  const files = fs.readdirSync(directory)
    .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .sort();
  const loaded: T[] = [];
  for (const file of files) {
    const module = await import(`${pathToFileURL(path.join(directory, file)).href}?probe=1`);
    if (typeof module.default !== 'function') {
      throw new Error(`${file} has no default skill class export`);
    }
    loaded.push(new module.default(targetBot) as T);
  }
  return loaded;
}

let finished = false;
function finish(exitCode: number, message?: string): void {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (message) process.stderr.write(`${message}\n`);
  process.exitCode = exitCode;
  bot.constantSkills.destroy();
  actor?.end('practical skills probe complete');
  bot.end('practical skills probe complete');
}

function createActor(): Promise<ReturnType<typeof mineflayer.createBot>> {
  return new Promise((resolve, reject) => {
    const created = mineflayer.createBot({
      host,
      port,
      username: actorUsername,
      auth: 'offline',
      version,
      checkTimeoutInterval: timeoutMilliseconds,
    });
    const timer = setTimeout(() => {
      created.end('actor spawn timeout');
      reject(new Error('MINECRAFT_PROBE_ACTOR_SPAWN_TIMEOUT'));
    }, 20_000);
    created.once('spawn', () => {
      clearTimeout(timer);
      resolve(created);
    });
    created.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function stringifyReason(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 500);
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}
