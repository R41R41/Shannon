#!/usr/bin/env node
// Model-free: a watcher in spectator looks at a box in a lab world and prints it layer by layer (one character
// per block, a legend after), with the items and mobs inside it. For reading what a run left standing (a
// shelter built round the body, a wall dug through) after the run is over.
//   MINECRAFT_BOX="x1,y1,z1,x2,y2,z2"  MINECRAFT_BOX_DIMENSION=the_nether
//   MINECRAFT_BOX_JSON=<file>: also every block and entity as JSON, for scripts/lab/render-box.py (a picture of it)
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
const [x1, y1, z1, x2, y2, z2] = (process.env.MINECRAFT_BOX ?? '').split(',').map(Number);
if (![x1, y1, z1, x2, y2, z2].every(Number.isFinite)) throw new Error('MINECRAFT_BOX="x1,y1,z1,x2,y2,z2" required');
const dimension = process.env.MINECRAFT_BOX_DIMENSION ?? 'the_nether';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const operator = await createProbeBot(port);
const control = new MinecraftCommandOracle(operator);
try {
  await control.verifyReady();
  await control.executeSetupCommand('gamemode spectator ShannonProbe');
  await control.executeSetupCommand(`execute in minecraft:${dimension} run tp ShannonProbe ${(x1 + x2) / 2} ${Math.max(y1, y2) + 4} ${(z1 + z2) / 2}`);
  await sleep(7000);
  const legend = new Map<string, string>([['air', '.'], ['cave_air', '.'], ['void_air', '.']]);
  const marks = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const mark = (name: string) => {
    if (!legend.has(name)) legend.set(name, marks[legend.size - 3] ?? '?');
    return legend.get(name)!;
  };
  const lines: string[] = [];
  const cells: Array<[number, number, number, string]> = [];
  for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
    lines.push(`y=${y}  (x ${Math.min(x1, x2)}→${Math.max(x1, x2)}, rows z ${Math.min(z1, z2)}→${Math.max(z1, z2)})`);
    for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
      let row = '';
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        const block: any = operator.blockAt(new Vec3(x, y, z));
        const name = block ? String(block.name) + (String(block.name).endsWith('_slab') ? `:${block.getProperties?.().type ?? '?'}` : '') : 'unloaded';
        row += mark(name);
        if (block && block.boundingBox !== 'empty' || /lava|water|fire/.test(name)) cells.push([x, y, z, name]);
      }
      lines.push(`  ${String(z).padStart(5)} ${row}`);
    }
  }
  const inside = (p: Vec3) => p.x >= Math.min(x1, x2) - 1 && p.x <= Math.max(x1, x2) + 1 && p.y >= Math.min(y1, y2) - 1
    && p.y <= Math.max(y1, y2) + 1 && p.z >= Math.min(z1, z2) - 1 && p.z <= Math.max(z1, z2) + 1;
  const entities = Object.values(operator.entities).filter((entity: any) => entity?.position && entity !== operator.entity && inside(entity.position))
    .map((entity: any) => {
      const item = entity.name === 'item' ? (entity.getDroppedItem?.()?.name ?? '?') : '';
      return `${entity.name}${item ? `(${item})` : ''}@${entity.position.toArray().map((v: number) => v.toFixed(1)).join(',')}`;
    });
  if (process.env.MINECRAFT_BOX_JSON) {
    const things = Object.values(operator.entities).filter((entity: any) => entity?.position && entity !== operator.entity && inside(entity.position))
      .map((entity: any) => ({ name: entity.name === 'item' ? `item:${entity.getDroppedItem?.()?.name ?? '?'}` : String(entity.name ?? entity.username ?? '?'),
        x: entity.position.x, y: entity.position.y, z: entity.position.z, height: entity.height ?? 1 }));
    fs.writeFileSync(process.env.MINECRAFT_BOX_JSON, JSON.stringify({ box: [x1, y1, z1, x2, y2, z2], dimension, cells, entities: things }));
  }
  console.log(`BOX_DUMP ${JSON.stringify({ box: [x1, y1, z1, x2, y2, z2], legend: Object.fromEntries([...legend].map(([name, m]) => [m, name])), entities })}`);
  console.log(lines.join('\n'));
} finally {
  await closeProbeBot(operator);
}
process.exit(0);
