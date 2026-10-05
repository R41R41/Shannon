#!/usr/bin/env node
// Model-free and command-free: join an isolated lab world as it stands and report what the body's memory of
// places holds after the loaded chunks have been read, what reading them cost, and what one observation carries.
// MINECRAFT_PLACE_GOALS="x,y,z,range;..." walks there in turn and reports again after each.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { captureWorldObservation } from '../src/services/minebot/cognition/worldFrame.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const actor: any = await createProbeBot(port, 'MinebotTrial');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// The longest gap between two physics ticks while the columns are read: what the reading costs the body.
let lastTick = performance.now(); let worstGapMs = 0;
actor.on('physicsTick', () => { const now = performance.now(); worstGapMs = Math.max(worstGapMs, now - lastTick); lastTick = now; });
const snapshot = (label: string) => {
  const memory = actor.placeMemory;
  const byKind: Record<string, number> = {};
  for (const place of memory.state.places) byKind[place.kind] = (byKind[place.kind] ?? 0) + 1;
  const observation: any = captureWorldObservation(actor);
  return { label, position: actor.entity.position.floored(), columnsLoaded: actor.world.getColumns().length,
    stats: { ...memory.stats, maxReadMs: +memory.stats.maxReadMs.toFixed(2), totalReadMs: +memory.stats.totalReadMs.toFixed(1),
      meanReadMs: +(memory.stats.totalReadMs / Math.max(1, memory.stats.columnsRead)).toFixed(2) },
    worstTickGapMs: +worstGapMs.toFixed(1), places: memory.state.places.length, byKind,
    rememberedPlaces: observation.rememberedPlaces, observationChars: JSON.stringify(observation.rememberedPlaces ?? {}).length,
    recallWater: memory.recall('water', 3).map((place: any) => `${place.distance}m ${place.direction} ×${place.count ?? 1}`),
    stateBytes: JSON.stringify(memory.state).length };
};
const report: any = { snapshots: [] };
try {
  await sleep(Number(process.env.MINECRAFT_PLACE_SETTLE_MS ?? 15_000));
  report.snapshots.push(snapshot('arrival'));
  const move = actor.instantSkills.getSkill('move-to');
  for (const spec of (process.env.MINECRAFT_PLACE_GOALS ?? '').split(';').filter(Boolean)) {
    const [x, y, z, range] = spec.split(',').map(Number);
    worstGapMs = 0;
    const result = await move.run(x, y, z, range || 3, 'near');
    await sleep(3000);
    report.snapshots.push({ ...snapshot(`after ${spec}`), move: String(result.result).slice(0, 120) });
  }
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  closeProbeBot(actor);
  const file = path.resolve('saves/minecraft/progressive_reports', `${new Date().toISOString().replace(/[:.]/g, '-')}-place-memory.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`PLACE_MEMORY_REPORT ${JSON.stringify(report)}`);
}
