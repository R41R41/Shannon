#!/usr/bin/env node
// Model-free check of the body's map in a natural lab world (one made from a chosen seed: minecraft-isolated-lab.mjs MINECRAFT_LAB_SEED).
// The server console (not a second bot: it would read columns in the same process and share the ticks) finds the structures
// (MINECRAFT_MAP_LOCATE="village,ruined_portal,igloo,shipwreck") and puts the body (MinebotTrial, its place memory as in a run) in
// spectator above each for MINECRAFT_MAP_SETTLE_MS. At each: what the memory noted near it, the map's lines, and what reading cost
// (the memory's longest step, column and share of a tick; the gaps between physics ticks; the GC pauses).
// MINECRAFT_MAP_STOPS="label@x,z;..." adds stops of its own. MINECRAFT_MAP_WALK="x,z;..." then has it walk in survival from the
// last stop (pathfinder, the gaps measured while it walks). MINECRAFT_MAP_ENTRANCES=N walks down from the mouths of the N nearest
// cave entrances the map holds, no digging and no placing, and reports how deep it got and in how long.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PerformanceObserver } from 'node:perf_hooks';
import { Vec3 } from 'vec3';
import pathfinderModule from 'mineflayer-pathfinder';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';

const { Movements, goals } = pathfinderModule as any;
const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const session = `codex-progressive-lab-${port}`;
const logFile = path.join(worldDirectory, 'logs', 'latest.log');
const settleMs = Number(process.env.MINECRAFT_MAP_SETTLE_MS ?? 45_000);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A console command; returns the server log lines it wrote within `waitMs`. */
async function consoleCommand(command: string, waitMs = 1500): Promise<string[]> {
  if (!/^[A-Za-z0-9_:#~ .\-]+$/.test(command)) throw new Error(`CONSOLE_COMMAND_REFUSED ${command}`);
  const before = fs.statSync(logFile).size;
  spawnSync('tmux', ['-L', 'minebot-lab', 'send-keys', '-t', session, command, 'Enter']);
  await sleep(waitMs);
  const text = fs.readFileSync(logFile, 'utf8');
  return Buffer.from(text).subarray(before).toString('utf8').split('\n').filter(Boolean);
}

const STRUCTURES: Record<string, string> = { village: '#minecraft:village', ruined_portal: '#minecraft:ruined_portal', igloo: 'minecraft:igloo',
  shipwreck: '#minecraft:shipwreck' };
async function locate(kind: string, from?: { x: number; z: number }): Promise<{ x: number; z: number; said: string } | null> {
  const lines = await consoleCommand(`${from ? `execute positioned ${from.x} 64 ${from.z} run ` : ''}locate structure ${STRUCTURES[kind]}`, 12_000);
  for (const line of lines) {
    const match = line.match(/is at \[(-?\d+), [^,]+, (-?\d+)\]/);
    if (match) return { x: Number(match[1]), z: Number(match[2]), said: line.replace(/^.*?\]: /, '').slice(0, 160) };
  }
  return null;
}

const actor: any = await createProbeBot(port, 'MinebotTrial');
const memory = actor.placeMemory;
let gaps: number[] = [];
let lastTick = performance.now();
actor.on('physicsTick', () => { const now = performance.now(); gaps.push(now - lastTick); lastTick = now; });
let pauses: number[] = [];
// Every GC pause kept with when it was, to tell the slowest steps that a pause fell into from those that were slow themselves.
const allPauses: Array<{ at: number; ms: number }> = [];
new PerformanceObserver(list => { for (const entry of list.getEntries()) { pauses.push(entry.duration); allPauses.push({ at: entry.startTime, ms: entry.duration }); } })
  .observe({ entryTypes: ['gc'] });
const quantile = (values: number[], q: number) => { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; };
const round = (value: number) => Math.round(value * 100) / 100;
/** The cost since the last call, and the memory's own counts so far. */
const cost = () => {
  const stats = memory.stats;
  const out = { ticks: gaps.length, gapP50: round(quantile(gaps, 0.5)), gapP99: round(quantile(gaps, 0.99)), gapMax: round(Math.max(0, ...gaps)),
    gapsOver60: gaps.filter(gap => gap > 60).length, gapsOver100: gaps.filter(gap => gap > 100).length,
    gcCount: pauses.length, gcMax: round(Math.max(0, ...pauses)), gcTotal: round(pauses.reduce((sum, value) => sum + value, 0)),
    memory: { columnsRead: stats.columnsRead, meanColumnMs: round(stats.totalReadMs / Math.max(1, stats.columnsRead)),
      maxStepMs: round(stats.maxReadMs), maxColumnMs: round(stats.maxColumnMs ?? NaN), maxTickMs: round(stats.maxTickMs ?? NaN),
      setupMs: round(stats.setupMs ?? NaN), stepBuckets: stats.stepBuckets, columnBuckets: stats.columnBuckets,
      maxStepCpuMs: round(stats.maxStepCpuMs ?? NaN), maxColumnCpuMs: round(stats.maxColumnCpuMs ?? NaN), columnCpuBuckets: stats.columnCpuBuckets,
      slowest: (stats.slowest ?? []).map((step: any) => {
        const pause = allPauses.filter(gc => gc.at < step.at + step.ms && gc.at + gc.ms > step.at).reduce((sum, gc) => sum + gc.ms, 0);
        return { phase: step.phase, ms: round(step.ms), cpuMs: round(step.cpuMs), gcInside: round(pause) };
      }),
      phases: Object.fromEntries(Object.entries(stats.phases ?? {}).map(([name, phase]: [string, any]) => [name,
        { steps: phase.steps, meanMs: round(phase.totalMs / Math.max(1, phase.steps)), maxMs: round(phase.maxMs), maxCpuMs: round(phase.maxCpuMs ?? NaN) }])) } };
  gaps = []; pauses = [];
  return out;
};
const NOTED = new Set(['village', 'bell', 'ruined_portal', 'igloo', 'shipwreck', 'chest', 'obsidian', 'grindstone', 'smithing_table', 'blast_furnace',
  'cave_entrance', 'bed', 'crafting_table', 'furnace']);
const notedNear = (x: number, z: number, radius: number) => {
  const byKind: Record<string, string[]> = {};
  for (const place of memory.state.places) {
    if (!NOTED.has(place.kind) || Math.hypot(place.position.x - x, place.position.z - z) > radius) continue;
    (byKind[place.kind] ??= []).push(`(${place.position.x},${place.position.y},${place.position.z})${place.count ? `×${place.count}` : ''}${place.note ? ` ${place.note}` : ''}`);
  }
  return byKind;
};

const report: any = { seed: properties.find(line => line.startsWith('level-seed=')), stops: [], walks: [], entrances: [] };
try {
  await sleep(8000);
  await consoleCommand('gamemode spectator MinebotTrial');
  report.arrival = cost();
  const stops: Array<{ label: string; x: number; z: number; said?: string }> = [];
  for (const kind of (process.env.MINECRAFT_MAP_LOCATE ?? '').split(',').filter(Boolean)) {
    const found = await locate(kind);
    if (found) stops.push({ label: kind, ...found }); else report.stops.push({ label: kind, located: false });
  }
  // MINECRAFT_MAP_VILLAGES_FROM="x,z;...": the village nearest each of these points as well (one seed has more than one village).
  for (const spec of (process.env.MINECRAFT_MAP_VILLAGES_FROM ?? '').split(';').filter(Boolean)) {
    const [x, z] = spec.split(',').map(Number);
    const found = await locate('village', { x, z });
    if (found && !stops.some(stop => stop.label === 'village' && stop.x === found.x && stop.z === found.z)) stops.push({ label: 'village', ...found });
  }
  for (const spec of (process.env.MINECRAFT_MAP_STOPS ?? '').split(';').filter(Boolean)) {
    const [label, at] = spec.split('@'); const [x, z] = at.split(',').map(Number);
    stops.push({ label, x, z });
  }
  for (const stop of stops) {
    cost();
    await consoleCommand(`tp MinebotTrial ${stop.x} 140 ${stop.z}`);
    const started = Date.now();
    await sleep(settleMs);
    // The cost first: the probe's own search of the world below would be counted in the gaps.
    const settled = Date.now() - started, measured = cost(), map = memory.map();
    const noted = notedNear(stop.x, stop.z, 128);
    // What the world really has there (read by the probe after the measuring): the blocks the map's structure lines stand on.
    const truth: Record<string, string[]> = {};
    // Only the blocks of this structure, near it: a search of all that is loaded for each held the loop past the server's keep-alive.
    const TRUTH: Record<string, string[]> = { village: ['bell', 'grindstone', 'smithing_table', 'blast_furnace', 'chest'],
      ruined_portal: ['obsidian', 'crying_obsidian', 'chest'], igloo: ['white_carpet', 'chest'], shipwreck: ['chest'] };
    const structure = memory.recall(stop.label, 1)[0];
    // Round the structure the map found (a ruined portal can lie under ground), else round the stop at the body's height.
    const centre = new Vec3(stop.x, structure?.position.y ?? actor.entity.position.y, stop.z);
    for (const name of TRUTH[stop.label] ?? []) {
      const id = actor.registry.blocksByName[name]?.id;
      const found = actor.findBlocks({ matching: id, maxDistance: stop.label === 'village' ? 64 : 48, count: 64, point: centre });
      if (found.length) truth[name] = [`×${found.length}`, ...found.slice(0, 12).map((p: Vec3) => `(${p.x},${p.y},${p.z})`)];
      // Whose chest it is, as the server has it: the loot table a chest keeps until it is first opened.
      if (name === 'chest') for (const at of found.slice(0, 8) as Vec3[]) {
        const said = (await consoleCommand(`data get block ${at.x} ${at.y} ${at.z} LootTable`, 1200)).find(line => /block data|Found no|no element/i.test(line)) ?? '';
        truth[`chest (${at.x},${at.y},${at.z})`] = [said.replace(/^.*has the following block data: /, '').replace(/^.*?\]: /, '').slice(0, 90)];
      }
    }
    // MINECRAFT_MAP_DUMP=<file>: the columns round the stop (5×5), one JSON line each, to time the reading on a quiet machine
    // (scripts/minecraft-map-read-bench.ts); the lab VM is shared, and its clock counts the time spent waiting for a core.
    if (process.env.MINECRAFT_MAP_DUMP) {
      const cx = Math.floor(stop.x / 16), cz = Math.floor(stop.z / 16);
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        const column = actor.world.getColumn(cx + dx, cz + dz);
        if (column) fs.appendFileSync(process.env.MINECRAFT_MAP_DUMP, `${JSON.stringify({ stop: stop.label, chunkX: cx + dx, chunkZ: cz + dz, column: column.toJson() })}\n`);
      }
    }
    report.stops.push({ label: stop.label, at: [stop.x, stop.z], located: stop.said, settleMs: settled,
      found: structure ? { position: structure.position, distanceFromLocate: Math.round(Math.hypot(structure.position.x - stop.x, structure.position.z - stop.z)), note: structure.note, count: structure.count } : null,
      noted, truth, map, cost: measured });
    console.log(`MAP_STOP ${JSON.stringify(report.stops.at(-1))}`);
  }

  const walk = (process.env.MINECRAFT_MAP_WALK ?? '').split(';').filter(Boolean);
  const entrances = Number(process.env.MINECRAFT_MAP_ENTRANCES ?? 0);
  if (walk.length || entrances) {
    await consoleCommand('gamemode survival MinebotTrial');
    await consoleCommand('effect give MinebotTrial minecraft:resistance infinite 4 true');
    await consoleCommand('effect give MinebotTrial minecraft:water_breathing infinite 0 true');
    await consoleCommand('effect give MinebotTrial minecraft:night_vision infinite 0 true');
  }
  if (walk.length) {
    const here = actor.entity.position;
    await consoleCommand(`spreadplayers ${Math.floor(here.x)} ${Math.floor(here.z)} 0 1 false MinebotTrial`, 4000);
    cost();
    for (const leg of walk) {
      const [x, z] = leg.split(',').map(Number);
      const from = actor.entity.position.clone();
      const started = Date.now();
      let outcome = 'reached';
      try {
        const movements = new Movements(actor);
        actor.pathfinder.setMovements(movements);
        await Promise.race([actor.pathfinder.goto(new goals.GoalXZ(x, z)), sleep(120_000).then(() => { throw new Error('timeout 120s'); })]);
      } catch (error) { outcome = String(error).slice(0, 120); actor.pathfinder.stop(); }
      report.walks.push({ to: [x, z], from: from.floored(), at: actor.entity.position.floored(), seconds: Math.round((Date.now() - started) / 1000),
        metres: Math.round(from.distanceTo(actor.entity.position)), outcome, cost: cost() });
      console.log(`MAP_WALK ${JSON.stringify(report.walks.at(-1))}`);
    }
  }
  if (entrances) {
    const known = memory.recall('cave_entrance', entrances) as any[];
    for (const entrance of known) {
      const bottom = entrance.note?.match(/\((-?\d+),(-?\d+),(-?\d+)\)/);
      if (!bottom) continue;
      const goal = new Vec3(Number(bottom[1]), Number(bottom[2]), Number(bottom[3]));
      await consoleCommand(`tp MinebotTrial ${entrance.position.x} ${entrance.position.y} ${entrance.position.z}`, 4000);
      const start = actor.entity.position.clone();
      const started = Date.now();
      let outcome = 'reached';
      try {
        const movements = new Movements(actor);
        Object.assign(movements, { canDig: false, allow1by1towers: false, scafoldingBlocks: [], allowParkour: true });
        actor.pathfinder.setMovements(movements);
        await Promise.race([actor.pathfinder.goto(new goals.GoalNear(goal.x, goal.y, goal.z, 2)), sleep(150_000).then(() => { throw new Error('timeout 150s'); })]);
      } catch (error) { outcome = String(error).slice(0, 120); actor.pathfinder.stop(); }
      const end = actor.entity.position;
      report.entrances.push({ mouth: entrance.position, distance: entrance.distance, bottom: goal, cells: entrance.count, startY: Math.floor(start.y),
        endedAt: end.floored(), descended: Math.floor(start.y - end.y), seconds: Math.round((Date.now() - started) / 1000), outcome,
        // What else this walk saw: ore with a face open to the air along the way.
        oresWithin16: Object.fromEntries(['iron_ore', 'diamond_ore', 'coal_ore'].map(kind => [kind, memory.recall(kind, 50).filter((place: any) => place.distance <= 16).length])) });
      console.log(`MAP_ENTRANCE ${JSON.stringify(report.entrances.at(-1))}`);
    }
  }
  report.final = { places: memory.state.places.length, byKind: Object.fromEntries(Object.entries(memory.state.places.reduce((counts: any, place: any) => {
    counts[place.kind] = (counts[place.kind] ?? 0) + 1; return counts; }, {})).sort((a: any, b: any) => b[1] - a[1])), memory: cost().memory };
  // The memory as it stood (full, in a run of this length): the bench reads the columns into it, as a body that has been about.
  if (process.env.MINECRAFT_MAP_DUMP) fs.writeFileSync(`${process.env.MINECRAFT_MAP_DUMP}.state.json`, JSON.stringify(memory.state));
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  closeProbeBot(actor);
  const file = path.resolve('saves/minecraft/progressive_reports', `${new Date().toISOString().replace(/[:.]/g, '-')}-map-survey.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`MAP_SURVEY_REPORT ${JSON.stringify({ file, final: report.final, error: report.error })}`);
  setTimeout(() => process.exit(), 1000);
}
