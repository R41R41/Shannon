#!/usr/bin/env node
// Model-free measurement: how far the body can read blocks at all (loaded
// chunks) and what it costs to look for rare marker blocks across all of it.
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { scanLoadedBlocks } from '../src/services/minebot/utils/loadedBlockScan.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_SCAN_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_SCAN_WORLD_CONFIGURATION_INVALID');
const actor = await createProbeBot(port, 'MinebotTrial');
await new Promise(resolve => setTimeout(resolve, 6000));
const columns = (actor.world as any).getColumns?.() ?? [];
const here = actor.entity.position;
const reach = columns.reduce((max: number, column: any) => Math.max(max, Math.hypot(column.chunkX * 16 + 8 - here.x, column.chunkZ * 16 + 8 - here.z)), 0);
const names = ['bell', 'hay_block', 'composter', 'lectern', 'smithing_table', 'grindstone', 'fletching_table', 'cartography_table', 'loom', 'barrel',
  ...Object.keys(actor.registry.blocksByName).filter(name => name.endsWith('_bed'))];
const ids = names.map(name => actor.registry.blocksByName[name]?.id).filter((id): id is number => typeof id === 'number');
const time = (label: string, run: () => unknown) => {
  const startedAt = process.hrtime.bigint();
  const result: any = run();
  return { label, ms: Number(process.hrtime.bigint() - startedAt) / 1e6, found: Array.isArray(result) ? result.length : result };
};
const cross = { byFindBlocks: actor.findBlocks({ matching: [actor.registry.blocksByName.oak_log.id, actor.registry.blocksByName.birch_log.id], maxDistance: 256, count: 100000 }).length,
  byPalette: scanLoadedBlocks(actor as any, ['oak_log', 'birch_log']).hits.length };
const report = { cross, viewDistanceSetting: properties.find(line => line.startsWith('view-distance')), loadedColumns: columns.length, farthestLoadedColumnMetres: Math.round(reach),
  scans: [
    time('markers by id, 96m', () => actor.findBlocks({ matching: ids, maxDistance: 96, count: 64 })),
    time('markers by id, 256m', () => actor.findBlocks({ matching: ids, maxDistance: 256, count: 64 })),
    time('markers by id, 256m, again', () => actor.findBlocks({ matching: ids, maxDistance: 256, count: 64 })),
    time('common block by id (stone), 256m, 64 hits', () => actor.findBlocks({ matching: actor.registry.blocksByName.stone.id, maxDistance: 256, count: 64 })),
    time('predicate function (no palette skip), 96m', () => actor.findBlocks({ matching: (block: any) => block.name === 'bell', maxDistance: 96, count: 8 })),
    time('palette scan of loaded chunks: markers', () => scanLoadedBlocks(actor as any, names).hits),
    time('palette scan of loaded chunks: markers, again', () => scanLoadedBlocks(actor as any, names).hits),
    time('palette scan of loaded chunks: oak_log (common)', () => scanLoadedBlocks(actor as any, ['oak_log', 'birch_log']).hits),
  ] };
console.log(`SCAN_COST ${JSON.stringify(report)}`);
await closeProbeBot(actor);
process.exit(0);
