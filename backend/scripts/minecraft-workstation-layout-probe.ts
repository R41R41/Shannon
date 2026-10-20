#!/usr/bin/env node
// Model-free: where a crafting table and furnaces are set down, and whether they can be used. Cases (MINECRAFT_WS_CASE):
//   chain  - table, furnace, second furnace set down by the body (place-block-at with no coordinates, craft-one furnace, start-smelting):
//            seconds per tool, how far the body moved, and whether all three can be used from where it ends.
//   shadow - a table set behind a furnace (setblock): craft-one furnace must find a stand that sees the table; a furnace set behind
//            a table: start-smelting must find a stand that sees the furnace.
//   cave   - the same chain in a one-block tunnel (a dead end), where a block set down in the tunnel closes the way out.
// MINECRAFT_WS_TERRAIN=surface runs the case on the world's own ground (flat or natural) instead of a stone platform in the sky.
// Setup commands are lab-only (an isolated server on 127.0.0.1).
import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { stationAccess, listWorkstations } from '../src/services/minebot/utils/workstationAccess.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25669
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');

const caseName = process.env.MINECRAFT_WS_CASE ?? 'chain';
const surface = process.env.MINECRAFT_WS_TERRAIN === 'surface';
const actor = await createProbeBot(port, 'MinebotTrial');
const operator = await createProbeBot(port);
const oracle = new MinecraftCommandOracle(operator);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: any = { case: caseName, surface };
const setup = (command: string) => oracle.executeSetupCommand(command);
const count = (name: string) => actor.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);

async function run(label: string, name: string, ...args: any[]) {
  const before = actor.entity.position.clone();
  const started = Date.now();
  const result: any = await Promise.race([actor.instantSkills.getSkill(name)!.run(...args), sleep(60_000).then(() => ({ success: false, result: 'probe time limit' }))]);
  const step = { label, tool: name, ms: Date.now() - started, success: result?.success ?? null, failureType: result?.failureType ?? null,
    moved: +actor.entity.position.distanceTo(before).toFixed(2), result: String(result?.result).slice(0, 260),
    ...(process.env.MINECRAFT_WS_SNAPSHOT ? { at: actor.entity.position.toArray().map(n => +n.toFixed(2)), snapshot: snapshot() } : {}) };
  (report.steps ??= []).push(step);
  return { step, result };
}
const SYMBOLS: Record<string, string> = { air: '.', cave_air: '.', stone: '#', furnace: 'F', crafting_table: 'T', cobblestone: 'c' };
// Rows of z, columns of x round the body, one string per y layer (top first): # stone, . air, F furnace, T table, @ the body's cell.
function snapshot() {
  const p = actor.entity.position.floored();
  const layers: string[] = [];
  for (let dy = 2; dy >= -1; dy--) {
    const rows: string[] = [];
    for (let dz = -2; dz <= 2; dz++) {
      let row = '';
      for (let dx = -3; dx <= 6; dx++) row += dx === 0 && dz === 0 && dy <= 1 && dy >= 0 ? '@' : (SYMBOLS[actor.blockAt(p.offset(dx, dy, dz))?.name ?? ''] ?? '?');
      rows.push(row);
    }
    layers.push(`y${dy >= 0 ? '+' : ''}${dy}:${rows.join('/')}`);
  }
  return layers;
}
const placedAt = (text: string) => { const m = /\((-?\d+), (-?\d+), (-?\d+)\)に設置/.exec(text); return m ? new Vec3(+m[1], +m[2], +m[3]) : null; };

try {
  await oracle.verifyReady();
  for (const command of ['gamerule spawn_mobs false', 'time set day', 'gamemode spectator ShannonProbe', 'kill @e[type=!minecraft:player]',
    'clear MinebotTrial', 'effect clear MinebotTrial', 'gamemode survival MinebotTrial', 'effect give MinebotTrial minecraft:instant_health 1 5']) await setup(command);
  const cx = surface ? 300 : 60, cz = surface ? 300 : 90;
  let y = 230;
  await setup(`forceload add ${cx - 24} ${cz - 24} ${cx + 24} ${cz + 24}`);
  if (surface) {
    await setup('effect give MinebotTrial minecraft:slow_falling 60 0 true');
    await setup(`tp MinebotTrial ${cx + 0.5} 200 ${cz + 0.5}`);
    for (let waited = 0; waited < 40_000 && !actor.entity.onGround; waited += 250) await sleep(250);
    await sleep(800);
    await setup('effect clear MinebotTrial');
    y = Math.floor(actor.entity.position.y);
    // A clear patch of ground: the plants and snow on it, and the air over it, cleared (the ground itself is what the world made).
    await setup(`fill ${cx - 8} ${y} ${cz - 8} ${cx + 8} ${y + 4} ${cz + 8} air`);
    // The shadow case tp's the body about the patch: a floor under all of it (the chain case keeps the world's own ground).
    if (caseName === 'shadow') await setup(`fill ${cx - 8} ${y - 1} ${cz - 8} ${cx + 8} ${y - 1} ${cz + 8} grass_block`);
    await sleep(500);
  } else {
    await setup('effect give MinebotTrial minecraft:slow_falling 8 0 true');
    await setup(`tp MinebotTrial ${cx + 0.5} ${y + 3} ${cz + 0.5}`);
    await sleep(2500);
    await setup(`fill ${cx - 20} ${y - 1} ${cz - 20} ${cx + 20} ${y + 6} ${cz + 20} air`);
    await setup(`fill ${cx - 20} ${y - 1} ${cz - 20} ${cx + 20} ${y - 1} ${cz + 20} stone`);
    await setup(`tp MinebotTrial ${cx + 0.5} ${y} ${cz + 0.5}`);
    await sleep(2000);
    await setup('effect clear MinebotTrial');
  }
  report.groundY = y;
  const give = async (items: Array<[string, number]>) => { for (const [name, n] of items) await setup(`give MinebotTrial minecraft:${name} ${n}`); await sleep(1200); };

  if (caseName === 'cave') {
    // A tunnel two high, nine long, in solid stone; the body stands at its dead end.
    await setup(`fill ${cx - 4} ${y - 1} ${cz - 4} ${cx + 12} ${y + 4} ${cz + 4} stone`);
    await setup(`fill ${cx} ${y} ${cz} ${cx + 8} ${y + 1} ${cz} air`);
    await setup(`tp MinebotTrial ${cx + 0.5} ${y} ${cz + 0.5}`);
    await sleep(1500);
  }
  if (caseName === 'niche') {
    // The steps of a niche by hand: dig the wall cell at head height beside the body, put a table in it, look at the body and the view.
    await setup(`fill ${cx - 4} ${y - 1} ${cz - 4} ${cx + 12} ${y + 4} ${cz + 4} stone`);
    await setup(`fill ${cx} ${y} ${cz} ${cx + 8} ${y + 1} ${cz} air`);
    await setup(`tp MinebotTrial ${cx + 0.5} ${y} ${cz + 0.5}`);
    await sleep(1500);
    await give([['stone_pickaxe', 1], ['crafting_table', 1]]);
    const dug = await run('dig niche', 'dig-block-at', cx, y + 1, cz + 1, false);
    const placed = await run('place table', 'place-block-at', 'crafting_table', cx, y + 1, cz + 1);
    const access = stationAccess(actor as any, new Vec3(cx, y + 1, cz + 1));
    report.niche = { dug: dug.step, placed: placed.step, access: { ready: access.ready, inReach: access.inReach, obstruction: access.obstruction?.name ?? null } };
    throw Object.assign(new Error('done'), { done: true });
  }
  if (caseName === 'reach') {
    // The server's own answer: a furnace opened from a growing distance on the flat, and from above and below. Eye = feet + 1.62.
    await setup(`setblock ${cx + 1} ${y} ${cz} minecraft:furnace`);
    await setup(`fill ${cx - 12} ${y - 1} ${cz - 3} ${cx + 1} ${y - 1} ${cz + 3} stone`);
    const tries: any[] = [];
    for (const d of [3.0, 3.8, 4.0, 4.2, 4.4, 4.6, 4.8, 5.0, 5.2, 5.5]) {
      // Standing d west of the furnace's west face (horizontal distance from the feet to the face), same level.
      await setup(`tp MinebotTrial ${cx + 1 - d} ${y} ${cz + 0.5}`);
      await sleep(1200);
      const block = actor.blockAt(new Vec3(cx + 1, y, cz))!;
      const eyes = actor.entity.position.offset(0, 1.62, 0);
      const toCentre = eyes.distanceTo(new Vec3(cx + 1.5, y + 0.5, cz + 0.5));
      const toFace = Math.hypot(Math.max(0, cx + 1 - eyes.x), Math.max(0, y - eyes.y, eyes.y - (y + 1)), Math.max(0, cz - eyes.z, eyes.z - (cz + 1)));
      let opened = false, error = '';
      try { const furnace: any = await Promise.race([actor.openFurnace(block), sleep(3500).then(() => { throw new Error('timeout'); })]); opened = !!furnace; furnace?.close?.(); }
      catch (e) { error = String((e as Error).message).slice(0, 60); }
      await sleep(300);
      tries.push({ d, feetX: +actor.entity.position.x.toFixed(2), eyeToCentre: +toCentre.toFixed(2), eyeToFace: +toFace.toFixed(2), opened, error });
    }
    // The same at height: the furnace one to three blocks above the feet, 3 blocks away.
    for (const dy of [-3, -2, 2, 3]) {
      await setup(`fill ${cx - 4} ${y + dy - 1} ${cz - 1} ${cx - 2} ${y + dy - 1} ${cz + 1} stone`);
      await setup(`tp MinebotTrial ${cx - 2.5} ${y + dy} ${cz + 0.5}`);
      await sleep(1200);
      const block = actor.blockAt(new Vec3(cx + 1, y, cz))!;
      const eyes = actor.entity.position.offset(0, 1.62, 0);
      let opened = false, error = '';
      try { const furnace: any = await Promise.race([actor.openFurnace(block), sleep(3500).then(() => { throw new Error('timeout'); })]); opened = !!furnace; furnace?.close?.(); }
      catch (e) { error = String((e as Error).message).slice(0, 60); }
      tries.push({ dy, eyeToCentre: +eyes.distanceTo(new Vec3(cx + 1.5, y + 0.5, cz + 0.5)).toFixed(2), opened, error });
    }
    report.reach = tries;
    throw Object.assign(new Error('done'), { done: true });
  }
  if (caseName === 'shadow') {
    // Area A (west): a furnace behind a table, for start-smelting. Area B (east): a table behind a furnace, for craft-one.
    await setup(`setblock ${cx - 5} ${y} ${cz} minecraft:crafting_table`);
    await setup(`setblock ${cx - 6} ${y} ${cz} minecraft:furnace`);
  }
  await give([['cobblestone', 40], ['raw_iron', 8], ['coal', 8], ['crafting_table', 1], ['oak_planks', 8], ['stone_pickaxe', 1]]);
  await sleep(500);

  if (caseName === 'shadow') {
    // 1) start-smelting on a furnace behind a table: the body stands in line with the two, the table between.
    await setup(`tp MinebotTrial ${cx - 1.5} ${y} ${cz + 0.5}`);
    await sleep(1500);
    const access0 = stationAccess(actor as any, new Vec3(cx - 6, y, cz));
    report.furnaceBefore = { ready: access0.ready, inReach: access0.inReach, obstruction: access0.obstruction?.name ?? null };
    const smelt = await run('smelt behind table', 'start-smelting', cx - 6, y, cz, 'raw_iron', 'coal', 3);
    report.smeltShadow = smelt.step;
    // 2) craft-one furnace with the table behind a furnace, to the east.
    await setup(`setblock ${cx + 6} ${y} ${cz + 4} minecraft:crafting_table`);
    await setup(`setblock ${cx + 5} ${y} ${cz + 4} minecraft:furnace`);
    await setup(`tp MinebotTrial ${cx + 2.5} ${y} ${cz + 4.5}`);
    await sleep(1500);
    const tableAccess = stationAccess(actor as any, new Vec3(cx + 6, y, cz + 4));
    report.tableBefore = { ready: tableAccess.ready, inReach: tableAccess.inReach, obstruction: tableAccess.obstruction?.name ?? null };
    const before = count('furnace');
    const crafted = await run('craft furnace behind furnace', 'craft-one', 'furnace', 1);
    report.craftShadow = crafted.step;
    report.passed = smelt.step.success === true && crafted.step.success === true && count('furnace') > before;
    throw Object.assign(new Error('done'), { done: true });
  }

  // chain / cave
  const start = actor.entity.position.clone();
  const stations: Array<{ label: string; at: Vec3 }> = [];
  const t0 = Date.now();
  const table = await run('place table', 'place-block-at', 'crafting_table');
  const tableAt = placedAt(table.step.result); if (tableAt) stations.push({ label: 'table', at: tableAt });
  const make1 = await run('craft furnace 1', 'craft-one', 'furnace', 1);
  const place1 = await run('place furnace 1', 'place-block-at', 'furnace');
  const furnace1 = placedAt(place1.step.result); if (furnace1) stations.push({ label: 'furnace1', at: furnace1 });
  const smelt1 = furnace1 ? await run('smelt 1', 'start-smelting', furnace1.x, furnace1.y, furnace1.z, 'raw_iron', 'coal', 3) : null;
  const make2 = await run('craft furnace 2', 'craft-one', 'furnace', 1);
  const place2 = await run('place furnace 2', 'place-block-at', 'furnace');
  const furnace2 = placedAt(place2.step.result); if (furnace2) stations.push({ label: 'furnace2', at: furnace2 });
  const smelt2 = furnace2 ? await run('smelt 2', 'start-smelting', furnace2.x, furnace2.y, furnace2.z, 'raw_iron', 'coal', 3) : null;
  report.totalMs = Date.now() - t0;
  report.totalMoved = +actor.entity.position.distanceTo(start).toFixed(2);
  report.stations = stations.map(s => ({ ...s, at: s.at.toArray(), usableFromEnd: stationAccess(actor as any, s.at).ready }));
  report.worksite = listWorkstations(actor as any).map(s => `${s.name}@${s.position.toArray().join(',')}`);
  report.finalPosition = actor.entity.position.toArray().map(n => +n.toFixed(2));
  if (caseName === 'cave') {
    // The way out: the tunnel row and the head row east of the body are still open.
    const row = [];
    for (let x = cx + 1; x <= cx + 8; x++) for (const dy of [0, 1]) row.push(actor.blockAt(new Vec3(x, y + dy, cz))?.name);
    report.tunnelBlocked = row.filter(name => name !== 'air' && name !== 'cave_air').length;
  }
  const ok = (r: { step: { success: any } } | null) => r?.step.success === true;
  report.passed = [table, make1, place1, smelt1, make2, place2, smelt2].every(ok)
    && report.stations.every((s: any) => s.usableFromEnd) && (caseName !== 'cave' || report.tunnelBlocked === 0);
} catch (error) {
  if (!(error as any)?.done) report.error = String((error as Error)?.stack ?? error).slice(0, 600);
} finally {
  console.log(`WS_LAYOUT ${JSON.stringify(report)}`);
  await setup('clear MinebotTrial').catch(() => undefined);
  closeProbeBot(operator); closeProbeBot(actor);
  setTimeout(() => process.exit(0), 500);
}
