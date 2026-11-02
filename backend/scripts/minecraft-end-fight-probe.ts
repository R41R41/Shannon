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
import { hasActiveSafetyLease, preemptLowerPriorityActions, safetyLeaseCapabilities } from '../src/services/minebot/execution/ActionExecution.js';
import { blastAt } from '../src/services/minebot/utils/crystalBlast.js';

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
async function act(hands: Array<Record<string, unknown>>, seconds = 30, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; lines: string[]; parsed: any; ms: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort('probe_watchdog'), (seconds + 20) * 1000);
  let receipt: any = null;
  try { receipt = await body.execute(commandOf('act', { hands, ...extra }, seconds), controller.signal); } catch (error) { report.errors.push(`act threw: ${String((error as Error)?.message ?? error)}`); }
  clearTimeout(watchdog);
  let parsed: any = null; try { parsed = JSON.parse(receipt?.result ?? ''); } catch { parsed = null; }
  const lines = Array.isArray(parsed?.lines) ? parsed.lines.map((line: any) => `${line.i}.${line.do} ${line.status}: ${String(line.line).slice(0, 400)}`) : [String(receipt?.result ?? '').slice(0, 300)];
  log(`ACT ${hands.map(h => h.do).join('+')} ${parsed?.ok ? 'ok' : 'NOT-OK'} ${((Date.now() - started) / 1000).toFixed(1)}s ${lines.join(' | ').slice(0, 500)}`);
  return { ok: parsed?.ok === true, lines, parsed, ms: Date.now() - started };
}
async function evidence(): Promise<any> {
  const receipt = await body.execute(commandOf('goal-evidence', {}, 10), new AbortController().signal);
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
const wear = async () => { for (const [slot, item] of [['head', ARMOR[0]], ['chest', ARMOR[1]], ['legs', ARMOR[2]], ['feet', ARMOR[3]]]) await ask(`item replace entity ${ACTOR} armor.${slot} with ${item}`); await sleep(300); };
/** Resistance V for the scenes that do not measure what the body takes (the dragon is awake and kills a body that stands about); off for those that do. */
const protect = async (on: boolean) => { await ask(on ? `effect give ${ACTOR} minecraft:resistance 900 4 true` : `effect clear ${ACTOR}`); };
const hold = async (item: string) => { await ask(`item replace entity ${ACTOR} weapon.mainhand with ${item}`); await sleep(300); };

// ===== scenes =====
const scenes: Record<string, () => Promise<Record<string, unknown>>> = {};

scenes.enter = async () => {
  const t0 = Date.now();
  await enterEnd();
  const out: Record<string, unknown> = {};
  await sleep(1500);
  out.arrival = captureEnd('arrival', 'just arrived on the obsidian platform: the dragon and the crystals are not in sight yet');
  let dragonAt: number | null = null, crystalsAt: number | null = null;
  for (let i = 0; i < 240; i++) {
    const dragon = dragonEntity();
    if (dragon && dragonAt === null) dragonAt = Date.now() - t0;
    const view = endView();
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
    const spot = head ? new Vec3(head.centre.x + dir.x * 2.2, 0, head.centre.z + dir.z * 2.2) : new Vec3(0.5, 0, 9.2);
    const bx = Math.floor(spot.x), bz = Math.floor(spot.z);
    await ask(`${END} fill ${bx} ${g} ${bz} ${bx} ${g + 2} ${bz} end_stone`);
    if (wallBetween) await ask(`${END} fill -2 ${g} 11 3 ${g + 4} 11 obsidian`);
    const healthBefore = Number(actor.health), deathsBefore = actorDeaths;
    const dragonBefore = await dragonHealthServer();
    const lowest = trackMinHealth();
    await ask(`${END} setblock ${bx} ${g + 3} ${bz} white_bed[facing=south,part=foot]`);
    await ask(`${END} setblock ${bx} ${g + 3} ${bz + 1} white_bed[facing=south,part=head]`);
    const seenBefore = { bed: [bx, g + 3, bz], atClient: actor.blockAt(new Vec3(bx, g + 3, bz))?.name ?? null, headHalfAtClient: actor.blockAt(new Vec3(bx, g + 3, bz + 1))?.name ?? null,
      head: head ? [round(head.centre.x, 1), round(head.centre.z, 1)] : null, dragonAt: dragonNow ? [round(dragonNow.position.x, 1), round(dragonNow.position.z, 1)] : null, serverPos, dragonPhase: dragonNow ? dragonPhaseOf(actor, dragonNow) : null };
    log(`BED ${label}: before the hand ${JSON.stringify(seenBefore)}`);
    const run = await act([{ do: 'use', at: [{ x: bx, y: g + 3, z: bz }] }], 12);
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
async function crossRun(ballAfterMs: number | null): Promise<Record<string, unknown>> {
  // The way off the arrival platform: the island lies some tens of blocks off over the void, and the body stands on 5 x 5 of obsidian. A planner's `go` with blocks to lay over the gap and a place on the island for its end,
  // as many times as it takes (the hand may take 120 s). The dragon is kept over the island, high up (nothing here is a fight); what is measured is whether the body gets over, how long it takes and what it costs in blocks.
  await protect(false);
  releaseReflex();
  await park(true);
  await ask(`${END} forceload add 64 -16 111 16`);
  try {
    await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`); await ask(`${END} kill @e[type=minecraft:dragon_fireball]`);
    await ask(`${END} fill 98 48 -2 102 48 2 obsidian`); await ask(`${END} fill 98 49 -2 102 53 2 air`);
    await gear(['diamond_sword', 'cobblestone 64', 'cobblestone 64', 'cobblestone 64']); await wear();
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
    const calls: Array<{ lines: string[]; ok: boolean; ms: number }> = [];
    let reached = false;
    for (let call = 0; call < 4 && !reached && actorDeaths === deathsBefore; call++) {
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
    clearInterval(sample);
    const at = actor.entity.position;
    const entries = (actor.reflexLedger?.entriesSince?.(ledgerMark) as Array<{ kind: string; outcome: string; detail: string }> | undefined) ?? [];
    return {
      ballAt, ledger: entries.slice(0, 14).map(e => `${e.kind}:${e.outcome}:${e.detail.slice(0, 160)}`),
      rimX, profile, target, reached, died: actorDeaths > deathsBefore, finalAt: [round(at.x, 1), round(at.y, 1), round(at.z, 1)], healthNow: Number(actor.health), lowestHealth: lowest.stop(),
      blocksBefore: before, blocksAfter: blocksLeft(), seconds: Math.round((Date.now() - startedAt) / 1000), calls, trail,
    };
  } finally {
    await ask(`${END} forceload remove 64 -16 111 16`);
  }
}
scenes.cross = () => crossRun(null);
scenes.cross_ball = () => crossRun(9000);

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
  // how long after the landing the bucket is full again, and whether the source of water is gone.
  await protect(false);
  releaseReflex();
  await park(true);
  const trials: Array<Record<string, unknown>> = [];
  const cases: Array<[string, number, string[]]> = [
    ['bucket in the hand, 38 up, cut after the pour', 38, ['diamond_sword', 'water_bucket']],
    ['bucket in the hotbar (not the hand), 20 up, cut after the pour', 20, ['diamond_sword', 'cobblestone 64', 'water_bucket']],
  ];
  for (const [label, height, items] of cases) {
    await flatten(); await ask('kill @e[type=minecraft:item]');
    await ask(`${END} fill -3 ${g} 5 3 ${g + 2} 11 air replace minecraft:water`);
    await gear(items); await wear();
    actor.setQuickBarSlot(0); await sleep(300);
    await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`);
    await standAt(0.5, g, 8.5); await sleep(1000);
    const healthBefore = Number(actor.health), deathsBefore = actorDeaths, lowest = trackMinHealth(), ledgerMark = (actor.reflexLedger?.mark?.() as number | undefined) ?? 0;
    const start = Date.now();
    let cutAfterMs: number | null = null, landedAfterMs: number | null = null, refilledAfterLandingMs: number | null = null;
    const watch = every(5, () => {
      if (cutAfterMs === null && actor.heldItem?.name === 'bucket') { cutAfterMs = Date.now() - start; preemptLowerPriorityActions(actor, 500, 'lab-cut'); }
      if (landedAfterMs === null && Date.now() - start > 600 && actor.entity.onGround && actor.entity.position.y < g + 2) landedAfterMs = Date.now() - start;
      if (landedAfterMs !== null && refilledAfterLandingMs === null && (actor.inventory.items() as Array<{ name: string }>).some(item => item.name === 'water_bucket')) refilledAfterLandingMs = Date.now() - start - landedAfterMs;
    });
    await ask(`${END} tp ${ACTOR} 0.5 ${g + height} 8.5`);
    for (let i = 0; i < 200 && refilledAfterLandingMs === null; i++) await sleep(100);
    await sleep(1000);
    clearInterval(watch);
    const entries = (actor.reflexLedger?.entriesSince?.(ledgerMark) as Array<{ kind: string; outcome: string; detail: string }> | undefined) ?? [];
    const remaining = await ask(`${END} execute if block 0 ${g} 8 minecraft:water run say SOURCE_STILL_THERE`);
    const result = {
      label, height, healthBefore, healthAfter: Number(actor.health), healthLost: round(healthBefore - Number(actor.health), 1), lowest: lowest.stop(), died: actorDeaths > deathsBefore, cutAfterMs, landedAfterMs, refilledAfterLandingMs,
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
  for (const name of Object.keys(scenes)) {
    if (!include(name)) continue;
    if (name !== 'enter' && g === 0) { log(`SCENE ${name} skipped: the End was not entered (no enter scene yet)`); continue; }
    const started = Date.now();
    log(`SCENE ${name} begins`);
    try { report.scenes[name] = { ms: 0, ...(await scenes[name]()) }; }
    catch (error) { report.scenes[name] = { error: String((error as Error)?.stack ?? error).slice(0, 800) }; exitCode = 1; }
    finally {
      // Whatever way the scene ended: its timers stop, the reflex is let go, and the dragon is put back for the next one (not after the one that kills it).
      stopTimers(); releaseReflex();
      if (g !== 0 && name !== 'enter' && name !== 'death') { try { await restoreDragon(); } catch { /* the next scene looks for itself */ } }
    }
    report.scenes[name].ms = Date.now() - started;
    log(`SCENE ${name} ends after ${((Date.now() - started) / 1000).toFixed(1)}s: ${JSON.stringify(report.scenes[name]).slice(0, 700)}`);
    if (disconnected) { report.errors.push(`disconnected: ${disconnected}`); break; }
  }
} finally {
  if (process.env.MINECRAFT_END_REPORT) { try { fs.writeFileSync(process.env.MINECRAFT_END_REPORT, JSON.stringify(report, null, 2)); } catch { /* the line below has it */ } }
  console.log(`ENDFIGHT_RESULT ${JSON.stringify(report)}`);
  try { await body.dispose(); } catch { /* gone */ }
  try { actor.quit(); operator.quit(); } catch { /* gone */ }
  setTimeout(() => process.exit(exitCode), 1500);
}
