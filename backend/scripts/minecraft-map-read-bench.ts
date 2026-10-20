#!/usr/bin/env node
// Times the body's reading of real chunk columns on a quiet machine: the columns a lab probe dumped
// (minecraft-map-survey-probe.ts MINECRAFT_MAP_DUMP=<file>), read into the memory the probe ended with (1,500 places), stop by stop,
// the way a physics tick reads them (work(2 ms) a call). Prints, per stop and round (the first round has the code cold), the longest
// step, the longest column (its steps added up), the most a tick gave the reading, and the steps of each kind.
//   node --loader ts-node/esm scripts/minecraft-map-read-bench.ts <dump.jsonl> [rounds=3]
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import prismarineChunk from 'prismarine-chunk';
import { parsePlaceMemory } from '../src/modules/minecraftLearning/places.js';
import { installPlaceMemory } from '../src/services/minebot/utils/placeMemory.js';

const [dump, roundsText = '3'] = process.argv.slice(2);
if (!dump || !fs.existsSync(dump)) throw new Error('usage: minecraft-map-read-bench.ts <dump.jsonl> [rounds]');
const registry = minecraftData('1.21.11');
const Chunk = (prismarineChunk as any)('1.21.11');
const byStop = new Map<string, Array<{ chunkX: number; chunkZ: number; column: any }>>();
for (const line of fs.readFileSync(dump, 'utf8').split('\n').filter(Boolean)) {
  const entry = JSON.parse(line);
  (byStop.get(entry.stop) ?? byStop.set(entry.stop, []).get(entry.stop)!).push({ chunkX: entry.chunkX, chunkZ: entry.chunkZ, column: Chunk.fromJson(entry.column) });
}
const stateFile = `${dump}.state.json`;
const saved = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null;
const round2 = (value: number) => Math.round(value * 100) / 100;

for (let round = 1; round <= Number(roundsText); round++) {
  for (const [stop, columns] of byStop) {
    const middle = columns[Math.floor(columns.length / 2)];
    const bot: any = Object.assign(new EventEmitter(), { registry, game: { dimension: 'overworld' },
      entity: { position: new Vec3(middle.chunkX * 16 + 8, 80, middle.chunkZ * 16 + 8) },
      world: { getColumns: () => columns, getColumn: (x: number, z: number) => columns.find(entry => entry.chunkX === x && entry.chunkZ === z)?.column } });
    installPlaceMemory(bot);
    if (saved) bot.placeMemory.state = parsePlaceMemory(JSON.parse(saved));
    let ticks = 0, maxTickMs = 0;
    while (bot.placeMemory.stats.columnsRead < columns.length && ticks < 100_000) {
      const started = performance.now();
      bot.placeMemory.work(2);
      maxTickMs = Math.max(maxTickMs, performance.now() - started);
      ticks++;
    }
    const stats = bot.placeMemory.stats;
    console.log(`MAP_BENCH ${JSON.stringify({ round, stop, columns: stats.columnsRead, ticks, meanColumnMs: round2(stats.totalReadMs / Math.max(1, stats.columnsRead)),
      maxColumnMs: round2(stats.maxColumnMs ?? NaN), maxStepMs: round2(stats.maxReadMs), maxTickMs: round2(maxTickMs), columnBuckets: stats.columnBuckets,
      phases: Object.fromEntries(Object.entries(stats.phases ?? {}).map(([name, phase]: [string, any]) => [name, { steps: phase.steps,
        meanMs: round2(phase.totalMs / phase.steps), maxMs: round2(phase.maxMs) }])),
      places: bot.placeMemory.state.places.length, entrances: bot.placeMemory.state.places.filter((place: any) => place.kind === 'cave_entrance').length })}`);
  }
}
