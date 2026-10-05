#!/usr/bin/env node
// Read-only live-block diagnostic. Only the spectator operator connects; the
// saved trial actor is never connected, moved, equipped or given a new goal.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import FindDryFootholds, { scanDryFootholds } from '../src/services/minebot/instantSkills/findDryFootholds.js';

const port = Number(process.env.MINECRAFT_TERRAIN_PORT ?? 0);
const worldDirectory = process.env.MINECRAFT_TERRAIN_WORLD_DIRECTORY ?? '';
const sourceReport = process.env.MINECRAFT_TERRAIN_SOURCE_REPORT ?? '';
const reportsDirectory = path.resolve('saves/minecraft/progressive_reports');
if (process.env.SHANNON_ISOLATED_MINEBOT_PROBE !== 'true'
  || process.env.MINECRAFT_COGNITION_MODE !== 'off'
  || !Number.isInteger(port) || port < 25577 || port > 25650
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)
  || !sourceReport.startsWith(`${reportsDirectory}${path.sep}`)
  || !sourceReport.endsWith('-dragon-campaign.json')) {
  throw new Error('ISOLATED_READ_ONLY_TERRAIN_LAB_REQUIRED');
}
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8');
for (const entry of [`server-port=${port}`, 'server-ip=127.0.0.1', 'gamemode=survival']) {
  if (!properties.split(/\r?\n/).includes(entry)) throw new Error(`TERRAIN_WORLD_CONFIGURATION_INVALID:${entry}`);
}
const ops = JSON.parse(fs.readFileSync(path.join(worldDirectory, 'ops.json'), 'utf8')) as Array<{ name: string }>;
if (!ops.some(entry => entry.name === 'ShannonProbe') || ops.some(entry => entry.name === 'MinebotTrial')) {
  throw new Error('TERRAIN_OPERATOR_OR_NON_OP_ACTOR_INVALID');
}
const source = JSON.parse(fs.readFileSync(sourceReport, 'utf8')) as {
  worldId: string; port: number; actor: { position: { x: number; y: number; z: number } };
};
const worldId = createHash('sha256').update(fs.realpathSync(worldDirectory)).digest('hex').slice(0, 20);
if (source.worldId !== worldId || source.port !== port
  || ![source.actor.position.x, source.actor.position.y, source.actor.position.z].every(Number.isFinite)) {
  throw new Error('TERRAIN_SOURCE_WORLD_MISMATCH');
}

const startedAt = Date.now();
const operator = await createProbeBot(port, 'ShannonProbe');
let report: Record<string, unknown> = {};
try {
  if (operator.game.gameMode !== 'spectator' || operator.game.dimension !== 'overworld') {
    throw new Error('TERRAIN_OPERATOR_NOT_OVERWORLD_SPECTATOR');
  }
  if (operator.players.MinebotTrial?.entity) throw new Error('TERRAIN_ACTOR_MUST_BE_OFFLINE');
  const actorPosition = new Vec3(source.actor.position.x, source.actor.position.y, source.actor.position.z);
  if (operator.entity.position.distanceTo(actorPosition) > 32) {
    // A spectator teleport is the only permitted game command in this probe.
    operator.chat(`/tp @s ${actorPosition.x} ${actorPosition.y} ${actorPosition.z}`);
    const deadline = Date.now() + 30_000;
    while (operator.entity.position.distanceTo(actorPosition) > 32 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (operator.entity.position.distanceTo(actorPosition) > 32) throw new Error('TERRAIN_OPERATOR_TELEPORT_FAILED');
  }
  await new Promise(resolve => setTimeout(resolve, 2_000));
  // Give the sensor the actor's recorded position while all block reads come
  // from the real spectator's current Minecraft chunk packets.
  const reader = { entity: { position: actorPosition },
    blockAt: operator.blockAt.bind(operator) };
  const scan = scanDryFootholds(reader as any, { radius: 8, maxVertical: 14, maxCandidates: 8 });
  const skillResult = await new FindDryFootholds(reader as any).runImpl(8, 14, 8);
  const first = scan.candidates[0];
  const firstFeet = first && operator.blockAt(new Vec3(Math.floor(first.x), first.y, Math.floor(first.z)), false)?.name;
  const firstHead = first && operator.blockAt(new Vec3(Math.floor(first.x), first.y + 1, Math.floor(first.z)), false)?.name;
  const firstGround = first && operator.blockAt(new Vec3(Math.floor(first.x), first.y - 1, Math.floor(first.z)), false)?.name;
  report = { sensorPassed: Boolean(skillResult.success && first && first.distance <= 8
      && firstFeet === 'air' && firstHead === 'air' && firstGround === first.groundBlock),
    acceptancePassed: false, modelRequests: 0, actorConnected: false, actorMoved: false,
    durationMs: Date.now() - startedAt, sourceReport, worldDirectory, port,
    recordedActorPosition: source.actor.position, operatorPosition: operator.entity.position,
    scan, skillResult, firstCandidateNativeBlocks: { feet: firstFeet, head: firstHead, ground: firstGround },
    caveat: 'Read-only loaded-chunk geometry; no physical path or autonomous emergency escape attempted.' };
  if (!report.sensorPassed) process.exitCode = 1;
} catch (error) {
  report = { sensorPassed: false, acceptancePassed: false, modelRequests: 0,
    actorConnected: false, actorMoved: false, durationMs: Date.now() - startedAt,
    sourceReport, worldDirectory, port, error: String(error) };
  process.exitCode = 1;
} finally {
  closeProbeBot(operator);
  const file = path.join(reportsDirectory,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-dry-footholds.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`DRY_FOOTHOLDS_RESULT ${JSON.stringify({ sensorPassed: report.sensorPassed,
    acceptancePassed: false, modelRequests: 0, durationMs: report.durationMs,
    firstCandidate: (report.scan as any)?.candidates?.[0], error: report.error })}`);
  console.log(`DRY_FOOTHOLDS_REPORT ${file}`);
}
