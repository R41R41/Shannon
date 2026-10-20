#!/usr/bin/env node
// Model-free lab probe for run 20's two body fixes (mb-r20-body, water): an empty bucket finding and scooping water by itself, and
// use-item on food at a half-empty hunger bar. WATER_CASE picks the part:
//   scoop  water of each kind (ocean, river, pond) from 5, 20 and 40 m, with and without coordinates; a waterfall (flowing); a pond under ice
//   carry  the water bucket kept through a descent: stair-mine, mine-block, dig-block-at, and what the pack holds after each
//   eat    use-item on raw and cooked meat at food 12; a meal begun by another consumer; a full bar
// Setup commands are lab-only; the world must be an isolated lab on 25660..25669.
import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25660 || port > 25669
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const which = process.env.WATER_CASE ?? 'scoop';
const actor: any = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = { case: which, rows: [] };
const cmd = (command: string) => oracle.executeSetupCommand(command);
const row = (data: object) => { report.rows.push(data); console.log(`WATER_ROW ${JSON.stringify(data)}`); };
const count = (name: string) => actor.inventory.items().filter((item: any) => item.name === name).reduce((sum: number, item: any) => sum + item.count, 0);
const run = async (skill: string, ...args: any[]) => {
  const started = Date.now();
  const result: any = await Promise.race([actor.instantSkills.getSkill(skill)!.run(...args), sleep(Number(process.env.WATER_SKILL_LIMIT_MS ?? 150_000)).then(() => ({ success: null, result: 'probe time limit' }))]);
  return { ms: Date.now() - started, success: result?.success ?? null, failureType: result?.failureType ?? null, text: String(result?.result ?? '').slice(0, 260) };
};
/** The server's own word (not the client's pack): the actor has the item in a container slot. The operator hears the answer. */
async function serverHas(item: string): Promise<boolean> {
  const id = Math.random().toString(36).slice(2, 10);
  return await new Promise<boolean>(resolve => {
    const listener = (message: unknown) => { const text = String(message); if (text.includes(`HAS${id}`)) done(true); else if (text.includes(`NOT${id}`)) done(false); };
    const timer = setTimeout(() => done(false), 8000);
    const done = (value: boolean) => { clearTimeout(timer); operator.removeListener('message', listener); resolve(value); };
    operator.on('message', listener);
    operator.chat(`/execute as MinebotTrial if items entity @s container.* ${item} run tellraw @a[name=ShannonProbe] {"text":"HAS${id}"}`);
    operator.chat(`/execute as MinebotTrial unless items entity @s container.* ${item} run tellraw @a[name=ShannonProbe] {"text":"NOT${id}"}`);
  });
}
const waterId = actor.registry.blocksByName.water.id;
const solid = (at: Vec3) => actor.blockAt(at)?.boundingBox === 'block';
const open = (at: Vec3) => { const b = actor.blockAt(at); return !!b && b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava'; };

async function prepare() {
  for (const command of ['gamerule spawn_mobs false', 'time set day', 'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]', 'clear MinebotTrial',
    'effect clear MinebotTrial', 'gamemode survival MinebotTrial', 'effect give MinebotTrial minecraft:instant_health 1 5']) await cmd(command);
}

/** Land at (x, z): the top solid cell with two open cells over it, scanned down from `from`; null when it is water or there is none. */
function groundAt(x: number, z: number, from: number): Vec3 | null {
  for (let y = from; y > from - 30; y--) {
    const here = new Vec3(x, y, z);
    if (/_leaves$|_log$/.test(String(actor.blockAt(here)?.name))) continue;
    if (solid(here) && open(here.offset(0, 1, 0)) && open(here.offset(0, 2, 0))) return here.offset(0, 1, 0);
    const b = actor.blockAt(here);
    if (b?.name === 'water') return null;
  }
  return null;
}

/** The surface water sources around the body (level 0, open air over them), with the biome. */
function surfaceWater() {
  const found: Vec3[] = actor.findBlocks({ matching: waterId, maxDistance: 90, count: 4000,
    useExtraInfo: (block: any) => Number(block.getProperties?.().level) === 0 && open(block.position.offset(0, 1, 0)) }) ?? [];
  // The kind by the extent of the surface around the source (the biome name is not known to the client): wide = ocean/lake, narrow = river, small = pond.
  const near = (at: Vec3) => found.filter(other => Math.abs(other.x - at.x) <= 12 && Math.abs(other.z - at.z) <= 12 && Math.abs(other.y - at.y) <= 1).length;
  return found.filter((_, index) => index % 5 === 0).map(at => { const n = near(at); return { at, biome: n >= 420 ? 'ocean' : n >= 70 ? 'river' : 'pond', extent: n }; });
}

async function stage(point: Vec3, wait = 2500) {
  await cmd('clear MinebotTrial'); await cmd('effect clear MinebotTrial');
  await cmd(`tp MinebotTrial ${point.x + 0.5} ${point.y} ${point.z + 0.5}`);
  await sleep(wait);
}

/** Water of each kind: scanned for around the world, one place for each. */
async function locate() {
  const places: Record<string, { source: Vec3; biome: string }> = {};
  const spots = [[0, 0], [160, 0], [0, 160], [-160, 0], [0, -160], [320, 0], [0, 320], [-320, 0], [0, -320], [240, 240], [-240, 240], [240, -240], [-240, -240], [480, 0], [0, 480]];
  for (const [x, z] of spots) {
    await cmd('effect give MinebotTrial minecraft:slow_falling 40 0 true'); await cmd('effect give MinebotTrial minecraft:resistance 40 4 true');
    await cmd(`tp MinebotTrial ${x + 0.5} 140 ${z + 0.5}`);
    await sleep(5000);
    for (const { at, biome } of surfaceWater()) {
      const kind = biome;
      // A shore: some land within 5 blocks of the source, so that the stands are real.
      const shore = [[3, 0], [-3, 0], [0, 3], [0, -3]].some(([dx, dz]) => groundAt(at.x + dx, at.z + dz, at.y + 4) !== null);
      if (!shore) continue;
      if (!places[kind]) places[kind] = { source: at, biome };
    }
    const anyWater: Vec3[] = actor.findBlocks({ matching: waterId, maxDistance: 90, count: 50 }) ?? [];
    console.log(`WATER_SCAN ${JSON.stringify({ at: [x, z], pos: actor.entity.position, anyWater: anyWater.length, sample: anyWater[0] ?? null,
      level: anyWater[0] ? actor.blockAt(anyWater[0])?.getProperties?.() : null, biome: anyWater[0] ? actor.blockAt(anyWater[0])?.biome?.name : null, columns: actor.world.getColumns().length, found: Object.keys(places) })}`);
    if (Object.keys(places).length >= 3 || (Object.keys(places).length >= 2 && !process.env.WATER_NEED_ALL)) break;
  }
  return places;
}

/** A land cell about `d` blocks (horizontally) from the water, at a similar height. */
function landAt(water: Vec3, d: number): Vec3 | null {
  for (let step = 0; step < 24; step++) {
    const angle = (step * 55 % 360) * Math.PI / 180;
    for (const radius of [d, d + 1, d - 1, d + 2]) {
      const g = groundAt(Math.round(water.x + Math.cos(angle) * radius), Math.round(water.z + Math.sin(angle) * radius), water.y + 8);
      if (g && Math.abs(g.y - water.y) <= 6) return g;
    }
  }
  return null;
}

async function naturalRows() {
  const places = await locate();
  report.places = Object.fromEntries(Object.entries(places).map(([k, v]) => [k, { source: v.source, biome: v.biome }]));
  for (const [kind, { source }] of Object.entries(places).filter(([name]) => !process.env.WATER_KINDS || process.env.WATER_KINDS.split(',').includes(name))) {
    for (const d of (process.env.WATER_DS ?? '5,20,40').split(',').map(Number)) {
      const land = landAt(source, d);
      if (!land) { row({ kind, d, skipped: 'no land at that distance' }); continue; }
      for (const mode of ['coords', 'none'] as const) {
        await stage(land);
        await cmd(`setblock ${source.x} ${source.y} ${source.z} minecraft:water`);
        await cmd('give MinebotTrial minecraft:bucket 1'); await sleep(1200);
        const startedAt = actor.entity.position.clone();
        const result = await run('use-item-on-block', ...(mode === 'coords' ? [source.x, source.y, source.z, 'bucket'] : [null, null, null, 'bucket']));
        const server = { passed: await serverHas('minecraft:water_bucket') };
        row({ kind, d, mode, from: `${startedAt.x.toFixed(0)},${startedAt.y.toFixed(0)},${startedAt.z.toFixed(0)}`, distanceToWater: +startedAt.distanceTo(source).toFixed(1),
          ...result, held: actor.heldItem?.name ?? null, serverHasWaterBucket: server.passed, walkedTo: +actor.entity.position.distanceTo(startedAt).toFixed(1) });
        await cmd('clear MinebotTrial');
      }
    }
  }
}

async function builtRows() {
  // Built fixtures on a stone pad far from any natural water (the pad is at y 199, the nearest natural water 130 blocks below).
  const pad = async (cx: number, cz: number) => {
    await cmd('effect give MinebotTrial minecraft:slow_falling 20 0 true');
    await cmd(`tp MinebotTrial ${cx + 0.5} 215 ${cz + 0.5}`); await sleep(3000);
    await cmd(`fill ${cx - 20} 190 ${cz - 20} ${cx + 20} 199 ${cz + 20} stone`); await cmd(`fill ${cx - 20} 200 ${cz - 20} ${cx + 20} 212 ${cz + 20} air`);
    await cmd(`tp MinebotTrial ${cx + 0.5} 200 ${cz + 0.5}`); await sleep(1500); await cmd('effect clear MinebotTrial');
    await cmd('clear MinebotTrial'); await cmd('give MinebotTrial minecraft:bucket 1'); await sleep(1000);
  };
  // A waterfall: a source in the air three blocks over the pad; the cells below it flow. The planner names a flowing cell.
  await pad(9000, 9000);
  await cmd('setblock 9003 203 9000 minecraft:water'); await sleep(3500);
  const flowing = [new Vec3(9005, 200, 9000), new Vec3(9004, 200, 9000), new Vec3(9003, 202, 9000)].find(at => actor.blockAt(at)?.name === 'water');
  if (flowing) row({ kind: 'waterfall (flowing cell named)', flowingCell: flowing, level: actor.blockAt(flowing)?.getProperties?.().level, ...(await run('use-item-on-block', flowing.x, flowing.y, flowing.z, 'bucket')), held: actor.heldItem?.name ?? null });
  else row({ kind: 'waterfall', skipped: 'no flowing cell formed' });
  // A pond under ice (5 x 5), no coordinates.
  await pad(9100, 9000);
  await cmd('fill 9104 199 8998 9108 199 9002 water'); await cmd('fill 9104 200 8998 9108 200 9002 ice');
  row({ kind: 'under-ice (no coordinates)', ...(await run('use-item-on-block', null, null, null, 'bucket')), held: actor.heldItem?.name ?? null, iceLeft: actor.blockAt(new Vec3(9106, 200, 9000))?.name });
  // A pond three below the rim (water at y 197, the rim at 199): reached from the rim.
  await pad(9200, 9000);
  await cmd('fill 9204 196 8998 9208 199 9002 air'); await cmd('fill 9204 196 8998 9208 197 9002 water');
  row({ kind: 'pond 2 below the rim', ...(await run('use-item-on-block', null, null, null, 'bucket')), held: actor.heldItem?.name ?? null });
  // A pit: the water five below the rim, walls straight down: the body has to go down into it.
  await pad(9300, 9000);
  await cmd('fill 9304 192 8998 9308 199 9002 air'); await cmd('fill 9304 192 8998 9308 193 9002 water');
  row({ kind: 'pit 6 below the rim', ...(await run('use-item-on-block', 9306, 193, 9000, 'bucket')), held: actor.heldItem?.name ?? null, y: actor.entity.position.y });
  // Water behind a wall (the pond walled in with stone, a window on one side): no way in is no way to scoop; it must say so.
  await pad(9400, 9000);
  await cmd('fill 9404 199 8998 9408 199 9002 water'); await cmd('fill 9403 200 8997 9409 202 9003 stone'); await cmd('fill 9404 200 8998 9408 202 9002 air');
  await cmd('fill 9404 203 8998 9408 203 9002 stone');
  row({ kind: 'water inside a closed room', ...(await run('use-item-on-block', null, null, null, 'bucket')), held: actor.heldItem?.name ?? null });  // A body with no water at all within reach (a flat stone slab far from any): the reason and the next step it gives.
  await pad(9500, 9000);
  row({ kind: 'no-water', ...(await run('use-item-on-block', null, null, null, 'bucket', 0, 24)) });
}

async function carryRows() {
  const places = await locate();
  const kind = places.pond ?? places.river ?? places.ocean;
  if (!kind) { row({ skipped: 'no water found' }); return; }
  const land = landAt(kind.source, 5)!;
  await stage(land);
  await cmd('give MinebotTrial minecraft:bucket 1'); await cmd('give MinebotTrial minecraft:iron_pickaxe 1'); await cmd('give MinebotTrial minecraft:cooked_beef 8'); await sleep(1500);
  const scoop = await run('use-item-on-block', null, null, null, 'bucket');
  const pack = () => ({ water_bucket: count('water_bucket'), bucket: count('bucket'), held: actor.heldItem?.name ?? null, y: Math.round(actor.entity.position.y) });
  row({ step: 'scoop', ...scoop, pack: pack() });
  const y0 = actor.entity.position.y;
  const stair = await run('stair-mine', Math.round(y0) - 25);
  row({ step: 'stair-mine -25', ...stair, pack: pack() });
  const mined = await run('mine-block', 'stone', 6);
  row({ step: 'mine-block stone 6', ...mined, pack: pack() });
  const at = actor.entity.position.floored();
  const dig = await run('dig-block-at', at.x + 1, at.y, at.z);
  row({ step: 'dig-block-at', ...dig, pack: pack() });
  await sleep(8000);
  row({ step: 'after 8 s idle underground', pack: pack(), serverHasWaterBucket: await serverHas('minecraft:water_bucket'), serverHasBucket: await serverHas('minecraft:bucket') });
}

async function eatRows() {
  const spot = new Vec3(0, 200, 0);
  await cmd('difficulty normal');
  await cmd('effect give MinebotTrial minecraft:slow_falling 5 0 true');
  await cmd(`fill -6 199 -6 6 199 6 stone`); await cmd(`fill -6 200 -6 6 204 6 air`);
  await cmd(`tp MinebotTrial ${spot.x + 0.5} 200 ${spot.z + 0.5}`); await sleep(2500);
  const lower = async (target: number) => {
    await cmd('effect give MinebotTrial minecraft:hunger 30 60 true');
    for (const deadline = Date.now() + 15_000; Date.now() < deadline && actor.food > target;) await sleep(100);
    await cmd('effect clear MinebotTrial'); await sleep(600);
  };
  const raise = async () => { await cmd('effect give MinebotTrial minecraft:saturation 1 20 true'); await sleep(1500); await cmd('effect clear MinebotTrial'); };
  const fed = async (label: string, food: number, item: string, extra?: () => Promise<void>) => {
    await cmd('clear MinebotTrial'); await sleep(300);
    await cmd(`give MinebotTrial minecraft:${item} 4`); await sleep(1000);
    if (food >= 20) await raise(); else await lower(food);
    const startFood = actor.food;
    const sword = actor.inventory.items().find((it: any) => it.name === item);
    if (sword) await actor.equip(sword, 'hand');
    const extraDone = extra ? extra() : Promise.resolve();
    const result = await run('use-item', item);
    await extraDone;
    await sleep(800);
    row({ label, item, startFood, endFood: actor.food, left: count(item), ...result });
  };
  await fed('raw beef at ~12', 12, 'beef');
  await fed('cooked beef at ~12', 12, 'cooked_beef');
  await fed('porkchop (raw) at ~12', 12, 'porkchop');
  // Another consumer begins the same meal just before ours (the body's reflex): ours waits for it.
  await cmd('clear MinebotTrial'); await sleep(300); await cmd('give MinebotTrial minecraft:cooked_beef 4'); await sleep(800); await lower(12);
  {
    const beef = actor.inventory.items().find((it: any) => it.name === 'cooked_beef'); await actor.equip(beef, 'hand');
    const startFood = actor.food;
    void actor.consume().catch(() => undefined);
    await sleep(300);
    const result = await run('use-item', 'cooked_beef');
    await sleep(800);
    row({ label: 'a reflex-like consume() began 300 ms earlier', startFood, endFood: actor.food, left: count('cooked_beef'), ...result });
  }
  // Another consume() comes in on top of ours halfway (auto-eat): ours is cancelled, the meal goes on.
  await cmd('clear MinebotTrial'); await sleep(300); await cmd('give MinebotTrial minecraft:cooked_beef 4'); await sleep(800); await lower(12);
  {
    const startFood = actor.food;
    setTimeout(() => { void actor.consume().catch(() => undefined); }, 500);
    const result = await run('use-item', 'cooked_beef');
    await sleep(2500);
    row({ label: 'another consume() on top of ours after 500 ms', startFood, endFood: actor.food, left: count('cooked_beef'), ...result });
  }
  await fed('full bar (bread)', 20, 'bread');
  await fed('full bar, golden apple', 20, 'golden_apple');
}

async function debugRows() {
  // The same start as the one case that failed (ocean 40 m, no coordinates): from (-8, 64, 10), the pond at x 12..17.
  const start = groundAtLoaded(Number(process.env.WATER_X ?? 12), Number(process.env.WATER_Z ?? 7));
  console.log(`WATER_DEBUG ${JSON.stringify({ start, below: actor.blockAt(start!.offset(0, -1, 0))?.name, cells: [[13, 62, 6], [14, 62, 7], [14, 62, 6], [13, 62, 7]].map(([x, y, z]) => `${actor.blockAt(new Vec3(x, y, z))?.name}:${actor.blockAt(new Vec3(x, y, z))?.getProperties?.().level}`) })}`);
  for (let i = 0; i < (Number(process.env.WATER_REPEAT) || 3); i++) {
    if (process.env.WATER_RESTORE) for (const [x, y, z] of [[13, 62, 6], [14, 62, 7], [14, 62, 6], [13, 62, 7]]) await cmd(`setblock ${x} ${y} ${z} minecraft:water`);
    await stage(start ?? new Vec3(-8, 64, 10));
    await cmd('give MinebotTrial minecraft:bucket 1'); await sleep(1200);
    const result = await run('use-item-on-block', null, null, null, 'bucket');
    const eyes = actor.entity.position.offset(0, 1.62, 0);
    const near = actor.findBlocks({ matching: waterId, maxDistance: 6, count: 8 }).map((at: Vec3) => `${at.x},${at.y},${at.z}:${actor.blockAt(at)?.getProperties?.().level}`);
    row({ i, ...result, pos: actor.entity.position, yaw: actor.entity.yaw, pitch: actor.entity.pitch, cursor: actor.blockAtCursor?.(5)?.name ?? null, onGround: actor.entity.onGround,
      waterNear: near, server: await serverHas('minecraft:water_bucket'), held: actor.heldItem?.name ?? null });
    await cmd('clear MinebotTrial');
  }
}
function groundAtLoaded(x: number, z: number): Vec3 | null { return groundAt(x, z, 90); }

try {
  await oracle.verifyReady();
  await prepare();
  if (which === 'scoop') { await naturalRows(); await builtRows(); }
  else if (which === 'built') await builtRows();
  else if (which === 'natural') await naturalRows();
  else if (which === 'debug') { await cmd('effect give MinebotTrial minecraft:slow_falling 30 0 true'); await cmd('tp MinebotTrial 0.5 120 0.5'); await sleep(5000); await debugRows(); }
  else if (which === 'carry') await carryRows();
  else await eatRows();
} catch (error) {
  report.error = String((error as Error)?.stack ?? error).slice(0, 800);
} finally {
  console.log(`WATER_REPORT ${JSON.stringify({ case: which, rows: report.rows.length, error: report.error ?? null })}`);
  await cmd('clear MinebotTrial').catch(() => undefined);
  closeProbeBot(operator); closeProbeBot(actor);
  setTimeout(() => process.exit(0), 500);
}
