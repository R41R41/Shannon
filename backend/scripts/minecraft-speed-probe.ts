#!/usr/bin/env node
// Model-free: the body's own pace, on natural lab terrain. Each scenario starts from the same spot of the same world (the world is
// copied afresh for each run), so two builds of the body can be compared second for second. For every skill call: how long it took,
// what share of its ticks the body was digging, walking, laying blocks or doing none of these, how far it went, and which drops were
// left lying. MINECRAFT_SPEED_SCENARIOS picks the scenarios (comma separated): walk, logs, stone, stair, iron, coal, deep, night.
import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { forcedMoves } from '../src/services/minebot/utils/motionRecorder.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');

const NAME = 'MinebotTrial';
// A world just generated on a busy machine can take longer than one spawn wait: once more before giving up.
const join = async (name?: string) => { try { return await createProbeBot(port, name); } catch { await new Promise(r => setTimeout(r, 15_000)); return createProbeBot(port, name); } };
const actor = await join(NAME);
const operator = await join();
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const scenarios = (process.env.MINECRAFT_SPEED_SCENARIOS ?? 'walk,logs,stone,stair,iron,coal,deep').split(',').map(s => s.trim()).filter(Boolean);
const out: any = { scenarios: {} };

/** Ticks of a call, by what the body was doing. */
function watch() {
  const counts = { dig: 0, build: 0, walk: 0, other: 0 };
  let metres = 0;
  let last = actor.entity.position.clone();
  const pushedBefore = forcedMoves(actor).count;
  // Each dig: the block, its ticks, and how many of them the body was off the ground or in water (a dig five times slower).
  const digs = new Map<string, { n: number; ticks: number; air: number; wet: number }>();
  let digKey: string | null = null;
  const onTick = () => {
    const p = actor.entity.position;
    metres += Math.hypot(p.x - last.x, p.z - last.z) + Math.abs(p.y - last.y);
    last = p.clone();
    const pf: any = actor.pathfinder;
    const target = (actor as any).targetDigBlock;
    const key = target ? `${target.name}@${target.position}` : null;
    if (target) {
      const entry = digs.get(target.name) ?? { n: 0, ticks: 0, air: 0, wet: 0 };
      if (key !== digKey) entry.n++;
      entry.ticks++;
      if (!actor.entity.onGround) entry.air++;
      if ((actor.entity as any).isInWater) entry.wet++;
      digs.set(target.name, entry);
    }
    digKey = key;
    if (target) counts.dig++;
    else if (pf?.isBuilding?.()) counts.build++;
    else if (pf?.isMoving?.() || ['forward', 'back', 'left', 'right'].some(key => actor.getControlState(key as any))) counts.walk++;
    else counts.other++;
  };
  actor.on('physicsTick', onTick);
  return () => {
    actor.removeListener('physicsTick', onTick);
    const ticks = counts.dig + counts.build + counts.walk + counts.other;
    const share = (n: number) => ticks ? +(n / 20).toFixed(1) : 0;
    return { seconds: { dig: share(counts.dig), build: share(counts.build), walk: share(counts.walk), other: share(counts.other) },
      metres: +metres.toFixed(1), pushedBack: forcedMoves(actor).count - pushedBefore,
      digs: Object.fromEntries([...digs].map(([name, d]) => [name, `${d.n}x ${(d.ticks / 20).toFixed(1)}s air${d.air} wet${d.wet}`])) };
  };
}

/** Drops lying within 16 blocks of the body (what a call left behind). */
function dropsLying(): number {
  return Object.values(actor.entities).filter((e: any) => e?.name === 'item' && e.position.distanceTo(actor.entity.position) < 16).length;
}

async function setup(at: Vec3, kit: string[], extra: string[] = []) {
  for (const command of ['clear ' + NAME, 'effect clear ' + NAME, 'kill @e[type=minecraft:item]', `tp ${NAME} ${at.x + 0.5} ${at.y} ${at.z + 0.5}`,
    'effect give ' + NAME + ' minecraft:instant_health 1 5', 'effect give ' + NAME + ' minecraft:saturation 1 20', ...kit.map(item => `give ${NAME} ${item}`), ...extra]) {
    await oracle.executeSetupCommand(command);
  }
  await sleep(2500);
}

async function call(label: string, skill: string, ...args: any[]) {
  const stop = watch();
  const started = Date.now();
  let result: any;
  try { result = await actor.instantSkills.getSkill(skill)!.run(...args); }
  catch (error) { result = { success: false, result: `THROWN ${String((error as Error)?.message ?? error)}` }; }
  const ms = Date.now() - started;
  const watched = stop();
  await sleep(1500);
  const entry = { skill, args, ms, success: !!result?.success, failureType: result?.failureType, result: String(result?.result ?? '').slice(0, 260),
    ...watched, dropsLeft: dropsLying(), at: actor.entity.position.floored().toArray() };
  console.log(`SPEED_CALL ${label} ${JSON.stringify(entry)}`);
  return entry;
}

function count(name: (n: string) => boolean): number {
  return actor.inventory.items().filter(item => name(item.name)).reduce((sum, item) => sum + item.count, 0);
}

const TOOLS = ['minecraft:iron_pickaxe 1', 'minecraft:stone_pickaxe 1', 'minecraft:stone_axe 1', 'minecraft:cobblestone 64', 'minecraft:bread 8'];

try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'gamerule advance_time false', 'gamerule doWeatherCycle false', 'weather clear', 'time set 1000',
    'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]', 'gamemode survival ' + NAME]) {
    try { await oracle.executeSetupCommand(command); } catch { /* an unknown rule name on this version is skipped */ }
  }
  await sleep(3000);
  const spawnAt = process.env.MINECRAFT_SPEED_AT ? new Vec3(...(process.env.MINECRAFT_SPEED_AT.split(',').map(Number) as [number, number, number])) : actor.entity.position.floored();
  out.spawn = spawnAt.toArray();

  for (const scenario of scenarios) {
    const record: any = { calls: [] };
    out.scenarios[scenario] = record;
    const started = Date.now();
    if (scenario === 'walk') {
      // Four legs of 48 m over the surface, as the body walks to a tree, a village or a found block.
      await setup(spawnAt, TOOLS);
      for (const [dx, dz] of [[48, 0], [0, 48], [-48, 0], [0, -48]]) {
        const from = actor.entity.position;
        record.calls.push(await call(`walk ${dx},${dz}`, 'move-to', Math.floor(from.x) + dx, 0, Math.floor(from.z) + dz, 2, 'nearxz'));
      }
    } else if (scenario === 'logs') {
      await setup(spawnAt, TOOLS);
      record.calls.push(await call('logs', 'mine-block', 'oak_log,birch_log,spruce_log,acacia_log,dark_oak_log,jungle_log,cherry_log,mangrove_log', 8, 48));
      record.got = count(n => n.endsWith('_log'));
    } else if (scenario === 'stone') {
      await setup(spawnAt, ['minecraft:wooden_pickaxe 1', 'minecraft:bread 8']);
      record.calls.push(await call('stone', 'mine-block', 'stone', 10, 32));
      record.got = count(n => n === 'cobblestone');
    } else if (scenario === 'stair') {
      await setup(spawnAt, TOOLS);
      const y = Math.floor(actor.entity.position.y);
      record.calls.push(await call('stair', 'stair-mine', Math.max(20, y - 24), 'east'));
      record.steps = y - Math.floor(actor.entity.position.y);
    } else if (scenario === 'iron' || scenario === 'coal') {
      // From under the surface, as after a stair: the ore of the stone around.
      await setup(spawnAt, TOOLS);
      const y = Math.floor(actor.entity.position.y);
      await call('descend', 'stair-mine', Math.max(16, y - 30), 'south');
      const ore = scenario === 'iron' ? 'iron_ore' : 'coal_ore';
      record.calls.push(await call(scenario, 'mine-block', ore, scenario === 'iron' ? 10 : 6, 24));
      record.got = scenario === 'iron' ? count(n => n === 'raw_iron') : count(n => n === 'coal');
    } else if (scenario === 'deep') {
      await setup(spawnAt, TOOLS);
      const y = Math.floor(actor.entity.position.y);
      record.calls.push(await call('deep', 'stair-mine', -40, 'west'));
      record.steps = y - Math.floor(actor.entity.position.y);
    } else if (scenario === 'hunt') {
      // Three sheep and three rabbits a few blocks off: the kills, and what each left lying.
      await setup(spawnAt, [...TOOLS, 'minecraft:iron_sword 1']);
      const p = actor.entity.position.floored();
      for (const [mob, dx, dz] of [['sheep', 5, 0], ['sheep', 6, 3], ['sheep', 4, -4], ['rabbit', -5, 2], ['rabbit', -6, -3], ['rabbit', 3, 6]] as const) {
        await oracle.executeSetupCommand(`summon minecraft:${mob} ${p.x + dx} ${p.y + 1} ${p.z + dz}`);
      }
      await sleep(1500);
      record.calls.push(await call('sheep', 'attack-continuously', 'sheep', 3));
      record.calls.push(await call('rabbit', 'attack-continuously', 'rabbit', 3));
      record.got = { wool: count(n => n.endsWith('_wool')), mutton: count(n => n === 'mutton'), rabbit: count(n => n === 'rabbit' || n === 'rabbit_hide') };
    } else if (scenario === 'night') {
      // At midnight in iron armour, no bed: may the stair go down? Then with a bed carried: is the night slept through?
      await setup(spawnAt, [...TOOLS, 'minecraft:cooked_beef 4'], ['time set 18000',
        `item replace entity ${NAME} armor.chest with minecraft:iron_chestplate`, `item replace entity ${NAME} armor.legs with minecraft:iron_leggings`,
        `item replace entity ${NAME} armor.head with minecraft:iron_helmet`, `item replace entity ${NAME} armor.feet with minecraft:iron_boots`]);
      const y = Math.floor(actor.entity.position.y);
      record.calls.push(await call('night-stair', 'stair-mine', Math.min(10, y - 8), 'north'));
      await oracle.executeSetupCommand(`give ${NAME} minecraft:white_bed 1`);
      await oracle.executeSetupCommand('time set 18000');
      await sleep(1000);
      const before = Number(actor.time.timeOfDay);
      record.calls.push(await call('night-mine', 'mine-block', 'stone', 3, 8));
      record.timeOfDay = { before, after: Number(actor.time.timeOfDay) };
      record.bedCarried = count(n => n.endsWith('_bed'));
    }
    record.ms = Date.now() - started;
    console.log(`SPEED_SCENARIO ${scenario} ${JSON.stringify(record)}`);
  }
} catch (error) {
  out.error = String((error as Error)?.stack ?? error).slice(0, 800);
} finally {
  console.log(`SPEED_PROBE ${JSON.stringify(out)}`);
  closeProbeBot(operator); closeProbeBot(actor);
  setTimeout(() => process.exit(0), 500);
}
