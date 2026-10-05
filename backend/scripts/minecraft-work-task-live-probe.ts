#!/usr/bin/env node
/**
 * Runs a destructive, server-authoritative Minecraft work trial against an
 * explicitly supplied isolated server. The probe builds a small test arena,
 * executes Shannon's real production skills, and verifies world state with
 * Minecraft commands instead of trusting skill return values alone.
 */
import mineflayer from 'mineflayer';
import { plugin as collectBlock } from 'mineflayer-collectblock';
import { pathfinder } from 'mineflayer-pathfinder';
import { plugin as toolPlugin } from 'mineflayer-tool';
import CraftOne from '../src/services/minebot/instantSkills/craftOne.js';
import DigBlockAt from '../src/services/minebot/instantSkills/digBlockAt.js';
import MineBlock from '../src/services/minebot/instantSkills/mineBlock.js';
import MoveTo from '../src/services/minebot/instantSkills/moveTo.js';
import PlaceBlockAt from '../src/services/minebot/instantSkills/placeBlockAt.js';
import StartSmelting from '../src/services/minebot/instantSkills/startSmelting.js';
import WithdrawFromFurnace from '../src/services/minebot/instantSkills/withdrawFromFurnace.js';
import { MinecraftCommandOracle, type MinecraftCommandAssertion } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import type { CustomBot, InstantSkill } from '../src/services/minebot/types.js';
import { ConstantSkills, InstantSkills } from '../src/services/minebot/types.js';
import { Utils } from '../src/services/minebot/utils/index.js';

const host = process.env.MINECRAFT_PROBE_HOST?.trim() || '127.0.0.1';
const port = positiveInteger(process.env.MINECRAFT_PROBE_PORT) ?? 25_577;
const version = process.env.MINECRAFT_PROBE_VERSION?.trim() || '1.21.11';
const username = process.env.MINECRAFT_PROBE_USERNAME?.trim() || 'ShannonProbe';
const timeoutMilliseconds = positiveInteger(process.env.MINECRAFT_PROBE_TIMEOUT_MS) ?? 180_000;
const sharedServerAllowed = process.env.MINECRAFT_PROBE_ALLOW_SHARED_SERVER === 'true';

if (username.length < 1 || username.length > 16) {
  throw new Error('MINECRAFT_PROBE_USERNAME must be 1-16 characters');
}
if (!sharedServerAllowed && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
  throw new Error('Work-task probe only permits a loopback server by default');
}
if (!sharedServerAllowed && port >= 25_565 && port <= 25_569) {
  throw new Error('Work-task probe refuses known shared Minecraft ports by default');
}

interface ActionReport {
  skill: string;
  args: unknown[];
  success: boolean;
  result: string;
  durationMs: number;
}

interface LevelReport {
  level: number;
  name: string;
  difficulty: 'easy' | 'basic' | 'intermediate' | 'advanced';
  intent: string;
  actions: ActionReport[];
  assertions: Awaited<ReturnType<MinecraftCommandOracle['evaluateAll']>>;
  passed: boolean;
  durationMs: number;
}

const bot = mineflayer.createBot({
  host,
  port,
  username,
  auth: 'offline',
  version,
  checkTimeoutInterval: timeoutMilliseconds,
}) as CustomBot;

bot.loadPlugin(pathfinder);
bot.loadPlugin(collectBlock);
bot.loadPlugin(toolPlugin);
bot.isTest = true;
bot.chatMode = false;
bot.connectedServerName = 'isolated-work-task-probe';
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

for (const skill of [
  new MoveTo(bot),
  new DigBlockAt(bot),
  new MineBlock(bot),
  new PlaceBlockAt(bot),
  new CraftOne(bot),
  new StartSmelting(bot),
  new WithdrawFromFurnace(bot),
]) {
  bot.instantSkills.addSkill(skill);
}

const timeout = setTimeout(() => {
  finish(1, 'MINECRAFT_WORK_TASK_PROBE_TIMEOUT');
}, timeoutMilliseconds);

bot.once('error', error => finish(1, `MINECRAFT_WORK_TASK_PROBE_ERROR ${error.message}`));
bot.once('kicked', reason => finish(1, `MINECRAFT_WORK_TASK_PROBE_KICKED ${stringifyReason(reason)}`));
bot.once('spawn', async () => {
  const startedAt = Date.now();
  const oracle = new MinecraftCommandOracle(bot, 5_000);
  const levels: LevelReport[] = [];
  try {
    await oracle.verifyReady();
    await arrangeArena(oracle);

    levels.push(await runLevel(
      oracle,
      1,
      'supported-block-placement',
      'easy',
      '足場上の指定座標へ丸石を1個設置する。単一操作と座標精度を確認する。',
      [['place-block-at', ['cobblestone', 2, 100, 0]]],
      [
        { type: 'block_at', x: 2, y: 100, z: 0, block: 'cobblestone' },
        { type: 'inventory_count', item: 'cobblestone', minCount: 1, maxCount: 1 },
      ],
    ));

    levels.push(await runLevel(
      oracle,
      2,
      'walk-and-chop-tree',
      'basic',
      '6ブロック先まで移動し、高さ3のオーク原木を伐採してドロップを回収する。',
      [['mine-block', ['oak_log', 3, 16]]],
      [
        { type: 'block_at', x: 6, y: 100, z: 0, block: 'air' },
        { type: 'block_at', x: 6, y: 101, z: 0, block: 'air' },
        { type: 'block_at', x: 6, y: 102, z: 0, block: 'air' },
        { type: 'inventory_count', item: 'oak_log', minCount: 3 },
      ],
    ));

    levels.push(await runLevel(
      oracle,
      3,
      'cross-arena-and-mine-iron',
      'intermediate',
      '反対側の鉱脈へ移動し、適切なツルハシを選んで鉄鉱石3個を採掘・回収する。',
      [['mine-block', ['iron_ore', 3, 20]]],
      [
        { type: 'block_at', x: -6, y: 100, z: -1, block: 'air' },
        { type: 'block_at', x: -6, y: 100, z: 0, block: 'air' },
        { type: 'block_at', x: -6, y: 100, z: 1, block: 'air' },
        { type: 'inventory_count', item: 'raw_iron', minCount: 3 },
      ],
    ));

    levels.push(await runLevel(
      oracle,
      4,
      'resource-to-iron-pickaxe',
      'advanced',
      '自分で得た原木と鉄から板材・棒・作業台を作り、作業台を設置し、鉄を製錬して鉄のツルハシまで完成させる。',
      [
        ['craft-one', ['oak_planks', 12]],
        ['craft-one', ['stick', 4]],
        ['craft-one', ['crafting_table', 1]],
        ['move-to', [0, 100, 2, 2, 'near']],
        ['place-block-at', ['crafting_table', 0, 100, 2]],
        ['move-to', [2, 100, 3, 2, 'near']],
        ['start-smelting', [2, 100, 3, 'raw_iron', 'coal', 3]],
        ['withdraw-from-furnace', [2, 100, 3, 'output']],
        ['craft-one', ['iron_pickaxe', 1]],
      ],
      [
        { type: 'block_at', x: 0, y: 100, z: 2, block: 'crafting_table' },
        { type: 'block_at', x: 2, y: 100, z: 3, block: 'furnace' },
        { type: 'inventory_count', item: 'iron_pickaxe', minCount: 1 },
        { type: 'inventory_count', item: 'raw_iron', minCount: 0, maxCount: 0 },
        { type: 'health_between', min: 20, max: 20 },
      ],
    ));

    const report = {
      ok: levels.every(level => level.passed),
      probe: 'minecraft-work-task-live-probe',
      server: { host, port, version },
      arena: {
        origin: { x: 0, y: 100, z: 0 },
        supplied: ['iron_axe x1', 'stone_pickaxe x1', 'coal x1', 'cobblestone x2', 'furnace at (2,100,3)'],
        harvestedByBot: ['oak_log x3', 'raw_iron x3'],
      },
      levels,
      totalDurationMs: Date.now() - startedAt,
    };
    process.stdout.write(`MINECRAFT_WORK_TASK_REPORT ${JSON.stringify(report)}\n`);
    finish(report.ok ? 0 : 1);
  } catch (error) {
    const report = {
      ok: false,
      probe: 'minecraft-work-task-live-probe',
      server: { host, port, version },
      levels,
      totalDurationMs: Date.now() - startedAt,
      fatalError: error instanceof Error ? error.message : String(error),
    };
    process.stdout.write(`MINECRAFT_WORK_TASK_REPORT ${JSON.stringify(report)}\n`);
    finish(1);
  }
});

async function arrangeArena(oracle: MinecraftCommandOracle): Promise<void> {
  const commands = [
    'gamemode survival @s',
    'difficulty peaceful',
    'time set day',
    'weather clear',
    'effect clear @s',
    'clear @s',
    'fill -9 99 -9 9 99 9 stone',
    'fill -9 100 -9 9 105 9 air',
    'setblock 6 100 0 oak_log',
    'setblock 6 101 0 oak_log',
    'setblock 6 102 0 oak_log',
    'setblock -6 100 -1 iron_ore',
    'setblock -6 100 0 iron_ore',
    'setblock -6 100 1 iron_ore',
    'setblock 2 100 3 furnace',
    'give @s iron_axe 1',
    'give @s stone_pickaxe 1',
    'give @s coal 1',
    'give @s cobblestone 2',
    'tp @s 0 100 0',
  ];
  for (const command of commands) await oracle.executeSetupCommand(command);
  await delay(750);
}

async function runLevel(
  oracle: MinecraftCommandOracle,
  level: number,
  name: string,
  difficulty: LevelReport['difficulty'],
  intent: string,
  actionSpecs: Array<[string, unknown[]]>,
  expected: MinecraftCommandAssertion[],
): Promise<LevelReport> {
  const startedAt = Date.now();
  const actions: ActionReport[] = [];
  for (const [skillName, args] of actionSpecs) {
    const action = await runAction(skillName, args);
    actions.push(action);
    if (!action.success) break;
  }
  const assertions = await oracle.evaluateAll(expected);
  return {
    level,
    name,
    difficulty,
    intent,
    actions,
    assertions,
    passed: actions.length === actionSpecs.length
      && actions.every(action => action.success)
      && assertions.every(assertion => assertion.passed),
    durationMs: Date.now() - startedAt,
  };
}

async function runAction(skillName: string, args: unknown[]): Promise<ActionReport> {
  const skill = bot.instantSkills.getSkill(skillName) as InstantSkill | undefined;
  const startedAt = Date.now();
  if (!skill) {
    return { skill: skillName, args, success: false, result: 'skill is not registered', durationMs: 0 };
  }
  try {
    const outcome = await skill.run(...args);
    return {
      skill: skillName,
      args,
      success: outcome.success,
      result: String(outcome.result ?? ''),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      skill: skillName,
      args,
      success: false,
      result: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

let finished = false;
function finish(exitCode: number, message?: string): void {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (message) process.stderr.write(`${message}\n`);
  process.exitCode = exitCode;
  bot.constantSkills.destroy();
  bot.end('work-task probe complete');
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

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
