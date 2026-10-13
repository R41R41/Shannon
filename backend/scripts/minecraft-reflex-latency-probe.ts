#!/usr/bin/env node
// Legacy reflex latency baseline (Syzygy ADR-0010 D4/D8, ADR-0011 §6.2): how long the old Minebot takes from the moment
// its own client observes a trigger to the first actuator call it makes. Isolated lab worlds only, no model, no network:
// the legacy constant skills, EventReactionSystem (hostile_approach forced on, as in the outage probe) and the reflex
// plugins of the probe bot run as they did before common-FCA mode. Each scenario is repeated MINECRAFT_LATENCY_REPS times.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { MinebotTaskRuntime } from '../src/services/minebot/runtime/MinebotTaskRuntime.js';
import { BotEventHandler } from '../src/services/minebot/events/BotEventHandler.js';
import { EventReactionSystem } from '../src/services/minebot/eventReaction/EventReactionSystem.js';
import { loadEventReactionSettingsFile } from '../src/services/minebot/eventReaction/eventReactionSettingsStore.js';
import { SkillRegistrar } from '../src/services/minebot/skills/SkillRegistrar.js';

const port = Number(process.env.MINECRAFT_LATENCY_PORT);
const worldDirectory = process.env.MINECRAFT_LATENCY_WORLD_DIRECTORY ?? '';
const outFile = process.env.MINECRAFT_LATENCY_OUT ?? '';
if (!Number.isInteger(port) || port < 25577 || port > 25650 || !outFile
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_LATENCY_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_LATENCY_WORLD_CONFIGURATION_INVALID');
const reps = Math.max(1, Math.min(30, Number(process.env.MINECRAFT_LATENCY_REPS ?? 8)));
const only = (process.env.MINECRAFT_LATENCY_SCENARIOS ?? 'zombie,creeper,lava,water,hunger,armor,skeleton').split(',');

const operator = await createProbeBot(port);
const actor = await createProbeBot(port, 'MinebotTrial');
const oracle = new MinecraftCommandOracle(operator);
const runtime = new MinebotTaskRuntime(actor);
runtime.setExecutor(async () => { throw new Error('PLANNER_OFF_FOR_LATENCY_PROBE'); });
const settings = loadEventReactionSettingsFile();
const reactions = new EventReactionSystem(actor, runtime, { ...settings, reactions: settings.reactions.map(row =>
  row.eventType === 'hostile_approach' ? { ...row, enabled: true, probability: 100 } : row) });
const handler = new BotEventHandler(actor, runtime, []);
const registrar = new SkillRegistrar();
const timers: Array<ReturnType<typeof setInterval>> = [];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeoutMs: number, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(stepMs);
  return predicate();
}

// The first actuator call after a trigger. Wrapped once; only calls that press, aim, hit, use or move count.
let armed: { scenario: string; at: number; first?: { kind: string; at: number } } | null = null;
const record = (kind: string) => { if (armed && Number.isFinite(armed.at) && !armed.first) armed.first = { kind, at: performance.now() }; };
const wrap = (target: any, name: string, counts: (...args: any[]) => boolean = () => true) => {
  const original = target?.[name]; if (typeof original !== 'function') return;
  target[name] = function (...args: any[]) { if (counts(...args)) record(name); return original.apply(this, args); };
};
wrap(actor, 'setControlState', (_key: string, value: boolean) => value === true);
for (const name of ['look', 'lookAt', 'attack', 'equip', 'activateItem', 'consume', 'swingArm', 'dig', 'placeBlock']) wrap(actor, name);
wrap((actor as any).pathfinder, 'setGoal', (goal: unknown) => goal != null);
wrap((actor as any).pvp, 'attack');

const results: Record<string, Array<{ ms: number | null; kind: string | null }>> = {};
async function stage(index: number) {
  const x = 3000 + index * 64, y = 120, z = 3000;
  for (const command of [
    `forceload add ${x - 16} ${z - 16} ${x + 16} ${z + 16}`,
    `fill ${x - 6} ${y - 1} ${z - 6} ${x + 6} ${y - 1} ${z + 6} stone`, `fill ${x - 6} ${y} ${z - 6} ${x + 6} ${y + 4} ${z + 6} air`,
    'kill @e[type=!minecraft:player]', 'clear MinebotTrial', 'effect clear MinebotTrial',
    'effect give MinebotTrial minecraft:instant_health 1 5', 'effect give MinebotTrial minecraft:saturation 1 20',
    `tp MinebotTrial ${x + 0.5} ${y} ${z + 0.5} 0 0`, `tp ShannonProbe ${x + 0.5} ${y + 10} ${z + 0.5}`,
  ]) await oracle.executeSetupCommand(command);
  await until(() => Math.abs(actor.entity.position.x - (x + 0.5)) < 0.6 && actor.entity.onGround && actor.health >= 19, 6000);
  await sleep(1500);
  return { x, y, z };
}
async function measure(scenario: string, arm: () => Promise<boolean>, timeoutMs = 6000) {
  results[scenario] ??= [];
  armed = { scenario, at: Number.NaN };
  const triggered = await arm();
  if (!triggered) { results[scenario].push({ ms: null, kind: 'TRIGGER_NOT_OBSERVED' }); armed = null; return; }
  await until(() => !!armed?.first, timeoutMs, 5);
  const row = armed!;
  results[scenario].push(row.first ? { ms: Math.round((row.first.at - row.at) * 10) / 10, kind: row.first.kind } : { ms: null, kind: 'NO_OUTPUT' });
  armed = null;
  (actor as any).clearControlStates?.();
}
// The trigger moment is set by the first event in the actor's own client that shows the condition.
const triggerWhen = (predicate: () => boolean, maxMs: number) => new Promise<boolean>(resolve => {
  const started = Date.now();
  const events = ['physicsTick', 'entitySpawn', 'entityMoved', 'health', 'breath'];
  const done = (value: boolean) => { for (const event of events) actor.removeListener(event as any, check); resolve(value); };
  function check() {
    if (!armed) return done(false);
    if (predicate()) { armed.at = performance.now(); return done(true); }
    if (Date.now() - started > maxMs) done(false);
  }
  for (const event of events) actor.on(event as any, check);
});
const near = (name: string, within: number) => () => Object.values(actor.entities).some((entity: any) => entity.name === name
  && entity.position.distanceTo(actor.entity.position) <= within);

try {
  await oracle.verifyReady();
  for (const command of ['difficulty normal', 'gamerule spawn_mobs false', 'gamerule mob_griefing false', 'time set noon',
    'gamemode spectator ShannonProbe', 'gamemode survival MinebotTrial']) await oracle.executeSetupCommand(command);
  registrar.registerConstantSkills(actor, actor.constantSkills);
  handler.registerAll();
  handler.setEventReactionSystem(reactions);
  await reactions.initialize();
  for (const ms of [100, 1000, 5000]) timers.push(setInterval(() => actor.emit(`taskPer${ms}ms` as any), ms));
  let n = 0;
  for (let rep = 0; rep < reps; rep++) {
    if (only.includes('zombie')) { const s = await stage(n++);
      await measure('zombie', async () => { const seen = triggerWhen(near('zombie', 8), 4000); await oracle.executeSetupCommand(`summon zombie ${s.x + 5.5} ${s.y} ${s.z + 0.5}`); return seen; }); }
    if (only.includes('creeper')) { const s = await stage(n++);
      await measure('creeper', async () => { const seen = triggerWhen(near('creeper', 8), 4000); await oracle.executeSetupCommand(`summon creeper ${s.x + 3.5} ${s.y} ${s.z + 0.5} {ignited:1b,Fuse:40}`); return seen; }); }
    if (only.includes('skeleton')) { const s = await stage(n++);
      await oracle.executeSetupCommand('item replace entity MinebotTrial weapon.offhand with shield');
      await sleep(600);
      await measure('skeleton', async () => { const seen = triggerWhen(near('arrow', 32), 8000); await oracle.executeSetupCommand(`summon skeleton ${s.x + 6.5} ${s.y} ${s.z + 0.5}`); return seen; }, 6000); }
    if (only.includes('lava')) { const s = await stage(n++);
      await measure('lava', async () => { const seen = triggerWhen(() => !!(actor.entity as any).isInLava, 4000); await oracle.executeSetupCommand(`setblock ${s.x} ${s.y} ${s.z} lava`); return seen; });
      await oracle.executeSetupCommand(`fill ${s.x - 6} ${s.y} ${s.z - 6} ${s.x + 6} ${s.y + 1} ${s.z + 6} air replace lava`);
      await oracle.executeSetupCommand('effect give MinebotTrial minecraft:fire_resistance 5 0 true'); }
    if (only.includes('water')) { const s = await stage(n++);
      for (const command of [`fill ${s.x - 2} ${s.y - 6} ${s.z - 2} ${s.x + 2} ${s.y - 1} ${s.z + 2} stone`,
        `fill ${s.x - 1} ${s.y - 5} ${s.z - 1} ${s.x + 1} ${s.y - 1} ${s.z + 1} water`]) await oracle.executeSetupCommand(command);
      await measure('water', async () => { const seen = triggerWhen(() => (actor.oxygenLevel ?? 20) < 20, 15000);
        await oracle.executeSetupCommand(`tp MinebotTrial ${s.x + 0.5} ${s.y - 5} ${s.z + 0.5}`); return seen; }, 15000); }
    if (only.includes('hunger')) { await stage(n++);
      await oracle.executeSetupCommand('give MinebotTrial cooked_beef 8');
      await sleep(800);
      await measure('hunger', async () => { const seen = triggerWhen(() => (actor.food ?? 20) < 18, 15000);
        await oracle.executeSetupCommand('effect give MinebotTrial minecraft:hunger 10 255'); return seen; }, 4000);
      await oracle.executeSetupCommand('effect clear MinebotTrial'); }
    if (only.includes('armor')) { await stage(n++);
      await measure('armor', async () => { const seen = triggerWhen(() => actor.inventory.items().some(item => item.name === 'iron_chestplate'), 4000);
        await oracle.executeSetupCommand('give MinebotTrial iron_chestplate 1'); return seen; }, 7000); }
  }
} finally {
  for (const timer of timers) clearInterval(timer);
  const pct = (values: number[], p: number) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const summary = Object.fromEntries(Object.entries(results).map(([scenario, rows]) => {
    const ms = rows.map(row => row.ms).filter((value): value is number => value != null);
    const kinds: Record<string, number> = {}; for (const row of rows) kinds[row.kind ?? 'none'] = (kinds[row.kind ?? 'none'] ?? 0) + 1;
    return [scenario, { n: rows.length, measured: ms.length, p50: pct(ms, 0.5), p95: pct(ms, 0.95), max: pct(ms, 1), kinds, rows }];
  }));
  fs.writeFileSync(outFile, JSON.stringify({ reps, summary }, null, 1));
  console.log(`LATENCY_REPORT ${outFile}`);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(summary).map(([k, v]: any) => [k, { n: v.n, measured: v.measured, p50: v.p50, p95: v.p95, max: v.max, kinds: v.kinds }]))));
  for (const bot of [actor, operator]) { try { await closeProbeBot(bot); } catch { /* closing only */ } }
  setTimeout(() => process.exit(0), 1000).unref();
}
