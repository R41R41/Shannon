#!/usr/bin/env node
// Model-free: a watcher in spectator looks at a place in a lab world and prints a map from above, one line per z:
// for each column the height of the highest floor with room to stand (as an offset from the centre's y, 0-9 and
// a-z above, A-Z below), '#' where nothing can stand, '~' for lava on top, 'S' for a spawner. For reading a
// structure before a walk is asked across it.
//   MINECRAFT_MAP_AT="x,y,z"  MINECRAFT_MAP_RADIUS=22  MINECRAFT_MAP_DIMENSION=the_nether  MINECRAFT_MAP_SPAN=8
import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const [cx, cy, cz] = (process.env.MINECRAFT_MAP_AT ?? '').split(',').map(Number);
const radius = Number(process.env.MINECRAFT_MAP_RADIUS ?? 22), span = Number(process.env.MINECRAFT_MAP_SPAN ?? 8);
const dimension = process.env.MINECRAFT_MAP_DIMENSION ?? 'the_nether';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const operator = await createProbeBot(port);
const control = new MinecraftCommandOracle(operator);
try {
  await control.verifyReady();
  await control.executeSetupCommand('gamemode spectator ShannonProbe');
  await control.executeSetupCommand(`execute in minecraft:${dimension} run tp ShannonProbe ${cx} ${cy + 3} ${cz}`);
  await sleep(7000);
  const at = (x: number, y: number, z: number) => operator.blockAt(new Vec3(x, y, z));
  const rows: string[] = [];
  const floors: Record<string, number> = {};
  for (let z = cz - radius; z <= cz + radius; z++) {
    let row = '';
    for (let x = cx - radius; x <= cx + radius; x++) {
      let mark = '#';
      for (let y = cy + span; y >= cy - span; y--) {
        const block = at(x, y, z);
        if (block?.name === 'spawner') { mark = 'S'; break; }
        if (block?.name === 'lava') { mark = '~'; break; }
        if (block?.boundingBox === 'block' && at(x, y + 1, z)?.boundingBox === 'empty' && at(x, y + 2, z)?.boundingBox === 'empty') {
          const offset = y + 1 - cy;
          mark = offset >= 0 ? '0123456789abcdefghijklmnopqrstuvwxyz'[offset] : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[-offset - 1];
          floors[block.name] = (floors[block.name] ?? 0) + 1;
          break;
        }
      }
      row += mark;
    }
    rows.push(`${String(z).padStart(5)} ${row}`);
  }
  const mobs = Object.values(operator.entities).filter((entity: any) => entity?.type === 'hostile' || entity?.type === 'mob')
    .map((entity: any) => `${entity.name}@${entity.position.floored().toArray().join(',')}`).slice(0, 30);
  // What the place memory would note of the centre's chunk (a spawner and what it makes).
  const { readColumn } = await import('../src/services/minebot/utils/placeMemory.js');
  const noted = (operator as any).placeMemory?.recall('spawner', 4).map((place: any) => `${place.position.x},${place.position.y},${place.position.z} ${place.note ?? '-'}`);
  console.log(`AREA_NOTED ${JSON.stringify({ noted, raw: JSON.stringify((at(cx, cy, cz) as any)?.entity ?? null).slice(0, 300), readColumn: typeof readColumn })}`);
  console.log(`AREA_MAP ${JSON.stringify({ at: [cx, cy, cz], west: cx - radius, column: [-2, -1, 0, 1, 2, 3].map(dy => at(cx, cy + dy, cz)?.name), floors, mobs })}`);
  console.log(rows.join('\n'));
} finally {
  await closeProbeBot(operator);
}
process.exit(0);
