#!/usr/bin/env node
// Model-free live check of the End fight parts of the body (2026-11-02 sprint, S1): going into the End and the dragon fight beginning, a blow at the
// dragon's head part (the body's id + 1) against one at the body's id and the other parts, the server's reach for a blow, the hand `attack ender_dragon`,
// the floor reflex out of a breath cloud, crystals shot with the bow (open and caged) and struck, the blast model against the server's real blasts,
// a bed blown beside the dragon, and the dragon's death as the evidence reads it.
//
// It runs through the road the production body uses (NativeCommonFcaBody.execute for the skill `act` and `goal-evidence`), on an isolated flat-world lab
// (scripts/lab/run-end-fight.sh); the End is the world's own. The operator bot (op) sets scenes up with server commands (tp, give, data modify, fill,
// summon) and reads the server's side; the actor (`MinebotTrial`, survival, no op) does everything that is judged. Numbers are the result: each scene
// puts what it measured in the report (ENDFIGHT_RESULT, one JSON line) and the lines it printed as it went (ENDFIGHT ...).
//
// Env: MINECRAFT_END_PORT (25570..25599), MINECRAFT_END_WORLD_DIRECTORY, MINECRAFT_END_SCENES=enter,parts,... (default: all), MINECRAFT_END_REPORT=<file>.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Vec3 } from 'vec3';
import { createProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { NativeCommonFcaBody } from '../src/services/minebot/integration/commonFca/nativeBody.js';
import { madeStamp } from './lab/madeStamp.js';
import { entityHealth } from '../src/services/minebot/utils/mapMarks.js';
import { partBox, partTarget, boxDistance, type DragonPart } from '../src/services/minebot/utils/dragonParts.js';
import { breathCloudsOf, dragonPhaseOf, endDragonOf, endObservation } from '../src/services/minebot/utils/dragonState.js';
import { dragonHazards } from '../src/services/minebot/utils/dragonDanger.js';
import { activeActionCapabilities, hasActiveSafetyLease, preemptLowerPriorityActions, safetyLeaseCapabilities } from '../src/services/minebot/execution/ActionExecution.js';
import { blastAt } from '../src/services/minebot/utils/crystalBlast.js';
import { feetCentre, standing, walkGround } from '../src/services/minebot/utils/dragonWalk.js';
import { bodyReader } from '../src/services/minebot/utils/localMap.js';
import { bedHalves } from '../src/services/minebot/utils/bedRules.js';
import { perchBedFoot, bedWallCells, bedCellSupported, supportedBedCells } from '../src/services/minebot/utils/dragonBedGeometry.js';
import { approachClear } from '../src/services/minebot/utils/dragonApproach.js';
import { dragonNook, insideDragonNook, nookCellSupported, type DragonNook } from '../src/services/minebot/utils/dragonNook.js';
import { BLOCK_REACH } from '../src/services/minebot/utils/blockReach.js';
import { isPerched, type P3 } from '../src/services/minebot/utils/dragonParts.js';
import { cageRoots, cageWall, cageGuardCells, islandFootings } from '../src/services/minebot/utils/endFightGeometry.js';
import { CHAIN_LIMIT_MS, CRYSTAL_LIMIT_MS, chainBasin, chainClear, chainCrystal, chainDistance, chainHands, chainPause, chainShot, chainSitting, chainWait, type ChainCrystal } from '../src/services/minebot/utils/endFullChainPlan.js';

const port = Number(process.env.MINECRAFT_END_PORT);
const worldDirectory = process.env.MINECRAFT_END_WORLD_DIRECTORY ?? '';
if (!Number.isInteger(port) || port < 25570 || port > 25599 || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_END_WORLD_REQUIRED');
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GOOGLE_API_KEY', 'GEMINI_API_KEY']) if (process.env[key]) throw new Error(`END_PROBE_REFUSES_PAID_KEY:${key}`);
if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'offline-test-not-used') throw new Error('END_PROBE_REFUSES_PAID_KEY:OPENAI_API_KEY');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_END_WORLD_CONFIGURATION_INVALID');

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (text: string) => console.log(`[${stamp()}] ENDFIGHT ${text}`);
const ACTOR = 'MinebotTrial';
const END = 'execute in minecraft:the_end run';
const DRAGON = '@e[type=minecraft:ender_dragon,limit=1]';

const operator = await createProbeBot(port);
const actor: any = await createProbeBot(port, ACTOR);
const body = new NativeCommonFcaBody(actor, { serverId: 'end-fight-probe', capture: async () => { throw new Error('no picture in the lab'); }, rendererConfigured: () => false });
let disconnected: string | null = null;
actor.on('end', (reason: unknown) => { disconnected ??= `end:${String(reason)}`; });
actor.on('kicked', (reason: unknown) => { disconnected ??= `kicked:${JSON.stringify(reason).slice(0, 200)}`; });
let actorDeaths = 0;
actor.on('death', () => { actorDeaths++; });
actor.on('error', (error: Error) => { log(`ACTOR_ERROR ${String(error?.message ?? error).slice(0, 200)}`); });
operator.on('end', (reason: unknown) => { disconnected ??= `operator-end:${String(reason)}`; });

const messageString = (message: unknown): string => { try { return typeof message === 'string' ? message : String((message as { toString(): string }).toString()); } catch { return ''; } };
/** One server command as the operator; what the server answered (the lines between the command and a marker). */
async function ask(command: string, timeoutMs = 10_000): Promise<string> {
  const marker = `ENDASK_${randomUUID().split('-').join('').slice(0, 10)}`;
  const seen: string[] = [];
  const answer = await new Promise<string>(resolve => {
    let timer: NodeJS.Timeout | undefined;
    const done = (suffix = '') => { if (timer) clearTimeout(timer); operator.removeListener('message', listener as never); resolve(seen.join('\n') + suffix); };
    const listener = (message: unknown) => { const text = messageString(message); if (text.includes(marker)) done(); else seen.push(text); };
    timer = setTimeout(() => done('\n[timeout]'), timeoutMs);
    operator.on('message', listener as never);
    operator.chat(`/${command}`);
    operator.chat(`/tellraw @s ${JSON.stringify({ text: marker })}`);
  });
  await sleep(250); // the vanilla server disconnects a client that chats too fast
  return answer;
}
const float = (text: string): number | null => { const m = /(-?\d+(?:\.\d+)?)[fdb]?\s*$/m.exec(text.replace(/\[timeout\]/u, '').trim().split('\n').pop() ?? ''); return m ? Number(m[1]) : null; };
const dragonHealthServer = async () => float(await ask(`${END} data get entity ${DRAGON} Health`));
const round = (n: number | null | undefined, digits = 2) => typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10 ** digits) / 10 ** digits : null;

// ----- the story book -----
const report: { startedAt: string; port: number; scenes: Record<string, any>; errors: string[] } = { startedAt: new Date().toISOString(), port, scenes: {}, errors: [] };
const wanted = (process.env.MINECRAFT_END_SCENES ?? '').split(',').map(s => s.trim()).filter(Boolean);
const include = (name: string) => wanted.length === 0 || wanted.some(prefix => name.startsWith(prefix));

const dragonEntity = () => endDragonOf(actor);
/** The End fields of the observation, under the names the head reads (`state.world.dragon`, `.crystals`, `.perch`, `.dragonBreath`, `.dragonFireballs`), or null outside the End. */
const endView = () => { const world = (body.observe().state as { world?: any }).world; return world?.crystals ? world : null; };
/** The loaded crystals of a view, with their place flat (x, y, z). */
const loadedCrystals = (view: any): Array<{ id: number; x: number; y: number; z: number; caged: boolean | null }> =>
  (view?.crystals?.list ?? []).map((c: any) => ({ id: c.id, x: c.position.x, y: c.position.y, z: c.position.z, caged: c.caged }));
let counter = 0;
const context = { scopeKey: 'owner', taskId: 'end-fight', taskRevision: 1, bodyId: 'minecraft:end-fight-probe', sessionId: 'end-session', generation: 1,
  goal: 'エンダードラゴンを倒して', completionCondition: 'native proof' };
const commandOf = (skill: string, args: Record<string, unknown>, seconds: number): any => ({ schemaVersion: 1, id: `end-${++counter}`, serverId: 'end-fight-probe', connectionId: 'end-fight', kind: 'skill', skill,
  arguments: args, context: { ...context, ...madeStamp(body) }, lease: { id: 'end-lease', generation: 1, holder: 'end-task' }, deadlineAt: new Date(Date.now() + seconds * 1000).toISOString() });
/** One act through the production body; the parsed receipt and the lines. */
async function act(hands: Array<Record<string, unknown>>, seconds = 30, extra: Record<string, unknown> = {}, signal?: AbortSignal): Promise<{ ok: boolean; lines: string[]; parsed: any; ms: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const watchdog = setTimeout(() => controller.abort('probe_watchdog'), (seconds + 20) * 1000);
  let receipt: any = null;
  try { receipt = await body.execute(commandOf('act', { hands, ...extra }, seconds), controller.signal); } catch (error) { report.errors.push(`act threw: ${String((error as Error)?.message ?? error)}`); }
  clearTimeout(watchdog);
  signal?.removeEventListener('abort', abort);
  let parsed: any = null; try { parsed = JSON.parse(receipt?.result ?? ''); } catch { parsed = null; }
  const lines = Array.isArray(parsed?.lines) ? parsed.lines.map((line: any) => `${line.i}.${line.do} ${line.status}: ${String(line.line).slice(0, 400)}`) : [String(receipt?.result ?? '').slice(0, 300)];
  log(`ACT ${hands.map(h => h.do).join('+')} ${parsed?.ok ? 'ok' : 'NOT-OK'} ${((Date.now() - started) / 1000).toFixed(1)}s ${lines.join(' | ').slice(0, 500)}`);
  return { ok: parsed?.ok === true, lines, parsed, ms: Date.now() - started };
}
async function evidence(signal?: AbortSignal, seconds = 10): Promise<any> {
  const receipt = await body.execute(commandOf('goal-evidence', {}, seconds), signal ?? new AbortController().signal);
  try { return JSON.parse(receipt.result ?? ''); } catch { return null; }
}

// ----- the arena -----
let g = 0;            // the island's ground level at the podium: the portal blocks' y (the pillar rises 4 above it)
let fountainY = 0;    // the dragon's perch y (the pillar's top)
const HEAD_Z = 7.0;   // the head's middle, 6.5 out along +z, when the dragon is turned to yaw 180 (Notchian)
async function enterEnd(): Promise<void> {
  await ask('gamemode survival MinebotTrial'); await ask('difficulty normal'); await ask('gamerule doDaylightCycle false');
  // The dragon is awake from the first tick and the spawn platform is in its reach (r2: killed by its breath while the scene waited for it): armoured, and resistant until this scene ends.
  await ask(`effect give ${ACTOR} minecraft:resistance 200 4 true`);
  await wear();
  await ask(`${END} tp ${ACTOR} 100 50 0`);
}
/** The standing ground: a flat end stone slab with air over it, the podium untouched. */
async function flatten(): Promise<void> {
  await ask(`${END} fill -9 ${g} -3 9 ${g + 12} 17 air replace end_stone`, 20_000);
  await ask(`${END} fill -9 ${g - 1} -3 9 ${g - 1} 17 end_stone`, 20_000);
}
const standAt = async (x: number, y: number, z: number) => { await ask(`${END} tp ${ACTOR} ${x} ${y} ${z}`); await sleep(500); };
/** The dragon sits on the perch, turned so that its head is over +z; its health is as given. */
async function perch(health = 200, phase = 6): Promise<void> {
  await ask(`${END} data modify entity ${DRAGON} DragonPhase set value ${phase}`);
  await ask(`${END} tp ${DRAGON} 0.5 ${fountainY} 0.5 180 0`);
  await still();
  await ask(`${END} data modify entity ${DRAGON} Health set value ${health}.0f`);
  await sleep(400);
}
/**
 * A `tp` keeps the dragon's horizontal speed, and a dragon put on the perch or in a hover from its flight slides on (r6: the bed set beside its head was gone when the hand came;
 * the hovering dragon was 148 blocks off by the third arrow): its motion is taken after every placement.
 */
const still = () => ask(`${END} data modify entity ${DRAGON} Motion set value [0.0d,0.0d,0.0d]`);
/** The dragon reflex held off (the floor's own switch is its next look): for the trials that measure what the server does, not what the body does about it. */
let reflexOff: NodeJS.Timeout | null = null;
const holdReflexOff = () => { releaseReflex(); const push = () => { const state = (actor as any).floorReflexes; if (state) state.dragonNextAt = Date.now() + 3000; }; push(); reflexOff = setInterval(push, 500); };
const releaseReflex = () => { if (reflexOff) { clearInterval(reflexOff); reflexOff = null; } const state = (actor as any).floorReflexes; if (state) state.dragonNextAt = 0; };
/**
 * Every timer a scene starts is stopped when the scene ends, whatever way it ends (r5: the arrow scene threw, and the timer that kept its dragon hovering ran on
 * through the scenes after it: the cycle never saw a perch).
 */
const timers = new Set<NodeJS.Timeout>();
const every = (ms: number, fn: () => void): NodeJS.Timeout => { const timer = setInterval(fn, ms); timers.add(timer); return timer; };
const stopTimers = () => { for (const timer of timers) clearInterval(timer); timers.clear(); };
/** The health of an entity the client holds, or null when there is none (the dragon may be out of the client's sight). */
const healthOf = (entity: any): number | null => entity ? entityHealth(actor, entity) : null;
/**
 * The dragon parked, hovering (phase 10) high over the middle of the island, so that only what a scene summons acts on the body. Over the island and not far off:
 * r5 parked it 160 blocks out, where its chunk was not loaded, and no command could bring it back for the scenes after.
 */
let parked: NodeJS.Timeout | null = null;
let parking: Promise<unknown> = Promise.resolve();
const park = async (on: boolean) => {
  if (parked) { clearInterval(parked); parked = null; }
  await parking; // a put under way ends first, so that it cannot move the dragon after the scene that wanted it back
  if (!on) return;
  const put = () => (parking = (async () => { await ask(`${END} data modify entity ${DRAGON} DragonPhase set value 10`); await ask(`${END} tp ${DRAGON} 0.5 ${g + 70} 0.5`); await still(); })());
  await put(); parked = setInterval(() => { void put(); }, 4000);
};
/** The dragon as the next scene wants it: out of any parking, flying its pattern near the island, at full health. */
const restoreDragon = async () => {
  await park(false);
  await ask(`${END} data modify entity ${DRAGON} DragonPhase set value 0`);
  await ask(`${END} tp ${DRAGON} 0.5 ${g + 30} 0.5`);
  await ask(`${END} data modify entity ${DRAGON} Health set value 200.0f`);
};
/**
 * The lowest health the actor reaches until `stop()` is called. A full belly gives half a heart back every half second, so the health read a second after a blast
 * is higher than what the blast took (r5: 1.1 at 10.5 m where the model said 2.2).
 */
const trackMinHealth = () => {
  let min = Number(actor.health);
  const on = () => { min = Math.min(min, Number(actor.health)); };
  actor.on('health', on);
  return { stop: (): number => { actor.removeListener('health', on); return min; } };
};
/** What the client holds of the clouds: each one's metadata (radius 8, waiting 9, particle 10) as the body reads it. */
const cloudsInClient = () => (Object.values(actor.entities) as any[]).filter(e => e?.name === 'area_effect_cloud' && e.position)
  .map(e => ({ id: e.id, at: [round(e.position.x, 1), round(e.position.y, 1), round(e.position.z, 1)], radius: e.metadata?.[8], waiting: e.metadata?.[9], particle: e.metadata?.[10] }));
const phaseNow = () => { const dragon = dragonEntity(); return dragon ? dragonPhaseOf(actor, dragon) : null; };
const gear = async (items: string[]) => {
  await ask(`clear ${ACTOR}`);
  for (const item of items) await ask(`give ${ACTOR} ${item}`);
  await sleep(500);
};
const ARMOR = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'];
const IRON_ARMOR = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
const wearIron = async () => { for (const [slot, item] of [['head', IRON_ARMOR[0]], ['chest', IRON_ARMOR[1]], ['legs', IRON_ARMOR[2]], ['feet', IRON_ARMOR[3]]]) await ask(`item replace entity ${ACTOR} armor.${slot} with ${item}`); await sleep(300); };
const wear = async () => { for (const [slot, item] of [['head', ARMOR[0]], ['chest', ARMOR[1]], ['legs', ARMOR[2]], ['feet', ARMOR[3]]]) await ask(`item replace entity ${ACTOR} armor.${slot} with ${item}`); await sleep(300); };
/** Resistance V for the scenes that do not measure what the body takes (the dragon is awake and kills a body that stands about); off for those that do. */
const protect = async (on: boolean) => { await ask(on ? `effect give ${ACTOR} minecraft:resistance 900 4 true` : `effect clear ${ACTOR}`); };
const hold = async (item: string) => { await ask(`item replace entity ${ACTOR} weapon.mainhand with ${item}`); await sleep(300); };

// ===== scenes =====
const scenes: Record<string, () => Promise<Record<string, unknown>>> = {};
let chainArrivalAt: number | null = null, chainArrivalMinHealth = Infinity;
let chainArrivalCounts: Record<string, number> | null = null;
const chainArrivalTimeline: Array<Record<string, unknown>> = [];
actor.on('health', () => { if (chainArrivalAt !== null) chainArrivalMinHealth = Math.min(chainArrivalMinHealth, Number(actor.health)); });

scenes.enter = async () => {
  const t0 = Date.now();
  if (wanted.includes('end_full_chain')) { chainArrivalAt = t0; chainArrivalMinHealth = Number(actor.health); chainArrivalCounts = actor.reflexLedger.counts(); }
  await enterEnd();
  const out: Record<string, unknown> = {};
  await sleep(1500);
  out.arrival = captureEnd('arrival', 'just arrived on the obsidian platform: the dragon and the crystals are not in sight yet');
  let dragonAt: number | null = null, crystalsAt: number | null = null;
  for (let i = 0; i < 240; i++) {
    const dragon = dragonEntity();
    if (dragon && dragonAt === null) dragonAt = Date.now() - t0;
    const view = endView();
    if (chainArrivalAt !== null && (chainArrivalTimeline.length === 0 || Date.now() - t0 - Number(chainArrivalTimeline[chainArrivalTimeline.length - 1].ms) >= 5000))
      chainArrivalTimeline.push({ stage: 'enter', ms: Date.now() - t0, seconds: (Date.now() - t0) / 1000, health: view?.dragon?.health ?? null,
        actorHealth: Number(actor.health), remaining: view?.crystals?.remaining ?? null });
    if ((view?.crystals?.list?.length ?? 0) >= 1 && crystalsAt === null) crystalsAt = Date.now() - t0;
    if (dragonAt !== null && view?.perch && (crystalsAt !== null || Date.now() - t0 > dragonAt + 8000)) break;
    await sleep(500);
  }
  const view = endView();
  g = view?.perch ? Math.round(view.perch.y) - 4 : 0; fountainY = view?.perch?.y ?? 0;
  Object.assign(out, { dimension: String(actor.game?.dimension), dragonSeenAfterMs: dragonAt, crystalsSeenAfterMs: crystalsAt, observation: view ? { dragon: view.dragon ?? null, perch: view.perch ?? null, crystals: { remaining: view.crystals.remaining, gone: view.crystals.gone, caged: view.crystals.caged, loaded: view.crystals.list.length, unseen: view.crystals.unseen.length }, breath: view.dragonBreath.length, fireballs: view.dragonFireballs } : null,
    dragonHealthServer: await dragonHealthServer(), cagedList: loadedCrystals(view).filter(c => c.caged).map(c => [c.id, c.x, c.y, c.z]) });
  return out;
};

/** The head's middle now (the dragon turns on the perch, so it is read live) and the unit direction from the dragon's middle to it. */
function liveHead(): { centre: Vec3; dir: Vec3; dragon: any } | null {
  const dragon = dragonEntity(); if (!dragon) return null;
  const box = partBox({ position: dragon.position, yaw: dragon.yaw }, 'head');
  const centre = new Vec3((box.minX + box.maxX) / 2, box.minY, (box.minZ + box.maxZ) / 2);
  const dx = centre.x - dragon.position.x, dz = centre.z - dragon.position.z, length = Math.hypot(dx, dz) || 1;
  return { centre, dir: new Vec3(dx / length, 0, dz / length), dragon };
}
/** Stand on the ground so that the eye is `distance` from the head's box, on the side the head points to, from the live yaw. */
async function standForHeadDistance(distance: number): Promise<number | null> {
  const head = liveHead(); if (!head) return null;
  const flat = Math.sqrt(Math.max(0, distance ** 2 - 1.38 ** 2)); // the box's bottom is 3 over the ground, the eye 1.62
  const out = 0.5 + flat;
  await ask(`${END} tp ${ACTOR} ${(head.centre.x + head.dir.x * out).toFixed(2)} ${g} ${(head.centre.z + head.dir.z * out).toFixed(2)}`);
  await sleep(250);
  return distance;
}
const eyeToHead = (): number | null => {
  const head = liveHead(); if (!head) return null;
  const eye = new Vec3(actor.entity.position.x, actor.entity.position.y + 1.62, actor.entity.position.z);
  return boxDistance(eye, partBox({ position: head.dragon.position, yaw: head.dragon.yaw }, 'head'));
};

scenes.parts = async () => {
  await protect(true);
  holdReflexOff();
  await flatten(); await gear(['diamond_sword']); await wear(); await hold('diamond_sword');
  const out: Record<string, unknown> = { sword: 'diamond_sword (7 at full strength; a part that is not the head takes a quarter and a block: 2.75)' };
  const trials: Array<Record<string, unknown>> = [];
  // The crystals heal the dragon on the perch (+1 every half second while a beam reaches it): its rate is measured first, and the blow's damage is read from the
  // client's own health at the moment the dragon is hurt (the server's reading comes a chat round trip late, with the healing in it).
  await perch(150); await standAt(0.5, g, HEAD_Z + 1);
  const h0 = entityHealth(actor, dragonEntity()), t0 = Date.now(); await sleep(4000);
  const h1 = entityHealth(actor, dragonEntity());
  out.healingPerSecondOnPerch = h0 !== null && h1 !== null ? round((h1 - h0) / ((Date.now() - t0) / 1000), 2) : null;
  const trial = async (label: string, id: (d: any) => number, stand: () => Promise<unknown>) => {
    await perch(200); await stand(); await sleep(1500); // the sword is charged again
    await stand();
    const dragon = dragonEntity();
    if (!dragon) { trials.push({ label, error: 'no dragon' }); return; }
    const eye = new Vec3(actor.entity.position.x, actor.entity.position.y + 1.62, actor.entity.position.z);
    const pieces: Record<string, number> = {};
    for (const part of ['head', 'neck', 'body', 'wing1', 'wing2'] as DragonPart[]) pieces[part] = round(boxDistance(eye, partBox({ position: dragon.position, yaw: dragon.yaw }, part)), 2)!;
    const before = entityHealth(actor, dragon);
    let atHurt: number | null = null, hurtEvents = 0;
    const onHurt = (entity: any) => { if (entity?.id === dragon.id) { hurtEvents++; setTimeout(() => { if (atHurt === null) atHurt = entityHealth(actor, actor.entities?.[dragon.id] ?? dragon); }, 60); } };
    const events: unknown[] = [];
    const onDamage = (packet: any) => { if (packet?.entityId === dragon.id) events.push({ cause: packet.sourceCauseId, direct: packet.sourceDirectId, type: packet.sourceTypeId }); };
    actor.on('entityHurt', onHurt); actor._client.on('damage_event', onDamage);
    actor.attack({ id: id(dragon), name: 'probe-target', position: dragon.position });
    await sleep(700);
    actor.removeListener('entityHurt', onHurt); actor._client.removeListener('damage_event', onDamage);
    const loss = before !== null && atHurt !== null ? round(before - atHurt, 2) : null;
    trials.push({ label, id: id(dragon), eyeToPart: pieces, healthClientBefore: before, healthClientAtHurt: atHurt, lossAtHurt: loss, hurtEvents, damageEvents: events });
    log(`PARTS ${label}: loss at hurt ${loss} (eye to parts ${JSON.stringify(pieces)}) damage_events ${JSON.stringify(events)}`);
  };
  const under = async () => { const head = liveHead(); if (head) await ask(`${END} tp ${ACTOR} ${head.centre.x.toFixed(2)} ${g} ${head.centre.z.toFixed(2)}`); await sleep(200); };
  const beside = (part: DragonPart, up: number, away: number) => async () => {
    const dragon = dragonEntity(); if (!dragon) return;
    const box = partBox({ position: dragon.position, yaw: dragon.yaw }, part);
    const cx = (box.minX + box.maxX) / 2, cz = (box.minZ + box.maxZ) / 2, dx = cx - dragon.position.x, dz = cz - dragon.position.z, length = Math.hypot(dx, dz) || 1;
    await ask(`${END} tp ${ACTOR} ${(cx + dx / length * away).toFixed(2)} ${Math.max(g, box.minY - up).toFixed(2)} ${(cz + dz / length * away).toFixed(2)}`); await sleep(200);
  };
  await trial('head (body id + 1)', d => d.id + 1, under);
  await trial('body id', d => d.id, under);
  await trial('neck (+2)', d => d.id + 2, beside('neck', 1.5, 2.5));
  await trial('body part (+3)', d => d.id + 3, beside('body', 1.5, 3.2));
  await trial('wing1 (+7)', d => d.id + 7, beside('wing1', 1.0, 2.8));
  await trial('wing2 (+8)', d => d.id + 8, beside('wing2', 1.0, 2.8));
  out.trials = trials;
  // The server's reach for a blow at the head: the farther the stand, the longer the eye's distance to the box; where do the blows stop landing?
  const reach: Array<Record<string, unknown>> = [];
  for (const wantedDistance of [3.0, 4.0, 5.0, 5.5, 5.8, 6.0, 6.2, 7.0]) {
    await perch(200); await standForHeadDistance(wantedDistance); await sleep(1500);
    await standForHeadDistance(wantedDistance);
    const real = eyeToHead(); const dragon = dragonEntity(); if (!dragon || real === null) break;
    const before = entityHealth(actor, dragon); let hurt = false;
    const onHurt = (entity: any) => { if (entity?.id === dragon.id) hurt = true; };
    actor.on('entityHurt', onHurt);
    actor.attack({ id: dragon.id + 1, name: 'probe-target', position: dragon.position });
    await sleep(500);
    actor.removeListener('entityHurt', onHurt);
    reach.push({ wantedDistance, eyeToHeadBox: round(real, 2), landed: hurt, healthClientBefore: before });
    log(`REACH ${real.toFixed(2)} m (wanted ${wantedDistance}): ${hurt ? 'landed' : 'no damage'}`);
  }
  out.reach = reach;
  releaseReflex();
  return out;
};

scenes.hand = async () => {
  await protect(true);
  holdReflexOff();
  await flatten(); await gear(['diamond_sword']); await wear(); await hold('diamond_sword');
  await perch(200); await standForHeadDistance(3.0); await sleep(1500);
  // The dragon turns on the perch: the operator keeps the actor near its head and the dragon on the perch, as a planner's go would.
  const follow = setInterval(() => { void standForHeadDistance(3.5); void ask(`${END} data modify entity ${DRAGON} DragonPhase set value 6`); }, 1200);
  const before = await dragonHealthServer();
  const h0 = entityHealth(actor, dragonEntity());
  const run = await act([{ do: 'attack', target: 'ender_dragon', untilDead: false, seconds: 9 }], 25);
  clearInterval(follow);
  const after = await dragonHealthServer();
  const h1 = entityHealth(actor, dragonEntity());
  releaseReflex();
  const text = run.lines.join(' ');
  const m = /(\d+)回振って (\d+)回当たった/u.exec(text);
  return { act: run.lines, ok: run.ok, healthServerBefore: before, healthServerAfter: after, healthClientBefore: h0, healthClientAfter: h1,
    blows: m ? Number(m[1]) : null, landed: m ? Number(m[2]) : null, secondsPerBlow: m && Number(m[1]) > 0 ? round(run.ms / 1000 / Number(m[1]), 2) : null };
};

const CLOUD_AT = { x: -5.5, z: 11.5 };
/**
 * The body's way out of a cloud laid on it: from the moment the command is sent, the cloud in the client, the first forward key, the first step and the way out of the zone,
 * the health lost, the reflexes in the ledger, and what the body made of the cloud when it first saw it (the metadata the client holds, the body's own reading, the hazards,
 * the floor's state). With `hold` the dragon reflex is held off until the cloud lies in the client, so that a fireball's line is not what the body runs from.
 */
async function escapeTrial(label: string, zone: number, lay: () => Promise<string>, options: { hold?: boolean } = {}): Promise<Record<string, unknown>> {
  await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`); await ask(`${END} kill @e[type=minecraft:dragon_fireball]`);
  await wear(); await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`); await standAt(CLOUD_AT.x, g, CLOUD_AT.z); await sleep(1500);
  const healthBefore = Number(actor.health), deathsBefore = actorDeaths, ledgerMark = (actor.reflexLedger?.mark?.() as number | undefined) ?? 0;
  const lowest = trackMinHealth();
  const found: { cloudSeen: number | null; released: number | null; firstForward: number | null; step: number | null; exited: number | null; jump: boolean; sprint: boolean; atSight: Record<string, unknown> | null; later: Record<string, unknown> | null } =
    { cloudSeen: null, released: null, firstForward: null, step: null, exited: null, jump: false, sprint: false, atSight: null, later: null };
  /** What the body makes of the cloud and what holds its dragon reflex back, at one moment. */
  const reading = (): Record<string, unknown> => {
    const floor = (actor as any).floorReflexes;
    return {
      clouds: cloudsInClient(),
      read: breathCloudsOf(actor).map(c => ({ radius: c.radius, at: [round(c.position.x, 1), round(c.position.y, 1), round(c.position.z, 1)] })),
      hazards: dragonHazards(actor).map(h => h.kind),
      dragonNextAtIn: floor?.dragonNextAt ? floor.dragonNextAt - Date.now() : null, busy: floor?.busy ?? null, retreatEngaged: floor?.retreat?.engaged ?? null,
      lease: hasActiveSafetyLease(actor), leaseBy: safetyLeaseCapabilities(actor), lava: (actor as any).lavaReflex?.engaged ?? null, breathing: (actor as any).breathingReflex?.engaged ?? null,
      at: [round(actor.entity.position.x, 2), round(actor.entity.position.y, 2), round(actor.entity.position.z, 2)], health: actor.health, keys: Object.entries(actor.controlState ?? {}).filter(([, on]) => on).map(([key]) => key),
    };
  };
  const originalKey = actor.setControlState.bind(actor);
  const startedAt = Date.now();
  if (options.hold) holdReflexOff();
  actor.setControlState = (key: string, value: boolean) => { if (key === 'forward' && value && found.firstForward === null) found.firstForward = Date.now() - startedAt; return originalKey(key, value); };
  let answered = '', serverCloud = '';
  const poll = every(25, () => {
    const p = actor.entity?.position; if (!p) return;
    if (found.cloudSeen === null && cloudsInClient().length) {
      found.cloudSeen = Date.now() - startedAt;
      found.atSight = reading();
      log(`BREATH ${label}: cloud in the client after ${found.cloudSeen} ms: ${JSON.stringify(found.atSight)}`);
      if (options.hold) { releaseReflex(); found.released = found.cloudSeen; }
    }
    if (found.cloudSeen !== null && found.later === null && Date.now() - startedAt > found.cloudSeen + 1500) {
      found.later = reading();
      log(`BREATH ${label}: a second and a half later: ${JSON.stringify(found.later)}`);
    }
    if (actor.controlState?.jump) found.jump = true;
    if (actor.controlState?.sprint) found.sprint = true;
    const flat = Math.hypot(p.x - CLOUD_AT.x, p.z - CLOUD_AT.z);
    if (found.step === null && flat > 0.8) found.step = Date.now() - startedAt;
    if (found.exited === null && flat > Math.max(zone, 7) + 0.2) found.exited = Date.now() - startedAt;
  });
  try {
    answered = await lay();
    serverCloud = (await ask(`${END} data get entity @e[type=minecraft:area_effect_cloud,limit=1]`)).replace(/\s+/gu, ' ').slice(0, 600);
    for (let i = 0; i < 80 && found.exited === null; i++) await sleep(100);
  } finally {
    clearInterval(poll);
    actor.setControlState = originalKey;
    if (options.hold) releaseReflex();
  }
  await sleep(500);
  const p = actor.entity.position;
  const entries = (actor.reflexLedger?.entriesSince?.(ledgerMark) as Array<{ kind: string; at: number; detail: string; outcome: string }> | undefined) ?? [];
  const result = {
    label, zone, answer: answered.slice(0, 120), serverCloud,
    cloudInClientAfterMs: found.cloudSeen, releasedAfterMs: found.released, firstForwardKeyAfterMs: found.firstForward, firstStepAfterMs: found.step, outOfZoneAfterMs: found.exited,
    died: actorDeaths > deathsBefore, ledger: entries.map(e => `${e.kind}:${e.outcome}@${e.at - startedAt}ms:${e.detail.slice(0, 90)}`),
    finalFlatDistance: round(Math.hypot(p.x - CLOUD_AT.x, p.z - CLOUD_AT.z), 2), healthLost: round(healthBefore - Number(actor.health), 1), healthLostAtWorst: round(healthBefore - lowest.stop(), 1), jumped: found.jump, sprinted: found.sprint,
    atFirstSight: found.atSight, aSecondAndAHalfLater: found.later,
  };
  log(`BREATH ${label}: ${JSON.stringify(result)}`);
  await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`);
  return result;
}

scenes.breath = async () => {
  // The cloud as the game lays it (a dragon fireball down on the body: radius 3 growing to 7, the harming II that takes 6 a second), then clouds summoned at radius 3, 5 and 7 with the same effect.
  await protect(false);
  await park(true);
  await flatten(); await gear(['diamond_sword']); await wear();
  const runs: Array<Record<string, unknown>> = [];
  const summoned = (radius: number) => () => ask(`${END} summon minecraft:area_effect_cloud ${CLOUD_AT.x} ${g} ${CLOUD_AT.z} {custom_particle:{type:"minecraft:dragon_breath",power:1.0f},Radius:${radius}f,Duration:600,ReapplicationDelay:20,potion_contents:{custom_effects:[{id:"minecraft:instant_damage",amplifier:1,duration:1}]}}`);
  const fireball = () => ask(`${END} summon minecraft:dragon_fireball ${CLOUD_AT.x} ${g + 6} ${CLOUD_AT.z} {Motion:[0.0d,-1.0d,0.0d],acceleration_power:0.1d}`);
  runs.push(await escapeTrial("a fireball's own cloud (the reflex held until it lies)", 3, fireball, { hold: true }));
  for (const radius of [3, 5, 7]) runs.push(await escapeTrial(`summoned cloud, radius ${radius}`, radius, summoned(radius)));
  await park(false);
  return { runs };
};

scenes.fireball = async () => {
  await protect(false);
  await park(true);
  await flatten(); await gear(['diamond_sword']); await wear();
  const runs: Array<Record<string, unknown>> = [];
  // 20 blocks south and 10 or 12 up, flying north and down: onto the actor (it comes down on the body at about 10), over it to land 6 blocks behind (12), or beside it (14 off).
  for (const [label, wide, high] of [['aimed at the body', 0, 10], ['over the body, landing 6 blocks behind it', 0, 12], ['passing 14 blocks to the side', 14, 12]] as Array<[string, number, number]>) {
    await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`); await wear();
    await standAt(-3.5, g, 4.5); await sleep(1000);
    const healthBefore = Number(actor.health), start = actor.entity.position.clone(), lowest = trackMinHealth();
    const ledgerMark = (actor.reflexLedger?.mark?.() as number | undefined) ?? 0;
    const answered = await ask(`${END} summon minecraft:dragon_fireball ${-3.5 + wide} ${g + high} ${24.5} {Motion:[0.0d,-0.45d,-1.0d],acceleration_power:0.1d}`);
    const startedAt = Date.now();
    let seenAfter: number | null = null, movedAfter: number | null = null, velocity: unknown = null, jumped = false, sprinted = false;
    const poll = every(50, () => {
      const balls = (Object.values(actor.entities) as any[]).filter(e => e?.name === 'dragon_fireball');
      if (balls.length && seenAfter === null) { seenAfter = Date.now() - startedAt; const v = actor.toldVelocities?.get(balls[0].id); velocity = v ? [v.x, v.y, v.z].map((n: number) => Math.round(n * 1000) / 1000) : null; }
      const p = actor.entity?.position; if (p && movedAfter === null && p.distanceTo(start) > 1) movedAfter = Date.now() - startedAt;
      if (actor.controlState?.jump) jumped = true; if (actor.controlState?.sprint) sprinted = true;
    });
    await sleep(5000);
    clearInterval(poll);
    const end = actor.entity.position, entries = (actor.reflexLedger?.entriesSince?.(ledgerMark) as Array<{ kind: string; outcome: string; detail: string }> | undefined) ?? [];
    runs.push({ label, summonAnswer: answered.slice(0, 160), fireballSeenAfterMs: seenAfter, toldVelocity: velocity, bodyMovedAfterMs: movedAfter, movedBlocks: round(end.distanceTo(start), 1), movedBy: [round(end.x - start.x, 1), round(end.z - start.z, 1)],
      healthLost: round(healthBefore - Number(actor.health), 1), healthLostAtWorst: round(healthBefore - lowest.stop(), 1), jumped, sprinted, cloudsAtEnd: cloudsInClient().length, ledger: entries.map(e => `${e.kind}:${e.outcome}:${e.detail.slice(0, 80)}`) });
    log(`FIREBALL ${label}: ${JSON.stringify(runs.at(-1))}`);
    await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`); await ask(`${END} kill @e[type=minecraft:dragon_fireball]`);
    await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`); await sleep(500);
  }
  await park(false);
  return { runs };
};

scenes.arrow_dragon = async () => {
  await protect(true);
  await flatten(); await gear(['bow', 'arrow 64', 'diamond_sword']); await wear();
  // The dragon hovers (phase 10) 14 up over the middle; the actor shoots it from the ground, 28 blocks off.
  await park(false);
  const hover = async () => { await ask(`${END} data modify entity ${DRAGON} DragonPhase set value 10`); await ask(`${END} tp ${DRAGON} 0.5 ${g + 14} 0.5`); await still(); };
  await hover();
  every(1500, () => { void hover(); });
  await ask(`${END} data modify entity ${DRAGON} Health set value 200.0f`);
  // a slab to stand on at 28 blocks out (the natural ground there is not level with the podium: r4 put the body in a wall and its wall-escape reflex held it)
  await ask(`${END} fill -4 ${g} 24 5 ${g + 8} 34 air replace end_stone`, 20_000); await ask(`${END} fill -4 ${g - 1} 24 5 ${g - 1} 34 end_stone`, 20_000);
  await standAt(0.5, g, 28.5); await sleep(1500);
  const damage: unknown[] = [];
  const dragon0 = dragonEntity();
  if (!dragon0) return { error: 'the dragon is not in the client\'s sight', dragonServerHealth: await dragonHealthServer() };
  const onDamage = (p: any) => { if (p?.entityId === dragon0.id) damage.push({ cause: p.sourceCauseId, direct: p.sourceDirectId, type: p.sourceTypeId }); };
  actor._client.on('damage_event', onDamage);
  const before = healthOf(dragon0);
  const run = await act([{ do: 'shoot', target: 'ender_dragon', n: 4 }], 40);
  await sleep(1000);
  actor._client.removeListener('damage_event', onDamage);
  const after = healthOf(dragonEntity());
  const proof = await evidence();
  return { act: run.lines, ok: run.ok, healthClientBefore: before, healthClientAfter: after, damageEvents: damage, bossWitness: proof?.boss?.witness ?? null, bossVerified: proof?.boss?.verified };
};

scenes.cycle = async () => {
  // The whole perch cycle without a planner: the dragon is sent to land by its own landing phases (2 -> 3 -> 5 -> 6 -> 7 -> 5 ... -> 4), the crystals are taken away (their healing would hide
  // the blows), and a stand-in for the planner brings the body under the head with a `tp` (a `go` would walk) and sends `attack ender_dragon` while it sits. The floor reflex is ON:
  // it steps out of the flame and the boxes. Per perch: the phases and when, the blows and how many landed, the health the dragon lost, the reflexes that fired, the actor's health.
  await protect(false);
  await flatten(); await gear(['diamond_sword']); await wear(); await hold('diamond_sword');
  await standAt(-5.5, g, 11.5);
  await park(false);
  await ask(`${END} kill @e[type=minecraft:end_crystal]`);
  await ask(`${END} data modify entity ${DRAGON} Health set value 200.0f`);
  await ask(`${END} data modify entity ${DRAGON} DragonPhase set value 2`);
  const t0 = Date.now(); const rel = () => Math.round((Date.now() - t0) / 100) / 10;
  const timeline: Array<[number, string]> = [];
  let lastPhase: number | null = null, lastClouds = 0, minHealth = Number(actor.health), deaths = 0;
  actor.on('death', () => { deaths++; });
  every(100, () => {
    const d = dragonEntity(); const p = d ? dragonPhaseOf(actor, d) : null;
    if (p !== lastPhase) { timeline.push([rel(), `phase ${p}`]); lastPhase = p; }
    const clouds = breathCloudsOf(actor).length;
    if (clouds !== lastClouds) { timeline.push([rel(), `clouds ${clouds}`]); lastClouds = clouds; }
    minHealth = Math.min(minHealth, Number(actor.health));
  });
  const ledgerAt = (actor.reflexLedger?.mark?.() as number | undefined) ?? 0;
  const perches: Array<Record<string, unknown>> = [];
  let sitting = false, blowsTotal = 0, landedTotal = 0, acts = 0;
  const startHealth = healthOf(dragonEntity());
  // A stand-in for a planner that reads `state.world.dragonBreath`: it does not walk back under the head while the breath lies within 9 blocks of it.
  const cloudNearHead = (): boolean => { const head = liveHead(); return !!head && breathCloudsOf(actor).some(c => Math.hypot(c.position.x - head.centre.x, c.position.z - head.centre.z) < 9); };
  while (Date.now() - t0 < 170_000 && deaths === 0) {
    const dragon = dragonEntity();
    if (!dragon) { await sleep(500); continue; }
    const phase = dragonPhaseOf(actor, dragon);
    const health = healthOf(dragon);
    if (health !== null && health <= 20) break;
    if (phase !== null && phase >= 5 && phase <= 7) {
      if (!sitting) { sitting = true; perches.push({ startedAt: rel(), phaseAtStart: phase, healthAtStart: health }); }
      if (phase === 5) { await sleep(200); continue; } // the flame: the stand-in waits for the next scanning phase, as a planner that reads the phase does
      for (let waited = 0; waited < 150 && cloudNearHead(); waited++) await sleep(100);
      if (phaseNow() === null || (phaseNow() as number) < 5 || (phaseNow() as number) > 7) continue; // the perch ended while the breath lay
      // The stand-in for the planner: the body under the head, then the hand, in the perch.
      await standForHeadDistance(3.5);
      const before = healthOf(dragonEntity());
      const run = await act([{ do: 'attack', target: 'ender_dragon', untilDead: false, seconds: 10 }], 25);
      acts++;
      // Cut by the floor's reflex: a planner that read the cut does not go back under the head while the flame is on (the cloud is there for the phase's ten seconds).
      if (/反射/u.test(run.lines.join(' '))) for (let waited = 0; waited < 150 && phaseNow() === 5; waited++) await sleep(100);
      const m = /(\d+)回振って (\d+)回当たった/u.exec(run.lines.join(' '));
      const blows = m ? Number(m[1]) : 0, landed = m ? Number(m[2]) : 0;
      blowsTotal += blows; landedTotal += landed;
      const last = perches[perches.length - 1];
      last.acts = ((last.acts as number) ?? 0) + 1; last.blows = ((last.blows as number) ?? 0) + blows; last.landed = ((last.landed as number) ?? 0) + landed;
      last.lines = [...((last.lines as string[]) ?? []), run.lines.join(' ').slice(0, 260)];
      last.healthLost = round((Number(last.healthAtStart) || 0) - (healthOf(dragonEntity()) ?? 0), 1);
      if (before !== null) last.lastActLoss = round(before - (healthOf(dragonEntity()) ?? before), 1);
      await sleep(300);
    } else {
      if (sitting) { sitting = false; const last = perches[perches.length - 1]; last.endedAt = rel(); last.phaseAtEnd = phase; }
      await sleep(300);
    }
  }
  const entries = ((actor.reflexLedger?.entriesSince?.(ledgerAt) as Array<{ kind: string; detail: string; outcome: string }> | undefined) ?? []).map(e => `${e.kind}:${e.outcome}:${e.detail.slice(0, 80)}`);
  const kinds: Record<string, number> = {};
  for (const e of entries) { const k = e.split(':')[0]; kinds[k] = (kinds[k] ?? 0) + 1; }
  return { seconds: rel(), dragonHealthStart: startHealth, dragonHealthEnd: healthOf(dragonEntity()), perches, acts, blowsTotal, landedTotal, reflexKinds: kinds, reflexSample: entries.slice(0, 12),
    actorMinHealth: round(minHealth, 1), actorDeaths: deaths, timeline: timeline.slice(0, 60) };
};

scenes.crystal_bow = async () => {
  await protect(true);
  await flatten(); await gear(['bow', 'arrow 64']); await wear();
  const out: Record<string, unknown> = {};
  const view = endView();
  const open = loadedCrystals(view).filter(c => c.caged === false);
  if (!open.length) return { error: 'no uncaged crystal in sight' };
  // The nearest uncaged crystal; the actor stands about 20 blocks off along the line from the island's middle, on a slab at the crystal's height - 10.
  const target = open[0];
  const dx = target.x - 0.5, dz = target.z - 0.5, length = Math.hypot(dx, dz) || 1;
  const stand = { x: Math.round(target.x + dx / length * 20), z: Math.round(target.z + dz / length * 20) };
  const standY = Math.max(g, Math.round(target.y) - 8);
  await ask(`${END} fill ${stand.x - 2} ${standY - 1} ${stand.z - 2} ${stand.x + 2} ${standY - 1} ${stand.z + 2} end_stone`);
  await ask(`${END} fill ${stand.x - 2} ${standY} ${stand.z - 2} ${stand.x + 2} ${standY + 4} ${stand.z + 2} air`);
  await standAt(stand.x + 0.5, standY, stand.z + 0.5);
  await ask(`${END} data modify entity ${DRAGON} DragonPhase set value 0`);
  const near = await act([{ do: 'shoot', target: `#${target.id}`, n: 1 }], 20);
  const farView = endView();
  out.target = { id: target.id, x: target.x, y: target.y, z: target.z, distance: round(Math.hypot(stand.x - target.x, standY - target.y, stand.z - target.z), 1) };
  out.shot = { lines: near.lines, ok: near.ok, crystalsBefore: view.crystals.remaining, crystalsAfter: farView?.crystals.remaining, healthNow: actor.health };
  // Too near: refused before a draw.
  await standAt(target.x + 0.5 + dx / length * 6, standY + 0, target.z + 0.5 + dz / length * 6);
  const tooNear = await act([{ do: 'shoot', target: `#${loadedCrystals(farView).find(c => c.caged === false)?.id ?? target.id}` }], 10);
  out.tooNear = { lines: tooNear.lines };
  return out;
};

scenes.crystal_caged = async () => {
  await protect(true);
  await flatten(); await gear(['bow', 'arrow 64', 'iron_pickaxe']); await wear();
  const view = endView();
  const caged = loadedCrystals(view).filter(c => c.caged === true);
  if (!caged.length) return { error: 'no caged crystal in sight', crystals: view?.crystals };
  const target = caged[0];
  const out: Record<string, unknown> = { target: { id: target.id, x: target.x, y: target.y, z: target.z } };
  // Shot from outside: the arrow's way is blocked by the bars, so no arrow is drawn.
  const dx = target.x - 0.5, dz = target.z - 0.5, length = Math.hypot(dx, dz) || 1;
  const ux = dx / length, uz = dz / length;
  const stand = { x: Math.round(target.x + ux * 18), z: Math.round(target.z + uz * 18) };
  const standY = Math.round(target.y) - 1;
  await ask(`${END} fill ${stand.x - 2} ${standY - 1} ${stand.z - 2} ${stand.x + 2} ${standY - 1} ${stand.z + 2} end_stone`);
  await ask(`${END} fill ${stand.x - 2} ${standY} ${stand.z - 2} ${stand.x + 2} ${standY + 4} ${stand.z + 2} air`);
  await standAt(stand.x + 0.5, standY, stand.z + 0.5);
  await ask(`${END} data modify entity ${DRAGON} DragonPhase set value 0`);
  const blocked = await act([{ do: 'shoot', target: `#${target.id}` }], 15);
  out.shotThroughBars = { lines: blocked.lines, ok: blocked.ok };
  // The bars on the arrow's way are taken out one by one, as `dig` would take them (only the ones on the way): each refusal names the bar; it is set to air and the shot is asked again.
  const taken: string[] = [];
  let open = await act([{ do: 'shoot', target: `#${target.id}` }], 20);
  for (let i = 0; i < 8 && !open.ok && /iron_bars/u.test(open.lines.join(' ')); i++) {
    const cell = /\((-?\d+),(-?\d+),(-?\d+)\) の iron_bars/u.exec(open.lines.join(' '));
    if (!cell) break;
    await ask(`${END} setblock ${cell[1]} ${cell[2]} ${cell[3]} air`); taken.push(`${cell[1]},${cell[2]},${cell[3]}`);
    open = await act([{ do: 'shoot', target: `#${target.id}` }], 20);
  }
  await sleep(500);
  out.barsTaken = taken;
  out.shotThroughHole = { lines: open.lines, ok: open.ok, crystalGone: actor.entities?.[target.id] === undefined };
  return out;
};

scenes.crystal_bars = async () => {
  // A caged crystal's loop with the body's own hands: the shot is refused naming the bar in the way (`line_blocked`), the planner's `dig` takes that bar (an iron pickaxe, a step from it), and
  // the shot is asked again. A plane of bars at z 15 stands between the stand (z 3.5) and a crystal in the air at z 17.5 (the walk to the bar is not what is looked at: the body is put there).
  await protect(true);
  await park(true);
  await flatten(); await gear(['bow', 'arrow 64', 'iron_pickaxe']); await wear();
  await standAt(0.5, g, 3.5); // in the arena first: a crystal 100 blocks off is not in the client's entities
  const crystalAt = { x: 0.5, y: g + 3, z: 17.5 };
  await ask(`${END} fill -4 ${g} 12 5 ${g + 9} 16 air`);
  await ask(`${END} fill -3 ${g} 15 4 ${g + 7} 15 iron_bars`);
  await ask(`${END} kill @e[type=minecraft:end_crystal]`);
  await ask(`${END} summon minecraft:end_crystal ${crystalAt.x} ${crystalAt.y} ${crystalAt.z} {ShowBottom:0b}`);
  const findCrystal = () => (Object.values(actor.entities) as any[]).find(e => e?.name === 'end_crystal' && Math.abs(e.position.z - crystalAt.z) < 1.5) ?? null;
  for (let i = 0; i < 20 && !findCrystal(); i++) await sleep(150);
  const target = findCrystal();
  if (!target) return { error: 'no crystal in sight' };
  await standAt(0.5, g, 3.5); await sleep(800);
  const first = await act([{ do: 'shoot', target: `#${target.id}` }], 20);
  let shot = first;
  const taken: string[] = [];
  for (let i = 0; i < 6 && !shot.ok && /iron_bars/u.test(shot.lines.join(' ')); i++) {
    const cell = /\((-?\d+),(-?\d+),(-?\d+)\) の iron_bars/u.exec(shot.lines.join(' '));
    if (!cell) break;
    const [x, y, z] = [Number(cell[1]), Number(cell[2]), Number(cell[3])];
    await ask(`${END} tp ${ACTOR} ${x + 0.5} ${g} ${z - 2.0}`); await sleep(600);
    const dug = await act([{ do: 'dig', at: [{ x, y, z }], collect: false }], 20);
    taken.push(`${x},${y},${z}: ${dug.ok ? 'dug' : 'NOT dug'}: ${dug.lines.join(' ').slice(0, 200)}`);
    await standAt(0.5, g, 3.5); await sleep(600);
    shot = await act([{ do: 'shoot', target: `#${target.id}` }], 20);
  }
  await sleep(600);
  return { firstShot: first.lines, barsDug: taken, lastShot: shot.lines, ok: shot.ok, crystalGone: actor.entities?.[target.id] === undefined, healthNow: actor.health };
};

scenes.crystal_blast = async () => {
  // The blast model against the server's real blasts. A crystal is summoned in the air over the arena (z 17.5) and the body stands at a given distance on the slab, level with it, with
  // or without a wall of obsidian between; the crystal is hurt by the operator (`damage`: a crystal is not hurt by /kill, it is only removed) and the health lost is read.
  await protect(false);
  await park(true);
  await flatten(); await gear(['diamond_sword']); await wear();
  const out: Record<string, unknown> = {};
  const trials: Array<Record<string, unknown>> = [];
  const crystalAt = { x: 0.5, y: g + 1, z: 17.5 };
  const summonCrystal = async () => {
    await ask(`${END} kill @e[type=minecraft:end_crystal]`);
    await ask(`${END} summon minecraft:end_crystal ${crystalAt.x} ${crystalAt.y} ${crystalAt.z} {ShowBottom:0b}`);
    for (let i = 0; i < 20; i++) { if ((Object.values(actor.entities) as any[]).some(e => e?.name === 'end_crystal' && Math.abs(e.position.z - crystalAt.z) < 1.5)) break; await sleep(150); }
    return (Object.values(actor.entities) as any[]).find(e => e?.name === 'end_crystal' && Math.abs(e.position.z - crystalAt.z) < 1.5) ?? null;
  };
  // The attack hand at a crystal within reach is refused, with the estimate; nothing is struck.
  await ask(`${END} fill -3 ${g} 14 3 ${g + 4} 16 air`);
  let crystal = await summonCrystal();
  await standAt(0.5, g, crystalAt.z - 2.4); await sleep(600);
  if (crystal) {
    const refused = await act([{ do: 'attack', target: `#${crystal.id}` }], 10);
    out.meleeRefusal = { lines: refused.lines, crystalStillThere: actor.entities?.[crystal.id] !== undefined };
  }
  for (const [distance, wall] of [[12.5, false], [10.5, false], [8.5, false], [6.5, false], [8.5, true]] as Array<[number, boolean]>) {
    await ask(`${END} fill -3 ${g} 4 3 ${g + 6} 16 air`); // no wall left from the last trial (the podium ring is at z <= 4)
    crystal = await summonCrystal();
    if (!crystal) { trials.push({ distance, error: 'no crystal' }); continue; }
    const z = crystalAt.z - distance;
    if (wall) await ask(`${END} fill -2 ${g} ${z + 3} 3 ${g + 4} ${z + 3} obsidian`);
    await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`);
    await standAt(0.5, g, z); await sleep(1500);
    const estimate = blastAt(actor, crystal.position);
    const healthBefore = Number(actor.health), deathsBefore = actorDeaths;
    const lowest = trackMinHealth();
    await ask(`${END} damage @e[type=minecraft:end_crystal,limit=1] 1 minecraft:arrow`);
    await sleep(1200);
    const lost = round(healthBefore - Number(actor.health), 1), lostAtWorst = round(healthBefore - lowest.stop(), 1);
    trials.push({ distance, wall, estimate: { distance: estimate.distance, seen: estimate.seen, raw: estimate.raw, expected: estimate.expected }, healthLost: lost, healthLostAtWorst: lostAtWorst, died: actorDeaths > deathsBefore });
    log(`BLAST ${distance} m wall ${wall}: estimate ${estimate.expected} (raw ${estimate.raw}, seen ${estimate.seen}), real loss ${lostAtWorst} at worst (${lost} a second later)`);
  }
  await park(false);
  out.trials = trials;
  return out;
};

scenes.perch_watch = async () => {
  // Does a dragon on the perch stay where it is put? (r9: its head was 10 blocks from where it should have been.) The client's reading of it every half second, and the server's.
  await protect(true);
  holdReflexOff();
  await park(false);
  await flatten(); await gear(['diamond_sword']); await wear();
  await perch(200);
  every(1500, () => { void ask(`${END} data modify entity ${DRAGON} DragonPhase set value 6`); });
  await standAt(0.5, g, 13.2);
  const samples: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 20; i++) {
    const d = dragonEntity();
    const head = liveHead();
    samples.push({ t: i * 0.5, at: d ? [round(d.position.x, 1), round(d.position.y, 1), round(d.position.z, 1)] : null, yaw: d ? round(Number(d.yaw), 2) : null, phase: phaseNow(), head: head ? [round(head.centre.x, 1), round(head.centre.z, 1)] : null });
    await sleep(500);
  }
  const serverPos = (await ask(`${END} data get entity ${DRAGON} Pos`)).replace(/\s+/gu, ' ').slice(0, 160);
  const serverMotion = (await ask(`${END} data get entity ${DRAGON} Motion`)).replace(/\s+/gu, ' ').slice(0, 160);
  releaseReflex();
  return { samples, serverPos, serverMotion };
};

/** Both bed scenes use the actual HEAD half as the blast centre, exactly as the production use hand does. */
function perchBedEstimate(cell: P3) {
  const halves = bedHalves(actor.blockAt(new Vec3(cell.x, cell.y, cell.z)), cell);
  if (!halves) return null;
  return blastAt(actor, { x: halves.head.x + 0.5, y: halves.head.y + 0.5, z: halves.head.z + 0.5 }, actor.entity.position, 5, [halves.foot, halves.head]);
}
async function usePerchBed(cell: P3, signal?: AbortSignal): ReturnType<typeof act> {
  const guess = perchBedEstimate(cell);
  if (!guess || !guess.safe || !Number.isFinite(guess.expected) || guess.expected > 4) return { ok: false, lines: [`bed estimate refused: ${JSON.stringify(guess)}`], parsed: null, ms: 0 };
  return act([{ do: 'use', at: [cell] }], 12, {}, signal);
}

scenes.bed = async () => {
  // A bed blown beside the dragon's head on its perch. The dragon turns its head toward the body (a player), and its head, neck and body wipe out every block that is not dragon-proof (r6/r7:
  // a bed set at a fixed place was gone when the hand came), so the body stands first on the line through the dragon's middle where the head will face, the dragon is given time to turn, and the bed is
  // set 2.2 blocks past the head (the pillar under it is end stone, which the dragon cannot break), level with it, and used at once. Behind a wall of obsidian (the body's estimate is small, the
  // blast goes on) and in the open (the estimate is not: the body refuses and says why). The dragon is kept in phase 6 and the reflex held off.
  await protect(false);
  holdReflexOff();
  await park(false);
  await flatten(); await gear(['white_bed 4', 'diamond_sword']); await wear();
  const out: Record<string, unknown> = {};
  const trials: Array<Record<string, unknown>> = [];
  every(1500, () => { void ask(`${END} data modify entity ${DRAGON} DragonPhase set value 6`); });
  const STAND = { x: 0.5, z: 13.2 }; // on the line from the dragon's middle through the head that faces +z: 6.5 + 2.2 + 4 blocks out
  for (const [label, wallBetween] of [['bed past the head, wall between', true], ['bed past the head, in the open', false]] as Array<[string, boolean]>) {
    await perch(200);
    await flatten();
    await ask(`${END} fill -2 ${g} 11 3 ${g + 5} 11 air replace obsidian`);
    await ask(`${END} fill -1 ${g + 3} 8 2 ${g + 4} 11 air replace white_bed`);
    await ask(`${END} fill -4 ${g} 6 5 ${g + 6} 15 air replace fire`); // the last bed's blast lit fires round it
    await standAt(STAND.x, g, STAND.z);
    await sleep(6000); // the dragon turns its head toward the body
    const head = liveHead(), dragonNow = dragonEntity();
    const serverPos = (await ask(`${END} data get entity ${DRAGON} Pos`)).replace(/\s+/gu, ' ').slice(0, 120);
    // the bed past the head along the line from the dragon's middle, one pillar of end stone under its foot
    const dir = head ? head.dir : new Vec3(0, 0, 1);
    const spot = perchBedFoot(head?.centre ?? new Vec3(0.5, 0, 7), dir, g + 3);
    const bx = spot.x, bz = spot.z;
    await ask(`${END} fill ${bx} ${g} ${bz} ${bx} ${g + 2} ${bz} end_stone`);
    if (wallBetween) {
      const wall = bedWallCells(spot, { ...STAND, y: g }, g, g + 4, 6);
      const first = wall[0], last = wall[wall.length - 1];
      await ask(`${END} fill ${first.x} ${first.y} ${first.z} ${last.x} ${last.y} ${last.z} obsidian`);
    }
    const healthBefore = Number(actor.health), deathsBefore = actorDeaths;
    const dragonBefore = await dragonHealthServer();
    const lowest = trackMinHealth();
    await ask(`${END} setblock ${bx} ${g + 3} ${bz} white_bed[facing=south,part=foot]`);
    await ask(`${END} setblock ${bx} ${g + 3} ${bz + 1} white_bed[facing=south,part=head]`);
    const seenBefore = { bed: [bx, g + 3, bz], atClient: actor.blockAt(new Vec3(bx, g + 3, bz))?.name ?? null, headHalfAtClient: actor.blockAt(new Vec3(bx, g + 3, bz + 1))?.name ?? null,
      head: head ? [round(head.centre.x, 1), round(head.centre.z, 1)] : null, dragonAt: dragonNow ? [round(dragonNow.position.x, 1), round(dragonNow.position.z, 1)] : null, serverPos, dragonPhase: dragonNow ? dragonPhaseOf(actor, dragonNow) : null };
    log(`BED ${label}: before the hand ${JSON.stringify(seenBefore)}`);
    const run = await usePerchBed({ x: bx, y: g + 3, z: bz });
    await sleep(800);
    const dragonAfter = await dragonHealthServer();
    trials.push({ label, seenBefore, lines: run.lines, ok: run.ok, healthLost: round(healthBefore - Number(actor.health), 1), healthLostAtWorst: round(healthBefore - lowest.stop(), 1), died: actorDeaths > deathsBefore,
      dragonBefore, dragonAfter, dragonLoss: dragonBefore !== null && dragonAfter !== null ? round(dragonBefore - dragonAfter, 1) : null, dragonPhaseAfter: phaseNow() });
    log(`BED ${label}: ${JSON.stringify(trials.at(-1))}`);
    await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`); await sleep(500);
  }
  releaseReflex();
  out.trials = trials;
  return out;
};

// ===== the End fields of the observation as the lab sees them: fixtures for the head, and the inputs for a replay test of the body =====
const xyz = (v: any) => v ? { x: v.x, y: v.y, z: v.z } : null;
/**
 * The End fields of the observation at this instant (`endObservation`) and everything the body read to make them: the entities that matter with their metadata, the body's own state, the
 * metadata keys of the registry, and every block the code looked at (through a proxy that has no chunk columns, so that each read goes through `blockAt` and is seen). The replay test
 * (tests/unit/minecraftEndObservationLab.test.ts) builds a body from the inputs and expects the same fields. The synchronous calls see one instant: no packet is handled between them.
 */
function captureEnd(label: string, note: string): Record<string, unknown> {
  const now = Date.now();
  const expected = endObservation(actor, now);
  const kinds = ['ender_dragon', 'end_crystal', 'area_effect_cloud', 'dragon_fireball'];
  const entities = (Object.values(actor.entities) as any[]).filter(e => kinds.includes(e?.name) && e.position).map(e => ({
    id: e.id, name: e.name, position: xyz(e.position), yaw: Number(e.yaw ?? 0), pitch: Number(e.pitch ?? 0),
    ...(typeof e.health === 'number' && Number.isFinite(e.health) ? { health: e.health } : {}), metadata: JSON.parse(JSON.stringify(e.metadata ?? [])) }));
  const told: Record<string, unknown> = {};
  for (const e of entities) { const v = actor.toldVelocities?.get(e.id); if (v) told[String(e.id)] = xyz(v); }
  const cells = new Map<string, number | null>(), types: Array<Record<string, unknown>> = [], typeAt = new Map<string, number>();
  const recorder = new Proxy(actor, { get: (target, prop) => {
    if (prop === 'world') return undefined;
    if (prop === 'blockAt') return (position: Vec3, extra?: boolean) => {
      const block = target.blockAt(position, extra);
      const cell = `${position.x},${position.y},${position.z}`;
      if (!block) { cells.set(cell, null); return block; }
      const kind = JSON.stringify([block.name, block.boundingBox, block.shapes ?? null]);
      let index = typeAt.get(kind);
      if (index === undefined) { index = types.length; typeAt.set(kind, index); types.push({ name: block.name, boundingBox: block.boundingBox, ...(block.shapes ? { shapes: block.shapes } : {}) }); }
      cells.set(cell, index);
      return block;
    };
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const through = endObservation(recorder as any, now);
  const strip = (view: any) => { const copy = JSON.parse(JSON.stringify(view)); if (copy?.dragon) delete copy.dragon.phaseFor; return JSON.stringify(copy); }; // the phase clock is the body's own
  const agrees = strip(expected) === strip(through);
  if (!agrees) log(`OBSERVE ${label}: the blockAt reader and the column reader disagree`);
  const armor = [5, 6, 7, 8].map(slot => actor.inventory?.slots?.[slot]?.name ?? null);
  return {
    label, note, capturedAt: new Date(now).toISOString(), agreesWithBlockAtReader: agrees, expected: JSON.parse(JSON.stringify(expected)),
    input: {
      now, bot: { position: xyz(actor.entity.position), yaw: Number(actor.entity.yaw ?? 0), pitch: Number(actor.entity.pitch ?? 0), health: actor.health, food: actor.food,
        game: { dimension: actor.game?.dimension, difficulty: actor.game?.difficulty, serverViewDistance: actor.game?.serverViewDistance }, armor },
      entities, toldVelocities: told,
      registryKeys: Object.fromEntries(kinds.map(kind => [kind, actor.registry?.entitiesByName?.[kind]?.metadataKeys ?? null])),
      types, cells: Object.fromEntries(cells),
    },
  };
}

scenes.observe = async () => {
  // The End fields of the observation in the situations the head reads them: the dragon flying, perched (out of reach, then under the head), crystals near (one caged), a breath cloud (just seen,
  // then growing) and a fireball in the air. The body does not move (the reflex is held off and it has resistance), so that each reading is of the situation, not of the body leaving it.
  await protect(true);
  holdReflexOff();
  await flatten(); await gear(['diamond_sword']); await wear();
  const captures: Array<Record<string, unknown>> = [];
  const take = (label: string, note: string) => {
    const capture = captureEnd(label, note); captures.push(capture);
    log(`OBSERVE ${label}: ${JSON.stringify(capture.expected).slice(0, 400)}`);
  };
  // 1. the dragon flying its pattern, the body in the arena
  await restoreDragon(); await standAt(-5.5, g, 11.5); await sleep(3000);
  take('dragon_flying', 'the dragon flying its pattern near the island (phase 0 or 1); the body in the arena; the crystals the view distance lets it see');
  // 2. the dragon on the perch: the body 13 blocks out (no part in reach), then under the head
  await perch(200, 6);
  every(1500, () => { void ask(`${END} data modify entity ${DRAGON} DragonPhase set value 6`); });
  await standAt(0.5, g, 13.2); await sleep(6500);
  take('dragon_perched_out_of_reach', 'the dragon on the perch (phase 6) turned to the body, 13 blocks out: headPosition given, strike false');
  await standForHeadDistance(3.5); await sleep(900);
  take('dragon_perched_in_reach', 'the dragon on the perch, the body 3.5 blocks from the head box: strike true');
  stopTimers();
  // 3. crystals near, one in a cage (iron bars on four sides and a roof), one open; the dragon hovering high up
  await park(true);
  await ask(`${END} kill @e[type=minecraft:end_crystal,x=-40,y=${g},z=-5,dx=80,dy=6,dz=30]`);
  await standAt(0.5, g, 9.0); await sleep(500);
  await ask(`${END} summon minecraft:end_crystal 0.5 ${g + 1} 17.5 {ShowBottom:0b}`);
  await ask(`${END} summon minecraft:end_crystal -6.5 ${g + 1} 6.5 {ShowBottom:0b}`);
  for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) await ask(`${END} setblock ${-7 + dx} ${g + 2} ${6 + dz} iron_bars`);
  await ask(`${END} setblock -7 ${g + 3} 6 iron_bars`);
  await sleep(1500);
  take('crystals_near_caged_and_open', 'an open crystal 8.5 blocks off and a caged one (bars on four sides and a roof) 7.4 blocks off, both within the blast reach: blast given; the natural crystals far off');
  await ask(`${END} kill @e[type=minecraft:end_crystal,x=-10,y=${g},z=5,dx=20,dy=6,dz=15]`);
  // 4. a breath cloud: a dragon fireball down on the body, the cloud as the game lays it
  await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`);
  await standAt(-5.5, g, 11.5); await sleep(800);
  await ask(`${END} summon minecraft:dragon_fireball -5.5 ${g + 6} 11.5 {Motion:[0.0d,-1.0d,0.0d],acceleration_power:0.1d}`);
  for (let i = 0; i < 40 && cloudsInClient().length === 0; i++) await sleep(50);
  take('breath_cloud_just_seen', 'a cloud the dragon\'s fireball laid on the body, as first seen (the client has not been told its radius yet: radius 7, the radius the body keeps clear of)');
  await sleep(1500);
  take('breath_cloud_growing', 'the same cloud a second and a half later: its own radius (about 3.1, growing to 7)');
  await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`);
  // 5. a fireball in the air
  await standAt(-3.5, g, 4.5); await sleep(800);
  await ask(`${END} summon minecraft:dragon_fireball -3.5 ${g + 10} 24.5 {Motion:[0.0d,-0.45d,-1.0d],acceleration_power:0.1d}`);
  for (let i = 0; i < 20 && !(Object.values(actor.entities) as any[]).some(e => e?.name === 'dragon_fireball'); i++) await sleep(25);
  take('fireball_in_flight', 'a dragon fireball in the air, aimed at the body from 20 blocks off');
  await sleep(2500);
  await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`); await ask(`${END} kill @e[type=minecraft:dragon_fireball]`);
  releaseReflex();
  return { captures };
};

/** The arrival platform's trials (`platform`), or only those whose label has `only` in it (`platform_edge`: the front edge of a bridge). */
async function platformRun(only: string | null): Promise<Record<string, unknown>> {
  // The End's arrival: the body on the obsidian platform in the void (5 x 5 round (100, 48, 0)), a dragon fireball down on it. Every heading is the void, so no way out can be walked; with a block carried the
  // dragon reflex puts it under the feet (obsidian first): a cloud is a slab on the ground, and a body one block up is clear of it. Then the same with nothing to put under the feet, for the cost, and with a second
  // ball a while after the first (the cloud laid at the new height).
  await protect(false);
  releaseReflex();
  await park(true);
  // The platform's chunks stay loaded whoever stands where: a body that died is back in the overworld, and a cloud left in an unloaded End chunk is not found by `kill` (w4: the next trial was met by it on arrival).
  await ask(`${END} forceload add 64 -16 111 16`);
  const clear = async () => { await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`); await ask(`${END} kill @e[type=minecraft:dragon_fireball]`); };
  const trial = async (label: string, items: string[], balls = 1, bridgeAt: number | null = null, bridgeFrom = 70, bridgeTo = 97) => {
    await clear();
    // the platform as the game makes it (5 x 5 of obsidian at y 48), nothing on it; the body put on it and waited for until it stands, whole. On the bridge: a line of cobblestone one wide, 28 long, from the platform out over the void (a way out that can be walked: the body walks it, w8: 9 blocks, no harm); in the other trials there is none.
    await ask(`${END} fill 98 48 -2 102 48 2 obsidian`); await ask(`${END} fill 98 49 -2 102 53 2 air`);
    await ask(`${END} fill 70 48 0 97 48 0 air`); await ask(`${END} fill 70 49 -1 97 53 1 air`);
    if (bridgeAt !== null) await ask(`${END} fill ${bridgeFrom} 48 0 ${bridgeTo} 48 0 cobblestone`);
    const standX = bridgeAt ?? 100.5;
    await gear(items); await wear();
    await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`);
    for (let attempt = 0; attempt < 6; attempt++) {
      await ask(`${END} tp ${ACTOR} ${standX} 49 0.5`); await sleep(1200);
      if (actor.entity.onGround && Math.abs(actor.entity.position.y - 49) < 0.2 && Math.hypot(actor.entity.position.x - standX, actor.entity.position.z - 0.5) < 0.6 && Number(actor.health) >= 19.9) break;
    }
    await clear(); await sleep(300);
    const healthBefore = Number(actor.health), deathsBefore = actorDeaths, ledgerMark = (actor.reflexLedger?.mark?.() as number | undefined) ?? 0, lowest = trackMinHealth();
    const y0 = actor.entity.position.y;
    let maxY = y0, riseAfterMs: number | null = null, firstHarmAfterMs: number | null = null;
    const startedAt = Date.now();
    const onHealth = () => { if (firstHarmAfterMs === null && Number(actor.health) < healthBefore - 0.5) firstHarmAfterMs = Date.now() - startedAt; };
    actor.on('health', onHealth);
    const poll = every(50, () => {
      maxY = Math.max(maxY, actor.entity.position.y);
      if (riseAfterMs === null && actor.entity.position.y - y0 >= 0.9) riseAfterMs = Date.now() - startedAt;
    });
    for (let n = 0; n < balls; n++) {
      // over the body, or over the last block of a bridge that is cut short (the body half over its edge would otherwise have the ball fall past it into the void)
      const ballX = bridgeAt !== null && bridgeFrom > 70 ? bridgeFrom + 0.5 : standX;
      await ask(`${END} summon minecraft:dragon_fireball ${ballX} 55 0.5 {Motion:[0.0d,-1.0d,0.0d],acceleration_power:0.1d}`);
      if (n + 1 < balls) await sleep(3000);
    }
    await sleep(label.includes('nothing') ? 2800 : 5000);
    clearInterval(poll); actor.removeListener('health', onHealth);
    const entries = (actor.reflexLedger?.entriesSince?.(ledgerMark) as Array<{ kind: string; outcome: string; detail: string }> | undefined) ?? [];
    const at = actor.entity.position;
    const result = {
      label, items, balls, healthLost: round(healthBefore - Number(actor.health), 1), healthLostAtWorst: round(healthBefore - lowest.stop(), 1), died: actorDeaths > deathsBefore,
      feetY: [round(y0, 2), round(at.y, 2)], highestFeetY: round(maxY, 2), roseAfterMs: riseAfterMs, firstHarmAfterMs, blockUnder: actor.blockAt(new Vec3(Math.floor(at.x), Math.floor(at.y) - 1, Math.floor(at.z)))?.name ?? null,
      ledger: entries.map(e => `${e.kind}:${e.outcome}:${e.detail.slice(0, 110)}`),
    };
    log(`PLATFORM ${label}: ${JSON.stringify(result)}`);
    return result;
  };
  try {
    const runs: unknown[] = [];
    const run = async (label: string, ...rest: [string[], number?, (number | null)?, number?, number?]) => { if (only === null || label.includes(only)) runs.push(await trial(label, ...rest)); };
    {
      await run('with obsidian and cobblestone carried', ['diamond_sword', 'cobblestone 16', 'obsidian 4']);
      await run('with cobblestone only', ['diamond_sword', 'cobblestone 16']);
      await run('with two balls, three seconds apart', ['diamond_sword', 'cobblestone 16', 'obsidian 4'], 2);
      await run('with nothing to put under the feet', ['diamond_sword']);
      await run('on a bridge one wide, 12 blocks out', ['diamond_sword', 'cobblestone 16'], 1, 88.5);
      await run('on a bridge one wide, two balls 3 s apart', ['diamond_sword', 'cobblestone 16'], 2, 88.5);
      // the front edge of a bridge being laid in the void, one block of it laid (x 90, nothing beyond it: no way to walk out of a cloud): the body stands on that block with its middle over x 89, where nothing is under it
      // (the go leans over the gap to lay the next block)
      await run('at the front edge of a bridge of one block, half over the next cell', ['diamond_sword', 'cobblestone 16'], 1, 89.97, 90, 90);
    }
    return { runs };
  } finally {
    await clear(); await ask(`${END} forceload remove 64 -16 111 16`);
  }
}
scenes.platform = () => platformRun(null);
scenes.platform_edge = () => platformRun('front edge');

/** The way off the arrival platform, as the `cross` scene; with `ballAfterMs` a dragon fireball is dropped on the body that long after the first `go` began (`cross_ball`). */
async function crossRun(ballAfterMs: number | null, natural = false, freshDragon = true, onPerch = false, thinkMs = 0): Promise<Record<string, unknown>> {
  // The way off the arrival platform: the island lies some tens of blocks off over the void, and the body stands on 5 x 5 of obsidian. A planner's `go` with blocks to lay over the gap and a place on the island for its end,
  // as many times as it takes (the hand may take 120 s). The dragon is kept over the island, high up (nothing here is a fight); what is measured is whether the body gets over, how long it takes and what it costs in blocks.
  await protect(false);
  releaseReflex();
  // natural: the dragon as it is at the start of a fight (flying its pattern, full health), left to do what it does; the body wears iron and carries one stack and a water bucket (what the run will have)
  // (a dragon put back at the start of every crossing is at the start of its pattern: its first strafe comes some 25 s in, and a crossing is over in 15 to 20, so r19's eight crossings met no ball at all; after the first, the dragon is left to its own cycle)
  if (natural) { if (freshDragon) await restoreDragon(); } else await park(true);
  await ask(`${END} forceload add 64 -16 111 16`);
  try {
    await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`); await ask(`${END} kill @e[type=minecraft:dragon_fireball]`);
    await ask(`${END} fill 98 48 -2 102 48 2 obsidian`); await ask(`${END} fill 98 49 -2 102 53 2 air`);
    if (natural) { await ask(`${END} fill 60 40 -8 99 70 8 air replace minecraft:cobblestone`); /* every block an earlier crossing laid (r22: after the first, the crossings laid 6 blocks, not 14: part of the first one's way was still there) */ await gear(['stone_sword', 'cobblestone 64', 'water_bucket']); await wearIron(); }
    else { await gear(['diamond_sword', 'cobblestone 64', 'cobblestone 64', 'cobblestone 64']); await wear(); }
    await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`);
    for (let attempt = 0; attempt < 6; attempt++) {
      await ask(`${END} tp ${ACTOR} 100.5 49 0.5`); await sleep(1200);
      if (actor.entity.onGround && Math.abs(actor.entity.position.y - 49) < 0.2 && Number(actor.health) >= 19.9) break;
    }
    // the island's nearest column along z = 0 from the east, and a place three columns in from its rim
    const topAt = (x: number, z: number): number | null => {
      for (let y = 110; y >= 20; y--) { const block = actor.blockAt(new Vec3(x, y, z), false); if (block && block.name === 'end_stone') return y; }
      return null;
    };
    // the island's top surface (y 55 and over: the ragged ends of end stone that hang below the rim are not a place to go to)
    const profile: Array<[number, number | null]> = [];
    for (let x = 100; x >= 0; x -= 4) profile.push([x, topAt(x, 0)]);
    log(`CROSS profile along z=0 (x, top y): ${JSON.stringify(profile)}`);
    let rimX: number | null = null;
    for (let x = 96; x >= 0 && rimX === null; x--) { const top = topAt(x, 0); if (top !== null && top >= 55) rimX = x; }
    if (rimX === null) return { error: 'no island surface seen along z = 0 (chunks not in the client?)', profile };
    const targetX = rimX - 3, targetTop = topAt(targetX, 0) ?? topAt(rimX, 0)!;
    const target = { x: targetX, y: targetTop + 1, z: 0 };
    log(`CROSS island rim at x=${rimX} (top y=${topAt(rimX, 0)}), target ${JSON.stringify(target)}, platform to rim ${100 - rimX} blocks`);
    const blocksLeft = () => (actor.inventory.items() as Array<{ name: string; count: number }>).filter(item => item.name === 'cobblestone').reduce((sum, item) => sum + item.count, 0);
    const before = blocksLeft(), deathsBefore = actorDeaths, lowest = trackMinHealth(), trail: Array<[number, number, number, number]> = [];
    const ledgerMark = (actor.reflexLedger?.mark?.() as number | undefined) ?? 0;
    let ballAt: number[] | null = null;
    const startedAt = Date.now();
    const sample = every(2000, () => { const p = actor.entity?.position; if (p) trail.push([Math.round((Date.now() - startedAt) / 1000), round(p.x, 1)!, round(p.y, 1)!, Number(actor.health)]); });
    // what the dragon did meanwhile: its phases (when it changed), the fireballs seen, how near it came, the hits the body took (when, how much, with what near)
    const phases: Array<[number, number | null]> = [], balls = new Set<number>(), hits: Array<Record<string, unknown>> = [], timeline: Array<Array<number | string | boolean | null>> = [];
    let lastPhase: number | null | undefined, nearestDragon = Infinity, lastHealth = Number(actor.health);
    const watch = every(100, () => {
      const at = round((Date.now() - startedAt) / 1000, 1)!, position = actor.entity?.position;
      if (!position) return;
      const dragon = dragonEntity(), phase = dragon ? dragonPhaseOf(actor, dragon) : null;
      if (phase !== lastPhase) { phases.push([at, phase]); lastPhase = phase; }
      if (dragon?.position) nearestDragon = Math.min(nearestDragon, position.distanceTo(dragon.position));
      const entities = Object.values(actor.entities) as any[];
      for (const entity of entities) if (entity?.name === 'dragon_fireball') balls.add(entity.id);
      const health = Number(actor.health);
      if (health < lastHealth - 0.01) {
        const clouds = entities.filter(e => e?.name === 'area_effect_cloud' && e.position && position.distanceTo(e.position) < 14);
        const inCloud = clouds.some(cloud => Math.hypot(cloud.position.x - position.x, cloud.position.z - position.z) < (Number(cloud.metadata?.[8]) || 3) + 0.3 && Math.abs(cloud.position.y - position.y) < 1.5);
        hits.push({ at, lost: round(lastHealth - health, 1), phase, dragonM: dragon?.position ? round(position.distanceTo(dragon.position), 1) : null, inCloud, x: round(position.x, 1), y: round(position.y, 1) });
      }
      lastHealth = health;
      if (natural && timeline.length < 450) {
        const v = actor.entity.velocity, keys = Object.entries(actor.controlState ?? {}).filter(([, on]) => on).map(([key]) => key).join('+');
        const near = entities.filter(e => e?.name === 'area_effect_cloud' && e.position && position.distanceTo(e.position) < 12).sort((a, b) => position.distanceTo(a.position) - position.distanceTo(b.position));
        const nearest = near[0], ball = entities.find(e => e?.name === 'dragon_fireball' && e.position);
        timeline.push([at, round(position.x, 2)!, round(position.y, 2)!, round(position.z, 2)!, round(v.y, 2)!, actor.entity.onGround === true, round(health, 1)!, activeActionCapabilities(actor).join('+'), keys, near.length,
          nearest ? `${round(nearest.position.x - position.x, 1)},${round(nearest.position.y - position.y, 1)},${round(nearest.position.z - position.z, 1)} r${round(Number(nearest.metadata?.[8]), 1)}` : '', ball ? `${round(ball.position.x - position.x, 1)},${round(ball.position.y - position.y, 1)},${round(ball.position.z - position.z, 1)}` : '']);
      }
    });
    const calls: Array<{ lines: string[]; ok: boolean; ms: number }> = [];
    let reached = false;
    // onPerch: the dragon is sent to land (phase 2) as the crossing begins: from then until it flies again (landing approach, landing, the perch: some 45 s) it does not strafe
    if (onPerch) await ask(`${END} data modify entity ${DRAGON} DragonPhase set value 2`);
    for (let call = 0; call < 4 && !reached && actorDeaths === deathsBefore; call++) {
      // thinkMs: the head's turn (it reads the observation and answers; the probe, which answers at once, is harsher than the head: r25 re-issued the `go` 0.3 s after a reflex had stopped it, and walked back into the cloud)
      if (thinkMs > 0) await sleep(thinkMs);
      const going = act([{ do: 'go', to: target, canPlace: ['cobblestone'], maxPlace: 100, seconds: 120 }], 135);
      if (call === 0 && ballAfterMs !== null) {
        await sleep(ballAfterMs);
        const p = actor.entity.position; ballAt = [round(p.x, 1)!, round(p.y, 1)!, round(p.z, 1)!];
        await ask(`${END} summon minecraft:dragon_fireball ${p.x.toFixed(1)} ${(p.y + 6).toFixed(1)} ${p.z.toFixed(1)} {Motion:[0.0d,-1.0d,0.0d],acceleration_power:0.1d}`);
        log(`CROSS ball dropped on the body at ${JSON.stringify(ballAt)} (${Math.round((Date.now() - startedAt) / 1000)} s into the first go)`);
      }
      const run = await going;
      calls.push({ lines: run.lines.map(line => line.slice(0, 400)), ok: run.ok, ms: run.ms });
      log(`CROSS go #${call + 1}: ${run.ok} after ${Math.round(run.ms / 1000)} s: ${run.lines.join(' | ').slice(0, 700)}`);
      const p = actor.entity.position;
      reached = Math.hypot(p.x - (targetX + 0.5), p.z - 0.5) <= 2 && Math.abs(p.y - (targetTop + 1)) <= 2;
    }
    clearInterval(sample); clearInterval(watch);
    const at = actor.entity.position;
    const entries = (actor.reflexLedger?.entriesSince?.(ledgerMark) as Array<{ kind: string; outcome: string; detail: string }> | undefined) ?? [];
    return {
      ballAt, ledger: entries.slice(0, 14).map(e => `${e.kind}:${e.outcome}:${e.detail.slice(0, 160)}`),
      rimX, profile, target, reached, died: actorDeaths > deathsBefore, finalAt: [round(at.x, 1), round(at.y, 1), round(at.z, 1)], healthNow: Number(actor.health), lowestHealth: lowest.stop(),
      blocksBefore: before, blocksAfter: blocksLeft(), seconds: Math.round((Date.now() - startedAt) / 1000), calls, trail,
      ...(natural ? { natural: true, dragon: { phases: phases.slice(0, 30), strafes: phases.filter(entry => entry[1] === 1).length, charge: phases.some(entry => entry[1] === 8), nearestM: Number.isFinite(nearestDragon) ? round(nearestDragon, 1) : null, fireballsSeen: balls.size }, hits: hits.slice(0, 20), ...(hits.length ? { timelineHeader: ['t', 'x', 'y', 'z', 'vy', 'onGround', 'hp', 'actions', 'keys', 'cloudsNear', 'nearestCloud dx,dy,dz r', 'ball dx,dy,dz'], timeline } : {}) } : {}),
    };
  } finally {
    await ask(`${END} forceload remove 64 -16 111 16`);
  }
}
scenes.cross = () => crossRun(null);
scenes.cross_ball = () => crossRun(9000);
scenes.cross_think = async () => {
  // The crossing with the head's own pace: a turn of 6 s before the first `go` (the first answer after the arrival) and after every stop (the reflex stops it, the head reads the result and answers). Sixteen crossings, the dragon on its own cycle.
  const trials: Array<Record<string, unknown>> = [];
  for (let n = 0; n < 16; n++) { const trial = await crossRun(null, true, n === 0, false, 6000); log(`CROSS_THINK #${n + 1}: ${JSON.stringify({ ...trial, timeline: undefined, profile: undefined }).slice(0, 1500)}`); trials.push(trial); }
  const lows = trials.map(trial => Number(trial.lowestHealth ?? NaN));
  return { trials, summary: { n: trials.length, reached: trials.filter(trial => trial.reached === true).length, died: trials.filter(trial => trial.died === true).length, hurt: lows.filter(low => low < 19.9).length, lowest: Math.min(...lows), healthLostTotal: round(trials.reduce((sum, trial) => sum + (20 - Number(trial.lowestHealth ?? 20)), 0), 1) } };
};
scenes.cross_perch = async () => {
  // The same crossing, begun as the dragon is sent to land (the protocol for the head: cross while the dragon is landing or perched, when it does not strafe). Eight crossings.
  const trials: Array<Record<string, unknown>> = [];
  for (let n = 0; n < 8; n++) { const trial = await crossRun(null, true, true, true); log(`CROSS_PERCH #${n + 1}: ${JSON.stringify({ ...trial, timeline: undefined, profile: undefined }).slice(0, 1500)}`); trials.push(trial); }
  const lows = trials.map(trial => Number(trial.lowestHealth ?? NaN));
  return { trials, summary: { n: trials.length, reached: trials.filter(trial => trial.reached === true).length, died: trials.filter(trial => trial.died === true).length, hurt: lows.filter(low => low < 19.9).length, lowest: Math.min(...lows) } };
};
scenes.cross_natural = async () => {
  // The way off the arrival platform to the island with the dragon NOT kept away (round 7 of the sprint's questions: the crossing was only measured with the dragon parked high, and with a ball summoned on the body):
  // the same `go` with blocks to lay, the dragon flying its own pattern and strafing the body (it did, every 26 s, on the platform: PLATFORM_SOAK). Sixteen crossings, the bridge of the one before taken away and the dragon left to its own cycle after the first; what each cost in health and blocks,
  // whether it got over, fell, was hit. (r18, three crossings with the first one's bridge left standing: the first lost 15.3 of 20 at the front of its bridge and fell off it, the water bucket saved it; the other two walked the old bridge.)
  const trials: Array<Record<string, unknown>> = [];
  for (let n = 0; n < 16; n++) { const trial = await crossRun(null, true, n === 0); log(`CROSS_NATURAL #${n + 1}: ${JSON.stringify({ ...trial, timeline: undefined, profile: undefined }).slice(0, 1500)}`); trials.push(trial); }
  const lows = trials.map(trial => Number(trial.lowestHealth ?? NaN));
  return { trials, summary: { n: trials.length, reached: trials.filter(trial => trial.reached === true).length, died: trials.filter(trial => trial.died === true).length, hurt: lows.filter(low => low < 19.9).length, lowest: Math.min(...lows), healthLostTotal: round(trials.reduce((sum, trial) => sum + (20 - Number(trial.lowestHealth ?? 20)), 0), 1) } };
};

scenes.landing = async () => {
  // Where a body can wait while the dragon comes down to the perch. The dragon is put in the landing approach (phase 2) and flies down to the podium on its own (phase 3, about ten seconds, then it sits: 6, 7, 5);
  // the body stands still at a given place round the podium, the reflex on and nothing else acting, until the dragon sits. What it lost, when (and the dragon's phase then), the fastest it was pushed and how far it
  // was moved are read every 100 ms. Not a measure of the head's reach once it sits (that is the cycle scene).
  await protect(false);
  releaseReflex();
  await flatten(); await gear(['diamond_sword']); await wear();
  const trials: Array<Record<string, unknown>> = [];
  const places: Array<[string, number, number]> = [['5 m out on +z', 0.5, 5.5], ['8 m out on +z', 0.5, 8.5], ['12 m out on +z', 0.5, 12.5], ['7 m out on +x', 7.5, 0.5]];
  for (const [label, x, z] of places) {
    await restoreDragon(); await sleep(2500);
    await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`);
    await standAt(x, g, z); await sleep(800);
    const healthBefore = Number(actor.health), deathsBefore = actorDeaths, lowest = trackMinHealth();
    const hits: Array<[number, number, number | null]> = [], phases: Array<[number, number | null]> = [];
    let lastHealth = healthBefore, lastPhase: number | null = null, maxSpeed = 0, sat = false;
    const start = Date.now(), p0 = actor.entity.position.clone();
    await ask(`${END} data modify entity ${DRAGON} DragonPhase set value 2`);
    while (Date.now() - start < 45_000 && !sat && actorDeaths === deathsBefore) {
      const health = Number(actor.health), phase = phaseNow();
      if (health < lastHealth - 0.01) hits.push([Date.now() - start, round(lastHealth - health, 1)!, phase]);
      lastHealth = health;
      if (phase !== lastPhase) { phases.push([Date.now() - start, phase]); lastPhase = phase; }
      const v = actor.entity.velocity; maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.z));
      if (phase !== null && (phase === 5 || phase === 6 || phase === 7)) sat = true;
      await sleep(100);
    }
    const p1 = actor.entity.position;
    const result = {
      label, healthLost: round(healthBefore - Number(actor.health), 1), lowest: lowest.stop(), died: actorDeaths > deathsBefore, hits, phases, maxSpeed: round(maxSpeed, 2), movedBlocks: round(p1.distanceTo(p0), 1),
      seconds: round((Date.now() - start) / 1000, 1), sat,
    };
    log(`LANDING ${label}: ${JSON.stringify(result)}`);
    trials.push(result);
  }
  return { trials };
};

scenes.soak = async () => {
  // The body stands about on the island and does nothing (a planner is thinking), with the dragon awake at full health and the ten crystals up, flying its own pattern for a long while: what reaches the body, in which
  // phase and from how near the dragon was, how it was moved, and what the floor reflex made of it. Resistance off; diamond armour; the reflex on and nothing else acting.
  await protect(false);
  releaseReflex();
  await flatten(); await gear(['diamond_sword']); await wear();
  const topAt = (x: number, z: number): number | null => {
    for (let y = 110; y >= 20; y--) { const block = actor.blockAt(new Vec3(x, y, z), false); if (block && block.name === 'end_stone') return y; }
    return null;
  };
  const seconds = 150;
  const places: Array<[string, number, number]> = [['5 m from the podium (+z)', 0.5, 5.5], ['6 m from the foot of the pillar at x 42', 36.5, 0.5]];
  const trials: Array<Record<string, unknown>> = [];
  for (const [label, x, z] of places) {
    await restoreDragon(); await sleep(2500);
    await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`);
    const top = topAt(Math.floor(x), Math.floor(z));
    if (top === null) { trials.push({ label, error: 'no ground seen there' }); continue; }
    await standAt(x, top + 1, z); await sleep(1200);
    const healthBefore = Number(actor.health), deathsBefore = actorDeaths, lowest = trackMinHealth(), ledgerMark = (actor.reflexLedger?.mark?.() as number | undefined) ?? 0;
    const hits: Array<[number, number, number | null, number | null]> = [], phaseSeconds: Record<string, number> = {};
    const start = Date.now(), p0 = actor.entity.position.clone();
    let lastHealth = healthBefore, nearest = Infinity, maxSpeed = 0, lastTick = start;
    while (Date.now() - start < seconds * 1000 && actorDeaths === deathsBefore) {
      const now = Date.now(), health = Number(actor.health), dragon = dragonEntity(), phase = dragon ? dragonPhaseOf(actor, dragon) : null;
      const distance = dragon?.position ? actor.entity.position.distanceTo(dragon.position) : null;
      if (distance !== null) nearest = Math.min(nearest, distance);
      if (health < lastHealth - 0.01) hits.push([Math.round((now - start) / 100) / 10, round(lastHealth - health, 1)!, phase, distance === null ? null : round(distance, 1)]);
      lastHealth = health;
      const key = phase === null ? 'unseen' : String(phase);
      phaseSeconds[key] = round((phaseSeconds[key] ?? 0) + (now - lastTick) / 1000, 1)!;
      lastTick = now;
      const v = actor.entity.velocity; maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z));
      await sleep(100);
    }
    const entries = (actor.reflexLedger?.entriesSince?.(ledgerMark) as Array<{ kind: string; outcome: string; detail: string }> | undefined) ?? [];
    const kinds: Record<string, number> = {};
    for (const entry of entries) kinds[`${entry.kind}:${entry.outcome}`] = (kinds[`${entry.kind}:${entry.outcome}`] ?? 0) + 1;
    const result = {
      label, seconds: round((Date.now() - start) / 1000, 1), healthLost: round(healthBefore - Number(actor.health), 1), lowest: lowest.stop(), died: actorDeaths > deathsBefore, hits,
      nearestDragonM: Number.isFinite(nearest) ? round(nearest, 1) : null, maxSpeed: round(maxSpeed, 2), movedBlocks: round(actor.entity.position.distanceTo(p0), 1), phaseSeconds, reflex: kinds,
      lastEntries: entries.slice(-6).map(e => `${e.kind}:${e.outcome}:${e.detail.slice(0, 120)}`),
    };
    log(`SOAK ${label}: ${JSON.stringify(result)}`);
    trials.push(result);
  }
  return { trials };
};

scenes.platform_soak = async () => {
  // The task-less body on the End's arrival platform (the obsidian 5 x 5 at (100, 48, 0) in the void), for minutes, with the dragon awake at full health, flying its own pattern, the ten crystals up. What the
  // coordinator asked for (2026-11-02 23:50, run59's gate): the body carries blocks, the floor reflex is on, NOTHING is summoned (no fireball, no cloud: only what the dragon does by itself), iron armour (what
  // the run will wear: no diamond), no effect. It stands; nothing else acts. Measured: the health lost and when (with what was near: a cloud on the body, a fireball, the dragon), whether it fell, what the
  // reflex did (the rises, the blocks used), the dragon's phases and how near it came, and whether the charge (phase 8) showed.
  await protect(false);
  releaseReflex();
  // The platform's chunks stay loaded whoever stands where (a cloud left in an unloaded chunk is not found by `kill`).
  await ask(`${END} forceload add 64 -16 111 16`);
  const SECONDS = 180;
  const cases: Array<[string, string[]]> = [
    ['64 cobblestone and a water bucket', ['stone_sword', 'cobblestone 64', 'water_bucket']],
    ['12 cobblestone and a water bucket', ['stone_sword', 'cobblestone 12', 'water_bucket']],
    ['3 cobblestone and a water bucket', ['stone_sword', 'cobblestone 3', 'water_bucket']],
  ];
  const count = (name: string) => (actor.inventory.items() as Array<{ name: string; count: number }>).filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
  const trials: Array<Record<string, unknown>> = [];
  try {
    for (const [label, items] of cases) {
      // what an earlier trial left (a cloud or a ball the dragon made), the platform as the game makes it, the dragon as it is at the start (flying its pattern, full health)
      await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`); await ask(`${END} kill @e[type=minecraft:dragon_fireball]`);
      await ask(`${END} fill 98 48 -2 102 48 2 obsidian`); await ask(`${END} fill 98 49 -2 102 53 2 air`);
      await restoreDragon();
      await gear(items); await wearIron();
      await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`);
      for (let attempt = 0; attempt < 6; attempt++) {
        await ask(`${END} tp ${ACTOR} 100.5 49 0.5`); await sleep(1200);
        if (actor.entity.onGround && Math.abs(actor.entity.position.y - 49) < 0.2 && Math.hypot(actor.entity.position.x - 100.5, actor.entity.position.z - 0.5) < 0.6 && Number(actor.health) >= 19.9) break;
      }
      await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`); await ask(`${END} kill @e[type=minecraft:dragon_fireball]`); await sleep(300);
      const healthBefore = Number(actor.health), deathsBefore = actorDeaths, lowest = trackMinHealth(), ledgerMark = (actor.reflexLedger?.mark?.() as number | undefined) ?? 0;
      const blocksBefore = count('cobblestone'), p0 = actor.entity.position.clone();
      const phases: Array<[number, number | null]> = [], hits: Array<Record<string, unknown>> = [], balls = new Set<number>();
      let lastPhase: number | null | undefined, lastHealth = healthBefore, nearest = Infinity, nearestInCharge = Infinity, minY = p0.y, maxY = p0.y, maxBalls = 0, maxClouds = 0, diedAfterS: number | null = null;
      const startedAt = Date.now();
      while (Date.now() - startedAt < SECONDS * 1000) {
        const now = Date.now(), at = round((now - startedAt) / 1000, 1)!, position = actor.entity.position, health = Number(actor.health);
        if (actorDeaths > deathsBefore) { diedAfterS = at; break; }
        const dragon = dragonEntity(), phase = dragon ? dragonPhaseOf(actor, dragon) : null;
        if (phase !== lastPhase) { phases.push([at, phase]); lastPhase = phase; }
        const dragonDistance = dragon?.position ? position.distanceTo(dragon.position) : null;
        if (dragonDistance !== null) { nearest = Math.min(nearest, dragonDistance); if (phase === 8) nearestInCharge = Math.min(nearestInCharge, dragonDistance); }
        const entities = Object.values(actor.entities) as any[];
        const fireballs = entities.filter(e => e?.name === 'dragon_fireball' && e.position);
        for (const ball of fireballs) balls.add(ball.id);
        const clouds = entities.filter(e => e?.name === 'area_effect_cloud' && e.position && position.distanceTo(e.position) < 14);
        maxBalls = Math.max(maxBalls, fireballs.length); maxClouds = Math.max(maxClouds, clouds.length);
        minY = Math.min(minY, position.y); maxY = Math.max(maxY, position.y);
        if (health < lastHealth - 0.01) {
          const inCloud = clouds.some(cloud => Math.hypot(cloud.position.x - position.x, cloud.position.z - position.z) < (Number(cloud.metadata?.[8]) || 3) + 0.3 && Math.abs(cloud.position.y - position.y) < 1.5);
          const ballM = fireballs.length ? Math.min(...fireballs.map(ball => position.distanceTo(ball.position))) : null;
          hits.push({ at, lost: round(lastHealth - health, 1), phase, dragonM: dragonDistance === null ? null : round(dragonDistance, 1), inCloud, ballM: ballM === null ? null : round(ballM, 1), y: round(position.y, 1) });
        }
        lastHealth = health;
        await sleep(100);
      }
      const entries = (actor.reflexLedger?.entriesSince?.(ledgerMark) as Array<{ kind: string; outcome: string; detail: string }> | undefined) ?? [];
      const kinds: Record<string, number> = {};
      for (const entry of entries) kinds[`${entry.kind}:${entry.outcome}`] = (kinds[`${entry.kind}:${entry.outcome}`] ?? 0) + 1;
      const died = actorDeaths > deathsBefore;
      const result = {
        label, items, seconds: round((Date.now() - startedAt) / 1000, 1), healthLost: round(healthBefore - Number(actor.health), 1), lowest: lowest.stop(), died, diedAfterS,
        fell: minY < 47, feetY: [round(minY, 1), round(maxY, 1)], movedBlocks: round(actor.entity.position.distanceTo(p0), 1), blocksUsed: blocksBefore - (died ? 0 : count('cobblestone')),
        strafes: phases.filter(entry => entry[1] === 1).length, charge: phases.some(entry => entry[1] === 8), nearestInChargeM: Number.isFinite(nearestInCharge) ? round(nearestInCharge, 1) : null,
        nearestDragonM: Number.isFinite(nearest) ? round(nearest, 1) : null, fireballsSeen: balls.size, maxFireballsAtOnce: maxBalls, maxCloudsNear: maxClouds,
        phases: phases.slice(0, 40), hits: hits.slice(0, 30), reflex: kinds, ledger: entries.slice(0, 14).map(e => `${e.kind}:${e.outcome}:${e.detail.slice(0, 120)}`),
      };
      log(`PLATFORM_SOAK ${label}: ${JSON.stringify(result)}`);
      trials.push(result);
    }
  } finally {
    await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`); await ask(`${END} kill @e[type=minecraft:dragon_fireball]`);
    await ask(`${END} forceload remove 64 -16 111 16`);
  }
  return { trials };
};

scenes.charge_nbt = async () => {
  // Can the charge (phase 8) be asked for from outside, and what does a body take when it comes? Asked by the coordinator ("if possible, take one charge"): the natural dragon did not charge in 540 s on the platform
  // (PLATFORM_SOAK) nor in the island soaks, and the game's own code is not at hand (the lab's jar is obfuscated), so this asks the game: the dragon put 36 m from the body, level and facing it, and `DragonPhase` set to 8 by
  // NBT. Read every 100 ms for 12 s: the phase (does it stay 8, or fall back at once), where the dragon goes, how near it comes, the health the body loses and how it is moved. Three tries, the body on the island floor
  // (a push off the platform is the other question: the void), iron armour, the reflex on, nothing else acting.
  await protect(false);
  releaseReflex();
  await flatten(); await gear(['stone_sword', 'cobblestone 64']); await wearIron();
  const trials: Array<Record<string, unknown>> = [];
  for (let n = 0; n < 3; n++) {
    await restoreDragon(); await sleep(1500);
    await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`);
    await standAt(0.5, g, 14.5); await sleep(800);
    const healthBefore = Number(actor.health), deathsBefore = actorDeaths, ledgerMark = (actor.reflexLedger?.mark?.() as number | undefined) ?? 0, lowest = trackMinHealth();
    await ask(`${END} tp ${DRAGON} 0.5 ${g + 6} 50.5 180 0`);
    await ask(`${END} data modify entity ${DRAGON} DragonPhase set value 8`);
    const startedAt = Date.now(), p0 = actor.entity.position.clone();
    const phases: Array<[number, number | null]> = [], track: Array<[number, number, number, number, number | null]> = [], hits: Array<Record<string, unknown>> = [];
    let lastPhase: number | null | undefined, nearest = Infinity, maxSpeed = 0, lastHealth = healthBefore;
    while (Date.now() - startedAt < 12_000 && actorDeaths === deathsBefore) {
      const at = round((Date.now() - startedAt) / 1000, 1)!, dragon = dragonEntity(), phase = dragon ? dragonPhaseOf(actor, dragon) : null, position = actor.entity.position, health = Number(actor.health);
      if (phase !== lastPhase) { phases.push([at, phase]); lastPhase = phase; }
      const distance = dragon?.position ? position.distanceTo(dragon.position) : null;
      if (distance !== null) nearest = Math.min(nearest, distance);
      if (track.length < 130 && Math.round(at * 10) % 5 === 0) track.push([at, round(dragon?.position?.x ?? NaN, 1)!, round(dragon?.position?.y ?? NaN, 1)!, round(dragon?.position?.z ?? NaN, 1)!, distance === null ? null : round(distance, 1)]);
      if (health < lastHealth - 0.01) hits.push({ at, lost: round(lastHealth - health, 1), phase, dragonM: distance === null ? null : round(distance, 1) });
      lastHealth = health;
      const v = actor.entity.velocity; maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z));
      await sleep(100);
    }
    const entries = (actor.reflexLedger?.entriesSince?.(ledgerMark) as Array<{ kind: string; outcome: string; detail: string }> | undefined) ?? [];
    const result = {
      try: n + 1, healthLost: round(healthBefore - Number(actor.health), 1), lowest: lowest.stop(), died: actorDeaths > deathsBefore, hits, phases, charge: phases.some(entry => entry[1] === 8), stayedInChargeS: (() => { const first = phases.find(entry => entry[1] === 8); if (!first) return 0; const next = phases.find(entry => entry[0] > first[0] && entry[1] !== 8); return round((next ? next[0] : 12) - first[0], 1); })(),
      nearestDragonM: Number.isFinite(nearest) ? round(nearest, 1) : null, maxSpeed: round(maxSpeed, 2), movedBlocks: round(actor.entity.position.distanceTo(p0), 1), track: track.slice(0, 40), ledger: entries.slice(0, 8).map(e => `${e.kind}:${e.outcome}:${e.detail.slice(0, 110)}`),
    };
    log(`CHARGE_NBT #${n + 1}: ${JSON.stringify(result)}`);
    trials.push(result);
  }
  await restoreDragon();
  return { trials };
};

scenes.crystals_bow = async () => {
  // Every crystal that is not caged, shot one after the other from one place on the island's flat ground (15 m from the podium, where every pillar is 30 to 55 m off), the dragon awake and flying its own pattern, the
  // reflex on, iron armour: how long each takes (the body's side only: the draw, the flight, the answer; the head's own thinking between two acts is not here), whether the arrow's way was free, what the body lost.
  // Asked for the survival-first review (2026-11-03): the crystals take a part of the 15 to 20 minutes of the fight, and the body stands in the open while it shoots.
  await protect(false);
  releaseReflex();
  await flatten(); await gear(['stone_sword', 'bow', 'arrow 64', 'cobblestone 64']); await wearIron();
  await restoreDragon(); await sleep(1500);
  await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`);
  await standAt(0.5, g, 15.5); await sleep(2500);
  const here = () => actor.entity.position;
  const view0 = endView();
  const crystals0 = loadedCrystals(view0).map(c => ({ ...c, distance: round(Math.hypot(here().x - c.x, here().y - c.y, here().z - c.z), 1)! }));
  log(`CRYSTALS_BOW in sight: ${JSON.stringify(crystals0)} remaining ${view0?.crystals?.remaining}`);
  const healthBefore = Number(actor.health), deathsBefore = actorDeaths, lowest = trackMinHealth(), ledgerMark = (actor.reflexLedger?.mark?.() as number | undefined) ?? 0;
  const startedAt = Date.now();
  const shots: Array<Record<string, unknown>> = [];
  const open = crystals0.filter(c => c.caged === false).sort((a, b) => a.distance - b.distance);
  for (const crystal of open) {
    if (actorDeaths > deathsBefore) break;
    const t0 = Date.now(), remainingBefore = endView()?.crystals?.remaining ?? null;
    const run = await act([{ do: 'shoot', target: `#${crystal.id}` }], 25);
    shots.push({ id: crystal.id, distance: crystal.distance, ms: Date.now() - t0, ok: run.ok, line: (run.lines[0] ?? '').slice(0, 220), remainingBefore, remainingAfter: endView()?.crystals?.remaining ?? null, health: round(Number(actor.health), 1), at: [round(here().x, 1), round(here().z, 1)] });
  }
  const view1 = endView();
  const entries = (actor.reflexLedger?.entriesSince?.(ledgerMark) as Array<{ kind: string; outcome: string; detail: string }> | undefined) ?? [];
  const result = {
    seconds: round((Date.now() - startedAt) / 1000, 1), crystalsSeen: crystals0.length, caged: crystals0.filter(c => c.caged === true).length, unknownCage: crystals0.filter(c => c.caged === null).length,
    shotsTried: shots.length, broken: shots.filter(shot => shot.remainingAfter !== null && shot.remainingBefore !== null && (shot.remainingAfter as number) < (shot.remainingBefore as number)).length,
    remainingNow: view1?.crystals?.remaining ?? null, healthLost: round(healthBefore - Number(actor.health), 1), lowest: lowest.stop(), died: actorDeaths > deathsBefore, shots,
    ledger: entries.slice(0, 12).map(e => `${e.kind}:${e.outcome}:${e.detail.slice(0, 110)}`),
  };
  log(`CRYSTALS_BOW result: ${JSON.stringify(result).slice(0, 3000)}`);
  return result;
};

scenes.tower = async () => {
  // A body on top of a one-block obsidian column 30 blocks up (the way a caged crystal is reached), the dragon awake at full health and the ten crystals up, for a long while: does the dragon come near enough to push
  // or hurt it, and does it fall. The body does nothing (a planner is busy); the reflex is on.
  await protect(false);
  releaseReflex();
  await flatten(); await wear();
  const topAt = (x: number, z: number): number | null => {
    for (let y = 110; y >= 20; y--) { const block = actor.blockAt(new Vec3(x, y, z), false); if (block && block.name === 'end_stone') return y; }
    return null;
  };
  const seconds = 150, height = 30;
  // what a head that climbed carries: the blocks it climbed with (some left) and the bucket; and, for the first, what it would have with nothing (the body of w19 died of the third cloud in a row)
  const kit = ['diamond_sword', 'cobblestone 12', 'water_bucket'];
  const places: Array<[string, number, number, string[]]> = [
    ['a column 30 up at x 30 (12 m from the pillar at x 42), with 12 blocks and a bucket', 30, 0, kit],
    ['a column 30 up at x 12 (by the middle), with 12 blocks and a bucket', 12, 12, kit],
  ];
  const trials: Array<Record<string, unknown>> = [];
  for (const [label, x, z, items] of places) {
    // (a body that died is back in the overworld: it is put in the End first, where the ground can be read)
    await gear(items); await wear(); actor.setQuickBarSlot(0);
    await standAt(0.5, g, 8.5); await sleep(1500);
    await restoreDragon(); await sleep(2500);
    const top = topAt(x, z);
    if (top === null) { trials.push({ label, error: 'no ground seen there' }); continue; }
    await ask(`${END} fill ${x} ${top + 1} ${z} ${x} ${top + height} ${z} obsidian`);
    await ask(`${END} fill ${x - 1} ${top + height + 1} ${z - 1} ${x + 1} ${top + height + 4} ${z + 1} air`);
    await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`);
    await standAt(x + 0.5, top + height + 1, z + 0.5); await sleep(1500);
    const healthBefore = Number(actor.health), deathsBefore = actorDeaths, lowest = trackMinHealth(), ledgerMark = (actor.reflexLedger?.mark?.() as number | undefined) ?? 0;
    const hits: Array<[number, number, number | null, number | null]> = [];
    const start = Date.now();
    let lastHealth = healthBefore, nearest = Infinity, fellAt: number | null = null, minY = actor.entity.position.y, maxSpeed = 0;
    while (Date.now() - start < seconds * 1000 && actorDeaths === deathsBefore && fellAt === null) {
      const now = Date.now(), health = Number(actor.health), dragon = dragonEntity(), phase = dragon ? dragonPhaseOf(actor, dragon) : null;
      const distance = dragon?.position ? actor.entity.position.distanceTo(dragon.position) : null;
      if (distance !== null) nearest = Math.min(nearest, distance);
      if (health < lastHealth - 0.01) hits.push([Math.round((now - start) / 100) / 10, round(lastHealth - health, 1)!, phase, distance === null ? null : round(distance, 1)]);
      lastHealth = health;
      minY = Math.min(minY, actor.entity.position.y);
      if (actor.entity.position.y < top + height - 3) fellAt = Math.round((now - start) / 100) / 10;
      const v = actor.entity.velocity; maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z));
      await sleep(50);
    }
    await sleep(3000); // the fall ends
    const entries = (actor.reflexLedger?.entriesSince?.(ledgerMark) as Array<{ kind: string; outcome: string; detail: string }> | undefined) ?? [];
    const result = {
      label, seconds: round((Date.now() - start) / 1000, 1), fellAfterS: fellAt, healthLost: round(healthBefore - Number(actor.health), 1), lowest: lowest.stop(), died: actorDeaths > deathsBefore, hits,
      nearestDragonM: Number.isFinite(nearest) ? round(nearest, 1) : null, lowestY: round(minY, 1), maxSpeed: round(maxSpeed, 2), ledger: entries.slice(0, 8).map(e => `${e.kind}:${e.outcome}:${e.detail.slice(0, 120)}`),
    };
    log(`TOWER ${label}: ${JSON.stringify(result)}`);
    trials.push(result);
    await ask(`${END} fill ${x} ${top + 1} ${z} ${x} ${top + height} ${z} air`);
  }
  return { trials };
};

scenes.fall = async () => {
  // A fall in the End from the height of a pillar, over the island's flat ground: with a bucket of water carried (the clutch of utils/fallClutch) and without (what the fall costs). The body is put at the
  // height in the air and let go; the dragon is parked high over the island. Armour on (it takes no part of a fall).
  await protect(false);
  releaseReflex();
  await park(true);
  const trials: Array<Record<string, unknown>> = [];
  // `give` fills the hotbar first: the sword is slot 0 (in the hand), the bucket slot 1 or 2. `pack` is put into the first slot of the pack (`inventory.0`: the player's slot 9; `container.0` would be the hotbar's first slot, and
  // r13 put the bucket there, into the hand) after: a bucket there does not start the clutch (it would have to be moved to the hand by clicks of the window, which a stronger reflex cannot stop), so that trial is the control of what the same fall costs.
  const cases: Array<[string, number, string[], string[]]> = [
    ['no bucket, 20 up', 20, ['diamond_sword'], []],
    ['bucket, 12 up', 12, ['diamond_sword', 'water_bucket'], []],
    ['bucket, 20 up', 20, ['diamond_sword', 'water_bucket'], []],
    ['bucket, 38 up', 38, ['diamond_sword', 'water_bucket'], []],
    ['bucket in the hotbar (not the hand), 38 up', 38, ['diamond_sword', 'cobblestone 64', 'water_bucket'], []],
    ['bucket in the pack (not the hotbar), 20 up', 20, ['diamond_sword'], ['water_bucket']],
  ];
  for (const [label, height, items, pack] of cases) {
    await flatten(); await ask('kill @e[type=minecraft:item]');
    await gear(items);
    for (const [slot, item] of pack.entries()) await ask(`item replace entity ${ACTOR} inventory.${slot} with minecraft:${item}`);
    await wear();
    // the first hotbar slot is the sword's: a `hold` replaces the selected slot, and the last trial left it on the bucket's
    actor.setQuickBarSlot(0); await sleep(300);
    await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`);
    await standAt(0.5, g, 8.5); await sleep(1000);
    const healthBefore = Number(actor.health), deathsBefore = actorDeaths, lowest = trackMinHealth(), ledgerMark = (actor.reflexLedger?.mark?.() as number | undefined) ?? 0;
    const start = Date.now();
    let minVy = 0, landedAfterMs: number | null = null;
    const poll = every(25, () => { minVy = Math.min(minVy, actor.entity.velocity?.y ?? 0); });
    await ask(`${END} tp ${ACTOR} 0.5 ${g + height} 8.5`);
    for (let i = 0; i < 160 && landedAfterMs === null; i++) { await sleep(50); if (Date.now() - start > 600 && actor.entity.onGround && actor.entity.position.y < g + 2) landedAfterMs = Date.now() - start; }
    await sleep(2500);
    clearInterval(poll);
    const entries = (actor.reflexLedger?.entriesSince?.(ledgerMark) as Array<{ kind: string; outcome: string; detail: string }> | undefined) ?? [];
    const holding = actor.heldItem?.name ?? null;
    const result = {
      label, height, healthBefore, healthAfter: Number(actor.health), healthLost: round(healthBefore - Number(actor.health), 1), lowest: lowest.stop(), died: actorDeaths > deathsBefore, landedAfterMs, fastestVy: round(minVy, 2),
      holding, bucketsNow: (actor.inventory.items() as Array<{ name: string }>).filter(item => item.name.endsWith('bucket')).map(item => item.name), ledger: entries.slice(0, 5).map(e => `${e.kind}:${e.outcome}:${e.detail.slice(0, 130)}`),
    };
    log(`FALL ${label}: ${JSON.stringify(result)}`);
    trials.push(result);
    await sleep(500);
  }
  await flatten(); await ask('kill @e[type=minecraft:item]');
  return { trials };
};

scenes.fall_cut = async () => {
  // The clutch cut off after the pour (independent review 2026-11-02, round 6): a stronger reflex takes the body in the tick the held bucket turns empty (here the lab does it: `preemptLowerPriorityActions` at the
  // wall escape's rank). The water is poured and not taken up; the floor takes it up later, in a quiet moment, so that the next fall has its bucket. Measured: the health lost, whether the clutch ledger says it was cut,
  // how long after the landing the bucket is full again, whether the source of water is gone, whether the cell the floor noted was the water's (the drops are off the middle of their cell, one across a block
  // boundary at a negative coordinate: the note names the cell the pour was made over), and what the hand holds in the end (round 8: the hand goes back to the sword).
  await protect(false);
  releaseReflex();
  await park(true);
  const trials: Array<Record<string, unknown>> = [];
  const cases: Array<[string, number, string[], number, number]> = [
    ['bucket in the hand, 38 up, cut after the pour', 38, ['diamond_sword', 'water_bucket'], 0.97, 8.03],
    ['bucket in the hotbar (not the hand), 20 up, cut after the pour', 20, ['diamond_sword', 'cobblestone 64', 'water_bucket'], -0.04, 7.96],
  ];
  for (const [label, height, items, dropX, dropZ] of cases) {
    await flatten(); await ask('kill @e[type=minecraft:item]');
    await ask(`${END} fill -3 ${g} 5 3 ${g + 2} 11 air replace minecraft:water`);
    await gear(items); await wear();
    actor.setQuickBarSlot(0); await sleep(300);
    await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`);
    await standAt(0.5, g, 8.5); await sleep(1000);
    const healthBefore = Number(actor.health), deathsBefore = actorDeaths, lowest = trackMinHealth(), ledgerMark = (actor.reflexLedger?.mark?.() as number | undefined) ?? 0;
    const start = Date.now();
    let cutAfterMs: number | null = null, landedAfterMs: number | null = null, refilledAfterLandingMs: number | null = null, noteCell: string | null = null, noteCellWasWater = false;
    const watch = every(5, () => {
      if (cutAfterMs === null && actor.heldItem?.name === 'bucket') { cutAfterMs = Date.now() - start; preemptLowerPriorityActions(actor, 500, 'lab-cut'); }
      const note = actor.floorReflexes?.fall?.scoop as { x: number; y: number; z: number } | undefined;
      if (note) { noteCell ??= `${note.x},${note.y},${note.z}`; if (actor.blockAt(new Vec3(note.x, note.y, note.z))?.name === 'water') noteCellWasWater = true; }
      if (landedAfterMs === null && Date.now() - start > 600 && actor.entity.onGround && actor.entity.position.y < g + 2) landedAfterMs = Date.now() - start;
      if (landedAfterMs !== null && refilledAfterLandingMs === null && (actor.inventory.items() as Array<{ name: string }>).some(item => item.name === 'water_bucket')) refilledAfterLandingMs = Date.now() - start - landedAfterMs;
    });
    await ask(`${END} tp ${ACTOR} ${dropX} ${g + height} ${dropZ}`);
    for (let i = 0; i < 200 && refilledAfterLandingMs === null; i++) await sleep(100);
    await sleep(1000);
    clearInterval(watch);
    const entries = (actor.reflexLedger?.entriesSince?.(ledgerMark) as Array<{ kind: string; outcome: string; detail: string }> | undefined) ?? [];
    const remaining = await ask(`${END} execute if block ${Math.floor(dropX)} ${g} ${Math.floor(dropZ)} minecraft:water run say SOURCE_STILL_THERE`);
    const result = {
      label, height, healthBefore, healthAfter: Number(actor.health), healthLost: round(healthBefore - Number(actor.health), 1), lowest: lowest.stop(), died: actorDeaths > deathsBefore, cutAfterMs, landedAfterMs, refilledAfterLandingMs,
      drop: [dropX, dropZ], expectedCell: `${Math.floor(dropX)},${g},${Math.floor(dropZ)}`, noteCell, noteCellWasWater,
      holding: actor.heldItem?.name ?? null, bucketsNow: (actor.inventory.items() as Array<{ name: string }>).filter(item => item.name.endsWith('bucket')).map(item => item.name),
      sourceStillThere: remaining.includes('SOURCE_STILL_THERE'), ledger: entries.slice(0, 5).map(e => `${e.kind}:${e.outcome}:${e.detail.slice(0, 130)}`),
    };
    log(`FALL_CUT ${label}: ${JSON.stringify(result)}`);
    trials.push(result);
    await sleep(500);
  }
  await flatten(); await ask('kill @e[type=minecraft:item]');
  await ask(`${END} fill -3 ${g} 5 3 ${g + 2} 11 air replace minecraft:water`);
  return { trials };
};

scenes.tower_ball = async () => {
  // The top of a one-block column 30 up is a place with no way to walk out of a cloud: the body that climbed it with blocks carried rises above the cloud of a fireball that falls on it, as on the arrival platform,
  // and again for the next ball (the cloud laid at the new height). Three balls 3 s apart; the dragon parked high over the island. With the bucket carried (a fall off the top would be stopped).
  await protect(false);
  releaseReflex();
  await park(true);
  await flatten(); await wear();
  const topAt = (x: number, z: number): number | null => {
    for (let y = 110; y >= 20; y--) { const block = actor.blockAt(new Vec3(x, y, z), false); if (block && block.name === 'end_stone') return y; }
    return null;
  };
  const height = 30, x = 30, z = 0;
  const kit = ['diamond_sword', 'cobblestone 12', 'water_bucket'];
  await gear(kit); await wear(); actor.setQuickBarSlot(0);
  await standAt(0.5, g, 8.5); await sleep(1500);
  const top = topAt(x, z);
  if (top === null) return { error: 'no ground seen at the column' };
  await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`); await ask(`${END} kill @e[type=minecraft:dragon_fireball]`);
  await ask(`${END} fill ${x} ${top + 1} ${z} ${x} ${top + height} ${z} obsidian`);
  await ask(`${END} fill ${x - 2} ${top + height + 1} ${z - 2} ${x + 2} ${top + height + 8} ${z + 2} air`);
  await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`);
  await standAt(x + 0.5, top + height + 1, z + 0.5); await sleep(1500);
  const healthBefore = Number(actor.health), deathsBefore = actorDeaths, lowest = trackMinHealth(), ledgerMark = (actor.reflexLedger?.mark?.() as number | undefined) ?? 0;
  const y0 = actor.entity.position.y, start = Date.now();
  const risen: Array<[number, number]> = [];
  const poll = every(50, () => { const y = actor.entity.position.y; if (risen.length === 0 ? y - y0 >= 0.9 : y - risen[risen.length - 1][1] >= 0.9) risen.push([Date.now() - start, round(y, 2)!]); });
  for (let n = 0; n < 3; n++) {
    const at = actor.entity.position;
    await ask(`${END} summon minecraft:dragon_fireball ${at.x.toFixed(2)} ${(at.y + 6).toFixed(2)} ${at.z.toFixed(2)} {Motion:[0.0d,-1.0d,0.0d],acceleration_power:0.1d}`);
    await sleep(3000);
  }
  await sleep(3000);
  clearInterval(poll);
  const entries = (actor.reflexLedger?.entriesSince?.(ledgerMark) as Array<{ kind: string; outcome: string; detail: string }> | undefined) ?? [];
  const result = {
    topY: top + height, startFeetY: y0, endFeetY: round(actor.entity.position.y, 2), healthLost: round(healthBefore - Number(actor.health), 1), lowest: lowest.stop(), died: actorDeaths > deathsBefore,
    risenAtMsAndY: risen, blocksLeft: (actor.inventory.items() as Array<{ name: string; count: number }>).filter(item => item.name === 'cobblestone').reduce((sum, item) => sum + item.count, 0),
    ledger: entries.filter(e => e.kind === 'retreat').map(e => `${e.kind}:${e.outcome}:${e.detail.slice(0, 110)}`),
  };
  log(`TOWER_BALL ${JSON.stringify(result)}`);
  await ask(`${END} fill ${x} ${top + 1} ${z} ${x} ${top + height + 8} ${z} air`);
  return result;
};

scenes.knockback = async () => {
  // Does sneaking keep a body on the arrival platform when it is pushed? A cloud's harm pushes the body away from the cloud (the damage has a direct entity); here a zombie kept in the platform's
  // middle (no AI, invulnerable) is named as the attacker of a harmless `damage`, so the push is the same and nothing else acts. The body stands 1.5 blocks from the edge; pushes 0.7 s apart.
  await protect(false);
  releaseReflex();
  await park(true);
  await ask(`${END} forceload add 64 -16 111 16`); await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`); await ask(`${END} kill @e[type=minecraft:dragon_fireball]`);
  const trial = async (sneak: boolean) => {
    await ask(`${END} kill @e[type=minecraft:zombie]`);
    await ask(`${END} fill 98 48 -2 102 48 2 obsidian`); await ask(`${END} fill 98 49 -2 102 53 2 air`);
    await ask(`${END} summon minecraft:zombie 100.5 49 -1.5 {NoAI:1b,Silent:1b,Invulnerable:1b,PersistenceRequired:1b}`);
    await gear(['diamond_sword']); await wear();
    await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`);
    for (let attempt = 0; attempt < 5; attempt++) {
      await ask(`${END} tp ${ACTOR} 100.5 49 1.5`); await sleep(1000);
      if (actor.entity.onGround && Math.abs(actor.entity.position.y - 49) < 0.2) break;
    }
    if (sneak) actor.setControlState('sneak', true);
    const zs: number[] = []; let pushes = 0, fellAtPush: number | null = null;
    for (; pushes < 8 && fellAtPush === null; pushes++) {
      await ask(`${END} damage ${ACTOR} 0.01 minecraft:mob_attack by @e[type=minecraft:zombie,limit=1]`);
      await sleep(700);
      zs.push(round(actor.entity.position.z, 2)!);
      if (actor.entity.position.y < 48) fellAtPush = pushes + 1;
    }
    actor.setControlState('sneak', false);
    await ask(`${END} kill @e[type=minecraft:zombie]`);
    const result = { sneak, pushes: pushes, fellAtPush, zAfterEachPush: zs, deaths: actorDeaths };
    log(`KNOCKBACK ${JSON.stringify(result)}`);
    return result;
  };
  try {
    const runs = [await trial(false), await trial(true), await trial(false), await trial(true)];
    return { runs };
  } finally {
    await ask(`${END} kill @e[type=minecraft:zombie]`); await ask(`${END} forceload remove 64 -16 111 16`);
  }
};

/** Isolated section, with the actor saved on the island ground before login. No teleport, terrain edits,
 * parked dragon, healing between pillars, water bucket or replacement inventory. The script chooses two pillars;
 * production go/vertical/dig and the unchanged floor reflex own every physical step. */
/** Set by cage_section_walk: the body came to the island by its own walk from the game's arrival (no teleport after the arrival), not from saved player data. */
let cageWalkStart = false;
/** Set by cage_guard_walk: a ring of blocks is laid round the top of the tower (the side toward the bars left open to dig, closed after) so that a push of the dragon cannot carry the body off the one-wide tower. */
let cageGuard = false;
scenes.cage_section = async () => {
  if (!cageWalkStart && (wanted.length !== 1 || wanted[0] !== 'cage_section')) throw new Error('cage_section must run alone, from saved island-ground playerdata');
  if (String(actor.game?.dimension).replace(/^minecraft:/u, '') !== 'the_end' || !actor.entity?.onGround) throw new Error('cage_section requires an actor already standing on the End island; no tp bootstrap');
  const start = actor.entity.position.clone(), read = bodyReader(actor);
  if (!standing(read, { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) }) ||
    read(Math.floor(start.x), Math.floor(start.y) - 1, Math.floor(start.z))?.name !== 'end_stone') throw new Error('cage_section start must be natural island ground');
  const sceneDeaths = actorDeaths;
  releaseReflex();
  if (!dragonEntity() || [9, 10].includes(phaseNow() ?? -1)) throw new Error('cage_section requires the awake dragon');
  await ask(`gamemode survival ${ACTOR}`); await ask('difficulty normal'); await protect(false);
  await gear(['stone_sword', 'iron_pickaxe', 'cobblestone 64', 'bow', 'arrow 32']); await wearIron();
  if (actorDeaths !== sceneDeaths || Number(actor.health) <= 0) throw new Error('cage_section actor died during setup');
  const inventory = () => (actor.inventory.items() as Array<{ name: string; count: number }>);
  if (inventory().some(i => /bucket/u.test(i.name))) throw new Error('cage_section refuses every bucket');
  const chosen = loadedCrystals(endView()).filter(c => c.caged === true).sort((a, b) =>
    Math.hypot(a.x - start.x, a.z - start.z) - Math.hypot(b.x - start.x, b.z - start.z)).slice(0, 2);
  if (chosen.length !== 2) throw new Error('two natural caged crystals must already be loaded; no fabricated cages');
  const sections: Array<Record<string, unknown>> = [];
  for (const crystal of chosen) {
    const started = Date.now(), healthBefore = Number(actor.health), deathsBefore = actorDeaths;
    const mark = actor.reflexLedger?.mark?.() ?? 0, lowest = trackMinHealth();
    const blocksBefore = inventory().filter(i => i.name === 'cobblestone').reduce((n, i) => n + i.count, 0);
    let placed = 0, damageTaken = 0, previousHealth = healthBefore;
    const onHealth = () => { const h = Number(actor.health); damageTaken += Math.max(0, previousHealth - h); previousHealth = h; };
    const onBlock = (old: any, next: any) => { if (next?.name === 'cobblestone' && old?.name !== 'cobblestone') placed++; };
    actor.on('health', onHealth); actor.on('blockUpdate', onBlock);
    const section: Record<string, unknown> = { crystalId: crystal.id, crystal: { x: crystal.x, y: crystal.y, z: crystal.z }, stages: [] };
    const stages = section.stages as Array<Record<string, unknown>>;
    let success = false;
    const perform = async (stage: string, hand: Record<string, unknown>, seconds: number) => {
      // The stand-in planner reads the result like the head: a hand cut by a reflex or by a hit (the dragon's breath or ball), or a walk to the root whose search ran out (the lab's CPU is shared), is asked again while the health is above 8, at most twice; any other stop ends the section (no automatic retry of the body's own).
      let result = await act([hand], seconds), retries = 0;
      const again = (text: string) => /反射|被弾/u.test(text) || (stage === 'go_root' && /search_timeout|dead_end/u.test(text));
      while (!result.ok && retries < 2 && again(result.lines.join(' ')) && actorDeaths === deathsBefore && Number(actor.health) > 8) { retries++; await sleep(1500); result = await act([hand], seconds); }
      stages.push({ stage, ...result, retries });
      if (actorDeaths !== deathsBefore || Number(actor.health) <= 0) throw new Error(`${stage}: actor died`);
      if (!result.ok) throw new Error(`${stage}: stopped after ${retries} retries`);
    };
    try {
      const root = cageRoots(actor, crystal)[0];
      if (!root) throw new Error('no walkable root with a clear pillar column');
      section.root = root;
      await perform('go_root', { do: 'go', to: root, range: 0, maxDig: 0, maxPlace: 0, maxDrop: 1, seconds: 60 }, 65);
      await perform('pillar_up', { do: 'vertical', dir: 'up', shape: 'pillar', toY: Math.floor(crystal.y), canDig: ['none'], canPlace: ['cobblestone'], maxPlace: 64, maxDig: 0, liquid: 'stop', seconds: 60 }, 65);
      // Open one vertical column in the near wall. The crystal is left intact; this section measures cage access and return.
      const wall = cageWall(actor, crystal);
      if (!wall.length) throw new Error('no reachable cage bars; inspect displaced body');
      section.bars = wall;
      let closeCells: Array<{ x: number; y: number; z: number }> = [];
      if (cageGuard) {
        // the ring: bottom up (a block needs a face to be laid against: the tower's own side first), three sides two high, the side toward the bars open until the bars are out
        const { ring, close, feet: f, toward } = cageGuardCells(actor.entity.position, wall);
        closeCells = close;
        section.guard = { feet: f, toward, cells: ring.length };
        await perform('guard_ring', { do: 'place', at: ring, block: 'cobblestone' }, 40);
      }
      await perform('dig_bars', { do: 'dig', at: wall, tool: 'iron_pickaxe', collect: false }, 30);
      if (cageGuard && closeCells.length) await perform('guard_close', { do: 'place', at: closeCells, block: 'cobblestone' }, 30);
      const at = actor.entity.position;
      if (Math.floor(at.x) !== root.x || Math.floor(at.z) !== root.z) throw new Error('displaced from the built pillar; shaft descent cannot be assumed');
      await perform('shaft_down', { do: 'vertical', dir: 'down', shape: 'shaft', toY: root.y, canDig: ['cobblestone'], canPlace: ['none'], maxDig: 64, maxPlace: 0, liquid: 'stop', seconds: 60 }, 65);
      success = Math.abs(actor.entity.position.y - root.y) < 0.5 && actor.entity.onGround;
      if (!success) throw new Error('shaft did not return to ground');
    } catch (error) { section.error = String((error as Error).message ?? error); }
    finally {
      actor.removeListener('health', onHealth); actor.removeListener('blockUpdate', onBlock);
      const blocksAfter = inventory().filter(i => i.name === 'cobblestone').reduce((n, i) => n + i.count, 0);
      Object.assign(section, { ok: success, ms: Date.now() - started, healthBefore, healthAfter: Number(actor.health), healthLost: healthBefore - Number(actor.health),
        damageTaken, minimumHealth: lowest.stop(), blocksBefore, blocksAfter, blocksUsed: placed,
        ledger: actor.reflexLedger?.entriesSince?.(mark) ?? [], deaths: actorDeaths - deathsBefore, died: actorDeaths > deathsBefore });
      sections.push(section);
    }
    if (!success) break;
  }
  return { ok: sections.length === 2 && sections.every(s => s.ok) && actorDeaths === sceneDeaths, start, tp: false, waterBucket: false,
    reflex: 'on', dragon: 'awake', sections, deaths: actorDeaths - sceneDeaths };
};

scenes.approach_head = async () => {
  // Eight approaches under the head of a perched dragon, as a planner would make them from the observation (the approach is the body's offer; the choices are the stand-in planner's):
  // the dragon lands; the planner takes a waiting cell (`approach.stage`, safe for the whole perch) and goes there; it waits until the window is open (`dragon.windows.open`); it goes to the strike cell (`approach.strike`),
  // strikes with the sword, and goes to the retreat cell once the dragon has taken off (phase 4). Floor reflexes on, iron armour, no resistance. Each trial records what the reflex saw (the hazards and the ledger).
  const trials: Array<Record<string, unknown>> = [];
  await protect(false); releaseReflex();
  const deathsAll = actorDeaths;
  const dragonOf = (view: any) => view?.dragon as { phase: number | null; approach?: { strike: any[]; stage?: any[]; retreat: any[] }; windows?: { open: boolean; remainingSeconds: number[] | null; secondsUntil: number[] | null } } | undefined;
  const toCell = (p: { x: number; y: number; z: number }) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
  for (let n = 1; n <= 8; n++) {
    await flatten(); await gear(['stone_sword', 'cobblestone 64']); await wearIron();
    await restoreDragon(); await sleep(1500);
    // what an earlier trial left on the island (a cloud of breath lies for 30 s, a ball may still fly) is not what this trial measures
    await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`); await ask(`${END} kill @e[type=minecraft:dragon_fireball]`);
    await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`);
    await standAt(0.5, g, 14.5); await sleep(800);
    await perch(200, 6); await sleep(500);
    const deaths0 = actorDeaths, hp0 = Number(actor.health), lowest = trackMinHealth(), ledgerMark = (actor.reflexLedger?.mark?.() as number | undefined) ?? 0;
    const first = dragonOf(endView());
    const strike = first?.approach?.strike?.[0], stage = first?.approach?.stage?.[0], retreat = first?.approach?.retreat?.[0];
    const row: Record<string, unknown> = { n, phaseAtStart: first?.phase ?? null, strikeCells: first?.approach?.strike?.length ?? 0, stageCells: first?.approach?.stage?.length ?? 0, retreatCells: first?.approach?.retreat?.length ?? 0,
      strike: strike ?? null, stage: stage ?? null, retreat: retreat ?? null };
    if (!strike) row.skipped = 'no strike cell in the observation';
    else {
      // to the waiting cell (when there is none, the body stays where it is: the planner waits at the start)
      if (stage) {
        const stageRun = await act([{ do: 'go', to: toCell(stage), range: 1, seconds: 25 }], 35);
        row.stageGo = { ok: stageRun.ok, ms: stageRun.ms, line: (stageRun.lines[0] ?? '').slice(0, 200) };
      }
      // wait for an open window (at most 30 s: a perch has two or three of them)
      const waitStart = Date.now(); let opened = false;
      while (Date.now() - waitStart < 30_000 && actorDeaths === deaths0) {
        const w = dragonOf(endView())?.windows;
        if (w?.open && (w.remainingSeconds?.[0] ?? 0) >= 0.8) { opened = true; break; }
        await sleep(100);
      }
      row.windowSeen = opened; row.waitedMs = Date.now() - waitStart;
      if (opened && actorDeaths === deaths0) {
        const hazards = dragonHazards(actor).map(h => `${h.kind}:${h.why}`).slice(0, 4);
        row.hazardsAtGo = hazards;
        const goRun = await act([{ do: 'go', to: toCell(strike), range: 1, seconds: 10 }], 20);
        row.go = { ok: goRun.ok, ms: goRun.ms, line: (goRun.lines[0] ?? '').slice(0, 200) };
        const at = actor.entity.position;
        row.arrivedWithin = round(Math.hypot(at.x - strike.x, at.z - strike.z), 1);
        const strikeRun = await act([{ do: 'equip', item: 'stone_sword' }, { do: 'attack', target: 'ender_dragon', untilDead: false, seconds: 6 }], 20);
        const m = /(\d+)回振って (\d+)回当たった/u.exec(strikeRun.lines.join(' '));
        row.strikeHand = { ok: strikeRun.ok, blows: m ? Number(m[1]) : null, landed: m ? Number(m[2]) : null, line: strikeRun.lines.join(' | ').slice(0, 240) };
      }
      // after the strike, the planner waits for the take-off (phase 4, at most 45 s) and takes the retreat cell
      const takeoffStart = Date.now(); let phase: number | null = null;
      while (Date.now() - takeoffStart < 45_000 && actorDeaths === deaths0) { phase = dragonOf(endView())?.phase ?? null; if (phase === 4) break; await sleep(500); }
      row.phaseWhenRetreating = phase;
      if (retreat && actorDeaths === deaths0) {
        const retreatRun = await act([{ do: 'go', to: toCell(retreat), range: 1.5, seconds: 20 }], 30);
        row.retreatGo = { ok: retreatRun.ok, ms: retreatRun.ms, line: (retreatRun.lines[0] ?? '').slice(0, 200) };
      }
    }
    const ledger = (actor.reflexLedger?.entriesSince?.(ledgerMark) as Array<{ kind: string; outcome: string; detail: string }> | undefined) ?? [];
    row.ledger = ledger.slice(0, 8).map(e => `${e.kind}:${e.outcome}:${String(e.detail).slice(0, 110)}`);
    row.healthLost = round(hp0 - Number(actor.health), 1); row.lowest = lowest.stop(); row.died = actorDeaths > deaths0;
    trials.push(row);
    log(`ENDFIGHT APPROACH #${n}: ${JSON.stringify(row).slice(0, 2400)}`);
  }
  const struck = trials.filter(t => Number((t.strikeHand as { landed?: number } | undefined)?.landed ?? 0) > 0).length;
  return { trials: trials.length, deaths: actorDeaths - deathsAll, windowSeen: trials.filter(t => t.windowSeen).length, reachedStrike: trials.filter(t => (t.go as { ok?: boolean } | undefined)?.ok === true).length, struck,
    lowestOverall: Math.min(...trials.map(t => Number(t.lowest ?? 20))), skipped: trials.filter(t => t.skipped).length, trialsDetail: trials };
};

scenes.cage_section_walk = async () => {
  // The whole way from the arrival with no teleport after it: the game's own arrival on the platform (enter), the crossing to the island by go (blocks laid by the hand, no bucket), then the two cages from where the body stands.
  cageWalkStart = true; // (run after the enter scene: `enter,cage_section_walk`)
  await ask('difficulty normal'); await protect(false); releaseReflex();
  await gear(['stone_sword', 'cobblestone 64']); await wearIron();
  const deaths0 = actorDeaths, crossStart = Date.now();
  let reached = false;
  for (let call = 0; call < 4 && !reached && actorDeaths === deaths0; call++) {
    await act([{ do: 'go', to: { x: 67, y: 59, z: 0 }, range: 1.5, canPlace: ['cobblestone'], maxPlace: 100, seconds: 120 }], 135);
    const at = actor.entity.position; reached = Math.hypot(at.x - 67.5, at.z - 0.5) < 3 && Number(actor.health) > 0;
    if (!reached) await sleep(2000);
  }
  const crossing = { reached, seconds: round((Date.now() - crossStart) / 1000, 1), health: round(Number(actor.health), 1), deaths: actorDeaths - deaths0 };
  log(`ENDFIGHT CAGE_WALK crossing: ${JSON.stringify(crossing)}`);
  if (!reached) return { crossing, error: 'the crossing did not reach the island' };
  // across the island to the west side where the caged pillars stand (about 100 m from the arrival rim): on foot, as the planner would
  const westStart = Date.now(); let west = false;
  for (let call = 0; call < 4 && !west && actorDeaths === deaths0; call++) {
    await act([{ do: 'go', to: { x: -27, y: g, z: 0 }, range: 3, seconds: 90 }], 100);
    const at = actor.entity.position; west = Math.hypot(at.x + 27, at.z) < 5 && Number(actor.health) > 0;
    if (!west) await sleep(1500);
  }
  const walkWest = { reached: west, seconds: round((Date.now() - westStart) / 1000, 1), health: round(Number(actor.health), 1), deaths: actorDeaths - deaths0 };
  log(`ENDFIGHT CAGE_WALK island walk: ${JSON.stringify(walkWest)}`);
  if (!west) return { crossing, walkWest, error: 'the walk across the island did not arrive' };
  await sleep(1000);
  return { crossing, walkWest, ...(await scenes.cage_section()) };
};

scenes.cage_guard_walk = async () => { cageGuard = true; try { return await scenes.cage_section_walk(); } finally { cageGuard = false; } };

// ===== end_full_chain: stand-in HEAD, from arrival, without the comparison arena setup =====
scenes.end_full_chain = async () => {
  if (wanted.filter(n => n !== 'enter').join() !== 'end_full_chain') throw new Error('end_full_chain must run alone (optionally after enter)');
  if (!report.scenes.enter && !chainArrivalAt) await scenes.enter();
  const t0 = chainArrivalAt ?? Date.now(), deadline = t0 + CHAIN_LIMIT_MS, deaths0 = 0;
  const elapsed = () => Math.round((Date.now() - t0) / 100) / 10;
  const lowest = trackMinHealth(), counts0 = chainArrivalCounts ?? actor.reflexLedger?.counts?.() ?? {};
  const out: Record<string, any> = { scene: 'end_full_chain', tp: false, tpScope: 'after enter arrival', commandCrystalRemoval: false, waterBucket: false,
    reflex: 'on', limitSeconds: 2400, crystalLimitSeconds: 900, dragonTargetSeconds: 900, order: 'near',
    stages: [], crystals: [], hands: [], interruptions: [], healthTimeline: [...chainArrivalTimeline], transitions: [], waitingChosen: [], boss: null, bossVerified: false };
  out.stages.push({ stage: 'enter', seconds: (Date.now() - t0) / 1000, endedAt: elapsed() });
  let stage = 'setup', stageAt = Date.now(), crystalDeadline = deadline, paused = false;
  let dragonId: number | null = null, dragonDead = false, entered = false, mustLeave = false, lastPhase: number | null | undefined;
  let observedWait: P3 | null = null;
  let active: { controller: AbortController; mode: string } | null = null, lastSample = -Infinity;
  const read = (): any => (body.observe().state as any).world;
  const setStage = (next: string) => {
    out.stages.push({ stage, seconds: (Date.now() - stageAt) / 1000, endedAt: elapsed() });
    stage = next; stageAt = Date.now();
    if (next === 'crystals') crystalDeadline = Math.min(deadline, Date.now() + CRYSTAL_LIMIT_MS);
  };
  const check = () => {
    if (actorDeaths > deaths0 || Number(actor.health) <= 0) throw new Error('actor_dead');
    if (disconnected) throw new Error('disconnected');
    if (Date.now() >= deadline) throw new Error('time_limit');
    if (stage === 'crystals' && Date.now() >= crystalDeadline) throw new Error('crystal_time_limit');
  };
  const sample = () => {
    const v = read(), d = v?.dragon;
    const waiting = chainWait(v); if (waiting) observedWait = { x: waiting.x, y: waiting.y, z: waiting.z };
    for (const c of v?.crystals?.list ?? []) {
      const row = out.crystals.find((r: any) => r.id === c.id);
      if (!row) out.crystals.push({ id: c.id, position: c.position, caged: c.caged, firstSeenSeconds: elapsed(), destroyedSeconds: null, arrows: 0, shots: [], tried: [], cageOpened: false });
      else if (row.caged === null && c.caged !== null) row.caged = c.caged;
    }
    if (dragonId === null && d) dragonId = d.id;
    if (d?.id === dragonId && (d.health === 0 || d.phase === 9)) dragonDead = true;
    if (d?.phase !== lastPhase) { lastPhase = d?.phase; out.transitions.push([elapsed(), lastPhase ?? null]); }
    if (stage === 'crystals') {
      const next = chainPause(v, paused);
      if (next && !paused) out.interruptions.push({ seconds: elapsed(), reason: 'phase_6', phase: d?.phase, position: v.position });
      paused = next;
    }
    if (Date.now() - lastSample >= 5000) {
      lastSample = Date.now(); out.healthTimeline.push({ seconds: elapsed(), stage, health: d?.health ?? null, actorHealth: v.health, remaining: v?.crystals?.remaining ?? null });
    }
    if (active && (actorDeaths > deaths0 || disconnected || Date.now() >= deadline ||
      (stage === 'crystals' && Date.now() >= crystalDeadline) || (active.mode === 'crystal' && paused) ||
      (active.mode === 'basin' && !chainSitting(d?.phase)) ||
      (active.mode === 'attack' && (!chainSitting(d?.phase) || !chainClear(v))) || (dragonDead && active.mode !== 'proof'))) active.controller.abort('chain_observation_changed');
  };
  const perform = async (name: string, hand: Record<string, unknown>, seconds = 30, mode = 'crystal') => {
    check(); sample();
    if (mode === 'crystal' && paused) throw new Error('crystal_paused');
    const controller = new AbortController(); active = { controller, mode };
    const position = read()?.position, at = elapsed();
    try {
      const result = await act([hand], seconds, {}, controller.signal);
      out.hands.push({ stage, name, seconds: at, position, hand, ...result });
      sample(); check();
      if (mode === 'crystal' && paused) throw new Error('crystal_paused');
      if (!result.ok && /invalid_input/u.test(result.lines.join(' '))) throw new Error(`invalid_hand:${name}`);
      return result;
    } finally { active = null; }
  };
  const must = async (name: string, hand: Record<string, unknown>, seconds = 30, mode = 'crystal') => {
    for (let retry = 0; retry <= 2; retry++) {
      const r = await perform(name, hand, seconds, mode);
      if (r.ok) return;
      if (!/反射|被弾|search_timeout/u.test(r.lines.join(' ')) || retry === 2) throw new Error(`hand_stopped:${name}`);
      await sleep(500); // The stand-in HEAD reissues after the observed cut.
    }
  };
  const go = (name: string, p: P3, seconds = 60, mode = 'crystal', range = 0.5) => perform(name, chainHands.go(p, seconds, range), seconds + 5, mode);
  const onDead = (e: any) => {
    if (dragonId !== null && e?.id === dragonId) dragonDead = true;
    const c = out.crystals.find((r: any) => r.id === e?.id);
    if (c) { c.destroyedSeconds = elapsed(); c.destroyedEvidence = 'entityDead'; }
  };
  actor.on('entityDead', onDead);
  const timer = setInterval(sample, 100);
  let lastGround: P3 | null = null;
  const openCage = async (c: ChainCrystal, row: any) => {
    // The root/up/ring/bars/close/shaft parts of cage_section; geometry offers cells, the HEAD chooses the first.
    const opening = read().crystals.openings?.find((o: any) => o.id === c.id);
    row.blockedBy = opening?.blockedBy ?? null;
    row.afterCageRemoved = opening?.afterCageRemoved ?? row.afterCageRemoved ?? [];
    const root = cageRoots(actor, c.position, opening?.blockedBy)[0];
    if (!root) throw new Error('no_cage_root');
    row.root = root;
    await must('go_root', chainHands.go(root, 60, 0), 65);
    lastGround = feetCentre(root);
    try {
      await must('pillar_up', chainHands.up(c.position.y), 65);
      const wall = cageWall(actor, c.position, opening?.blockedBy);
      if (!wall.length) throw new Error('no_reachable_bars');
      const guard = cageGuardCells(read().position, wall);
      row.bars = wall; row.guard = guard;
      await must('guard_ring', chainHands.place(guard.ring), 40);
      try { await must('dig_bars', chainHands.dig(wall)); }
      finally { const r = out.hands.at(-1); if (r?.name === 'dig_bars' && r.ok) row.cageOpened = true; }
      await must('guard_close', chainHands.place(guard.close));
    } finally {
      // A phase-6 cut also descends before a ground retreat. A displaced body cannot assume the shaft.
      const at = read()?.position;
      if (at && at.y > root.y + 0.5 && actorDeaths === deaths0) {
        if (Math.floor(at.x) !== root.x || Math.floor(at.z) !== root.z) throw new Error('displaced_from_shaft');
        await must('shaft_down', chainHands.down(root.y), 65, 'recovery');
        if (Math.abs(read().position.y - root.y) > 0.5) throw new Error('shaft_not_grounded');
      }
    }
  };
  try {
    // Inventory provision only. No arena edits, parked/reset dragon, heal, crystal/cloud cleanup or tp.
    if (!actor.floorReflexes || !actor.reflexLedger?.counts) { out.reflex = 'unavailable'; throw new Error('floor_reflex_required'); }
    releaseReflex();
    await ask('difficulty normal'); await ask(`gamemode survival ${ACTOR}`);
    await gear(['stone_sword', 'shield', 'iron_pickaxe', 'cobblestone 64', 'bow', 'arrow 64', 'cooked_beef 64']);
    await wearIron(); await protect(false);
    await must('equip_shield', { do: 'equip', item: 'shield', slot: 'offhand' }, 10, 'move');
    const initial = read();
    if (!initial?.crystals || String(actor.game?.dimension).replace(/^minecraft:/u, '') !== 'the_end') throw new Error('not_in_end');
    if (initial.inventory.some((i: any) => /bucket/u.test(i.name))) throw new Error('bucket_refused');
    out.initial = { position: initial.position, health: initial.health, inventory: initial.inventory, crystals: initial.crystals.remaining };
    // crossing + walkWest of cage_section_walk: same go hands; natural footings replace fixed coordinates.
    setStage('crossing');
    let reached = false;
    for (let call = 0; call < 4 && !reached; call++) {
      // the island edge the arrival platform bridges to (the cage_section_walk crossing target: a footing at the platform's own side is not an island)
      const landing = { x: 67, y: 59, z: 0 };
      const r = await perform('crossing', chainHands.crossing(landing), 125, 'move');
      reached = chainDistance(read().position, landing) < 3 && Number(actor.health) > 0;
      out.crossing = { reached, to: landing };
    }
    if (!reached) throw new Error('crossing_failed');
    setStage('walkWest');
    for (let call = 0; call < 4; call++) {
      const v = read(), c = v.crystals.list.find((c: ChainCrystal) => c.caged === true), target = c?.position ?? v.perch;
      if (!target) throw new Error('no_observed_island_target');
      const to = islandFootings(actor, target)[0];
      if (!to) throw new Error('no_island_footing');
      const r = await go('walkWest', to, 90, 'move', 1);
      out.walkWest = { reached: r.ok, to };
      if (r.ok) { lastGround = to; break; }
      if (call === 3) throw new Error('island_walk_failed');
    }
    setStage('crystals');
    while (!chainClear(read())) {
      check(); sample();
      if (paused) {
        const away = chainWait(read()) ?? observedWait ?? lastGround;
        const r = away && chainDistance(read().position, away) > 1.5 ? await go('crystal_retreat', away, 12, 'recovery', 1) : null;
        if (r && !r.ok) out.interruptions.push({ seconds: elapsed(), reason: 'retreat_cut', lines: r.lines });
        await sleep(250); continue;
      }
      if (read().food <= 18) { await perform('eat_crystals', { do: 'eat' }, 8, 'recovery'); }
      const v = read(), c = chainCrystal(v, 'near');
      if (!c) {
        // remaining includes unknown spikes; an empty loaded list is not proof of zero crystals.
        const unseen = v.crystals.unseen[0];
        if (!unseen) { await sleep(500); continue; }
        const to = islandFootings(actor, { ...unseen, y: v.position.y })[0];
        if (!to) throw new Error('no_unseen_spike_approach');
        try { await go('load_unseen_crystal', to); } catch (e) { if ((e as Error).message !== 'crystal_paused') throw e; }
        continue;
      }
      let row = out.crystals.find((r: any) => r.id === c.id);
      if (!row) { row = { id: c.id, position: c.position, caged: c.caged, firstSeenSeconds: elapsed(), destroyedSeconds: null, arrows: 0, shots: [], tried: [], cageOpened: false }; out.crystals.push(row); }
      try {
        if (c.caged === true && !row.cageOpened) await openCage(c, row);
        // Cached hypothetical positions are only used after digging. shoot rechecks the real arrow path.
        let to = chainShot(read(), c, row.cageOpened, row.tried);
        if (!to && row.cageOpened) to = row.afterCageRemoved?.find((p: P3) => !row.tried.some((q: P3) => chainDistance(p, q) < 0.1));
        if (!to) {
          const approach = islandFootings(actor, c.position)[0];
          if (!approach || chainDistance(read().position, approach) < 3) throw new Error('no_shooting_position');
          await go('crystal_reposition', approach); continue;
        }
        const moved = await go('shoot_position', to, 60, 'crystal', 0);
        if (!moved.ok) { await sleep(250); continue; }
        const before = read(), arrows = (w: any) => w.inventory.filter((i: any) => i.name === 'arrow').reduce((n: number, i: any) => n + i.count, 0);
        if (!before.crystals.list.some((live: any) => live.id === c.id)) { await sleep(500); continue; }
        if (arrows(before) === 0) throw new Error('arrows_exhausted');
        const firedAt = elapsed(), position = before.position;
        let shot: Awaited<ReturnType<typeof act>> | null = null;
        const handCount = out.hands.length;
        try { shot = await perform('shoot_crystal', chainHands.shoot(c.id), 12); }
        finally {
          const delta = arrows(before) - arrows(read());
          const used = actorDeaths === deaths0 && Number(actor.health) > 0 && delta >= 0 && delta <= 1 ? delta : null;
          row.arrows += used ?? 0; if (used === null) row.arrowsUnknown = true;
          const receipt = shot ?? (out.hands.length > handCount ? out.hands.at(-1) : null), lines = receipt?.lines ?? [];
          const destroyed = lines.some((s: string) => /クリスタルを壊した/u.test(s));
          row.shots.push({ seconds: firedAt, position, arrows: used, ok: receipt?.ok ?? false, lines,
            outcome: destroyed ? 'destroyed' : lines.some((s: string) => /外れた/u.test(s)) ? 'miss' : lines.some((s: string) => /line_blocked/u.test(s)) ? 'line_blocked' : 'refused_or_cut' });
          if (destroyed) { row.destroyedSeconds ??= elapsed(); row.destroyedEvidence ??= 'shoot_receipt'; }
          if (lines.some((s: string) => /line_blocked/u.test(s)) || row.shots.filter((s: any) => chainDistance(s.position, position) < 1).length >= 3) row.tried.push(to);
        }
      } catch (error) { if ((error as Error).message !== 'crystal_paused') throw error; }
      await sleep(250);
    }
    out.crystalsClearedSeconds = elapsed();
    out.dragonStartedSeconds = elapsed();
    setStage('dragon');
    // Same basin walk sequence, with waiting/entry positions chosen exclusively from the observation.
    while (!dragonDead) {
      check(); sample();
      const v = read(), d = v.dragon;
      if (!chainClear(v)) throw new Error('crystals_reappeared');
      if (entered && !chainSitting(d?.phase)) { entered = false; mustLeave = true; }
      const waiting = chainWait(v);
      if (mustLeave) {
        const away = waiting ?? observedWait;
        if (away) {
          const r = await go('leave_basin', away, 12, 'move', 1);
          out.waitingChosen.push({ seconds: elapsed(), reason: 'takeoff', to: away, retainedObservation: !waiting, ok: r.ok });
          if (r.ok) mustLeave = false;
        }
        await sleep(100); continue;
      }
      if (!entered && v.food <= 18) { await perform('eat_waiting', { do: 'eat' }, 8, 'move'); await sleep(100); continue; }
      if (entered && chainSitting(d?.phase)) {
        await perform('equip_sword', { do: 'equip', item: 'stone_sword' }, 8, 'move');
        if (chainSitting(read()?.dragon?.phase) && chainClear(read())) await perform('attack_basin', chainHands.attack(), 16, 'attack');
      } else if (chainBasin(v)) {
        const r = await go('enter_basin', chainBasin(v)!, 12, 'basin');
        entered = r.ok; if (!r.ok) mustLeave = true;
      } else if (waiting && chainDistance(v.position, waiting) > 1.5) {
        const r = await go('wait_landing', waiting, 12, 'move', 1);
        out.waitingChosen.push({ seconds: elapsed(), reason: 'landing', to: waiting, ok: r.ok });
      } else if (!waiting && v.perch && chainDistance(v.position, v.perch) > 28) {
        const to = islandFootings(actor, v.perch).find(p => Math.hypot(p.x - v.perch.x, p.z - v.perch.z) >= 12);
        if (to) await go('approach_wait_range', to, 60, 'move');
      }
      await sleep(100);
    }
    out.killSeconds = elapsed();
    setStage('verify');
    const proofDeadline = Math.min(deadline, Date.now() + 15_000);
    do {
      check();
      const controller = new AbortController(); active = { controller, mode: 'proof' };
      try { const proof = await evidence(controller.signal, Math.min(10, (deadline - Date.now()) / 1000)); out.boss = proof?.boss ?? null; }
      finally { active = null; }
      out.bossVerified = out.boss?.verified === true && out.boss?.witness?.entityId === dragonId;
      if (out.bossVerified) break;
      await sleep(250);
    } while (Date.now() < proofDeadline);
    out.endReason = out.bossVerified ? 'dragon_dead' : 'boss_unverified';
  } catch (error) { out.endReason = String((error as Error).message ?? error); }
  finally {
    clearInterval(timer); actor.removeListener('entityDead', onDead);
    setStage('finished');
    const counts = actor.reflexLedger?.counts?.() ?? {};
    out.reflexKinds = Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, Number(n) - Number(counts0[k] ?? 0)]).filter(([, n]) => Number(n) > 0));
    out.seconds = elapsed(); out.deaths = actorDeaths - deaths0; out.minHealth = Math.min(lowest.stop(), chainArrivalMinHealth);
    out.crystalSeconds = out.stages.find((s: any) => s.stage === 'crystals')?.seconds ?? null;
    out.dragonSeconds = out.stages.find((s: any) => s.stage === 'dragon')?.seconds ?? null;
    out.arrowsUsed = out.crystals.reduce((n: number, c: any) => n + c.arrows, 0);
    out.dragonId = dragonId; out.dragonHealthEnd = read()?.dragon?.health ?? (dragonDead ? 0 : null);
    out.crystalsRemaining = read()?.crystals?.remaining ?? null;
    out.ok = out.endReason === 'dragon_dead' && out.bossVerified && out.deaths === 0 && chainClear(read()) && Date.now() <= deadline;
  }
  return out;
};
// ===== end end_full_chain =====

// ===== dragon_kill_compare: the script below is the lab's stand-in HEAD, never a body policy =====
type KillStyle = 'sword_stage' | 'bed' | 'bow';
type KillNookBuilder = 'operator' | 'body';
const KILL_LIMIT_MS = 25 * 60 * 1000;
const killEntries = ['dragon_kill_compare', 'dragon_kill_sword', 'dragon_kill_bed', 'dragon_kill_bow', 'dragon_kill_sword_nook', 'dragon_kill_bed_nook', 'dragon_kill_sword_assist', 'dragon_kill_sword_assist_walk', 'dragon_kill_basin_assist', 'dragon_kill_basin_walk', 'dragon_kill_basin_walk_pumpkin', 'dragon_kill_basin_crystals_all', 'dragon_kill_basin_crystals_caged', 'end_full_chain'];
const killCell = (p: P3): P3 => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const packCount = (name: string): number => actor.inventory.items().filter((item: any) => item.name === name).reduce((n: number, item: any) => n + item.count, 0);
let killArena: { ground: P3; perch: P3; yaw: number } | null = null;
const killPlaced = new Map<string, P3>();
const killBlasts: P3[] = [];
/** The crystals the End showed just before the comparison's set-up removed them (the crystal-count experiments put some back). */
let killCrystalSnapshot: Array<{ id: number; x: number; y: number; z: number; caged: boolean | null }> = [];

/** Bootstrap only: choose real island support from the loaded terrain, relative to the observed fountain/head. */
async function prepareKillRun(waitingSide = false): Promise<{ dragonId: number; ground: P3 }> {
  const chosen = wanted.filter(name => name !== 'enter');
  if (chosen.length !== 1 || !killEntries.includes(chosen[0])) throw new Error('dragon_kill_compare entries must run alone');
  if (!actor.floorReflexes || !actor.reflexLedger?.counts) throw new Error('dragon_kill_compare requires floor reflexes ON and the full ledger counter');
  if (g === 0) await scenes.enter();
  await protect(true); releaseReflex(); await park(false);
  if (!killArena) {
    // the dragon is in sight 30 to 60 s after the arrival: waited for
    for (let i = 0; i < 400 && !(endView()?.perch && endView()?.dragon); i++) await sleep(300);
    const view = endView(), p = view?.perch, d = view?.dragon;
    if (!p || !d) throw new Error('comparison bootstrap needs an observed perch and dragon');
    const read = bodyReader(actor), dir = { x: Math.sin(d.yaw), z: Math.cos(d.yaw) };
    const cells: P3[] = [];
    for (let dx = -24; dx <= 24; dx++) for (let dz = -24; dz <= 24; dz++) {
      if (Math.hypot(dx, dz) < 12 || Math.hypot(dx, dz) > 24) continue;
      for (let y = Math.floor(p.y); y >= p.y - 32; y--) {
        const cell = { x: Math.floor(p.x) + dx, y, z: Math.floor(p.z) + dz };
        if (read(cell.x, y - 1, cell.z)?.name === 'end_stone' && standing(read, cell)) { cells.push(feetCentre(cell)); break; }
      }
    }
    cells.sort((a, b) => Math.hypot(a.x - p.x - dir.x * 16, a.z - p.z - dir.z * 16) - Math.hypot(b.x - p.x - dir.x * 16, b.z - p.z - dir.z * 16));
    if (!cells[0]) throw new Error('no loaded island ground for the comparison');
    killArena = { ground: cells[0], perch: { ...p }, yaw: 180 - d.yaw * 180 / Math.PI };
  }
  const arena = killArena;
  const ground = waitingSide ? basinWaitingCell(endView()) : arena.ground;
  if (!ground) throw new Error('no loaded lateral waiting footing 10 to 14 m from the observed perch');
  // Only blocks this comparison attempted to place; never flatten the island or the podium.
  for (const cell of killPlaced.values()) {
    const name = actor.blockAt(new Vec3(cell.x, cell.y, cell.z))?.name;
    if (['obsidian', 'white_bed', 'fire', 'cobblestone'].includes(name)) await ask(`${END} setblock ${cell.x} ${cell.y} ${cell.z} air`);
  }
  killPlaced.clear();
  for (const p of killBlasts) await ask(`${END} fill ${Math.floor(p.x) - 5} ${Math.floor(p.y) - 5} ${Math.floor(p.z) - 5} ${Math.floor(p.x) + 5} ${Math.floor(p.y) + 5} ${Math.floor(p.z) + 5} air replace fire`);
  killBlasts.length = 0;
  await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`);
  await ask(`${END} kill @e[type=minecraft:dragon_fireball]`);
  killCrystalSnapshot = ((endView() as any)?.crystals?.list ?? []).map((c: any) => ({ id: c.id, x: c.position.x, y: c.position.y, z: c.position.z, caged: c.caged }));
  await ask(`${END} kill @e[type=minecraft:end_crystal]`);
  await ask(`${END} kill @e[type=minecraft:arrow]`);
  await ask(`${END} kill @e[type=minecraft:item]`);
  // A previous successful run removed its dragon. A timed-out dragon is reset only here, before the clock starts.
  let exists = await dragonHealthServer();
  if (exists !== null && (exists <= 0 || endView()?.dragon?.phase === 9)) {
    for (let i = 0; i < 60 && exists !== null; i++) { await sleep(250); exists = await dragonHealthServer(); }
    if (exists !== null) throw new Error('previous dragon has not finished dying; cannot reset it into a new run');
  }
  if (exists === null) await ask(`${END} summon minecraft:ender_dragon ${arena.perch.x} ${arena.perch.y} ${arena.perch.z}`);
  await gear(['stone_sword', 'shield', 'cobblestone 64', 'bow', 'arrow 64', ...Array(12).fill('white_bed'), 'obsidian 12', 'cooked_beef 64']);
  await wearIron();
  await act([{ do: 'equip', item: 'shield', slot: 'offhand' }, { do: 'equip', item: 'stone_sword' }], 10);
  await standAt(ground.x, ground.y, ground.z);
  await ask(`${END} tp ${DRAGON} ${arena.perch.x} ${arena.perch.y} ${arena.perch.z} ${arena.yaw} 0`);
  await still();
  await ask(`${END} data modify entity ${DRAGON} Health set value 200.0f`);
  await ask(`effect give ${ACTOR} minecraft:instant_health 1 5 true`);
  await ask(`effect give ${ACTOR} minecraft:saturation 1 5 true`);
  await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`);
  await ask(`${END} kill @e[type=minecraft:dragon_fireball]`);
  // Set phase once. No operator mutations during the timed run.
  await ask(`${END} data modify entity ${DRAGON} DragonPhase set value 6`);
  await protect(false);
  // A fireball's reflex or a knock can move the body in the moment after the set-up: the state is waited for (at most 6 s), and only then refused.
  const unconfirmed = (): boolean => {
    const d = endView()?.dragon, slots = actor.inventory.slots;
    return (!d || d.health !== 200 || !actor.entity.onGround || Number(actor.health) !== 20 || Number(actor.food) !== 20 ||
      packCount('arrow') !== 64 || packCount('white_bed') !== 12 || packCount('obsidian') !== 12 || packCount('cobblestone') !== 64 || packCount('cooked_beef') !== 64 || packCount('bow') !== 1 ||
      actor.heldItem?.name !== 'stone_sword' || slots?.[45]?.name !== 'shield' ||
      ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'].some((name, i) => slots?.[5 + i]?.name !== name) ||
      actor.inventory.items().some((i: any) => i.name.endsWith('bucket')));
  };
  for (let i = 0; i < 30 && unconfirmed(); i++) await sleep(200);
  const d = endView()?.dragon;
  if (unconfirmed()) {
    throw new Error('comparison initial health/ground/gear was not confirmed');
  }
  context.taskId = `dragon-kill-${++context.taskRevision}`;
  return { dragonId: d!.id, ground };
}

/** Read-only geometry chosen by the script from one observed stage/strike pair and the observed head box. */
function chooseKillPlan(d: any) {
  const stages = [...(d?.approach?.stage ?? [])].sort((a: any, b: any) => a.toStrikeMeters - b.toStrikeMeters);
  const stage = stages.find((s: any) => d.approach.strike[s.strikeIndex]);
  if (!stage) return null;
  return { stage: { ...stage }, strike: { ...d.approach.strike[stage.strikeIndex] }, retreat: d.approach.retreat?.[0] ? { ...d.approach.retreat[0] } : null };
}

// Only observed approach geometry: walkMeters/countdowns change as the actor moves or time passes.
const killGeometry = (d: any) => JSON.stringify([
  (d?.approach?.stage ?? []).map((p: any) => [p.x, p.y, p.z, p.strikeIndex]),
  (d?.approach?.strike ?? []).map((p: any) => [p.x, p.y, p.z]),
]);
const killStageObservation = (d: any) => JSON.stringify([d?.phase, d?.windows?.open, killGeometry(d)]);

/** path_update points are the executor's feet positions, not a count of physics cells entered. */
function killRetreatRoute(origin: P3, target: P3, here: P3, walked: number, route: P3[]) {
  const direct = Math.hypot(target.x - origin.x, target.y - origin.y, target.z - origin.z);
  let meters = walked, previous = here, top = here.y;
  for (const p of route) { meters += Math.hypot(p.x - previous.x, p.y - previous.y, p.z - previous.z); top = Math.max(top, p.y); previous = p; }
  const reason = top - origin.y >= 3 ? 'retreat_route_rise' : meters > direct * 2.5 ? 'retreat_route_detour' : null;
  return { reason, meters, direct, rise: top - origin.y };
}

function killBedLayout(d: any, plan: NonNullable<ReturnType<typeof chooseKillPlan>>, alternative = 0) {
  const box = partBox({ position: d.position, yaw: d.yaw }, 'head');
  const head = { x: (box.minX + box.maxX) / 2, y: box.minY, z: (box.minZ + box.maxZ) / 2 };
  const dx = head.x - d.position.x, dz = head.z - d.position.z, length = Math.hypot(dx, dz);
  if (!length) return null;
  const foot = perchBedFoot(head, { x: dx / length, y: 0, z: dz / length }, box.minY);
  const alongZ = Math.abs(foot.z + 0.5 - plan.stage.z) >= Math.abs(foot.x + 0.5 - plan.stage.x);
  // Three distinct observed columns at most; a refused cell is never sent to place again this perch.
  const offset = [0, -1, 1][alternative] ?? 0;
  if (alongZ) foot.x += offset; else foot.z += offset;
  const wall = bedWallCells(foot, plan.stage, foot.y - 1, foot.y + 1, 1);
  const step = alongZ ? { x: 0, z: Math.sign(foot.z + 0.5 - plan.stage.z) } : { x: Math.sign(foot.x + 0.5 - plan.stage.x), z: 0 };
  const partner = { x: foot.x + step.x, y: foot.y, z: foot.z + step.z };
  const read = (p: P3) => actor.blockAt(new Vec3(p.x, p.y, p.z)) ?? null;
  const cells = supportedBedCells([...[foot, partner].map(p => ({ ...p, y: p.y - 1 })), ...wall], read);
  if (!cells) return null;
  let wallBottom = Math.min(wall[0].y, ...cells.filter(p => p.x === wall[0].x && p.z === wall[0].z).map(p => p.y));
  for (let i = 0; i < 16 && read({ ...wall[0], y: wallBottom - 1 })?.name === 'obsidian'; i++) wallBottom--;
  return { foot, partner, cells, wallBottom, wallTop: foot.y + 1, wallHeight: foot.y + 2 - wallBottom };
}

async function dragonKillRun(style: KillStyle, nookBuilder?: KillNookBuilder): Promise<Record<string, any>> {
  const initial = await prepareKillRun();
  const t0 = Date.now(), deadline = t0 + KILL_LIMIT_MS, deaths0 = actorDeaths, lowest = trackMinHealth();
  const counts0 = actor.reflexLedger.counts();
  const ledgerStart = actor.reflexLedger.mark();
  const out: Record<string, any> = { scene: 'dragon_kill_compare', style, limitSeconds: KILL_LIMIT_MS / 1000,
    initial: { ...initial, dragonHealth: 200, actorHealth: Number(actor.health), food: Number(actor.food), arrows: 64, beds: 12, obsidian: 12, floorReflexes: true },
    killSeconds: null, dragonHealthAt25Minutes: null, deaths: 0, minHealth: null, bedsUsed: 0, arrowsUsed: 0,
    perchCount: 0, perchesHit: 0, meleeHitWindows: 0, explosionsHit: 0, perches: [], windows: [], healthTimeline: [{ seconds: 0, health: 200, source: 'confirmed_start' }], actions: [], bedTrials: [], reflexKinds: {}, boss: null };
  let nook: DragonNook | null = null, nookReady = false, nookStamp = '', nookAttemptPerch = -1, nookEnterPerch = -1, nookEnterAttempts = 0;
  let nookRetreat: P3 | null = null;
  const nookRead = (p: P3) => actor.blockAt(new Vec3(p.x, p.y, p.z)) ?? null;
  if (nookBuilder) out.nook = { builder: nookBuilder, kind: null, cells: [], designs: [], insideSeconds: 0, damageInside: 0, damageEvents: [],
    reflexKindsInside: {}, retreatPreemptsInside: 0, retreatStartsInside: 0, retreatExits: 0, exits: [], safetyVerified: false,
    measurement: '100ms occupancy samples; health loss includes all causes; reflex counts inside are completions, preempts are separate' };
  const stop = new AbortController();
  let view = endView(), sitting = false, windowOpen = false, window = 0, terminal: string | null = null, withdrawalNeeded = false;
  let scanSeen = false, stableGeometry = '', stableLooks = 0, lastLook: number | undefined;
  let pendingSample: Promise<void> = Promise.resolve(), sampleBusy = false, activeBed: P3 | null = null, bedExploded = false;
  let lastArrows = 64, lastBeds = 12;
  let nookAt = t0, wasInside = false, nookHp = Number(actor.health), nookMark = ledgerStart, nookCounts = { ...counts0 };
  let retreatWasActive = false, retreatBeganInside = false;
  const sampleNook = () => {
    if (!nookBuilder || terminal) return;
    const now = Date.now(), inside = !!nook && nookReady && insideDragonNook(nook, actor.entity.position, nookRead);
    if (wasInside && inside) out.nook.insideSeconds += (now - nookAt) / 1000;
    const hp = Number(actor.health);
    if (inside && hp < nookHp) {
      out.nook.damageInside += nookHp - hp;
      out.nook.damageEvents.push({ seconds: (now - t0) / 1000, lost: nookHp - hp, position: { ...actor.entity.position }, hazards: dragonHazards(actor) });
    }
    const counts = actor.reflexLedger.counts(), preempts = actor.reflexLedger.preemptsSince(nookMark);
    const capabilities = activeActionCapabilities(actor), retreatActive = capabilities.includes('floor-dragon');
    if (retreatActive && !retreatWasActive && (inside || wasInside)) { out.nook.retreatStartsInside++; retreatBeganInside = true; }
    if (inside || wasInside) {
      for (const [kind, count] of Object.entries(counts) as Array<[string, number]>) {
        const delta = count - (nookCounts[kind] ?? 0);
        if (delta > 0) out.nook.reflexKindsInside[kind] = (out.nook.reflexKindsInside[kind] ?? 0) + delta;
      }
      out.nook.retreatPreemptsInside += preempts.filter((p: any) => p.by === 'floor-dragon').length;
    }
    if (wasInside && !inside) {
      const retreatExit = retreatBeganInside || retreatActive || preempts.some((p: any) => p.by === 'floor-dragon');
      if (retreatExit) out.nook.retreatExits++;
      out.nook.exits.push({ seconds: (now - t0) / 1000, position: { ...actor.entity.position }, preempts, capabilities,
        cause: retreatExit ? 'dragon_retreat_observed' : preempts.length ? 'reflex_preemption_observed' : 'unattributed_or_script_move' });
    }
    if (!retreatActive) retreatBeganInside = false;
    retreatWasActive = retreatActive;
    nookAt = now; wasInside = inside; nookHp = hp; nookMark = actor.reflexLedger.mark(); nookCounts = { ...counts };
  };
  const elapsed = () => (Date.now() - t0) / 1000;
  const finish = (reason: string) => {
    if (terminal) return;
    sampleNook();
    if (reason === 'dragon_dead' && Date.now() > deadline) reason = 'time_limit';
    terminal = reason; out.endReason = reason; out.seconds = Math.min(KILL_LIMIT_MS / 1000, elapsed());
    if (out.windows.length && out.windows.at(-1).endedSeconds === null) out.windows.at(-1).endedSeconds = out.seconds;
    samplePack(); out.minHealth = lowest.stop(); out.deaths = actorDeaths - deaths0;
    const counts = actor.reflexLedger.counts();
    for (const [kind, n] of Object.entries(counts) as Array<[string, number]>) { const used = n - (counts0[kind] ?? 0); if (used > 0) out.reflexKinds[kind] = used; }
    out.dragonHealthEnd = view?.dragon?.health ?? null;
    out.lastObservation = { actorHealth: Number(actor.health), position: { ...actor.entity.position }, dragon: view?.dragon ?? null,
      hazards: dragonHazards(actor), recentReflexes: actor.reflexLedger.entriesSince(ledgerStart) };
    if (reason === 'dragon_dead') { out.killSeconds = out.seconds; out.dragonHealthEnd = 0; }
    if (reason === 'time_limit') out.dragonHealthAt25Minutes = out.dragonHealthEnd;
    stop.abort(reason);
  };
  const onDead = (e: any) => { if (e?.id === initial.dragonId) finish('dragon_dead'); };
  const onDeath = () => finish('actor_dead');
  const onExplosion = (packet: any) => {
    const p = packet?.center ?? packet;
    if (activeBed && typeof p?.x === 'number' && Math.hypot(p.x - activeBed.x, p.y - activeBed.y, p.z - activeBed.z) < 3) { bedExploded = true; killBlasts.push({ ...activeBed }); }
  };
  const samplePack = () => {
    if (actorDeaths > deaths0 || Number(actor.health) <= 0) return;
    const arrows = packCount('arrow'), beds = packCount('white_bed');
    // Sum decreases, rather than initial-final: a recovered arrow is allowed to be fired again.
    out.arrowsUsed += Math.max(0, lastArrows - arrows); out.bedsUsed += Math.max(0, lastBeds - beds);
    lastArrows = arrows; lastBeds = beds;
  };
  const watch = () => {
    if (terminal) return;
    view = endView(); samplePack(); sampleNook();
    if (actorDeaths > deaths0 || Number(actor.health) <= 0) { finish('actor_dead'); return; }
    if (disconnected) { finish('disconnected'); return; }
    const d = view?.dragon;
    // Disappearance alone is never a kill. Wait for entityDead (and then the existing boss proof).
    if (d?.health !== null && d?.health !== undefined && d.health <= 0) { finish('dragon_dead'); return; }
    if (Date.now() >= deadline) { finish('time_limit'); return; }
    if (!d) return;
    if (isPerched(d.phase) && !sitting) {
      sitting = true; scanSeen = false; stableGeometry = ''; stableLooks = 0; lastLook = undefined;
      out.perches.push({ n: ++out.perchCount, seconds: elapsed(), health: d.health, meleeHitWindows: 0, explosionsHit: 0 });
    }
    if (!isPerched(d.phase) && sitting) { sitting = false; out.perches.at(-1).endedSeconds = elapsed(); }
    if (d.phase === 6) scanSeen = true;
    if (isPerched(d.phase) && scanSeen) {
      const geometry = nookBuilder ? JSON.stringify([d.position, d.yaw]) : killGeometry(d);
      if (geometry !== stableGeometry) { stableGeometry = geometry; stableLooks = 0; lastLook = undefined; }
      // phaseFor distinguishes a new observation from another read of the same one; it is not a delay threshold.
      if (d.phaseFor === undefined || d.phaseFor !== lastLook) { stableLooks++; lastLook = d.phaseFor; }
    }
    const open = isPerched(d.phase) && d.windows?.open === true;
    if (windowOpen && !open && style !== 'bow') withdrawalNeeded = true;
    if (windowOpen && !open && out.windows.length) out.windows.at(-1).endedSeconds = elapsed();
    if (open && !windowOpen) { window++; out.windows.push({ n: window, perch: out.perchCount, seconds: elapsed(), endedSeconds: null, swordAttempts: 0, meleeHit: false, bedExplosions: 0, explosionHit: false }); }
    windowOpen = open;
  };
  actor.on('entityDead', onDead); actor.on('death', onDeath); actor._client.on('explosion', onExplosion); actor.on('health', sampleNook);
  watch();
  const watchTimer = setInterval(watch, 100);
  const endTimer = setTimeout(() => { view = endView(); finish('time_limit'); }, Math.max(0, deadline - Date.now()));
  const sampleTimer = setInterval(() => {
    if (terminal || sampleBusy) return;
    sampleBusy = true;
    const seconds = elapsed();
    pendingSample = (async () => {
      const health = await dragonHealthServer();
      out.healthTimeline.push({ seconds, readAtSeconds: elapsed(), health, source: 'server' });
    })().catch(error => { out.sampleError = String(error); }).finally(() => { sampleBusy = false; });
  }, 5000);
  const perform = async (label: string, hands: Array<Record<string, unknown>>, seconds: number, allowed?: () => boolean, execute?: (signal: AbortSignal) => ReturnType<typeof act>, retreatTarget?: P3) => {
    const controller = new AbortController(), abort = () => controller.abort(stop.signal.reason);
    stop.signal.addEventListener('abort', abort, { once: true });
    if (stop.signal.aborted) abort();
    const origin = { ...actor.entity.position };
    let previous = origin, walked = 0, routeRefused: ReturnType<typeof killRetreatRoute> | null = null;
    const checkRoute = (route: P3[] = []) => {
      if (!retreatTarget || controller.signal.aborted) return;
      const here = { ...actor.entity.position };
      walked += Math.hypot(here.x - previous.x, here.y - previous.y, here.z - previous.z); previous = here;
      const result = killRetreatRoute(origin, retreatTarget, here, walked, route);
      if (result.reason) { routeRefused = result; controller.abort(result.reason); }
    };
    // pathfinder emits the proposed way before walking it, including each redraw. The script cancels the hand, never the reflex.
    const onRoute = (result: any) => checkRoute(result?.path ?? []);
    if (retreatTarget) actor.on('path_update', onRoute);
    const check = () => { checkRoute(); if (allowed && !allowed()) controller.abort('script_observation_changed'); };
    check(); const timer = setInterval(check, 50);
    const before = actor.reflexLedger.mark(), at = elapsed();
    try {
      const run = await (execute ? execute(controller.signal) : act(hands, Math.min(seconds, Math.max(0.05, (deadline - Date.now()) / 1000)), {}, controller.signal));
      const cut = (actor.reflexLedger.preemptsSince(before)?.length ?? 0) > 0 || /反射/u.test(run.lines.join(' '));
      const abortReason = controller.signal.aborted ? String(controller.signal.reason) : null;
      out.actions.push({ seconds: at, label, hands, ok: run.ok, ms: run.ms, cut, aborted: controller.signal.aborted, abortReason,
        interruptions: [...(cut ? ['reflex'] : []), ...(abortReason ? [abortReason] : [])], ...(retreatTarget ? { routeRefused } : {}), lines: run.lines,
        actorHealth: Number(actor.health), position: { ...actor.entity.position } });
      samplePack(); return { ...run, cut, aborted: controller.signal.aborted };
    } finally { clearInterval(timer); actor.removeListener('path_update', onRoute); stop.signal.removeEventListener('abort', abort); }
  };
  const go = (label: string, p: P3, allowed?: () => boolean) => perform(label, [{ do: 'go', to: killCell(p), range: 0.5, seconds: 10 }], 15, allowed);
  const open = () => !terminal && isPerched(view?.dragon?.phase) && view?.dragon?.windows?.open === true;
  const perched = () => !terminal && isPerched(view?.dragon?.phase);
  const flying = (d: any) => !!d && Number.isInteger(d.phase) && d.phase >= 0 && d.phase <= 10 && !isPerched(d.phase) && d.phase !== 9;
  let plan: ReturnType<typeof chooseKillPlan> = null, planGeometry = '', planPerch = 0, staged = false, stageAttempts = 0, triedObservation = '', usedWindow = -1, retreatDone = false;
  let bedLayout: ReturnType<typeof killBedLayout> = null, bedReady = false, bedTried = false;
  let skippedPerch = -1;
  const safeAt = (p: P3) => {
    const d = view?.dragon;
    return !!d && approachClear(actor, d, p) && standing(bodyReader(actor), killCell(p));
  };
  const safeHere = () => safeAt(actor.entity.position) && dragonHazards(actor).length === 0;
  const succeeded = (run: { ok: boolean; cut: boolean; aborted: boolean }) => run.ok && !run.cut && !run.aborted;
  const placeKillBed = async (foot: P3, partner: P3, allowed: () => boolean) => {
    for (const p of [foot, partner]) killPlaced.set(`${p.x},${p.y},${p.z}`, p);
    return bedHalves(nookRead(foot), foot) ? { ok: true, cut: false }
      : perform('bed_place', [{ do: 'place', block: 'white_bed', at: [foot] }], 10, allowed);
  };
  const sameNookHead = (d: any) => !!d && nookStamp === JSON.stringify([d.position, d.yaw]);
  // One cell/hand at a time; an interrupted cell is observed before any continuation. No weakening of a reflex or operator healing.
  const buildNook = async () => {
    if (!nook) return false;
    const held = nook;
    const refused = (reason: string, cell?: P3) => { out.nook.buildRefusals ??= []; out.nook.buildRefusals.push({ seconds: elapsed(), perch: out.perchCount, reason, cell }); return false; };
    const allowed = () => !terminal && isPerched(endView()?.dragon?.phase) && sameNookHead(endView()?.dragon);
    const reachable = (p: P3) => Math.hypot(p.x + 0.5 - actor.entity.position.x, p.y + 0.5 - actor.entity.position.y - 1.62, p.z + 0.5 - actor.entity.position.z) <= BLOCK_REACH;
    const occupies = (feet: P3, p: P3) => feet.x + 0.3 > p.x && feet.x - 0.3 < p.x + 1 && feet.z + 0.3 > p.z && feet.z - 0.3 < p.z + 1 && feet.y + 1.8 > p.y && feet.y < p.y + 1;
    for (const cell of held.cells) {
      if (!allowed()) return refused('perch_or_geometry_changed', cell);
      if (cell.role === 'scaffold' && held.requiredCells.every(p => nookRead(p)?.boundingBox === 'block')) continue;
      if (nookRead(cell)?.name === cell.block) continue;
      if (!/^(air|cave_air|void_air)$/u.test(nookRead(cell)?.name ?? '')) return refused('cell_obstructed_or_unloaded', cell);
      if (nookBuilder === 'body' && packCount(cell.block) < 1) return refused('insufficient_material', cell);
      if (nookBuilder === 'body' && (!reachable(cell) || occupies(actor.entity.position, cell))) {
        const d = endView()?.dragon;
        const ground = walkGround(actor, { deadline: performance.now() + 80, maxCells: 1600, radius: 24, safe: p => approachClear(actor, d, p) });
        const nodes = ground.cells.filter(node => {
          const p = feetCentre(node.cell);
          return !occupies(p, cell) && Math.hypot(p.x - cell.x - 0.5, p.y + 1.62 - cell.y - 0.5, p.z - cell.z - 0.5) <= BLOCK_REACH;
        }).sort((a, b) => a.walkMeters - b.walkMeters);
        if (!nodes[0] || !succeeded(await go('nook_build_position', feetCentre(nodes[0].cell), allowed))) return refused('no_reachable_build_position', cell);
      }
      if (nookBuilder === 'body' && (!reachable(cell) || !nookCellSupported(nookRead, cell))) return refused('reach_or_face_missing', cell);
      killPlaced.set(`${cell.x},${cell.y},${cell.z}`, cell);
      const run = nookBuilder === 'body'
        ? await perform('nook_place', [{ do: 'place', block: cell.block, at: [killCell(cell)] }], 10, allowed)
        : await perform('nook_operator_place', [], 5, allowed, async signal => {
          if (signal.aborted) return { ok: false, lines: ['aborted'], parsed: null, ms: 0 };
          const at = Date.now(); const answer = await ask(`${END} setblock ${cell.x} ${cell.y} ${cell.z} ${cell.block} keep`);
          return { ok: nookRead(cell)?.name === cell.block, lines: [answer], parsed: null, ms: Date.now() - at };
        });
      if (!succeeded(run) || nookRead(cell)?.name !== cell.block) return refused('place_interrupted_or_unconfirmed', cell);
    }
    // Cobblestone columns are temporary: a lateral impact there can put the cloud at body height.
    for (const p of held.dig) {
      if (/^(air|cave_air|void_air)$/u.test(nookRead(p)?.name ?? '')) continue;
      if (!allowed() || nookRead(p)?.name !== 'cobblestone') return refused('dig_geometry_or_block_changed', p);
      if (nookBuilder === 'body' && !reachable(p)) {
        if (!succeeded(await go('nook_dig_position', held.stand, allowed)) || !reachable(p)) return refused('dig_out_of_reach', p);
      }
      const run = nookBuilder === 'body'
        ? await perform('nook_dig_scaffold', [{ do: 'dig', at: [p] }], 20, allowed)
        : await perform('nook_operator_dig', [], 5, allowed, async signal => {
          if (signal.aborted) return { ok: false, lines: ['aborted'], parsed: null, ms: 0 };
          const at = Date.now(); const answer = await ask(`${END} setblock ${p.x} ${p.y} ${p.z} air replace`);
          return { ok: /^(air|cave_air|void_air)$/u.test(nookRead(p)?.name ?? ''), lines: [answer], parsed: null, ms: Date.now() - at };
        });
      if (!succeeded(run) || !/^(air|cave_air|void_air)$/u.test(nookRead(p)?.name ?? '')) return refused('dig_interrupted_or_unconfirmed', p);
    }
    return true;
  };
  let withdrawFailingSince = 0;
  const withdraw = async (label: string, toRetreat = false) => {
    if (terminal) return false;
    staged = false;
    const settled = (p: P3) => {
      staged = !toRetreat && !!plan && JSON.stringify(killCell(p)) === JSON.stringify(killCell(plan.stage));
      retreatDone = !staged; withdrawalNeeded = false; withdrawFailingSince = 0; return true;
    };
    const staySafe = () => {
      watch();
      if (terminal || !safeHere()) return false;
      out.actions.push({ seconds: elapsed(), label, hands: [], ok: true, ms: 0, cut: false, aborted: false,
        abortReason: null, interruptions: [], lines: ['already_safe'], actorHealth: Number(actor.health), position: { ...actor.entity.position } });
      return settled(actor.entity.position);
    };
    if (label === 'window_closed' && staySafe()) return true;
    const tried = new Set<string>();
    for (let attempt = 0; attempt < 3 && !terminal; attempt++) {
      watch();
      const d = view?.dragon;
      const distance = (p: P3) => Math.hypot(p.x - actor.entity.position.x, p.y - actor.entity.position.y, p.z - actor.entity.position.z);
      const candidates: P3[] = [...(!toRetreat && isPerched(d?.phase) && plan ? [plan.stage] : []),
        ...[...(d?.approach?.retreat ?? []), ...(plan?.retreat ? [plan.retreat] : [])].sort((a, b) => distance(a) - distance(b))];
      const p = candidates.find(p => !tried.has(JSON.stringify(killCell(p))) && safeAt(p));
      if (!p) break;
      tried.add(JSON.stringify(killCell(p)));
      const target = feetCentre(killCell(p));
      const back = await perform(label, [{ do: 'go', to: killCell(p), range: 0.5, maxDrop: 1, seconds: 5 }], 6,
        () => !terminal && safeAt(p), undefined, target);
      if (succeeded(back) && safeHere()) {
        return settled(p);
      }
      toRetreat = true; label = 'withdraw_retreat';
    }
    if (terminal) return false;
    if (staySafe()) return true;
    // no safe cell this time: the run goes on (the next look may find one); it ends only when none has been found for 90 s in a row (the floor reflexes keep the body safe meanwhile)
    withdrawFailingSince ||= Date.now(); await sleep(500);
    if (!terminal && Date.now() - withdrawFailingSince >= 90_000) finish('retreat_failed');
    return false;
  };
  try {
    while (!terminal) {
      watch(); if (terminal) break;
      const d = view?.dragon;
      if (nookBuilder && d && isPerched(d.phase) && skippedPerch !== out.perchCount) {
        if (nook && !sameNookHead(d)) { nookReady = false; nook = null; nookRetreat = null; staged = false; plan = null; }
        if (!nookReady && nookAttemptPerch !== out.perchCount) {
          if (!nook && (!scanSeen || stableLooks < 3)) { await sleep(100); continue; }
          nookAttemptPerch = out.perchCount;
          if (!nook) {
            const design = dragonNook(view, nookRead, style === 'bed');
            out.nook.designs.push({ seconds: elapsed(), perch: out.perchCount, ...design });
            nook = design.plan;
            if (nook) { nookStamp = JSON.stringify([d.position, d.yaw]); Object.assign(out.nook, nook); }
          }
          if (nook) { nookReady = await buildNook(); out.nook.ready = nookReady; }
          continue;
        }
        if (nookReady && nook) {
          if (!nook.requiredCells.every(p => nookRead(p)?.boundingBox === 'block')) { nookReady = false; out.nook.ready = false; skippedPerch = out.perchCount; continue; }
          if (planPerch !== out.perchCount) { staged = false; retreatDone = false; }
          if (nookEnterPerch !== out.perchCount) { nookEnterPerch = out.perchCount; nookEnterAttempts = 0; }
          nookRetreat = d.approach?.retreat?.[0] ?? nookRetreat;
          plan = { stage: { ...nook.stand, toStrikeMeters: 0, strikeIndex: 0 }, strike: { ...nook.strike }, retreat: nookRetreat };
          planPerch = out.perchCount; planGeometry = killGeometry(d); bedTried = style === 'bed';
          bedLayout = nook.bed ? { ...nook.bed, cells: [] } : null; bedReady = !!nook.bed;
          if ((!staged || !insideDragonNook(nook, actor.entity.position, nookRead)) && !withdrawalNeeded) {
            if (nookEnterAttempts >= 3) { skippedPerch = out.perchCount; await withdraw('nook_enter_limit', true); continue; }
            nookEnterAttempts++;
            staged = succeeded(await go('nook_enter', nook.stand, () => perched() && !!nook && safeAt(nook.stand))) && safeHere();
            if (!staged) { await withdraw('nook_enter_failed', true); skippedPerch = out.perchCount; }
            continue;
          }
        } else { await sleep(100); continue; }
      }
      if (style !== 'bow' && withdrawalNeeded) { await withdraw('window_closed', skippedPerch === out.perchCount || retreatDone); continue; }
      if (style !== 'bow' && !safeHere()) { await withdraw('unsafe_wait_retreat', true); continue; }
      if (!d || d.phase === 9) { await sleep(100); continue; }
      if (d.phase === 4 && plan?.retreat && !retreatDone) { await withdraw('takeoff_retreat', true); continue; }
      if (style === 'bow') {
        if (flying(d) && packCount('arrow') > 0) await perform('flying_bow', [{ do: 'shoot', target: 'ender_dragon', n: 1, charge: 1.05 }], 10, () => !terminal && flying(view?.dragon));
        else await sleep(100);
        continue;
      }
      if (!isPerched(d.phase)) { await sleep(100); continue; }
      if (skippedPerch === out.perchCount) { await sleep(100); continue; }
      if (planPerch !== out.perchCount) { plan = null; planPerch = out.perchCount; staged = false; stageAttempts = 0; triedObservation = ''; retreatDone = false; bedLayout = null; bedReady = false; bedTried = false; }
      if (plan && !bedTried && planGeometry !== killGeometry(d)) { plan = null; staged = false; }
      if (!staged) {
        if (!scanSeen || stableLooks < 3 || stageAttempts >= 3 || triedObservation === killStageObservation(d)) { await sleep(100); continue; }
        plan = chooseKillPlan(d);
        if (!plan) { await sleep(100); continue; }
        planGeometry = killGeometry(d);
        stageAttempts++; triedObservation = killStageObservation(d);
        const attempted = plan;
        const run = await go('stage', attempted.stage, () => perched() && safeAt(attempted.stage));
        Object.assign(out.actions.at(-1), { perch: out.perchCount, stageAttempt: stageAttempts, observation: triedObservation,
          phase: d.phase, phaseFor: d.phaseFor, stage: attempted.stage, strike: attempted.strike });
        staged = succeeded(run) && safeHere();
        if (!staged) { await withdraw('stage_failed_retreat', true); plan = null; }
        continue;
      }
      if (!plan) { await sleep(100); continue; }
      // Prepare a nook's bed before the short window. Actual halves and blast damage are still checked again at use time below.
      if (nookBuilder && style === 'bed' && bedReady && bedLayout && !open() && !bedHalves(nookRead(bedLayout.foot), bedLayout.foot) && packCount('white_bed') > 0) {
        const placed = await placeKillBed(bedLayout.foot, bedLayout.partner, () => perched() && safeHere() && sameNookHead(endView()?.dragon));
        if (!placed.ok || placed.cut) { skippedPerch = out.perchCount; await withdraw('nook_bed_unready_retreat', true); }
        continue;
      }
      // Build the reusable screen/support while waiting, not during the measured ~2.5-second strike window.
      if (style === 'bed' && staged && !bedTried) {
        bedTried = true;
        const refused = new Set<string>(), read = (p: P3) => actor.blockAt(new Vec3(p.x, p.y, p.z)) ?? null;
        let buildCut = false;
        for (let alternative = 0; alternative < 3 && !terminal && !withdrawalNeeded; alternative++) {
          bedLayout = killBedLayout(endView()?.dragon ?? d, plan, alternative);
          const layoutRecord: Record<string, any> = { seconds: elapsed(), label: 'bed_layout', alternative, layout: bedLayout, ready: false };
          out.actions.push(layoutRecord);
          if (!bedLayout) { layoutRecord.refused = 'no_observed_anchor'; continue; }
          if (bedLayout.cells.length > packCount('obsidian')) { layoutRecord.refused = 'insufficient_obsidian'; continue; }
          if (bedLayout.cells.some(p => refused.has(JSON.stringify(p)))) { layoutRecord.refused = 'previously_refused_cell'; continue; }
          bedReady = true;
          for (const p of bedLayout.cells) {
            // Only a freshly observed face supports the next hand. Never send the whole speculative column.
            const eye = actor.entity.position;
            if (!bedCellSupported(read, p) || Math.hypot(p.x + 0.5 - eye.x, p.y + 0.5 - eye.y - 1.62, p.z + 0.5 - eye.z) > BLOCK_REACH) {
              refused.add(JSON.stringify(p)); bedReady = false;
              layoutRecord.refused = 'face_missing_or_out_of_reach'; layoutRecord.cell = p; break;
            }
            killPlaced.set(`${p.x},${p.y},${p.z}`, p);
            const built = await perform('bed_screen_support', [{ do: 'place', block: 'obsidian', at: [p] }], 5, () => perched() && !withdrawalNeeded && safeHere());
            if (!succeeded(built) || read(p)?.name !== 'obsidian') {
              refused.add(JSON.stringify(p)); bedReady = false; buildCut = built.cut || built.aborted;
              layoutRecord.refused = 'placement_failed_or_unconfirmed'; layoutRecord.cell = p; break;
            }
          }
          layoutRecord.ready = bedReady;
          if (bedReady || buildCut || terminal || withdrawalNeeded || !safeHere()) break;
        }
        if (!bedReady || withdrawalNeeded || !safeHere()) { bedReady = false; skippedPerch = out.perchCount; await withdraw('bed_unready_retreat', true); }
        continue;
      }
      if (!staged || !open() || usedWindow === window) { await sleep(100); continue; }
      usedWindow = window;
      const row = out.perches.at(-1), windowRow = out.windows.at(-1), before = d.health;
      if (style === 'sword_stage') {
        const reached = await go('strike', plan.strike, open);
        if (reached.ok && !reached.cut && !reached.aborted && open()) {
          windowRow.swordAttempts++;
          await perform('sword', [{ do: 'equip', item: 'stone_sword' }, { do: 'attack', target: 'ender_dragon', untilDead: false, seconds: 6 }], 10, open);
          const after = endView()?.dragon?.health ?? (terminal === 'dragon_dead' ? 0 : null);
          if (before !== null && after !== null && after < before) { row.meleeHitWindows++; out.meleeHitWindows++; windowRow.meleeHit = true; }
        }
      } else if (bedReady && bedLayout && packCount('white_bed') > 0) {
        const { foot, partner } = bedLayout;
        const trial: Record<string, any> = { seconds: elapsed(), foot, partner, wallBottom: bedLayout.wallBottom, wallTop: bedLayout.wallTop,
          wallHeight: bedLayout.wallHeight, standingAt: { ...actor.entity.position }, expectedDamage: null, actualDamage: null, exploded: false };
        out.bedTrials.push(trial);
        const placed = await placeKillBed(foot, partner, open);
        const guess = perchBedEstimate(foot);
        trial.placedHalves = bedHalves(actor.blockAt(new Vec3(foot.x, foot.y, foot.z)), foot);
        trial.expectedDamage = guess?.expected ?? null;
        out.actions.push({ seconds: elapsed(), label: 'bed_estimate', foot, wallHeight: bedLayout.wallHeight, estimate: guess });
        if (placed.ok && !placed.cut && open() && guess?.safe && Number.isFinite(guess.expected) && guess.expected <= 4) {
          const halves = bedHalves(actor.blockAt(new Vec3(foot.x, foot.y, foot.z)), foot)!;
          activeBed = { x: halves.head.x + 0.5, y: halves.head.y + 0.5, z: halves.head.z + 0.5 }; bedExploded = false;
          const hpBefore = Number(actor.health); let minHp = hpBefore;
          const health = () => { minHp = Math.min(minHp, Number(actor.health)); };
          actor.on('health', health);
          try { await perform('bed_use', [], 12, open, signal => usePerchBed(foot, signal)); }
          finally { health(); actor.removeListener('health', health); activeBed = null;
            Object.assign(trial, { hpBefore, hpAfter: Number(actor.health), actualDamage: bedExploded ? Math.max(0, hpBefore - minHp) : null,
              damageObservation: 'health minimum during use hand; other hits may overlap', exploded: bedExploded }); }
          const after = endView()?.dragon?.health ?? (terminal === 'dragon_dead' ? 0 : null);
          if (bedExploded) windowRow.bedExplosions++;
          if (bedExploded && before !== null && after !== null && after < before) { row.explosionsHit++; out.explosionsHit++; windowRow.explosionHit = true; }
        }
      }
      // Leave the strike when the window closes or a reflex cuts it. Phase 4 uses the retained retreat instead.
      if (!terminal) await withdraw('withdraw_stage', !isPerched(view?.dragon?.phase));
    }
  } catch (error) { out.error = String((error as Error)?.stack ?? error).slice(0, 800); finish('error'); }
  finally {
    clearInterval(watchTimer); clearInterval(sampleTimer); clearTimeout(endTimer); stop.abort('run_finished');
    actor.removeListener('entityDead', onDead); actor.removeListener('death', onDeath); actor._client.removeListener('explosion', onExplosion); actor.removeListener('health', sampleNook);
    await pendingSample;
    if (terminal === 'time_limit') {
      out.dragonHealthAt25Minutes = await dragonHealthServer(); out.dragonHealthEnd = out.dragonHealthAt25Minutes;
    }
    out.minHealth ??= lowest.stop();
    out.perchesHit = out.perches.filter((p: any) => p.meleeHitWindows > 0 || p.explosionsHit > 0).length;
    out.perchesMeleeHit = out.perches.filter((p: any) => p.meleeHitWindows > 0).length;
    out.perchesExplosionHit = out.perches.filter((p: any) => p.explosionsHit > 0).length;
    out.healthTimeline.push({ seconds: out.seconds, health: out.dragonHealthEnd, source: 'terminal_observation' });
    out.healthLossPerSecond = typeof out.dragonHealthEnd === 'number' && out.seconds > 0 ? round((200 - out.dragonHealthEnd) / out.seconds, 4) : null;
  }
  if (terminal === 'dragon_dead') {
    const proofDeadline = Date.now() + 15_000;
    do {
      const proof = await evidence(); out.boss = proof?.boss ?? null;
      if (out.boss?.verified === true && out.boss?.witness?.entityId === initial.dragonId) break;
      await sleep(250);
    } while (Date.now() < proofDeadline && !disconnected && actorDeaths === deaths0);
    // Old kills on this connection must never verify this run.
    out.bossVerified = out.boss?.verified === true && out.boss?.witness?.entityId === initial.dragonId;
  }
  out.ok = out.deaths === 0 && out.killSeconds !== null && out.killSeconds <= KILL_LIMIT_MS / 1000 && out.bossVerified === true;
  return out;
}

scenes.dragon_kill_sword = () => dragonKillRun('sword_stage');
scenes.dragon_kill_bed = () => dragonKillRun('bed');
scenes.dragon_kill_bow = () => dragonKillRun('bow');
// CLI option, never an environment switch. The operator and body use exactly the same geometry and measurement loop.
const killNookBuilder = (): KillNookBuilder => {
  const values = process.argv.filter(arg => arg.startsWith('--nook-builder='));
  if (values.length > 1 || (values.length === 1 && !['--nook-builder=operator', '--nook-builder=body'].includes(values[0]))) throw new Error('use --nook-builder=operator or --nook-builder=body');
  return values[0] === '--nook-builder=body' ? 'body' : 'operator';
};
scenes.dragon_kill_sword_nook = () => dragonKillRun('sword_stage', killNookBuilder());
scenes.dragon_kill_bed_nook = () => dragonKillRun('bed', killNookBuilder());
// Feasibility baseline, not a method: the sword strike with the walking taken out. At each open window the body is put (tp) on the strike cell the observation names and strikes
// for as long as the window is open; then it is put back on the ground cell. Floor reflexes stay ON. It measures what a strike costs and gives when the body is already there.
const swordAssist = async (mode: 'strike' | 'stage') => {
  const initial = await prepareKillRun();
  const t0 = Date.now(), deadline = t0 + KILL_LIMIT_MS, deaths0 = actorDeaths, lowest = trackMinHealth(), counts0 = actor.reflexLedger.counts();
  const elapsed = () => (Date.now() - t0) / 1000;
  const windows: Array<Record<string, any>> = [];
  let endReason = 'time_limit', usedWindow = -1, windowId = 0, wasOpen = false;
  let dragonDead = false, stagedPerch = false;
  const onDead = (e: any) => { if (e?.id === initial.dragonId) dragonDead = true; };
  actor.on('entityDead', onDead);
  try {
    while (Date.now() < deadline) {
      if (actorDeaths > deaths0) { endReason = 'actor_dead'; break; }
      if (dragonDead) { endReason = 'dragon_dead'; break; }
      const d = endView()?.dragon;
      if (mode === 'stage' && d && !isPerched(d.phase)) stagedPerch = false;
      // the waiting cell is given (tp) once the head has settled and the plan stands, before the window
      if (mode === 'stage' && d && isPerched(d.phase) && !stagedPerch) { const early = chooseKillPlan(d); if (early) { stagedPerch = true; await standAt(early.stage.x, early.stage.y, early.stage.z); continue; } }
      const open = !!d && isPerched(d.phase) && d.windows?.open === true && (d.windows.remainingSeconds?.[0] ?? 0) >= (mode === 'stage' ? 0.6 : 1.0);
      if (open && !wasOpen) windowId++;
      wasOpen = open;
      if (!open || usedWindow === windowId) { await sleep(100); continue; }
      const plan = chooseKillPlan(d);
      if (!plan) { await sleep(100); continue; }
      usedWindow = windowId;
      const row: Record<string, any> = { n: windowId, seconds: elapsed(), dragonBefore: d.health, hpBefore: Number(actor.health), strike: plan.strike, mode };
      if (mode === 'strike') await standAt(plan.strike.x, plan.strike.y, plan.strike.z);
      else {
        // the walk from the waiting cell to the strike cell is the body's own, at the open window
        const walk = await act([{ do: 'go', to: killCell(plan.strike), range: 0.5, seconds: 5 }], 8);
        row.walk = { ok: walk.ok, ms: walk.ms, line: walk.lines.join(' | ').slice(0, 160), stillOpen: endView()?.dragon?.windows?.open === true };
      }
      const swing = await act([{ do: 'equip', item: 'stone_sword' }, { do: 'attack', target: 'ender_dragon', untilDead: false, seconds: 3 }], 8);
      row.hand = { ok: swing.ok, line: swing.lines.join(' | ').slice(0, 200) };
      row.dragonAfter = endView()?.dragon?.health ?? null; row.hpAfter = Number(actor.health);
      row.at = { ...actor.entity.position };
      await standAt(initial.ground.x, initial.ground.y, initial.ground.z);
      row.died = actorDeaths > deaths0;
      windows.push(row);
    }
  } finally { actor.removeListener('entityDead', onDead); }
  const counts = actor.reflexLedger.counts(), reflexKinds: Record<string, number> = {};
  for (const [kind, n] of Object.entries(counts) as Array<[string, number]>) { const used = n - (counts0[kind] ?? 0); if (used > 0) reflexKinds[kind] = used; }
  const health = await dragonHealthServer().catch(() => null);
  return { scene: 'dragon_kill_compare', style: 'sword_assist', endReason, seconds: elapsed(), killSeconds: endReason === 'dragon_dead' ? elapsed() : null, deaths: actorDeaths - deaths0,
    minHealth: lowest.stop(), dragonHealthEnd: health, windows, reflexKinds, ok: endReason === 'dragon_dead' && actorDeaths === deaths0 };
};
/** Lab HEAD's waiting choice, relative to the first observed perch/facing; basin destinations belong entirely to the observation. */
function basinWaitingCell(view: ReturnType<typeof endObservation>): P3 | null {
  const centre = view?.perch, d = view?.dragon;
  if (!centre || !d) return null;
  const read = bodyReader(actor), facing = { x: Math.sin(d.yaw), z: Math.cos(d.yaw) };
  const cells: Array<{ p: P3; score: number }> = [];
  for (let dx = -14; dx <= 14; dx++) for (let dz = -14; dz <= 14; dz++) {
    const x = Math.floor(centre.x) + dx, z = Math.floor(centre.z) + dz;
    const rx = x + 0.5 - centre.x, rz = z + 0.5 - centre.z, r = Math.hypot(rx, rz);
    if (r < 10 || r > 14) continue;
    const side = Math.abs((rx * facing.x + rz * facing.z) / r);
    if (side > 0.25) continue;
    for (let y = Math.floor(centre.y) + 1; y >= centre.y - 32; y--) {
      if (!standing(read, { x, y, z })) continue;
      const p = feetCentre({ x, y, z });
      cells.push({ p, score: side * 100 + Math.abs(r - 12) + Math.hypot(p.x - actor.entity.position.x, p.z - actor.entity.position.z) * 0.01 });
      break;
    }
  }
  cells.sort((a, b) => a.score - b.score);
  return cells[0]?.p ?? null;
}
// The tp baseline and the walking scene use the same first observed basin candidate. Floor reflexes stay ON;
// after entry, keep swinging throughout phases 6/7/5, independently of the short head-strike windows.
const basinAssist = async (mode: 'tp' | 'walk', pumpkin = false, keep: 'none' | 'all' | 'caged' = 'none') => {
  const initial = await prepareKillRun(true);
  // Crystal-count experiment: the crystals the experiment keeps are put back where they stood (the dragon heals while one lives); the dragon's health is sampled every 5 s.
  const keptCrystals = killCrystalSnapshot.filter(c => keep === 'all' || (keep === 'caged' && c.caged === true));
  for (const c of keptCrystals) await ask(`${END} summon minecraft:end_crystal ${c.x} ${c.y} ${c.z} {ShowBottom:0b}`);
  const dragonSamples: Array<[number, number | null]> = [];
  const sampleT0 = Date.now();
  const sampleTimerCrystals = setInterval(() => { dragonSamples.push([Math.round((Date.now() - sampleT0) / 100) / 10, endView()?.dragon?.health ?? null]); }, 5000);
  // Endermen (the End island has them) take offence at eye contact; a carved pumpkin on the head ends that (it stands in for the iron helmet: two armour points less).
  if (pumpkin) { await ask(`give ${ACTOR} minecraft:carved_pumpkin 1`); await sleep(500); await act([{ do: 'equip', item: 'carved_pumpkin', slot: 'head' }], 8); }
  const t0 = Date.now(), deadline = t0 + KILL_LIMIT_MS, deaths0 = actorDeaths, lowest = trackMinHealth(), counts0 = actor.reflexLedger.counts();
  const elapsed = () => (Date.now() - t0) / 1000;
  const sits: Array<Record<string, any>> = [], transitions: Array<[number, number | null]> = [];
  let endReason = 'time_limit', dragonDead = false, lastPhase: number | null = null, sitId = 0, wasSitting = false, enteredSit = -1;
  let landingId = 0, lastLandingPhase: number | null = null, waitedLanding = -1;
  const waitingChosen: Array<Record<string, any>> = [];
  const onDead = (e: any) => { if (e?.id === initial.dragonId) dragonDead = true; };
  actor.on('entityDead', onDead);
  // the phase is watched on its own timer (the swinging loop below does not return for seconds): its changes, to 0.1 s
  const phaseTimer = setInterval(() => { const p = endView()?.dragon?.phase ?? null; if (p !== lastPhase) { lastPhase = p; transitions.push([Math.round(elapsed() * 10) / 10, p]); } }, 100);
  try {
    while (Date.now() < deadline) {
      if (actorDeaths > deaths0) { endReason = 'actor_dead'; break; }
      if (dragonDead) { endReason = 'dragon_dead'; break; }
      const view = endView(), d = view?.dragon;
      const sitting = !!d && isPerched(d.phase);
      if (sitting && !wasSitting) sitId++;
      wasSitting = sitting;
      // walking mode: the waiting cell is chosen sideways of the facing of THIS landing (the facing changes from landing to landing), taken once while it is still landing (phase 3, a few seconds in)
      if (mode === 'walk' && d && view?.perch && d.phase === 3 && d.phaseFor >= 3 && waitedLanding !== landingId) {
        waitedLanding = landingId;
        const waiting = basinWaitingCell(view);
        // no tp: the body walks to the waiting cell itself (a hand cut by a reflex is simply not completed; the next look decides)
        const wait = waiting ? await act([{ do: 'go', to: killCell(waiting), range: 1, seconds: 12 }], 16) : null;
        waitingChosen.push({ landing: landingId, seconds: elapsed(), waiting, yaw: d.yaw, walk: wait ? { ok: wait.ok, ms: wait.ms, line: wait.lines.join(' | ').slice(0, 160) } : null });
        continue;
      }
      if (d && d.phase === 3 && lastLandingPhase !== 3) landingId++;
      lastLandingPhase = d?.phase ?? null;
      // enter at the scan (phase 6) of a sit, once
      if (!d || !view?.perch || d.phase !== 6 || enteredSit === sitId) { await sleep(100); continue; }
      const cell = d.approach?.basin?.[0];
      if (!cell) { enteredSit = sitId; sits.push({ n: sitId, seconds: elapsed(), skipped: 'no proven basin walk', entryFailure: { noCandidate: true } }); continue; }
      enteredSit = sitId;
      const row: Record<string, any> = { n: sitId, seconds: elapsed(), cell, dragonBefore: d.health, hpBefore: Number(actor.health), phaseAtEntry: d.phase, hands: [] };
      const mark = actor.reflexLedger.mark(), seatStart = Date.now();
      row.mode = mode;
      if (mode === 'tp') await standAt(cell.x, cell.y, cell.z);
      else {
        // the walk from the waiting cell into the basin is the body's own
        const walk = await act([{ do: 'go', to: killCell(cell), range: 0.5, maxDrop: 1, seconds: 12 }], 16);
        const line = walk.lines.join(' | '), ledger = actor.reflexLedger.entriesSince(mark) ?? [];
        row.walk = { ok: walk.ok, ms: walk.ms, line, phaseAfter: endView()?.dragon?.phase ?? null,
          reflexes: ledger.map((e: any) => ({ kind: e.kind, outcome: e.outcome, detail: String(e.detail) })) };
        row.entryFailure = { reflex: /反射/u.test(line), reflexKinds: [...new Set(ledger.map((e: any) => e.kind))],
          deadEnd: /\bdead_end\b/u.test(line), limitTime: /\blimit_time\b/u.test(line) };
      }
      row.at = { ...actor.entity.position };
      let hp = Number(actor.health), minHp = hp;
      const onHealth = () => { minHp = Math.min(minHp, Number(actor.health)); };
      actor.on('health', onHealth);
      try {
        while (Date.now() < deadline && actorDeaths === deaths0 && !dragonDead) {
          const now = endView()?.dragon;
          if (!now || !isPerched(now.phase)) break;
          const swing = await act([{ do: 'equip', item: 'stone_sword' }, { do: 'attack', target: 'ender_dragon', untilDead: false, seconds: 12 }], 16);
          row.hands.push({ at: Math.round((Date.now() - seatStart) / 100) / 10, ok: swing.ok, ms: swing.ms, line: swing.lines.join(' | ').slice(0, 150) });
          if (row.hands.length >= 12) break;
          await sleep(150);
        }
      } finally { actor.removeListener('health', onHealth); }
      row.seatedSeconds = Math.round((Date.now() - seatStart) / 100) / 10;
      row.dragonAfter = endView()?.dragon?.health ?? null; row.hpAfter = Number(actor.health); row.minHp = minHp;
      row.ledger = (actor.reflexLedger.entriesSince(mark) ?? []).map((e: any) => `${e.kind}:${e.outcome}:${String(e.detail).slice(0, 80)}`).slice(0, 8);
      row.died = actorDeaths > deaths0;
      // The sit is over (take-off: phase 4 beats the wings hard within four blocks of the body; lab r115/r116/r119 threw the body 20 blocks up from the basin): the body leaves at once, to the cell sideways of
      // this sit's facing, 10 to 14 m off (by go); the tp baseline goes back by tp.
      if (mode === 'tp' && actorDeaths === deaths0 && !dragonDead) await standAt(initial.ground.x, initial.ground.y, initial.ground.z);
      else if (actorDeaths === deaths0 && !dragonDead) {
        const away = basinWaitingCell(endView());
        const left = away ? await act([{ do: 'go', to: killCell(away), range: 1, seconds: 12 }], 16) : null;
        row.leave = { to: away, ok: left?.ok ?? null, ms: left?.ms ?? null, line: left ? left.lines.join(' | ').slice(0, 160) : null, hpAfter: Number(actor.health) };
      }
      sits.push(row);
    }
  } finally { clearInterval(phaseTimer); clearInterval(sampleTimerCrystals); actor.removeListener('entityDead', onDead); }
  const counts = actor.reflexLedger.counts(), reflexKinds: Record<string, number> = {};
  for (const [kind, n] of Object.entries(counts) as Array<[string, number]>) { const used = n - (counts0[kind] ?? 0); if (used > 0) reflexKinds[kind] = used; }
  const health = await dragonHealthServer().catch(() => null);
  return { scene: 'dragon_kill_compare', style: 'basin_assist', endReason, seconds: elapsed(), killSeconds: endReason === 'dragon_dead' ? elapsed() : null, deaths: actorDeaths - deaths0,
    minHealth: lowest.stop(), dragonHealthEnd: health, waiting: initial.ground, waitingChosen, keptCrystals: keptCrystals.length, dragonSamples, windows: sits, transitions: transitions.slice(0, 400), reflexKinds, ok: endReason === 'dragon_dead' && actorDeaths === deaths0 };
};
scenes.dragon_kill_basin_assist = () => basinAssist('tp');
scenes.dragon_kill_basin_walk = () => basinAssist('walk');
scenes.dragon_kill_basin_walk_pumpkin = () => basinAssist('walk', true);
scenes.dragon_kill_basin_crystals_all = () => basinAssist('walk', false, 'all');
scenes.dragon_kill_basin_crystals_caged = () => basinAssist('walk', false, 'caged');
scenes.dragon_kill_sword_assist = () => swordAssist('strike');
scenes.dragon_kill_sword_assist_walk = () => swordAssist('stage');
scenes.dragon_kill_compare = async () => {
  const runs: Record<string, any> = {};
  for (const style of ['sword_stage', 'bed', 'bow'] as const) {
    try { runs[style] = await dragonKillRun(style); }
    catch (error) { runs[style] = { style, ok: false, error: String(error) }; }
    if (disconnected) break;
  }
  return { scene: 'dragon_kill_compare', runs, ok: Object.keys(runs).length === 3 && Object.values(runs).every(run => run.ok) };
};
// ===== end dragon_kill_compare =====

scenes.death = async () => {
  await protect(true);
  await flatten(); await gear(['diamond_sword']); await wear(); await hold('diamond_sword');
  const t0 = Date.now(); const events: Array<[number, string, unknown?]> = [];
  const rel = () => Date.now() - t0;
  const dragon0 = dragonEntity();
  const on = (name: string, fn: (...args: any[]) => unknown) => actor.on(name, fn);
  on('entityHurt', (e: any) => { if (e?.name === 'ender_dragon') events.push([rel(), 'entityHurt']); });
  on('entityDead', (e: any) => { if (e?.name === 'ender_dragon') events.push([rel(), 'entityDead']); });
  on('entityGone', (e: any) => { if (e?.name === 'ender_dragon') events.push([rel(), 'entityGone', { phase: dragonPhaseOf(actor, e), health: entityHealth(actor, e) }]); });
  actor._client.on('damage_event', (p: any) => { if (p?.entityId === dragon0?.id) events.push([rel(), 'damage_event', { cause: p.sourceCauseId, direct: p.sourceDirectId, type: p.sourceTypeId }]); });
  actor._client.on('advancements', (p: any) => { const mine = (p.progressMapping ?? []).find((e: any) => e.key === 'minecraft:end/kill_dragon'); events.push([rel(), 'advancements', { reset: p.reset, kill_dragon: mine ? mine.value : undefined }]); });
  let lastPhase: number | null = null;
  const phaseTimer = every(100, () => { const d = dragonEntity(); const p = d ? dragonPhaseOf(actor, d) : null; if (p !== lastPhase) { events.push([rel(), 'phase', p]); lastPhase = p; } });
  holdReflexOff();
  await perch(6); await standForHeadDistance(3.0); await sleep(1500);
  // The dragon at 6 health (one blow and a little): kept on the perch and the actor near its head, as in the hand scene; the crystals heal it, so it is kept low.
  const follow = every(1200, () => {
    const dragon = dragonEntity(); if (!dragon || phaseNow() === 9 || (entityHealth(actor, dragon) ?? 1) <= 0) return; // dying: leave it to die
    void standForHeadDistance(3.5); void ask(`${END} data modify entity ${DRAGON} DragonPhase set value 6`); void ask(`${END} data modify entity ${DRAGON} Health set value 6.0f`);
  });
  const run = await act([{ do: 'attack', target: 'ender_dragon', seconds: 25 }], 40);
  clearInterval(follow); releaseReflex();
  await sleep(3000);
  const snapshot = await evidence();
  // Wait for the end of the death animation (the removal), if the hand ended earlier.
  for (let i = 0; i < 160 && dragonEntity(); i++) await sleep(100);
  const late = await evidence();
  clearInterval(phaseTimer);
  return { act: run.lines, ok: run.ok, events, boss: snapshot?.boss, bossAfterRemoval: late?.boss, dragonStillLoaded: !!dragonEntity() };
};

// ===== run =====
let exitCode = 0;
try {
  const invalidKillSelection = wanted.some(name => name.startsWith('dragon_kill') || name === 'end_full_chain') && (wanted.filter(name => name !== 'enter').length !== 1 || !killEntries.includes(wanted.find(name => name !== 'enter')!));
  if (invalidKillSelection) { report.errors.push('choose exactly one standalone entry (dragon_kill_compare or end_full_chain, optionally after enter), without other scenes'); exitCode = 1; }
  for (const name of invalidKillSelection ? [] : Object.keys(scenes)) {
    if (killEntries.includes(name) && wanted.filter(n => n !== 'enter').join() !== name) continue;
    if (name === 'cage_section' && !wanted.includes('cage_section')) continue;
    if (!include(name)) continue;
    if (name !== 'enter' && name !== 'cage_section' && !killEntries.includes(name) && g === 0) { log(`SCENE ${name} skipped: the End was not entered (no enter scene yet)`); continue; }
    const started = Date.now();
    log(`SCENE ${name} begins`);
    try { report.scenes[name] = { ms: 0, ...(await scenes[name]()) }; if ((name === 'cage_section' || killEntries.includes(name)) && !report.scenes[name].ok) exitCode = 1; }
    catch (error) { report.scenes[name] = { error: String((error as Error)?.stack ?? error).slice(0, 800) }; exitCode = 1; }
    finally {
      // Whatever way the scene ended: its timers stop, the reflex is let go, and the dragon is put back for the next one (not after the one that kills it).
      stopTimers(); releaseReflex();
      if (g !== 0 && name !== 'enter' && name !== 'death' && name !== 'cage_section' && !killEntries.includes(name)) { try { await restoreDragon(); } catch { /* the next scene looks for itself */ } }
    }
    report.scenes[name].ms = Date.now() - started;
    log(`SCENE ${name} ends after ${((Date.now() - started) / 1000).toFixed(1)}s: ${JSON.stringify(report.scenes[name]).slice(0, 700)}`);
    if (disconnected) { report.errors.push(`disconnected: ${disconnected}`); break; }
  }
} finally {
  const reportPath = process.env.MINECRAFT_END_REPORT ?? (wanted.includes('cage_section') || wanted.some(name => killEntries.includes(name)) ? path.join(worldDirectory, 'report.json') : null);
  if (reportPath) { try { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); } catch (error) { report.errors.push(`report write failed: ${String((error as Error).message ?? error)}`); exitCode = 1; } }
  console.log(`ENDFIGHT_RESULT ${JSON.stringify(report)}`);
  try { await body.dispose(); } catch { /* gone */ }
  try { actor.quit(); operator.quit(); } catch { /* gone */ }
  setTimeout(() => process.exit(exitCode), 1500);
}
