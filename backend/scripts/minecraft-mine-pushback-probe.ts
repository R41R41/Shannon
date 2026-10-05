#!/usr/bin/env node
// Model-free: on natural lab terrain, mine stone in a batch with a wooden pickaxe as a paid run does,
// and report every server position correction with what the client believed there.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { forcedMoves } from '../src/services/minebot/utils/motionRecorder.js';
import { SkillRegistrar } from '../src/services/minebot/skills/SkillRegistrar.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const [gx, gy, gz] = (process.env.MINECRAFT_MINE_SITE ?? '').split(',').map(Number);
const actor = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = {};
try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set day', 'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]',
    'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial', 'effect give MinebotTrial minecraft:instant_health 1 5',
    `tp MinebotTrial ${gx} ${gy} ${gz}`, `give MinebotTrial ${process.env.MINECRAFT_MINE_TOOL ?? 'wooden_pickaxe'} 1`]) await oracle.executeSetupCommand(command);
  const timers: Array<ReturnType<typeof setInterval>> = [];
  if (process.env.MINECRAFT_MINE_CONSTANT_SKILLS === 'true') {
    // As in a paid run: the always-on skills (item pickup, eating, swimming...) run beside the task.
    new SkillRegistrar().registerConstantSkills(actor, actor.constantSkills);
    for (const ms of [100, 1000, 5000]) timers.push(setInterval(() => actor.emit(`taskPer${ms}ms` as any), ms));
    report.constantSkills = actor.constantSkills.getSkills().filter((skill: any) => skill.status).map((skill: any) => skill.skillName);
  }
  // Lab only: a server ticking slowly, as one starved of CPU does, and optionally the library's prediction left in place for comparison.
  const tickRate = Number(process.env.MINECRAFT_MINE_TICK_RATE ?? 20);
  if (tickRate !== 20) await oracle.executeSetupCommand(`tick rate ${tickRate}`);
  if (process.env.MINECRAFT_MINE_KEEP_PREDICTION === 'true') {
    const on = actor.on.bind(actor);
    (actor as any).on = (event: any, listener: any) => String(event).startsWith('blockUpdate:(') && listener?.name === 'onUpdate' ? actor : on(event, listener);
  }
  report.tickRate = tickRate; report.prediction = process.env.MINECRAFT_MINE_KEEP_PREDICTION === 'true' ? 'kept' : 'undone';
  await sleep(4000);
  report.start = actor.entity.position.floored();
  const before = forcedMoves(actor).count;
  const samples: any[] = [];
  let last = before;
  let prior: any = null;
  const onTick = () => {
    const p = actor.entity.position;
    const count = forcedMoves(actor).count;
    if (count !== last && samples.length < 40) samples.push({ n: count - before, claimed: prior, server: { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) },
      below: actor.blockAt(p.offset(0, -0.1, 0))?.name, feet: actor.blockAt(p.offset(0, 0.1, 0))?.name, head: actor.blockAt(p.offset(0, 1.7, 0))?.name });
    last = count;
    prior = { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3), ground: actor.entity.onGround, vy: +actor.entity.velocity.y.toFixed(3),
      keys: ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak'].filter(key => actor.getControlState(key as any)).join('+') };
  };
  actor.on('physicsTick', onTick);
  const started = Date.now();
  const result: any = await actor.instantSkills.getSkill('mine-block')!.run(process.env.MINECRAFT_MINE_BLOCK ?? 'stone', Number(process.env.MINECRAFT_MINE_COUNT ?? 12), 16, 'target');
  actor.removeListener('physicsTick', onTick);
  report.result = String(result?.result).slice(0, 160);
  report.ms = Date.now() - started;
  report.pushedBack = forcedMoves(actor).count - before;
  report.restored = (actor as any).ghostBlocksRestored ?? 0;
  report.samples = samples.filter((_sample, index) => index < 6 || index % 8 === 0);
  report.end = actor.entity.position;
} catch (error) {
  report.error = String((error as Error)?.stack ?? error).slice(0, 600);
} finally {
  try { await oracle.executeSetupCommand('tick rate 20'); } catch { /* reported below if the run itself failed */ }
  console.log(`MINE_PUSHBACK ${JSON.stringify(report)}`);
  closeProbeBot(operator); closeProbeBot(actor);
  setTimeout(() => process.exit(0), 500);
}
