#!/usr/bin/env node
// Diagnostic only: raw dig packets in a disposable, loopback Minecraft clone.
// The actor receives no items and the source campaign world is never opened.
import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_DIG_PROTOCOL_PORT);
const directory = process.env.MINECRAFT_DIG_PROTOCOL_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_DIG_PROTOCOL_PROBE !== 'true'
  || !Number.isInteger(port) || port < 25577 || port > 25650
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(directory)) {
  throw new Error('DIG_PROTOCOL_ISOLATED_CLONE_REQUIRED');
}
const properties = fs.readFileSync(path.join(directory, 'server.properties'), 'utf8');
for (const line of [`server-port=${port}`, 'server-ip=127.0.0.1', 'spawn-protection=0']) {
  if (!properties.split('\n').includes(line)) throw new Error(`DIG_PROTOCOL_CONFIGURATION_INVALID:${line}`);
}

const operator = await createProbeBot(port);
const actor = await createProbeBot(port, 'MinebotTrial');
const actorReadyAt = Date.now();
const control = new MinecraftCommandOracle(operator);
const actorOracle = new MinecraftCommandOracle({ version: actor.version,
  chat: command => operator.chat(`/execute as @a[name=MinebotTrial,limit=1] at @s run ${command.replace(/^\//, '')}`),
  on: (_event, listener) => actor.on('message', listener as any),
  removeListener: (_event, listener) => actor.removeListener('message', listener as any),
});
const surfaceFixture = process.env.MINECRAFT_DIG_PROTOCOL_SURFACE_FIXTURE === 'true';
const sendPlayerLoaded = process.env.MINECRAFT_DIG_PROTOCOL_SEND_PLAYER_LOADED === 'true';
const preDigDelayMs = Number(process.env.MINECRAFT_DIG_PROTOCOL_PRE_DIG_DELAY_MS ?? 0);
if (!Number.isInteger(preDigDelayMs) || preDigDelayMs < 0 || preDigDelayMs > 15000) {
  throw new Error('DIG_PROTOCOL_DELAY_INVALID');
}
const target = surfaceFixture ? new Vec3(-420, 90, -200) : new Vec3(-342, 61, -115);
const packets: Array<Record<string, unknown>> = [];
const record = (kind: string, packet: any) => {
  packets.push({ kind, packet, time: Date.now() });
};

try {
  await control.verifyReady();
  await control.executeSetupCommand('gamemode spectator ShannonProbe');
  await control.executeSetupCommand('tp ShannonProbe -500 150 -500');
  if (surfaceFixture) {
    // Deliberately controlled spatial diagnostic, never a campaign acceptance.
    await control.executeSetupCommand('fill -421 89 -201 -419 89 -199 stone');
    await control.executeSetupCommand('fill -421 90 -201 -419 93 -199 air');
    await control.executeSetupCommand('setblock -420 90 -200 stone');
    await control.executeSetupCommand('tp MinebotTrial -420.5 90 -200.5');
    await new Promise(resolve => setTimeout(resolve, 600));
  }
  if (sendPlayerLoaded) {
    actor._client.write('player_loaded', {});
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  if (preDigDelayMs > 0) await new Promise(resolve => setTimeout(resolve, preDigDelayMs));
  const serverPosition = surfaceFixture ? await actorOracle.evaluate({ type: 'position_within',
    x: -420.5, y: 90, z: -200.5, radius: 1 }) : undefined;
  if (surfaceFixture && !serverPosition?.passed) throw new Error('DIG_PROTOCOL_SURFACE_TELEPORT_FAILED');
  const stoneBefore = await actorOracle.evaluate({ type: 'block_at',
    x: target.x, y: target.y, z: target.z, block: 'stone' });
  if (!stoneBefore.passed) throw new Error('DIG_PROTOCOL_TARGET_NOT_STONE');
  const pickaxe = actor.inventory.items().find(item => item.name === 'stone_pickaxe');
  if (!pickaxe) throw new Error('DIG_PROTOCOL_PICKAXE_MISSING');
  await actor.equip(pickaxe, 'hand');
  const block = actor.blockAt(target);
  if (!block || block.name !== 'stone') throw new Error('DIG_PROTOCOL_LOCAL_TARGET_MISMATCH');
  const digTimeMs = actor.digTime(block);
  const waitMs = Math.max(2 * digTimeMs, 1200);
  const readyToDigMs = Date.now() - actorReadyAt;
  const start = Date.now();
  actor._client.on('acknowledge_player_digging', packet => record('ack', packet));
  actor._client.on('block_change', packet => {
    if (packet.location?.x === target.x && packet.location?.y === target.y
      && packet.location?.z === target.z) record('block_change', packet);
  });
  actor._client.on('multi_block_change', packet => record('multi_block_change', packet));
  await actor.lookAt(target.offset(0.5, 0.5, 0.5));
  actor._client.write('block_dig', { status: 0, location: target, face: 4, sequence: 501 });
  await new Promise(resolve => setTimeout(resolve, waitMs));
  actor._client.write('block_dig', { status: 2, location: target, face: 4, sequence: 502 });
  await new Promise(resolve => setTimeout(resolve, 2500));
  const airAfter = await actorOracle.evaluate({ type: 'block_at',
    x: target.x, y: target.y, z: target.z, block: 'air' });
  const stoneAfter = await actorOracle.evaluate({ type: 'block_at',
    x: target.x, y: target.y, z: target.z, block: 'stone' });
  console.log(`DIG_PROTOCOL_PROBE_RESULT ${JSON.stringify({ surfaceFixture, sendPlayerLoaded,
    preDigDelayMs, readyToDigMs, target,
    actorPosition: actor.entity.position, serverPosition: serverPosition?.passed,
    actorGameMode: actor.game.gameMode, heldItem: actor.heldItem?.name, digTimeMs, waitMs,
    durationMs: Date.now() - start, localBlockAfter: actor.blockAt(target)?.name,
    stoneBefore: stoneBefore.passed, airAfter: airAfter.passed, stoneAfter: stoneAfter.passed,
    packets: packets.filter(packet => packet.kind !== 'multi_block_change'),
    incidentalMultiBlockPackets: packets.filter(packet => packet.kind === 'multi_block_change').length })}`);
  if (!airAfter.passed) process.exitCode = 1;
} finally {
  closeProbeBot(actor);
  closeProbeBot(operator);
}
