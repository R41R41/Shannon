#!/usr/bin/env node
// Packet-level diagnosis only. Requires a disposable isolated campaign clone;
// never points at Shannon-prod, a shared world, or the preserved source world.
import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle } from '../src/services/minebot/testing/MinecraftCommandOracle.js';

const port = Number(process.env.MINECRAFT_DIG_PACKET_PORT);
const directory = process.env.MINECRAFT_DIG_PACKET_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_DIG_PACKET_PROBE !== 'true'
  || !Number.isInteger(port) || port < 25577 || port > 25650
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(directory)) {
  throw new Error('DIG_PACKET_PROBE_ISOLATED_CLONE_REQUIRED');
}
const properties = fs.readFileSync(path.join(directory, 'server.properties'), 'utf8');
for (const line of [`server-port=${port}`, 'server-ip=127.0.0.1', 'gamemode=survival']) {
  if (!properties.split('\n').includes(line)) throw new Error(`DIG_PACKET_WORLD_CONFIGURATION_INVALID:${line}`);
}

const target = new Vec3(-343, 60, -114);
const operator = await createProbeBot(port);
const actor = await createProbeBot(port, 'MinebotTrial');
const control = new MinecraftCommandOracle(operator);
const actorOracle = new MinecraftCommandOracle({ version: actor.version,
  chat: command => operator.chat(`/execute as @a[name=MinebotTrial,limit=1] at @s run ${command.replace(/^\//, '')}`),
  on: (_event, listener) => actor.on('message', listener as any),
  removeListener: (_event, listener) => actor.removeListener('message', listener as any),
});

const events: Array<Record<string, unknown>> = [];
const started = Date.now();
const record = (event: Record<string, unknown>) => {
  if (events.length < 80) events.push({ ms: Date.now() - started, ...event });
};
const client = (actor as any)._client;
const onBlockChange = (packet: any) => {
  const pos = packet.location;
  if (pos.x === target.x && pos.y === target.y && pos.z === target.z) {
    record({ packet: 'block_change', location: pos, type: packet.type,
      localBlock: actor.blockAt(target)?.name ?? null });
  }
};
const onMultiBlockChange = (packet: any) => {
  const chunk = packet.chunkCoordinates ?? { x: packet.chunkX, y: null, z: packet.chunkZ };
  if (chunk.x === Math.floor(target.x / 16) && chunk.z === Math.floor(target.z / 16)) {
    record({ packet: 'multi_block_change', chunk, recordCount: packet.records?.length ?? null,
      localBlock: actor.blockAt(target)?.name ?? null });
  }
};
const onAck = (packet: any) => record({ packet: 'acknowledge_player_digging', sequenceId: packet.sequenceId });
const onPosition = (packet: any) => record({ packet: 'position', x: packet.x, y: packet.y, z: packet.z });
const onRawPacket = (_data: any, meta: any) => {
  if (typeof meta?.name === 'string' && /block|digging|position/.test(meta.name)) {
    record({ packet: 'raw_incoming', name: meta.name });
  }
};
const originalWrite = client.write.bind(client);

try {
  await control.verifyReady();
  await control.executeSetupCommand('gamemode spectator ShannonProbe');
  await control.executeSetupCommand('tp ShannonProbe -500 150 -500');
  const serverStoneBefore = await actorOracle.evaluate({ type: 'block_at',
    x: target.x, y: target.y, z: target.z, block: 'stone' });
  if (!serverStoneBefore.passed) throw new Error('DIG_PACKET_TARGET_NOT_SERVER_STONE');
  const skill = actor.instantSkills.getSkill('dig-block-at');
  if (!skill) throw new Error('DIG_BLOCK_SKILL_MISSING');

  client.on('block_change', onBlockChange);
  client.on('multi_block_change', onMultiBlockChange);
  client.on('acknowledge_player_digging', onAck);
  client.on('position', onPosition);
  client.on('packet', onRawPacket);
  client.write = (name: string, data: any) => {
    if (name === 'block_dig') record({ packet: 'raw_outgoing', name,
      status: data.status, location: data.location, face: data.face,
      sequence: data.sequence ?? null });
    return originalWrite(name, data);
  };
  record({ packet: 'start', position: actor.entity.position,
    held: actor.heldItem?.name ?? null, inventory: actor.inventory.items()
      .filter(item => item.name.includes('pickaxe')).map(item => ({ name: item.name, count: item.count })) });
  const digStarted = Date.now();
  const dug = await skill.run(target.x, target.y, target.z, false);
  record({ packet: 'skill_result', durationMs: Date.now() - digStarted,
    success: dug.success, failureType: dug.failureType, result: dug.result,
    localBlock: actor.blockAt(target)?.name ?? null });
  await new Promise(resolve => setTimeout(resolve, 2500));
  const serverStoneAfter = await actorOracle.evaluate({ type: 'block_at',
    x: target.x, y: target.y, z: target.z, block: 'stone' });
  const serverAirAfter = await actorOracle.evaluate({ type: 'block_at',
    x: target.x, y: target.y, z: target.z, block: 'air' });
  record({ packet: 'final', position: actor.entity.position,
    localBlock: actor.blockAt(target)?.name ?? null,
    serverStone: serverStoneAfter.passed, serverAir: serverAirAfter.passed });
  console.log(`DIG_PACKET_PROBE_RESULT ${JSON.stringify({ target, port, events })}`);
} finally {
  client.off('block_change', onBlockChange);
  client.off('multi_block_change', onMultiBlockChange);
  client.off('acknowledge_player_digging', onAck);
  client.off('position', onPosition);
  client.off('packet', onRawPacket);
  client.write = originalWrite;
  closeProbeBot(actor);
  closeProbeBot(operator);
}
