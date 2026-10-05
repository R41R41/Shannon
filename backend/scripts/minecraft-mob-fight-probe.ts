#!/usr/bin/env node
// Model-free: one fight skill against a mob, with a given kit, on a stone floor in the open air. What the body
// can do in a fight is found here before a paid run meets that mob: whether the skill closes with it, how long
// the kill takes, what it costs in health, and whether what it drops is picked up. Development only (the kit and
// the mob come from commands).
//   MINECRAFT_FIGHT_MOB=blaze  MINECRAFT_FIGHT_COUNT=1  MINECRAFT_FIGHT_OFFSET="12,1,0"
//   MINECRAFT_FIGHT_KIT="stone_sword,iron_chestplate"   (armour and a shield are put on, the rest is carried)
//   MINECRAFT_FIGHT_SKILL=attack-continuously  MINECRAFT_FIGHT_ARGS='["blaze",40,32,1]'  MINECRAFT_FIGHT_MS=60000
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { visiblePointOn } from '../src/services/minebot/utils/sightLine.js';
import { Vec3 } from 'vec3';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const mob = process.env.MINECRAFT_FIGHT_MOB ?? 'blaze';
const count = Number(process.env.MINECRAFT_FIGHT_COUNT ?? 1);
const at = (process.env.MINECRAFT_FIGHT_AT ?? '3200.5,200,3200.5').split(',').map(Number);
const offset = (process.env.MINECRAFT_FIGHT_OFFSET ?? '12,1,0').split(',').map(Number);
const kit = (process.env.MINECRAFT_FIGHT_KIT ?? 'stone_sword,iron_chestplate').split(',').map(name => name.trim()).filter(Boolean);
const skillName = process.env.MINECRAFT_FIGHT_SKILL ?? 'attack-continuously';
const skillArgs: unknown[] = JSON.parse(process.env.MINECRAFT_FIGHT_ARGS ?? `["${mob}",40,32,${count}]`);
const maxMs = Number(process.env.MINECRAFT_FIGHT_MS ?? 60_000);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const SLOT: Record<string, string> = { helmet: 'armor.head', chestplate: 'armor.chest', leggings: 'armor.legs', boots: 'armor.feet', shield: 'weapon.offhand' };

const operator = await createProbeBot(port);
const actor: any = await createProbeBot(port, 'MinebotTrial');
const control = new MinecraftCommandOracle(operator);
const report: any = { mob, count, kit, skill: skillName, args: skillArgs };
try {
  await control.verifyReady();
  let [px, py, pz] = at.map(Math.floor);
  // MINECRAFT_FIGHT_REAL=<dimension>: the world as it is (a copy of a run's world), nothing built or cleared.
  // MINECRAFT_FIGHT_AT is then a spawner that stands there; the body is put on a free cell beside it, or with
  // MINECRAFT_FIGHT_WALK_FROM="x,y,z" at that point, from which it walks up itself (accept-threat, then move-to).
  const real = process.env.MINECRAFT_FIGHT_REAL;
  let realSpawner: number[] | null = null;
  if (real) {
    await control.executeSetupCommand('gamemode spectator ShannonProbe');
    await control.executeSetupCommand(`execute in minecraft:${real} run tp ShannonProbe ${px} ${py + 3} ${pz}`);
    await sleep(6000);
    const name = (x: number, y: number, z: number) => operator.blockAt(new Vec3(x, y, z))?.name ?? null;
    const box = (x: number, y: number, z: number) => operator.blockAt(new Vec3(x, y, z))?.boundingBox ?? null;
    report.realAt = { spawner: name(px, py, pz), around: [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => `${dx},${dz}: ${name(px + dx, py - 1, pz + dz)}/${name(px + dx, py, pz + dz)}/${name(px + dx, py + 1, pz + dz)}`) };
    if (name(px, py, pz) !== 'spawner') throw new Error(`NO_SPAWNER_AT:${px},${py},${pz}:${name(px, py, pz)}`);
    const side = [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([dx, dz]) => box(px + dx, py, pz + dz) === 'empty' && box(px + dx, py + 1, pz + dz) === 'empty' && box(px + dx, py - 1, pz + dz) === 'block');
    if (!side) throw new Error('NO_FREE_CELL_BESIDE_SPAWNER');
    realSpawner = [px, py, pz];
    px += side[0]; pz += side[1];
    at[0] = px + 0.5; at[1] = py; at[2] = pz + 0.5;
    // MINECRAFT_FIGHT_WALK_FROM="x,y,z", or "auto": a floor of the structure's own bricks 14 to 20 blocks off
    // with room to stand, found by the watcher.
    let from = at;
    if (process.env.MINECRAFT_FIGHT_WALK_FROM === 'auto') {
      const found: number[][] = [];
      for (let dx = -20; dx <= 20; dx++) for (let dz = -20; dz <= 20; dz++) for (let dy = -6; dy <= 6; dy++) {
        const span = Math.hypot(dx, dz);
        if (span < 14 || span > 20) continue;
        const [x, y, z] = [realSpawner[0] + dx, realSpawner[1] + dy, realSpawner[2] + dz];
        if (name(x, y - 1, z) === 'nether_bricks' && box(x, y, z) === 'empty' && box(x, y + 1, z) === 'empty' && box(x, y + 2, z) === 'empty') found.push([x + 0.5, y, z + 0.5]);
      }
      if (!found.length) throw new Error('NO_FLOOR_TO_WALK_FROM');
      from = found[Math.floor(found.length / 2)];
      report.walkFrom = { from, candidates: found.length };
    } else if (process.env.MINECRAFT_FIGHT_WALK_FROM) from = process.env.MINECRAFT_FIGHT_WALK_FROM.split(',').map(Number);
    for (const command of ['difficulty normal', 'gamemode survival MinebotTrial', 'clear MinebotTrial', 'effect clear MinebotTrial',
      `execute in minecraft:${real} run tp MinebotTrial ${from[0]} ${from[1]} ${from[2]}`,
      'effect give MinebotTrial minecraft:instant_health 1 5', 'effect give MinebotTrial minecraft:saturation 1 10']) await control.executeSetupCommand(command);
  } else {
  await control.executeSetupCommand(`execute in minecraft:overworld run tp ShannonProbe ${px} ${py + 14} ${pz}`);
  await sleep(4000);
  for (const command of [`forceload add ${px - 30} ${pz - 30} ${px + 30} ${pz + 30}`,
    `fill ${px - 26} ${py - 1} ${pz - 26} ${px + 26} ${py - 1} ${pz + 26} stone`, `fill ${px - 26} ${py} ${pz - 26} ${px + 26} ${py + 6} ${pz + 26} air`,
    `kill @e[type=minecraft:${mob}]`, 'kill @e[type=minecraft:item]', 'difficulty normal', 'time set noon', 'weather clear',   // rain kills a blaze by itself
    'gamemode spectator ShannonProbe', 'gamemode survival MinebotTrial', 'clear MinebotTrial', 'effect clear MinebotTrial',
    `execute in minecraft:overworld run tp MinebotTrial ${at[0]} ${at[1]} ${at[2]}`,
    'effect give MinebotTrial minecraft:instant_health 1 5', 'effect give MinebotTrial minecraft:saturation 1 10']) await control.executeSetupCommand(command);
  }
  for (const entry of kit) {
    const [item, amount] = entry.split('*');
    const slot = Object.entries(SLOT).find(([suffix]) => item.endsWith(suffix))?.[1];
    await control.executeSetupCommand(slot ? `item replace entity MinebotTrial ${slot} with minecraft:${item}` : `give MinebotTrial minecraft:${item} ${Number(amount) || 1}`);
  }
  // MINECRAFT_FIGHT_EFFECT="fire_resistance": an effect on the body for the fight (what a potion drunk beforehand would give).
  if (process.env.MINECRAFT_FIGHT_EFFECT) await control.executeSetupCommand(`effect give MinebotTrial minecraft:${process.env.MINECRAFT_FIGHT_EFFECT} 600 0 true`);
  // MINECRAFT_FIGHT_BUNKER=feet|eye|slit|slit8|cage|closed: a cobblestone cell round the body (walls two high, a roof), with one
  // opening on the side the mobs come from: at the feet (the upper block stays, so nothing looks in at the
  // eyes), at the eyes, or none. For finding out what a cover with a hole in it is worth before a skill builds one.
  const bunker = process.env.MINECRAFT_FIGHT_BUNKER;
  if (bunker) {
    const side = Math.abs(offset[0]) >= Math.abs(offset[2]) ? [Math.sign(offset[0]) || 1, 0] : [0, Math.sign(offset[2]) || 1];
    await control.executeSetupCommand(`fill ${px - 1} ${py} ${pz - 1} ${px + 1} ${py + 2} ${pz + 1} minecraft:cobblestone`);
    await control.executeSetupCommand(`fill ${px} ${py} ${pz} ${px} ${py + 1} ${pz} minecraft:air`);
    if (bunker === 'feet') await control.executeSetupCommand(`setblock ${px + side[0]} ${py} ${pz + side[1]} minecraft:air`);
    if (bunker === 'eye') await control.executeSetupCommand(`setblock ${px + side[0]} ${py + 1} ${pz + side[1]} minecraft:air`);
    // slit: on all four sides the block at the eyes is a slab in its upper half, so the gap is the lower half of
    // that cell: the body looks down and out under it; nothing standing outside has its eyes on a line to the body's.
    if (bunker === 'slit') for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
      await control.executeSetupCommand(`setblock ${px + dx} ${py + 1} ${pz + dz} minecraft:cobblestone_slab[type=top]`);
    // slit8: the slab in its upper half all round, corners too (a view on every side).
    // cage: the same, inside a walled and roofed corridor one block wide all round it (seven by seven outside):
    // what comes to be in the corridor stays within a blow of the slit, and a blow knocks it against the wall,
    // not away.
    if (bunker === 'slit8' || bunker === 'cage') {
      await control.executeSetupCommand(`fill ${px - 1} ${py + 1} ${pz - 1} ${px + 1} ${py + 1} ${pz + 1} minecraft:cobblestone_slab[type=top]`);
      await control.executeSetupCommand(`setblock ${px} ${py + 1} ${pz} minecraft:air`);
    }
    if (bunker === 'cage') {
      await control.executeSetupCommand(`fill ${px - 3} ${py} ${pz - 3} ${px + 3} ${py + 2} ${pz + 3} minecraft:cobblestone hollow`);
      await control.executeSetupCommand(`fill ${px - 2} ${py} ${pz - 2} ${px + 2} ${py + 1} ${pz + 2} minecraft:air`);
      await control.executeSetupCommand(`fill ${px - 1} ${py} ${pz - 1} ${px + 1} ${py + 2} ${pz + 1} minecraft:cobblestone`);
      await control.executeSetupCommand(`fill ${px} ${py} ${pz} ${px} ${py + 1} ${pz} minecraft:air`);
      await control.executeSetupCommand(`fill ${px - 1} ${py + 1} ${pz - 1} ${px + 1} ${py + 1} ${pz + 1} minecraft:cobblestone_slab[type=top]`);
      await control.executeSetupCommand(`setblock ${px} ${py + 1} ${pz} minecraft:air`);
    }
    report.bunker = bunker;
  }
  await sleep(5000);
  // MINECRAFT_FIGHT_SHIELD=off: without the reflex that raises the shield (the control).
  if (actor.shieldBlock && process.env.MINECRAFT_FIGHT_SHIELD === 'off') actor.shieldBlock.enabled = false;
  // MINECRAFT_FIGHT_GUARD=off: the shield still meets shots, but is not kept up between blows.
  if (actor.shieldBlock && process.env.MINECRAFT_FIGHT_GUARD === 'off') actor.shieldBlock.guard = false;
  const startedAt = Date.now();
  let lastHealth = actor.health, damage = 0, hitsTaken = 0, kills = 0, deaths = 0, swings = 0, nearest = Infinity, burning = 0;
  actor.on('health', () => { if (actor.health < lastHealth) { damage += lastHealth - actor.health; hitsTaken++; } lastHealth = actor.health; });
  actor.on('entityDead', (entity: any) => { if (entity?.name === mob) kills++; });
  actor.on('death', () => { deaths++; });
  // What the server says of the body itself (a shield struck, an item broken), and what the shield has left.
  const statuses: Array<[number, number]> = [];
  actor._client.on('entity_status', (packet: any) => { if (packet.entityId === actor.entity?.id && statuses.length < 80) statuses.push([Math.round((Date.now() - startedAt) / 100) / 10, packet.entityStatus]); });
  const offHand = () => { const item = actor.inventory.slots[actor.getEquipmentDestSlot('off-hand')]; return item ? `${item.name} ${item.maxDurability - (item.durabilityUsed ?? 0)}/${item.maxDurability}` : null; };
  report.offHandAtStart = offHand();
  const attack = actor.attack.bind(actor);
  actor.attack = (entity: any) => { swings++; return attack(entity); };
  const samples: string[] = [];
  const occupancy = { ticks: 0, occupied: 0, inView: 0, most: 0 };
  const where: number[][] = [];
  let tick = 0;
  actor.on('physicsTick', () => {
    tick++;
    const targets = Object.values(actor.entities).filter((entity: any) => entity?.name === mob && entity.position) as any[];
    const distance = Math.min(Infinity, ...targets.map(entity => entity.position.distanceTo(actor.entity.position)));
    nearest = Math.min(nearest, distance);
    if (actor.entity?.onFire || (actor.entity?.metadata?.[0] & 1)) burning++;
    // With a build: how many of the mob are inside it (the corridor), and of those how many the eyes have a point of
    // within a blow just now.
    if (process.env.MINECRAFT_FIGHT_BUILD && tick % 10 === 0) {
      const inside = targets.filter(entity => Math.abs(entity.position.x - (px + 0.5)) <= 2.6 && Math.abs(entity.position.z - (pz + 0.5)) <= 2.6 && entity.position.y >= py - 0.5 && entity.position.y <= py + 2);
      occupancy.ticks++;
      if (inside.length) occupancy.occupied++;
      if (inside.some(entity => visiblePointOn(actor, entity, 3))) occupancy.inView++;
      occupancy.most = Math.max(occupancy.most, inside.length);
      if (tick % 40 === 0 && where.length < 120) for (const entity of inside.slice(0, 3)) where.push([+(entity.position.x - (px + 0.5)).toFixed(1), +(entity.position.y - py).toFixed(1), +(entity.position.z - (pz + 0.5)).toFixed(1), visiblePointOn(actor, entity, 3) ? 1 : 0, visiblePointOn(actor, entity, 6) ? 1 : 0]);
    }
    if (tick % 20 === 0) samples.push(`${(tick / 20).toFixed(0)}s d=${Number.isFinite(distance) ? distance.toFixed(1) : '-'} dy=${targets[0] ? (targets[0].position.y - actor.entity.position.y).toFixed(1) : '-'} hp=${actor.health?.toFixed(0)} sw=${swings}`);
  });
  // MINECRAFT_FIGHT_SPAWNER="dx,dy,dz": a spawner of the mob at that offset from the body instead of mobs summoned
  // (MINECRAFT_FIGHT_COUNT=0), for what a body can do beside one. It spawns as the game's own do (four at a time,
  // ten to forty seconds apart); MINECRAFT_FIGHT_SPAWNER_FAST=1 for two every five to ten seconds;
  // MINECRAFT_FIGHT_SPAWNER_DELAY=<ticks> for when the first come (a body that has just walked up has some seconds).
  const spawner = realSpawner ? [realSpawner[0] - px, realSpawner[1] - py, realSpawner[2] - pz] : (process.env.MINECRAFT_FIGHT_SPAWNER ?? '').split(',').map(Number);
  if (realSpawner) report.spawner = spawner;
  else if (spawner.length === 3 && spawner.every(Number.isFinite)) {
    await control.executeSetupCommand(`setblock ${px + spawner[0]} ${py + spawner[1]} ${pz + spawner[2]} minecraft:spawner{SpawnData:{entity:{id:"minecraft:${mob}"}},Delay:${Number(process.env.MINECRAFT_FIGHT_SPAWNER_DELAY) || (process.env.MINECRAFT_FIGHT_SPAWNER_FAST === '1' ? 40 : 20)},MinSpawnDelay:${process.env.MINECRAFT_FIGHT_SPAWNER_FAST === '1' ? 100 : 200},MaxSpawnDelay:${process.env.MINECRAFT_FIGHT_SPAWNER_FAST === '1' ? 200 : 800},SpawnCount:${process.env.MINECRAFT_FIGHT_SPAWNER_FAST === '1' ? 2 : 4},MaxNearbyEntities:6,RequiredPlayerRange:16,SpawnRange:4} replace`);
    if (process.env.MINECRAFT_FIGHT_TIME) await control.executeSetupCommand(`time set ${process.env.MINECRAFT_FIGHT_TIME}`);
    report.spawner = spawner;
  }
  for (let index = 0; index < count; index++) {
    await control.executeSetupCommand(`execute in minecraft:overworld run summon minecraft:${mob} ${at[0] + offset[0] + index * 2} ${at[1] + offset[1]} ${at[2] + offset[2]}`);
  }
  // MINECRAFT_FIGHT_BUILD=<plan>: the body builds the plan round itself first, with the blocks it was given
  // (MINECRAFT_FIGHT_KIT can carry "cobblestone*192"), under whatever the spawner sends at it meanwhile.
  // MINECRAFT_FIGHT_PREFIGHT=<seconds>: first the fight in the open, as a body that has just walked up to the
  // spawner would have it, for that long or until nothing is left near; then the build.
  if (process.env.MINECRAFT_FIGHT_PREFIGHT) {
    const until = Date.now() + Number(process.env.MINECRAFT_FIGHT_PREFIGHT) * 1000;
    await sleep(4000);
    const open = actor.instantSkills.getSkill('attack-continuously');
    const home = actor.entity.position.clone();
    while (Date.now() < until && !deaths) {
      const fought: any = await open.run(mob, 60, 16, 0, false);
      if (String(fought?.result ?? '').includes('見つかりません')) break;
    }
    // Back to where it stood (the build is round that cell).
    await actor.instantSkills.getSkill('move-to').run(home.x, home.y, home.z, 0, 'near');
    report.prefight = { ms: Date.now() - (until - Number(process.env.MINECRAFT_FIGHT_PREFIGHT) * 1000), kills, damage: +damage.toFixed(1), health: actor.health, deaths, at: actor.entity.position.floored() };
  }
  if (real && process.env.MINECRAFT_FIGHT_WALK_FROM) {
    const began = Date.now();
    const said: any = await actor.instantSkills.getSkill('accept-threat').run(mob, 120);
    const walked: any = await actor.instantSkills.getSkill('move-to').run(at[0], at[1], at[2], 0, 'near');
    report.walk = { ms: Date.now() - began, said: String(said?.result ?? '').slice(0, 80), result: String(walked?.result ?? '').slice(0, 120), damage: +damage.toFixed(1), hitsTaken, health: actor.health, deaths, at: actor.entity.position.floored() };
  }
  if (process.env.MINECRAFT_FIGHT_BUILD) {
    const builder = actor.instantSkills.getSkill('build-around-self');
    const began = Date.now();
    const calls: string[] = [];
    for (let call = 0; call < 4; call++) {
      const built: any = await builder.run(process.env.MINECRAFT_FIGHT_BUILD);
      calls.push(String(built?.result ?? '').slice(0, 160));
      if (built?.success || deaths) break;
    }
    report.build = { ms: Date.now() - began, calls, damage: +damage.toFixed(1), hitsTaken, health: actor.health, deaths, offHand: offHand(), statuses: statuses.slice(0, 40) };
  }
  // MINECRAFT_FIGHT_PRE='[["tower-up",[3]]]': skills run first, in order, as a planner taking up a position would.
  if (process.env.MINECRAFT_FIGHT_PRE) {
    report.pre = [];
    for (const [name, args] of JSON.parse(process.env.MINECRAFT_FIGHT_PRE) as Array<[string, unknown[]]>) {
      const began = Date.now();
      const done: any = await actor.instantSkills.getSkill(name).run(...(args ?? []));
      report.pre.push({ name, ms: Date.now() - began, result: String(done?.result ?? '').slice(0, 100), damage: +damage.toFixed(1), at: actor.entity.position.floored() });
    }
  }
  const skill = actor.instantSkills.getSkill(skillName);
  if (!skill) throw new Error(`SKILL_MISSING:${skillName}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<any>(resolve => { timer = setTimeout(() => { actor.interruptExecution = true; actor.pathfinder?.stop();
    resolve({ success: false, result: `diagnostic timeout ${maxMs}ms`, failureType: 'timeout' }); }, maxMs); });
  let result: any;
  const results: string[] = [];
  // MINECRAFT_FIGHT_REPEAT=1: the skill is called again each time it returns, until the time is up (as a planner
  // holding a position would call it).
  do {
    try { result = await Promise.race([skill.run(...skillArgs), timeout]); } catch (error) { result = { success: false, result: String(error), failureType: 'exception' }; }
    results.push(String(result?.result ?? '').slice(0, 90));
    if (process.env.MINECRAFT_FIGHT_REPEAT === '1' && result?.failureType !== 'timeout' && Date.now() - startedAt < maxMs - 3000 && !deaths) await sleep(1500); else break;
  } while (true);
  report.results = results;
  clearTimeout(timer);
  report.fightMs = Date.now() - startedAt;
  // MINECRAFT_FIGHT_COLLECT=<item>: after the fight, what lies outside is fetched as a planner would have it
  // fetched (pick up, back to the cell, build again to mend the wall), and what that cost is told.
  if (process.env.MINECRAFT_FIGHT_COLLECT && process.env.MINECRAFT_FIGHT_BUILD && !deaths) {
    const home = actor.entity.position.clone();
    const before = { damage, hitsTaken };
    const began = Date.now();
    const steps: string[] = [];
    // MINECRAFT_FIGHT_BREAK_SPAWNER=1: the way a body ends such a stand. The spawner is dug out from inside (no
    // more come), what is left in the corridor is struck down from the slit, and only then is the wall opened.
    if (process.env.MINECRAFT_FIGHT_BREAK_SPAWNER === '1' && report.spawner) {
      const broke: any = await actor.instantSkills.getSkill('dig-block-at').run(px + spawner[0], py + spawner[1], pz + spawner[2], false);
      steps.push(`dig spawner: ${String(broke?.result ?? '').slice(0, 80)}`);
      const until = Date.now() + 150_000;
      while (Date.now() < until && !deaths) {
        const rest: any = await actor.instantSkills.getSkill('attack-continuously').run(mob, 60, 4, 0, true);
        steps.push(String(rest?.result ?? '').slice(0, 50));
        if (String(rest?.result ?? '').includes('見つかりません')) break;
      }
    }
    for (let round = 0; round < 8 && !deaths; round++) {
      const picked: any = await actor.instantSkills.getSkill('pickup-nearest-item').run(process.env.MINECRAFT_FIGHT_COLLECT, 8);
      steps.push(String(picked?.result ?? '').slice(0, 70));
      if (!picked?.success) break;
    }
    const back: any = await actor.instantSkills.getSkill('move-to').run(Math.floor(home.x) + 0.5, Math.floor(home.y), Math.floor(home.z) + 0.5, 0, 'near');
    steps.push(String(back?.result ?? '').slice(0, 70));
    const mended: any = await actor.instantSkills.getSkill('build-around-self').run(process.env.MINECRAFT_FIGHT_BUILD);
    steps.push(String(mended?.result ?? '').slice(0, 70));
    report.collect = { ms: Date.now() - began, steps, damage: +(damage - before.damage).toFixed(1), hitsTaken: hitsTaken - before.hitsTaken, deaths,
      at: actor.entity.position.floored(), home: home.floored() };
  }
  // What it dropped lies where it died: a few seconds for the body's own pickup to take it.
  await sleep(6000);
  Object.assign(report, { success: result?.success ?? false, result: String(result?.result ?? '').slice(0, 400), failureType: result?.failureType,
    kills, deaths, swings, hitsTaken, damage: +damage.toFixed(1), health: actor.health, nearest: Number.isFinite(nearest) ? +nearest.toFixed(1) : null,
    burningTicks: burning, occupancy, where, shield: actor.shieldBlock ? { raised: actor.shieldBlock.raised, guards: actor.shieldBlock.guards, upTicks: actor.shieldBlock.upTicks } : null, inventory: Object.fromEntries(actor.inventory.items().map((item: any) => [item.name, item.count])),
    mobsLeft: Object.values(actor.entities).filter((entity: any) => entity?.name === mob).length, samples: samples.slice(0, 70) });
  // The lab's own spawner and what it made are taken away again; a real world is left as the body left it.
  if (!real) {
    if (report.spawner) await control.executeSetupCommand(`setblock ${px + spawner[0]} ${py + spawner[1]} ${pz + spawner[2]} minecraft:air replace`);
    await control.executeSetupCommand(`kill @e[type=minecraft:${mob}]`);
  }
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  closeProbeBot(actor); closeProbeBot(operator);
  console.log(`MOB_FIGHT_REPORT ${JSON.stringify(report)}`);
}
