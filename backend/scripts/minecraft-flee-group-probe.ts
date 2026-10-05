#!/usr/bin/env node
// Zero-LLM diagnostic of the production flee-from skill on generated natural
// terrain. Operator commands only build/verify/clean the fixture; a non-OP
// MinebotTrial performs all movement. This is not an unassisted acceptance run.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { MinecraftCommandOracle, type MinecraftCommandAssertionResult } from '../src/services/minebot/testing/MinecraftCommandOracle.js';
import { isLikelyHostileMobName } from '../src/services/minebot/utils/hostileMobHints.js';

const port = Number(process.env.MINECRAFT_FLEE_PORT ?? 0);
const worldDirectory = process.env.MINECRAFT_FLEE_WORLD_DIRECTORY ?? '';
const minDistance = 10;
const oracleClearance = 8.5;
const skillTimeoutMs = 10_000;
const fixtureTag = `sh_flee_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const startedAt = Date.now();
const report: Record<string, unknown> = {
  probe: 'minecraft-flee-group-probe', fixtureKind: 'controlled_active_hostiles',
  acceptanceClass: 'diagnostic_fixture_not_unassisted_campaign',
  startedAt: new Date(startedAt).toISOString(), worldDirectory, port,
  minDistance, oracleClearance, skillTimeoutMs, fixtureTag, modelRequests: 0,
  passed: false, setupAttempts: [], pathTrace: [], positionTrace: [], assertions: [], cleanup: [],
};

function validateLab(): void {
  if (process.env.SHANNON_ISOLATED_MINEBOT_PROBE !== 'true'
    || process.env.MINECRAFT_COGNITION_MODE !== 'off'
    || !Number.isInteger(port) || port < 25_577 || port > 25_650
    || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)
    || path.basename(worldDirectory) === 'progressive-lab-c72uUG') {
    throw new Error('FLEE_PROBE_EXPLICIT_ISOLATED_NON_BILLABLE_LAB_REQUIRED');
  }
  const lines = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split(/\r?\n/);
  for (const expected of ['server-ip=127.0.0.1', `server-port=${port}`, 'online-mode=false',
    'generate-structures=true', 'gamemode=survival']) {
    if (!lines.includes(expected)) throw new Error(`FLEE_LAB_CONFIGURATION_INVALID:${expected}`);
  }
  if (!lines.some(line => line === 'level-type=minecraft:normal' || line === 'level-type=minecraft\\:normal')) {
    throw new Error('FLEE_LAB_NATURAL_TERRAIN_REQUIRED');
  }
  const operators = JSON.parse(fs.readFileSync(path.join(worldDirectory, 'ops.json'), 'utf8')) as Array<{ name?: string }>;
  if (!operators.some(entry => entry.name === 'ShannonProbe')
    || operators.some(entry => entry.name === 'MinebotTrial')) {
    throw new Error('FLEE_LAB_OPERATOR_BOUNDARY_INVALID');
  }
}

type StandingSite = { x: number; y: number; z: number };
type Fixture = {
  center: StandingSite;
  escape: { x: number; z: number };
  enemies: Array<StandingSite & { kind: 'zombie' | 'skeleton' }>;
};

function isNaturalGround(block: any): boolean {
  if (!block || block.boundingBox !== 'block') return false;
  const name = String(block.name ?? '');
  return /^(grass_block|dirt|coarse_dirt|podzol|mycelium|stone|andesite|diorite|granite|tuff|deepslate|gravel|sand|red_sand|clay|moss_block|snow_block|terracotta)$/.test(name);
}

function isOpen(block: any): boolean {
  if (!block || block.boundingBox !== 'empty') return false;
  return !/(water|lava|fire|cobweb|sweet_berry|powder_snow)/.test(String(block.name ?? ''));
}

function findSurfaceY(bot: any, x: number, z: number, aroundY: number): number | null {
  for (let y = aroundY + 5; y >= aroundY - 9; y--) {
    if (isNaturalGround(bot.blockAt(new Vec3(x, y - 1, z)))
      && isOpen(bot.blockAt(new Vec3(x, y, z)))
      && isOpen(bot.blockAt(new Vec3(x, y + 1, z)))) return y;
  }
  return null;
}

function findNaturalFixture(bot: any): Fixture | null {
  const current = bot.entity?.position;
  if (!current || bot.entity?.isInWater) return null;
  const originX = Math.floor(current.x), originZ = Math.floor(current.z), aroundY = Math.floor(current.y);
  const surfaceCache = new Map<string, StandingSite | null>();
  const site = (x: number, z: number): StandingSite | null => {
    const key = `${x},${z}`;
    if (surfaceCache.has(key)) return surfaceCache.get(key)!;
    for (let y = aroundY + 5; y >= aroundY - 9; y--) {
      const ground = bot.blockAt(new Vec3(x, y - 1, z));
      const feet = bot.blockAt(new Vec3(x, y, z));
      const head = bot.blockAt(new Vec3(x, y + 1, z));
      if (isNaturalGround(ground) && isOpen(feet) && isOpen(head)) {
        const found = { x, y, z };
        surfaceCache.set(key, found);
        return found;
      }
    }
    surfaceCache.set(key, null);
    return null;
  };
  const headings = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];
  for (let radius = 0; radius <= 4; radius++) {
    for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
      const center = site(originX + dx, originZ + dz);
      if (!center || Math.abs(center.y - current.y) > 4) continue;
      for (const escape of headings) {
        const side = { x: -escape.z, z: escape.x };
        const positions: Array<{ kind: 'zombie' | 'skeleton'; x: number; z: number }> = [
          { kind: 'zombie', x: center.x - 4 * escape.x, z: center.z - 4 * escape.z },
          { kind: 'zombie', x: center.x + 2 * escape.x + 5 * side.x, z: center.z + 2 * escape.z + 5 * side.z },
          { kind: 'skeleton', x: center.x - 6 * escape.x - 2 * side.x, z: center.z - 6 * escape.z - 2 * side.z },
        ];
        const enemies = positions.map(position => {
          const floor = site(position.x, position.z);
          return floor ? { ...floor, kind: position.kind } : null;
        });
        if (enemies.some(enemy => !enemy || Math.abs(enemy.y - center.y) > 2)) continue;
        // The world is untouched. Require a naturally walkable outward route,
        // but let the real skill choose its own route and expose bad choices.
        let previous = center;
        let corridorOpen = true;
        for (let step = 1; step <= 17; step++) {
          const next = site(center.x + step * escape.x, center.z + step * escape.z);
          if (!next || Math.abs(next.y - previous.y) > 1 || Math.abs(next.y - center.y) > 4) {
            corridorOpen = false;
            break;
          }
          previous = next;
        }
        if (corridorOpen) return { center, escape, enemies: enemies as Fixture['enemies'] };
      }
    }
  }
  return null;
}

function actorOracle(operator: any, actor: any): MinecraftCommandOracle {
  return new MinecraftCommandOracle({
    version: actor.version,
    chat: (command: string) => operator.chat(`/execute as @a[name=MinebotTrial,limit=1] at @s run ${command.replace(/^\//, '')}`),
    on: (_event: 'message', listener: (message: unknown) => void) => actor.on('message', listener),
    removeListener: (_event: 'message', listener: (message: unknown) => void) => actor.removeListener('message', listener),
  });
}

async function until(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (!predicate()) throw new Error(`FLEE_PROBE_TIMEOUT:${label}`);
}

async function readBooleanRule(oracle: MinecraftCommandOracle, rule: string): Promise<boolean> {
  const yes = await oracle.evaluate({ type: 'gamerule', rule, value: true });
  if (yes.passed) return true;
  const no = await oracle.evaluate({ type: 'gamerule', rule, value: false });
  if (no.passed) return false;
  throw new Error(`FLEE_PROBE_GAMERULE_UNREADABLE:${rule}:${yes.error ?? no.error ?? 'value mismatch'}`);
}

function distanceSnapshot(bot: any): Record<string, unknown> {
  const position = bot.entity?.position;
  const hostiles = position ? Object.values(bot.entities as Record<string, any>)
    .filter((entity: any) => entity?.position && isLikelyHostileMobName(String(entity.name ?? '')))
    .map((entity: any) => ({ id: entity.id, name: entity.name,
      position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
      distance: position.distanceTo(entity.position) })) : [];
  return { atMs: Date.now() - startedAt,
    position: position ? { x: position.x, y: position.y, z: position.z } : null,
    health: bot.health ?? null, food: bot.food ?? null, alive: Boolean(position && bot.health > 0),
    nearestDistance: hostiles.reduce((best: number, mob: any) => Math.min(best, mob.distance), Infinity),
    hostiles };
}

let operator: Awaited<ReturnType<typeof createProbeBot>> | null = null;
let actor: Awaited<ReturnType<typeof createProbeBot>> | null = null;
let oracle: MinecraftCommandOracle | null = null;
let positionTimer: ReturnType<typeof setInterval> | null = null;
let originalSpawnMobs: boolean | null = null;
let originalAdvanceTime: boolean | null = null;
let originalTime: number | null = null;
let fixtureSummoned = false;
let deaths = 0;
let fixture: Fixture | null = null;
try {
  validateLab();
  operator = await createProbeBot(port);
  actor = await createProbeBot(port, 'MinebotTrial');
  oracle = new MinecraftCommandOracle(operator);
  const proof = actorOracle(operator, actor);
  actor.on('death', () => { deaths++; });
  actor.on('path_update', (event: any) => {
    const trace = report.pathTrace as Array<Record<string, unknown>>;
    if (trace.length >= 240) return;
    trace.push({ atMs: Date.now() - startedAt, status: event?.status ?? null,
      pathLength: Array.isArray(event?.path) ? event.path.length : null,
      visitedNodes: event?.visitedNodes ?? null, generatedNodes: event?.generatedNodes ?? null });
  });
  actor.on('path_reset', (reason: unknown) => {
    const trace = report.pathTrace as Array<Record<string, unknown>>;
    if (trace.length < 240) trace.push({ atMs: Date.now() - startedAt, event: 'path_reset', reason: String(reason) });
  });
  await oracle.verifyReady();
  await proof.verifyReady();
  const difficulty = await oracle.evaluate({ type: 'difficulty', difficulty: 'normal' });
  if (!difficulty.passed) throw new Error(`FLEE_LAB_NORMAL_DIFFICULTY_REQUIRED:${difficulty.error ?? 'not normal'}`);
  originalSpawnMobs = await readBooleanRule(oracle, 'spawn_mobs');
  originalAdvanceTime = await readBooleanRule(oracle, 'advance_time');
  originalTime = actor.time?.timeOfDay ?? null;
  await oracle.executeSetupCommand('gamerule spawn_mobs false');
  await oracle.executeSetupCommand('gamerule advance_time false');
  // Diagnostic fixture only: clear previously loaded natural cave mobs so
  // this trial contains exactly the three tagged, active threats under test.
  await oracle.executeSetupCommand('difficulty peaceful');
  await new Promise(resolve => setTimeout(resolve, 500));
  await oracle.executeSetupCommand('difficulty normal');
  await oracle.executeSetupCommand('time set midnight');
  await oracle.executeSetupCommand('gamemode spectator ShannonProbe');
  await oracle.executeSetupCommand('gamemode survival MinebotTrial');
  const dimensionProof = await proof.evaluate({ type: 'dimension', dimension: 'overworld' });
  if (!dimensionProof.passed) throw new Error('FLEE_PROBE_OVERWORLD_ACTOR_REQUIRED');

  for (const radius of [24, 40, 56, 72, 88, 104, 120, 136]) {
    await oracle.executeSetupCommand(`spreadplayers 0 0 8 ${radius} false MinebotTrial`);
    await new Promise(resolve => setTimeout(resolve, 1250));
    fixture = findNaturalFixture(actor);
    (report.setupAttempts as Array<Record<string, unknown>>).push({ radius, spawnedAt: distanceSnapshot(actor), found: Boolean(fixture) });
    if (fixture) break;
  }
  if (!fixture) throw new Error('FLEE_PROBE_NATURAL_WALKABLE_FIXTURE_NOT_FOUND');
  report.fixture = fixture;
  const { center, enemies } = fixture;
  report.terrainEvidence = Array.from({ length: 18 }, (_, step) => {
    const x = center.x + step * fixture!.escape.x;
    const z = center.z + step * fixture!.escape.z;
    const feetY = findSurfaceY(actor, x, z, center.y);
    return { step, x, y: feetY, z,
      ground: feetY === null ? null : (actor!.blockAt(new Vec3(x, feetY - 1, z))?.name ?? null) };
  });
  await oracle.executeSetupCommand(`tp MinebotTrial ${center.x + 0.5} ${center.y} ${center.z + 0.5}`);
  await until(() => {
    const position = actor?.entity?.position;
    return Boolean(position && position.distanceTo(new Vec3(center.x + 0.5, center.y, center.z + 0.5)) < 1.1);
  }, 5000, 'actor at natural fixture');
  const contaminated = Object.values(actor.entities).some((entity: any) => entity?.position
    && isLikelyHostileMobName(String(entity.name ?? ''))
    && entity.position.distanceTo(actor!.entity.position) < 30);
  if (contaminated) throw new Error('FLEE_PROBE_PREEXISTING_HOSTILE_CONTAMINATION');
  const initialPositionProof = await proof.evaluate({ type: 'position_within',
    x: center.x + 0.5, y: center.y, z: center.z + 0.5, radius: 1.1 });
  const survivalProof = await proof.evaluate({ type: 'gamemode', gamemode: 'survival' });
  if (!initialPositionProof.passed || !survivalProof.passed) throw new Error('FLEE_PROBE_ACTOR_FIXTURE_NOT_PROVEN');

  for (const enemy of enemies) {
    await oracle.executeSetupCommand(`summon minecraft:${enemy.kind} ${enemy.x + 0.5} ${enemy.y} ${enemy.z + 0.5} {Tags:["${fixtureTag}"],PersistenceRequired:1b}`);
    fixtureSummoned = true;
  }
  await until(() => Object.values(actor!.entities).filter((entity: any) =>
    entity?.position && (entity.name === 'zombie' || entity.name === 'skeleton')
      && entity.position.distanceTo(actor!.entity.position) < 32).length >= 3,
    5000, 'three controlled hostile entities visible');
  const initial = distanceSnapshot(actor);
  report.initial = initial;
  const initialCountProofs = await proof.evaluateAll([
    { type: 'entity_count', entity: 'zombie', tag: fixtureTag,
      x: center.x, y: center.y, z: center.z, radius: 40, minCount: 2, maxCount: 2 },
    { type: 'entity_count', entity: 'skeleton', tag: fixtureTag,
      x: center.x, y: center.y, z: center.z, radius: 40, minCount: 1, maxCount: 1 },
  ]);
  report.initialAssertions = [dimensionProof, initialPositionProof, survivalProof, ...initialCountProofs];
  if (initialCountProofs.some(result => !result.passed)
    || !(Number(initial.nearestDistance) < minDistance)
    || deaths !== 0) throw new Error('FLEE_PROBE_INITIAL_THREAT_NOT_PROVEN');

  // No operator mutation from here until the skill settles. The genuine
  // Minebot skill owns the body and encounters three active hostile AI mobs.
  const skill = actor.instantSkills.getSkill('flee-from');
  if (!skill) throw new Error('FLEE_PROBE_SKILL_MISSING');
  const initialPosition = actor.entity.position.clone();
  const atSkillStart = distanceSnapshot(actor);
  report.atSkillStart = atSkillStart;
  positionTimer = setInterval(() => {
    const trace = report.positionTrace as Array<Record<string, unknown>>;
    if (trace.length < 200) trace.push(distanceSnapshot(actor));
  }, 100);
  const skillStartedAt = Date.now();
  const result = await skill.run('hostile', minDistance, skillTimeoutMs);
  const durationMs = Date.now() - skillStartedAt;
  if (positionTimer) clearInterval(positionTimer);
  positionTimer = null;
  const atReturn = distanceSnapshot(actor);
  const movedMetersAtReturn = initialPosition.distanceTo(actor.entity.position);
  const pathfinderMovingAtReturn = actor.pathfinder?.isMoving?.() ?? null;
  report.skill = { result, durationMs, atReturn, movedMetersAtReturn, pathfinderMovingAtReturn };

  const postAssertions = await proof.evaluateAll([
    { type: 'entity_nearby', entity: 'zombie', maxDistance: oracleClearance, present: false },
    { type: 'entity_nearby', entity: 'skeleton', maxDistance: oracleClearance, present: false },
    { type: 'health_between', min: 1, max: 20 },
    { type: 'entity_count', entity: 'zombie', tag: fixtureTag,
      x: center.x, y: center.y, z: center.z, radius: 64, minCount: 2, maxCount: 2 },
    { type: 'entity_count', entity: 'skeleton', tag: fixtureTag,
      x: center.x, y: center.y, z: center.z, radius: 64, minCount: 1, maxCount: 1 },
  ]);
  const outsideStart = await proof.evaluate({ type: 'position_within',
    x: center.x + 0.5, y: center.y, z: center.z + 0.5, radius: 5 });
  const movedMetersAfterOracle = initialPosition.distanceTo(actor.entity.position);
  const nearestGain = Number(atReturn.nearestDistance) - Number(atSkillStart.nearestDistance);
  const seenAtReturn = atReturn.hostiles as Array<{ name: string }>;
  report.assertions = postAssertions;
  report.outsideStartProof = outsideStart;
  report.final = distanceSnapshot(actor);
  report.deaths = deaths;
  report.movedMetersAtReturn = movedMetersAtReturn;
  report.movedMetersAfterOracle = movedMetersAfterOracle;
  report.pathfinderMovingAtReturn = pathfinderMovingAtReturn;
  report.nearestGain = nearestGain;
  report.passed = result.success === true && durationMs <= skillTimeoutMs + 2000
    && movedMetersAtReturn >= 5 && nearestGain >= 3
    && Number(atReturn.nearestDistance) >= minDistance
    && seenAtReturn.filter(mob => mob.name === 'zombie').length === 2
    && seenAtReturn.filter(mob => mob.name === 'skeleton').length === 1
    && deaths === 0 && postAssertions.every((assertion: MinecraftCommandAssertionResult) => assertion.passed)
    && outsideStart.error === null && outsideStart.passed === false;
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  report.deaths = deaths;
  process.exitCode = 1;
} finally {
  if (positionTimer) clearInterval(positionTimer);
  if (actor) {
    try { actor.pathfinder?.stop(); } catch { /* actor may already be disconnected */ }
  }
  if (oracle && operator) {
    const cleanup = async (command: string): Promise<void> => {
      try {
        await oracle!.executeSetupCommand(command);
        (report.cleanup as Array<Record<string, unknown>>).push({ command, ok: true });
      } catch (error) {
        (report.cleanup as Array<Record<string, unknown>>).push({ command, ok: false, error: String(error) });
        report.passed = false;
        process.exitCode = 1;
      }
    };
    if (fixtureSummoned) {
      await cleanup(`kill @e[tag=${fixtureTag}]`);
      if (fixture) {
        const gone = await oracle.evaluateAll([
          { type: 'entity_count', entity: 'zombie', tag: fixtureTag,
            x: fixture.center.x, y: fixture.center.y, z: fixture.center.z, radius: 64, minCount: 0, maxCount: 0 },
          { type: 'entity_count', entity: 'skeleton', tag: fixtureTag,
            x: fixture.center.x, y: fixture.center.y, z: fixture.center.z, radius: 64, minCount: 0, maxCount: 0 },
        ]);
        report.cleanupAssertions = gone;
        if (gone.some(result => !result.passed)) {
          report.passed = false;
          process.exitCode = 1;
        }
      }
    }
    if (originalSpawnMobs !== null) await cleanup(`gamerule spawn_mobs ${originalSpawnMobs}`);
    if (originalAdvanceTime !== null) await cleanup(`gamerule advance_time ${originalAdvanceTime}`);
    if (originalTime !== null && Number.isInteger(originalTime)) await cleanup(`time set ${originalTime}`);
    await cleanup('gamemode survival ShannonProbe');
  }
  if (actor) closeProbeBot(actor);
  if (operator) closeProbeBot(operator);
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  const output = path.resolve('saves/minecraft/progressive_reports',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-flee-group.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`FLEE_GROUP_RESULT ${JSON.stringify({ passed: report.passed, durationMs: report.durationMs,
    skill: report.skill, movedMetersAtReturn: report.movedMetersAtReturn,
    movedMetersAfterOracle: report.movedMetersAfterOracle,
    pathfinderMovingAtReturn: report.pathfinderMovingAtReturn, nearestGain: report.nearestGain,
    deaths: report.deaths, error: report.error })}`);
  console.log(`FLEE_GROUP_REPORT ${output}`);
}
