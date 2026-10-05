#!/usr/bin/env node
// Model-free: what the server names as the cause of a hit, for a mob that strikes from far off. The body is put
// in the open with one such mob in view and every hit is listed with the cause the client was given (kind, type,
// how far it stood), next to what the nearest mob of the hostile list was at that moment.
//   MINECRAFT_HURT_MOB=ghast  MINECRAFT_HURT_AT="x,y,z"  MINECRAFT_HURT_DIMENSION=the_nether  MINECRAFT_HURT_OFFSET="dx,dy,dz"
import fs from 'node:fs';
import path from 'node:path';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { advance } from '../src/services/minebot/utils/fireballDeflect.js';

const port = Number(process.env.MINECRAFT_OUTAGE_PORT);
const worldDirectory = process.env.MINECRAFT_OUTAGE_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_OUTAGE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25577 || port > 25651
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_PROBE_WORLD_REQUIRED');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_PROBE_WORLD_CONFIGURATION_INVALID');
const mob = process.env.MINECRAFT_HURT_MOB ?? 'ghast';
const at = (process.env.MINECRAFT_HURT_AT ?? '16.5,81,10.6').split(',').map(Number);
const offset = (process.env.MINECRAFT_HURT_OFFSET ?? '18,6,0').split(',').map(Number);
const dimension = process.env.MINECRAFT_HURT_DIMENSION ?? 'the_nether';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const operator = await createProbeBot(port);
const actor: any = await createProbeBot(port, 'MinebotTrial');
const control = new MinecraftCommandOracle(operator);
const hits: any[] = [];
const report: any = { mob, hits };
try {
  await control.verifyReady();
  // MINECRAFT_HURT_PAD=1: a stone pad in the open air at the place (for a sky stage where nothing is in the way).
  if (process.env.MINECRAFT_HURT_PAD === '1') {
    const [px, py, pz] = at.map(Math.floor);
    // MINECRAFT_HURT_PAD_RADIUS: how far the floor reaches (a mob that walks needs it under its feet too).
    const pad = Math.max(4, Math.min(30, Number(process.env.MINECRAFT_HURT_PAD_RADIUS ?? 4) || 4));
    for (const command of [`execute in minecraft:${dimension} run tp ShannonProbe ${px} ${py + 12} ${pz}`]) await control.executeSetupCommand(command);
    await sleep(4000);
    for (const command of [`execute in minecraft:${dimension} run forceload add ${px - 40} ${pz - 40} ${px + 40} ${pz + 40}`,
      `execute in minecraft:${dimension} run fill ${px - pad} ${py - 1} ${pz - pad} ${px + pad} ${py - 1} ${pz + pad} stone`,
      `execute in minecraft:${dimension} run fill ${px - pad} ${py} ${pz - pad} ${px + pad} ${py + 4} ${pz + pad} air`,
      'kill @e[type=minecraft:ghast]', 'difficulty normal']) await control.executeSetupCommand(command);
  }
  for (const command of ['gamemode spectator ShannonProbe', 'gamemode survival MinebotTrial', 'effect clear MinebotTrial',
    `execute in minecraft:${dimension} run tp MinebotTrial ${at[0]} ${at[1]} ${at[2]}`,
    'effect give MinebotTrial minecraft:regeneration 120 4 true', 'effect give MinebotTrial minecraft:fire_resistance 120 0 true',
    'effect give MinebotTrial minecraft:instant_health 1 5']) await control.executeSetupCommand(command);
  await sleep(6000);
  // The reflexes are left out of it: the body stands and is hit. MINECRAFT_HURT_DEFLECT=on leaves the one that
  // strikes a ghast's fireball back in play (the control is without it).
  for (const skill of actor.constantSkills.getSkills()) skill.status = false;
  if (actor.fireballDeflect) actor.fireballDeflect.enabled = process.env.MINECRAFT_HURT_DEFLECT === 'on';
  // MINECRAFT_HURT_SHIELD=on leaves the reflex that raises the shield in play; MINECRAFT_HURT_KIT="shield,iron_chestplate"
  // puts armour and a shield on the body (the rest is carried); MINECRAFT_HURT_TIME=midnight for mobs the sun burns.
  if (actor.shieldBlock) actor.shieldBlock.enabled = process.env.MINECRAFT_HURT_SHIELD === 'on';
  // MINECRAFT_HURT_BRACE=off: without the lean against a push that is throwing the body off a ledge (the control).
  if (actor.knockBrace && process.env.MINECRAFT_HURT_BRACE === 'off') actor.knockBrace.enabled = false;
  // MINECRAFT_HURT_STAND="dx,dz": the body stands that far from the middle of the pad (near its rim, say).
  const stand = (process.env.MINECRAFT_HURT_STAND ?? '').split(',').map(Number);
  if (stand.length === 2 && stand.every(Number.isFinite)) {
    await control.executeSetupCommand(`execute in minecraft:${dimension} run tp MinebotTrial ${at[0] + stand[0]} ${at[1]} ${at[2] + stand[1]}`);
    await sleep(1500);
  }
  const SLOT: Record<string, string> = { helmet: 'armor.head', chestplate: 'armor.chest', leggings: 'armor.legs', boots: 'armor.feet', shield: 'weapon.offhand' };
  for (const item of (process.env.MINECRAFT_HURT_KIT ?? '').split(',').map(name => name.trim()).filter(Boolean)) {
    const slot = Object.entries(SLOT).find(([suffix]) => item.endsWith(suffix))?.[1];
    await control.executeSetupCommand(slot ? `item replace entity MinebotTrial ${slot} with minecraft:${item}` : `give MinebotTrial minecraft:${item}`);
  }
  if (process.env.MINECRAFT_HURT_TIME) await control.executeSetupCommand(`time set ${process.env.MINECRAFT_HURT_TIME}`);
  let blocked = 0;
  actor._client.on('entity_status', (packet: any) => { if (packet.entityId === actor.entity?.id && packet.entityStatus === 29) blocked++; });
  await sleep(1500);
  const startedAt = Date.now();
  let lastHealth = actor.health;
  actor.on('entityHurt', (entity: any, source: any) => {
    if (entity?.id !== actor.entity?.id) return;
    hits.push({ ms: Date.now() - startedAt, kind: 'entityHurt', source: source ? { name: source.name ?? null, type: source.type ?? null, displayName: source.displayName ?? null,
      distance: source.position ? +actor.entity.position.distanceTo(source.position).toFixed(1) : null } : null });
  });
  actor._client.on('damage_event', (packet: any) => {
    if (packet.entityId !== actor.entity?.id) return;
    const cause = actor.entities[packet.sourceCauseId - 1], direct = actor.entities[packet.sourceDirectId - 1];
    hits.push({ ms: Date.now() - startedAt, kind: 'damage_event', sourceTypeId: packet.sourceTypeId, cause: cause?.name ?? null, direct: direct?.name ?? null,
      causeDistance: cause?.position ? +actor.entity.position.distanceTo(cause.position).toFixed(1) : null });
  });
  // MINECRAFT_HURT_TRACE=1: every tick, where the client holds each fireball and what speed it was told (how
  // often the server says where a ball is decides how it has to be followed).
  const ballTrace: any[] = [];
  let traceTick = 0;
  if (process.env.MINECRAFT_HURT_TRACE === '1') {
    actor.on('physicsTick', () => {
      traceTick++;
      for (const entity of Object.values(actor.entities) as any[]) {
        if (entity?.type !== 'projectile' || !entity.position) continue;
        const eyes = actor.entity.position.offset(0, 1.62, 0);
        ballTrace.push({ t: traceTick, id: entity.id, n: entity.name, x: +entity.position.x.toFixed(2), y: +entity.position.y.toFixed(2), z: +entity.position.z.toFixed(2),
          vx: +(entity.velocity?.x ?? 0).toFixed(3), vy: +(entity.velocity?.y ?? 0).toFixed(3), vz: +(entity.velocity?.z ?? 0).toFixed(3),
          d: +eyes.distanceTo(entity.position).toFixed(2) });
      }
    });
    actor._client.on('spawn_entity', (packet: any) => { if (actor.entities[packet.entityId]?.type === 'projectile') ballTrace.push({ t: traceTick, id: packet.entityId, packet: 'spawn', raw: JSON.stringify(packet).slice(0, 400),
      body: [+actor.entity.position.x.toFixed(2), +actor.entity.position.y.toFixed(2), +actor.entity.position.z.toFixed(2)],
      held: (() => { const v = actor.entities[packet.entityId]?.velocity; return v ? [v.x, v.y, v.z] : null; })() }); });
    actor._client.on('packet', (data: any, meta: any, buffer: Buffer) => {
      if ((meta?.name === 'spawn_entity' || meta?.name === 'entity_velocity') && ballTrace.length < 4000) {
        const entity = actor.entities[data.entityId];
        if (meta.name === 'spawn_entity' || entity?.type === 'projectile' || data.entityId === actor.entity?.id) ballTrace.push({ t: traceTick, id: data.entityId, rawPacket: meta.name, hex: buffer.toString('hex').slice(0, 160),
          self: data.entityId === actor.entity?.id, name: entity?.name ?? null });
      }
    });
    for (const name of ['entity_velocity', 'rel_entity_move', 'entity_move_look', 'entity_teleport', 'sync_entity_position']) {
      actor._client.on(name, (packet: any) => { if (actor.entities[packet.entityId]?.type === 'projectile') ballTrace.push({ t: traceTick, id: packet.entityId, packet: name, raw: JSON.stringify(packet).slice(0, 300) }); });
    }
    report.ballTrace = ballTrace;
  }
  // What each struck ball then did: the direction it left in against the one meant, and how near it passed to
  // the mob (the blow is aimed at where the mob will be; this says which of the two was off, and by how much).
  const flights = new Map<number, Array<{ t: number; position: any; velocity: any }>>();
  const mobTrack: Array<{ t: number; position: any; told?: any }> = [];
  let flightTick = 0;
  actor.on('physicsTick', () => {
    flightTick++;
    const target: any = Object.values(actor.entities).find((entity: any) => entity?.name === mob);
    if (target?.position) mobTrack.push({ t: flightTick, position: target.position.clone(), told: target.velocity?.clone?.() });
    for (const entity of Object.values(actor.entities) as any[]) {
      if (entity?.name !== 'fireball' || !entity.position) continue;
      const list = flights.get(entity.id) ?? [];
      const last = list[list.length - 1];
      if (!last || !last.position.equals(entity.position)) list.push({ t: flightTick, position: entity.position.clone(), velocity: entity.velocity?.clone?.() ?? null });
      flights.set(entity.id, list);
    }
  });
  // How far each hit moved the body: where it stood when the server said it was hurt, and how far from there,
  // and how high, it was at its furthest in the twelve ticks after (a body that takes knockback is thrown a
  // block or two; one that does not stays where it stood).
  const knocks: Array<{ pushed: number; lifted: number }> = [];
  let knockTick = 0;
  const pendingKnocks: Array<{ until: number; from: any; pushed: number; lifted: number }> = [];
  actor._client.on('damage_event', (packet: any) => {
    if (packet.entityId === actor.entity?.id) pendingKnocks.push({ until: knockTick + 12, from: actor.entity.position.clone(), pushed: 0, lifted: 0 });
  });
  let fellAtHit: number | null = null, hitsSoFar = 0;
  actor._client.on('damage_event', (packet: any) => { if (packet.entityId === actor.entity?.id) hitsSoFar++; });
  actor.on('physicsTick', () => {
    knockTick++;
    if (fellAtHit === null && actor.entity.position.y < at[1] - 2) fellAtHit = hitsSoFar;
    for (const knock of [...pendingKnocks]) {
      const at = actor.entity.position;
      knock.pushed = Math.max(knock.pushed, Math.hypot(at.x - knock.from.x, at.z - knock.from.z));
      knock.lifted = Math.max(knock.lifted, at.y - knock.from.y);
      if (knockTick >= knock.until) { pendingKnocks.splice(pendingKnocks.indexOf(knock), 1); knocks.push({ pushed: +knock.pushed.toFixed(2), lifted: +knock.lifted.toFixed(2) }); }
    }
  });
  // How many balls were in the air, and whether the mob died (a ball struck back kills a ghast outright).
  const ballIds = new Set<number>();
  let mobDeaths = 0;
  actor.on('entitySpawn', (entity: any) => { if (entity?.name === 'fireball') ballIds.add(entity.id); });
  const shotIds = new Set<number>();
  actor.on('entitySpawn', (entity: any) => { if (entity?.type === 'projectile') shotIds.add(entity.id); });
  actor.on('entityDead', (entity: any) => { if (entity?.name === mob) mobDeaths++; });
  actor.on('entityGone', (entity: any) => { if (entity?.name === mob) hits.push({ ms: Date.now() - startedAt, kind: 'mob_gone' }); });
  actor.on('health', () => { if (actor.health < lastHealth) hits.push({ ms: Date.now() - startedAt, kind: 'health', lost: +(lastHealth - actor.health).toFixed(1), health: +actor.health.toFixed(1) }); lastHealth = actor.health; });
  await control.executeSetupCommand(`execute in minecraft:${dimension} run summon minecraft:${mob} ${at[0] + offset[0]} ${at[1] + offset[1]} ${at[2] + offset[2]}`);
  await sleep(Number(process.env.MINECRAFT_HURT_WATCH_MS ?? 30_000));
  report.entitiesInView = [...new Set(Object.values(actor.entities).map((entity: any) => `${entity.name}:${entity.type}`))];
  report.deflect = actor.fireballDeflect ? { ...actor.fireballDeflect } : null;
  report.ballsSeen = ballIds.size;
  report.knocks = knocks;
  report.brace = actor.knockBrace ? { ...actor.knockBrace } : null;
  report.fellAtHit = fellAtHit;
  report.endPosition = [+actor.entity.position.x.toFixed(1), +actor.entity.position.y.toFixed(1), +actor.entity.position.z.toFixed(1)];
  report.shield = actor.shieldBlock ? { ...actor.shieldBlock } : null;
  report.offHand = actor.inventory.slots[actor.getEquipmentDestSlot('off-hand')]?.name ?? null;
  report.blocked = blocked;
  report.shotsSeen = shotIds.size;
  // MINECRAFT_HURT_MOBTRACK=<file>: where the mob was each tick and the speed the server told of it, for trying
  // ways of telling where it will be against how it really moved.
  if (process.env.MINECRAFT_HURT_MOBTRACK) fs.writeFileSync(process.env.MINECRAFT_HURT_MOBTRACK, JSON.stringify({
    body: [actor.entity.position.x, actor.entity.position.y + 1.62, actor.entity.position.z],
    track: mobTrack.map(entry => [entry.t, +entry.position.x.toFixed(3), +entry.position.y.toFixed(3), +entry.position.z.toFixed(3),
      +(entry.told?.x ?? 0).toFixed(4), +(entry.told?.y ?? 0).toFixed(4), +(entry.told?.z ?? 0).toFixed(4)]) }));
  report.returns = (actor.fireballDeflect?.struck ?? []).map((strike: any) => {
    const said = flights.get(strike.ball) ?? [];
    const meant = strike.aim.minus(strike.from).normalize();
    // The first word of the ball after it turned: moving away along something like the line meant.
    const turned = said.find(entry => entry.velocity && entry.velocity.norm() > 0.05 && entry.velocity.normalize().dot(meant) > 0);
    if (!turned) return { ball: strike.ball, turned: false, updates: said.length };
    const left = turned.velocity.normalize();
    const offDegrees = +(Math.acos(Math.min(1, left.dot(meant))) * 180 / Math.PI).toFixed(1);
    // Carried on by the server's rule from that word, against where the mob was at each of those ticks.
    let track = { position: turned.position, velocity: turned.velocity };
    let nearest = Infinity, nearestTick = 0, nearestOffset: any = null;
    for (let t = turned.t; t < turned.t + 120; t++) {
      const where = [...mobTrack].reverse().find(entry => entry.t <= t) ?? mobTrack[0];
      if (!where) break;
      const centre = where.position.offset(0, 2, 0);
      const d = track.position.distanceTo(centre);
      if (d < nearest) { nearest = d; nearestTick = t - turned.t; nearestOffset = track.position.minus(centre); }
      track = advance(track);
    }
    const centreAtStrike = (mobTrack.find(entry => entry.t >= turned.t) ?? mobTrack[mobTrack.length - 1])?.position.offset(0, 2, 0);
    return { ball: strike.ball, turned: true, offDegrees, passedAt: +nearest.toFixed(1), afterTicks: nearestTick,
      passOffset: nearestOffset ? [+nearestOffset.x.toFixed(1), +nearestOffset.y.toFixed(1), +nearestOffset.z.toFixed(1)] : null,
      range: centreAtStrike ? +strike.from.distanceTo(centreAtStrike).toFixed(1) : null,
      mobMoved: centreAtStrike && nearestOffset ? (() => { const then = ([...mobTrack].reverse().find(entry => entry.t <= turned.t + nearestTick) ?? mobTrack[0]).position.offset(0, 2, 0);
        return [+(then.x - centreAtStrike.x).toFixed(1), +(then.y - centreAtStrike.y).toFixed(1), +(then.z - centreAtStrike.z).toFixed(1)]; })() : null,
      aimLead: centreAtStrike ? [+(strike.aim.x - centreAtStrike.x).toFixed(1), +(strike.aim.y - centreAtStrike.y).toFixed(1), +(strike.aim.z - centreAtStrike.z).toFixed(1)] : null,
      leftSpeed: +turned.velocity.norm().toFixed(2), saidAfterTicks: said.filter(entry => entry.t >= turned.t).map(entry => entry.t - turned.t).slice(0, 6) };
  });
  report.mobDeaths = mobDeaths;
  report.damageTaken = +hits.filter(hit => hit.kind === 'health').reduce((sum, hit) => sum + hit.lost, 0).toFixed(1);
  report.hitsTaken = hits.filter(hit => hit.kind === 'damage_event').length;
  report.mobAliveAtEnd = Object.values(actor.entities).some((entity: any) => entity.name === mob);
  await control.executeSetupCommand(`execute in minecraft:${dimension} run kill @e[type=minecraft:${mob}]`);
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  closeProbeBot(actor); closeProbeBot(operator);
  console.log(`HURT_SOURCE_REPORT ${JSON.stringify(report)}`);
}
