#!/usr/bin/env node
/**
 * Runs one real SelfTestRunner suite against an explicitly supplied isolated
 * Minecraft server. It intentionally registers only the read-only skills used
 * by command-oracle-smoke, so no full Shannon runtime or LLM is required.
 */
import mineflayer from 'mineflayer';
import { SelfTestRunner } from '../src/services/llm/graph/cognitive/selfImprove/SelfTestRunner.js';
import CheckInventoryItem from '../src/services/minebot/instantSkills/checkInventoryItem.js';
import GetPosition from '../src/services/minebot/instantSkills/getPosition.js';
import type { CustomBot } from '../src/services/minebot/types.js';
import { ConstantSkills, InstantSkills } from '../src/services/minebot/types.js';
import { Utils } from '../src/services/minebot/utils/index.js';

const host = process.env.MINECRAFT_PROBE_HOST?.trim() || '127.0.0.1';
const port = positiveInteger(process.env.MINECRAFT_PROBE_PORT) ?? 25577;
const version = process.env.MINECRAFT_PROBE_VERSION?.trim() || '1.21.11';
const username = process.env.MINECRAFT_PROBE_USERNAME?.trim() || 'ShannonProbe';
const suiteName = process.env.MINECRAFT_SELF_TEST_SUITE?.trim() || 'command-oracle-smoke';
const timeoutMilliseconds = positiveInteger(process.env.MINECRAFT_PROBE_TIMEOUT_MS) ?? 45_000;
const sharedServerAllowed = process.env.MINECRAFT_PROBE_ALLOW_SHARED_SERVER === 'true';

if (username.length < 1 || username.length > 16) {
  throw new Error('MINECRAFT_PROBE_USERNAME must be 1-16 characters');
}
if (!/^[a-zA-Z0-9_-]+$/.test(suiteName)) {
  throw new Error('MINECRAFT_SELF_TEST_SUITE contains unsupported characters');
}
if (!sharedServerAllowed && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
  throw new Error('Live self-test probe only permits a loopback server by default');
}
if (!sharedServerAllowed && port >= 25_565 && port <= 25_569) {
  throw new Error('Live self-test probe refuses known shared Minecraft ports by default');
}
if (suiteName !== 'command-oracle-smoke') {
  throw new Error('Standalone probe currently permits only command-oracle-smoke');
}

const bot = mineflayer.createBot({
  host,
  port,
  username,
  auth: 'offline',
  version,
  checkTimeoutInterval: timeoutMilliseconds,
}) as CustomBot;

bot.isTest = true;
bot.chatMode = false;
bot.connectedServerName = 'isolated-command-oracle';
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
bot.instantSkills.addSkill(new GetPosition(bot));
bot.instantSkills.addSkill(new CheckInventoryItem(bot));

const timeout = setTimeout(() => {
  finish(1, 'MINECRAFT_SELF_TEST_PROBE_TIMEOUT');
}, timeoutMilliseconds);

bot.once('error', error => finish(1, `MINECRAFT_SELF_TEST_PROBE_ERROR ${error.message}`));
bot.once('kicked', reason => finish(1, `MINECRAFT_SELF_TEST_PROBE_KICKED ${stringifyReason(reason)}`));
bot.once('spawn', async () => {
  try {
    const report = await new SelfTestRunner().runFromFile(bot, suiteName, {
      autoFix: false,
      trigger: 'manual',
      persistReport: false,
    });
    const assertions = report.skillReports.flatMap(skillReport =>
      skillReport.initialTestResults.flatMap(result => result.serverAssertions ?? []),
    );
    const ok = report.summary.unfixable === 0
      && report.summary.skipped === 0
      && report.summary.passed === report.summary.totalTested
      && assertions.length > 0
      && assertions.every(result => result.passed);

    process.stdout.write(`${JSON.stringify({
      ok,
      suite: suiteName,
      server: { host, port, version },
      summary: report.summary,
      skills: report.skillReports.map(skillReport => ({
        skillName: skillReport.skillName,
        finalStatus: skillReport.finalStatus,
        tests: skillReport.initialTestResults.map(result => ({
          description: result.testCase.description ?? null,
          skillSuccess: result.skillResult?.success ?? null,
          passed: result.passed,
          error: result.errorMessage,
          assertions: (result.serverAssertions ?? []).map(assertion => ({
            assertion: assertion.assertion,
            passed: assertion.passed,
            durationMs: assertion.durationMs,
            error: assertion.error,
          })),
        })),
      })),
    }, null, 2)}\n`);
    finish(ok ? 0 : 1);
  } catch (error) {
    finish(1, `MINECRAFT_SELF_TEST_PROBE_FAILED ${error instanceof Error ? error.message : String(error)}`);
  }
});

let finished = false;
function finish(exitCode: number, message?: string): void {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (message) process.stderr.write(`${message}\n`);
  process.exitCode = exitCode;
  bot.constantSkills.destroy();
  bot.end('live self-test probe complete');
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function stringifyReason(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 500);
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}
