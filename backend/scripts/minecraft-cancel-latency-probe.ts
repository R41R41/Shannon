#!/usr/bin/env node
// Model-free: how long the body takes to be free for the next action after the one it is doing is cancelled.
// A skill is started (MINECRAFT_CANCEL_SKILL / _ARGS), cancelled after MINECRAFT_CANCEL_AFTER_MS as the
// emergency layer cancels it, and a second action of high priority is asked for at once: the time until that
// one starts is what a counterattack or an escape waits. Repeated MINECRAFT_CANCEL_REPEAT times, each with a
// different delay (so the cancellation lands in different steps of the skill).
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { cancelNonSurvivalActions, executeAction } from '../src/services/minebot/execution/ActionExecution.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const skillName = process.env.MINECRAFT_CANCEL_SKILL ?? 'dig-shelter';
const skillArgs: unknown[] = JSON.parse(process.env.MINECRAFT_CANCEL_ARGS ?? '[]');
const repeat = Number(process.env.MINECRAFT_CANCEL_REPEAT ?? 6);
const firstDelay = Number(process.env.MINECRAFT_CANCEL_AFTER_MS ?? 600);
const ground = process.env.MINECRAFT_CANCEL_GROUND ?? 'soul_soil';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const operator = await createProbeBot(port);
const actor: any = await createProbeBot(port, 'MinebotTrial');
const control = new MinecraftCommandOracle(operator);
const report: any = { skill: skillName, args: skillArgs, ground, trials: [] };
try {
  await control.verifyReady();
  const [px, py, pz] = [3300, 200, 3300];
  await control.executeSetupCommand(`execute in minecraft:overworld run tp ShannonProbe ${px} ${py + 12} ${pz}`);
  await sleep(4000);
  for (const command of [`forceload add ${px - 20} ${pz - 20} ${px + 20} ${pz + 20}`, 'gamemode spectator ShannonProbe', 'gamemode survival MinebotTrial',
    'clear MinebotTrial', 'effect clear MinebotTrial', 'time set noon', 'weather clear', 'kill @e[type=!minecraft:player,distance=..80]']) await control.executeSetupCommand(command);
  for (let trial = 0; trial < repeat; trial++) {
    // Fresh ground each time: eight deep of what a body would be digging, and air above.
    await control.executeSetupCommand(`fill ${px - 6} ${py - 8} ${pz - 6} ${px + 6} ${py - 1} ${pz + 6} minecraft:${ground}`);
    await control.executeSetupCommand(`fill ${px - 6} ${py} ${pz - 6} ${px + 6} ${py + 5} ${pz + 6} minecraft:air`);
    await control.executeSetupCommand(`execute in minecraft:overworld run tp MinebotTrial ${px + 0.5} ${py} ${pz + 0.5}`);
    await control.executeSetupCommand('clear MinebotTrial');
    for (const give of ['iron_pickaxe 1', 'iron_sword 1', 'cobblestone 64']) await control.executeSetupCommand(`give MinebotTrial minecraft:${give}`);
    await sleep(2500);
    const skill = actor.instantSkills.getSkill(skillName);
    if (!skill) throw new Error(`SKILL_MISSING:${skillName}`);
    const delay = firstDelay + trial * 450;
    const began = Date.now();
    let skillDoneAt = 0;
    const running = skill.run(...skillArgs).then((result: any) => { skillDoneAt = Date.now(); return result; }, (error: unknown) => { skillDoneAt = Date.now(); return { success: false, result: String(error) }; });
    await sleep(delay);
    const cancelledAt = Date.now();
    const alreadyDone = skillDoneAt > 0;
    cancelNonSurvivalActions(actor, 'probe_cancel');
    let nextStartedAt = 0;
    const next: any = await executeAction(actor, 'attack-nearest', 8000, async () => { nextStartedAt = Date.now(); return { success: true, result: 'started' }; }, { priority: 200, waitForQuiescence: true });
    const result: any = await running;
    report.trials.push({ cancelAfterMs: delay, alreadyDone, nextWaitedMs: nextStartedAt ? nextStartedAt - cancelledAt : null, next: String(next?.result ?? '').slice(0, 60),
      skillSettledMs: skillDoneAt - cancelledAt, skillResult: String(result?.result ?? '').slice(0, 70), tookMs: Date.now() - began });
    await sleep(1500);
  }
  const waits = report.trials.filter((trial: any) => !trial.alreadyDone && trial.nextWaitedMs !== null).map((trial: any) => trial.nextWaitedMs);
  report.worstMs = waits.length ? Math.max(...waits) : null;
  console.log(`CANCEL_LATENCY_REPORT ${JSON.stringify(report)}`);
} finally {
  await closeProbeBot(actor);
  await closeProbeBot(operator);
}
process.exit(0);
