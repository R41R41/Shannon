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
import { dragonPhaseOf, endDragonOf } from '../src/services/minebot/utils/dragonState.js';
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
const endView = () => (body.observe().state as { end?: any }).end ?? null;
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
  await ask(`${END} data modify entity ${DRAGON} Health set value ${health}.0f`);
  await sleep(400);
}
/** The dragon reflex held off (the floor's own switch is its next look): for the trials that measure what the server does, not what the body does about it. */
let reflexOff: NodeJS.Timeout | null = null;
const holdReflexOff = () => { releaseReflex(); const push = () => { const state = (actor as any).floorReflexes; if (state) state.dragonNextAt = Date.now() + 3000; }; push(); reflexOff = setInterval(push, 500); };
const releaseReflex = () => { if (reflexOff) { clearInterval(reflexOff); reflexOff = null; } const state = (actor as any).floorReflexes; if (state) state.dragonNextAt = 0; };
/** The dragon parked far off, hovering (phase 10), so that only what a scene summons acts on the body. */
let parked: NodeJS.Timeout | null = null;
const park = async (on: boolean) => {
  if (parked) { clearInterval(parked); parked = null; }
  if (!on) return;
  const put = async () => { await ask(`${END} data modify entity ${DRAGON} DragonPhase set value 10`); await ask(`${END} tp ${DRAGON} 0.5 ${g + 70} 160`); };
  await put(); parked = setInterval(() => { void put(); }, 4000);
};
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
  let dragonAt: number | null = null, crystalsAt: number | null = null;
  for (let i = 0; i < 240; i++) {
    const dragon = dragonEntity();
    if (dragon && dragonAt === null) dragonAt = Date.now() - t0;
    const view = endView();
    if ((view?.crystals?.list?.length ?? 0) >= 1 && crystalsAt === null) crystalsAt = Date.now() - t0;
    if (dragonAt !== null && view?.fountain && (crystalsAt !== null || Date.now() - t0 > dragonAt + 8000)) break;
    await sleep(500);
  }
  const view = endView();
  g = view?.fountain ? Math.round(view.fountain.y) - 4 : 0; fountainY = view?.fountain?.y ?? 0;
  Object.assign(out, { dimension: String(actor.game?.dimension), dragonSeenAfterMs: dragonAt, crystalsSeenAfterMs: crystalsAt, observation: view ? { dragon: view.dragon, fountain: view.fountain, crystals: { remaining: view.crystals.remaining, gone: view.crystals.gone, caged: view.crystals.caged, loaded: view.crystals.list.length, unseen: view.crystals.unseen.length }, clouds: view.clouds.length, fireballs: view.fireballs } : null,
    dragonHealthServer: await dragonHealthServer(), cagedList: (view?.crystals?.list ?? []).filter((c: any) => c.caged).map((c: any) => [c.id, c.x, c.y, c.z]) });
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

scenes.breath = async () => {
  await protect(false);
  await park(true);
  await flatten(); await gear(['diamond_sword']); await wear();
  await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`);
  const out: Record<string, unknown> = {};
  const runs: Array<Record<string, unknown>> = [];
  for (const radius of [3, 5, 7]) {
    await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`); await standAt(-5.5, g, 11.5); await sleep(1500);
    const healthBefore = Number(actor.health), deathsBefore = actorDeaths, ledgerMark = (actor.reflexLedger?.mark?.() as number | undefined) ?? 0;
    const summon = `${END} summon minecraft:area_effect_cloud -5.5 ${g} 11.5 {Particle:{type:"minecraft:dragon_breath"},Radius:${radius}f,Duration:200,WaitTime:20,ReapplicationDelay:20,potion_contents:{custom_effects:[{id:"minecraft:instant_damage",amplifier:0,duration:1}]}}`;
    const startedAt = Date.now();
    let exitedAt: number | null = null, detectedAt: number | null = null, firstForward: number | null = null, cloudSeen: number | null = null, maxJump = false, sprinted = false;
    // The reaction in milliseconds from the moment the command was sent: the cloud in the client's entities, the first forward key, the first step, the way out of the zone.
    const originalKey = actor.setControlState.bind(actor);
    actor.setControlState = (key: string, value: boolean) => { if (key === 'forward' && value && firstForward === null) firstForward = Date.now() - startedAt; return originalKey(key, value); };
    const answered = await ask(summon);
    const poll = setInterval(() => {
      const p = actor.entity?.position; if (!p) return;
      if (cloudSeen === null && (Object.values(actor.entities) as any[]).some(e => e?.name === 'area_effect_cloud')) cloudSeen = Date.now() - startedAt;
      if (actor.controlState?.jump) maxJump = true;
      if (actor.controlState?.sprint) sprinted = true;
      const flat = Math.hypot(p.x + 5.5, p.z - 11.5);
      if (detectedAt === null && flat > 0.8) detectedAt = Date.now() - startedAt;
      if (exitedAt === null && flat > Math.max(radius, 7) + 0.2) exitedAt = Date.now() - startedAt;
    }, 25);
    for (let i = 0; i < 80 && exitedAt === null; i++) await sleep(100);
    clearInterval(poll);
    actor.setControlState = originalKey;
    await sleep(500);
    const p = actor.entity.position;
    runs.push({ radius, summonAnswer: answered.slice(0, 160), cloudInClientAfterMs: cloudSeen, firstForwardKeyAfterMs: firstForward, firstStepAfterMs: detectedAt, outOfZoneAfterMs: exitedAt, died: actorDeaths > deathsBefore, ledger: ((actor.reflexLedger?.entriesSince?.(ledgerMark) as Array<{ kind: string; at: number; detail: string; outcome: string }> | undefined) ?? []).map(e => `${e.kind}:${e.outcome}@${e.at - startedAt}ms:${e.detail.slice(0, 70)}`), finalFlatDistance: round(Math.hypot(p.x + 5.5, p.z - 11.5), 2), healthLost: round(healthBefore - Number(actor.health), 1), jumped: maxJump, sprinted });
    log(`BREATH radius ${radius}: ${JSON.stringify(runs.at(-1))}`);
    await ask(`${END} kill @e[type=minecraft:area_effect_cloud]`);
  }
  await park(false);
  out.runs = runs;
  return out;
};

scenes.fireball = async () => {
  await protect(false);
  await park(true);
  await flatten(); await gear(['diamond_sword']); await wear();
  const runs: Array<Record<string, unknown>> = [];
  for (const [label, wide] of [['straight at the body', 0], ['passing 14 blocks to the side', 14]] as Array<[string, number]>) {
    await standAt(-3.5, g, 4.5); await sleep(1000);
    const healthBefore = Number(actor.health), start = actor.entity.position.clone();
    // 20 blocks south, 12 up, flying north and down toward the actor (or beside it)
    const answered = await ask(`${END} summon minecraft:dragon_fireball ${-3.5 + wide} ${g + 12} ${24.5} {Motion:[0.0d,-0.45d,-1.0d],acceleration_power:0.1d}`);
    const startedAt = Date.now();
    let seenAfter: number | null = null, movedAfter: number | null = null, velocity: unknown = null, jumped = false, sprinted = false;
    const poll = setInterval(() => {
      const balls = (Object.values(actor.entities) as any[]).filter(e => e?.name === 'dragon_fireball');
      if (balls.length && seenAfter === null) { seenAfter = Date.now() - startedAt; const v = actor.toldVelocities?.get(balls[0].id); velocity = v ? [v.x, v.y, v.z].map((n: number) => Math.round(n * 1000) / 1000) : null; }
      const p = actor.entity?.position; if (p && movedAfter === null && p.distanceTo(start) > 1) movedAfter = Date.now() - startedAt;
      if (actor.controlState?.jump) jumped = true; if (actor.controlState?.sprint) sprinted = true;
    }, 50);
    await sleep(5000);
    clearInterval(poll);
    runs.push({ label, summonAnswer: answered.slice(0, 160), fireballSeenAfterMs: seenAfter, toldVelocity: velocity, bodyMovedAfterMs: movedAfter, movedBlocks: round(actor.entity.position.distanceTo(start), 1), healthLost: round(healthBefore - Number(actor.health), 1), jumped, sprinted });
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
  const keep = setInterval(() => { void ask(`${END} data modify entity ${DRAGON} DragonPhase set value 10`); void ask(`${END} tp ${DRAGON} 0.5 ${g + 14} 0.5`); }, 1500);
  await ask(`${END} data modify entity ${DRAGON} DragonPhase set value 10`); await ask(`${END} tp ${DRAGON} 0.5 ${g + 14} 0.5`);
  await ask(`${END} data modify entity ${DRAGON} Health set value 200.0f`);
  // a slab to stand on at 28 blocks out (the natural ground there is not level with the podium: r4 put the body in a wall and its wall-escape reflex held it)
  await ask(`${END} fill -4 ${g} 24 5 ${g + 8} 34 air replace end_stone`, 20_000); await ask(`${END} fill -4 ${g - 1} 24 5 ${g - 1} 34 end_stone`, 20_000);
  await standAt(0.5, g, 28.5); await sleep(1500);
  const damage: unknown[] = [];
  const dragon0 = dragonEntity();
  const onDamage = (p: any) => { if (p?.entityId === dragon0?.id) damage.push({ cause: p.sourceCauseId, direct: p.sourceDirectId, type: p.sourceTypeId }); };
  actor._client.on('damage_event', onDamage);
  const before = entityHealth(actor, dragon0);
  const run = await act([{ do: 'shoot', target: 'ender_dragon', n: 4 }], 40);
  await sleep(1000);
  actor._client.removeListener('damage_event', onDamage);
  clearInterval(keep);
  const after = entityHealth(actor, dragonEntity());
  const proof = await evidence();
  return { act: run.lines, ok: run.ok, healthClientBefore: before, healthClientAfter: after, damageEvents: damage, bossWitness: proof?.boss?.witness ?? null, bossVerified: proof?.boss?.verified };
};

scenes.cycle = async () => {
  // The whole perch cycle without a planner: the dragon is sent to land by its own landing phases (2 -> 3 -> 5 -> 6 -> 7 -> 5 ... -> 4), the crystals are taken away (their healing would hide
  // the blows), and a stand-in for the planner brings the body under the head with a `tp` (a `go` would walk) and sends `attack ender_dragon` while it sits. The floor reflex is ON:
  // it steps out of the flame and the boxes. Per perch: the phases and when, the blows and how many landed, the health the dragon lost, the reflexes that fired, the actor's health.
  await protect(false);
  await flatten(); await gear(['diamond_sword']); await wear(); await hold('diamond_sword');
  await ask(`${END} kill @e[type=minecraft:end_crystal]`);
  await ask(`${END} data modify entity ${DRAGON} Health set value 200.0f`);
  await ask(`${END} data modify entity ${DRAGON} DragonPhase set value 2`);
  const t0 = Date.now(); const rel = () => Math.round((Date.now() - t0) / 100) / 10;
  const timeline: Array<[number, string]> = [];
  let lastPhase: number | null = null, minHealth = Number(actor.health), deaths = 0;
  actor.on('death', () => { deaths++; });
  const watcher = setInterval(() => {
    const d = dragonEntity(); const p = d ? dragonPhaseOf(actor, d) : null;
    if (p !== lastPhase) { timeline.push([rel(), `phase ${p}`]); lastPhase = p; }
    minHealth = Math.min(minHealth, Number(actor.health));
  }, 100);
  const ledgerAt = (actor.reflexLedger?.mark?.() as number | undefined) ?? 0;
  const perches: Array<Record<string, unknown>> = [];
  let sitting = false, blowsTotal = 0, landedTotal = 0, acts = 0;
  const startHealth = entityHealth(actor, dragonEntity());
  while (Date.now() - t0 < 170_000 && deaths === 0) {
    const dragon = dragonEntity();
    if (!dragon) { await sleep(500); continue; }
    const phase = dragonPhaseOf(actor, dragon);
    const health = entityHealth(actor, dragon);
    if (health !== null && health <= 20) break;
    if (phase !== null && phase >= 5 && phase <= 7) {
      if (!sitting) { sitting = true; perches.push({ startedAt: rel(), phaseAtStart: phase, healthAtStart: health }); }
      // The stand-in for the planner: the body under the head, then the hand, in the perch (not in the flame: the reflex will have it away).
      await standForHeadDistance(3.5);
      const before = entityHealth(actor, dragonEntity());
      const run = await act([{ do: 'attack', target: 'ender_dragon', untilDead: false, seconds: 10 }], 25);
      acts++;
      const m = /(\d+)回振って (\d+)回当たった/u.exec(run.lines.join(' '));
      const blows = m ? Number(m[1]) : 0, landed = m ? Number(m[2]) : 0;
      blowsTotal += blows; landedTotal += landed;
      const last = perches[perches.length - 1];
      last.acts = ((last.acts as number) ?? 0) + 1; last.blows = ((last.blows as number) ?? 0) + blows; last.landed = ((last.landed as number) ?? 0) + landed;
      last.lines = [...((last.lines as string[]) ?? []), run.lines.join(' ').slice(0, 260)];
      last.healthLost = round((Number(last.healthAtStart) || 0) - (entityHealth(actor, dragonEntity()) ?? 0), 1);
      if (before !== null) last.lastActLoss = round(before - (entityHealth(actor, dragonEntity()) ?? before), 1);
      await sleep(300);
    } else {
      if (sitting) { sitting = false; const last = perches[perches.length - 1]; last.endedAt = rel(); last.phaseAtEnd = phase; }
      await sleep(300);
    }
  }
  clearInterval(watcher);
  const entries = ((actor.reflexLedger?.entriesSince?.(ledgerAt) as Array<{ kind: string; detail: string; outcome: string }> | undefined) ?? []).map(e => `${e.kind}:${e.outcome}:${e.detail.slice(0, 80)}`);
  const kinds: Record<string, number> = {};
  for (const e of entries) { const k = e.split(':')[0]; kinds[k] = (kinds[k] ?? 0) + 1; }
  return { seconds: rel(), dragonHealthStart: startHealth, dragonHealthEnd: entityHealth(actor, dragonEntity()), perches, acts, blowsTotal, landedTotal, reflexKinds: kinds, reflexSample: entries.slice(0, 12),
    actorMinHealth: round(minHealth, 1), actorDeaths: deaths, timeline: timeline.slice(0, 60) };
};

scenes.crystal_bow = async () => {
  await protect(true);
  await flatten(); await gear(['bow', 'arrow 64']); await wear();
  const out: Record<string, unknown> = {};
  const view = endView();
  const open = (view?.crystals?.list ?? []).filter((c: any) => c.caged === false);
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
  out.shot = { lines: near.lines, ok: near.ok, crystalsBefore: view.crystals.left, crystalsAfter: farView?.crystals.left, healthNow: actor.health };
  // Too near: refused before a draw.
  await standAt(target.x + 0.5 + dx / length * 6, standY + 0, target.z + 0.5 + dz / length * 6);
  const tooNear = await act([{ do: 'shoot', target: `#${(farView?.crystals?.list ?? []).find((c: any) => c.caged === false)?.id ?? target.id}` }], 10);
  out.tooNear = { lines: tooNear.lines };
  return out;
};

scenes.crystal_caged = async () => {
  await protect(true);
  await flatten(); await gear(['bow', 'arrow 64', 'iron_pickaxe']); await wear();
  const view = endView();
  const caged = (view?.crystals?.list ?? []).filter((c: any) => c.caged === true);
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
    await ask(`${END} damage @e[type=minecraft:end_crystal,limit=1] 1 minecraft:arrow`);
    await sleep(1200);
    const lost = round(healthBefore - Number(actor.health), 1);
    trials.push({ distance, wall, estimate: { distance: estimate.distance, seen: estimate.seen, raw: estimate.raw, expected: estimate.expected }, healthLost: lost, died: actorDeaths > deathsBefore });
    log(`BLAST ${distance} m wall ${wall}: estimate ${estimate.expected} (raw ${estimate.raw}, seen ${estimate.seen}), real loss ${lost}`);
  }
  await park(false);
  out.trials = trials;
  return out;
};

scenes.bed = async () => {
  // A bed blown beside the dragon on its perch: behind a wall of obsidian (the body's estimate is small), then in the open (the body refuses). The dragon is kept in phase 6 and the reflex held off.
  await protect(false);
  holdReflexOff();
  await flatten(); await gear(['white_bed 4', 'diamond_sword']); await wear();
  const out: Record<string, unknown> = {};
  const trials: Array<Record<string, unknown>> = [];
  const keep = setInterval(() => { void ask(`${END} data modify entity ${DRAGON} DragonPhase set value 6`); }, 1500);
  for (const [label, wallBetween] of [['bed beside the head, wall between', true], ['bed beside the head, in the open', false]] as Array<[string, boolean]>) {
    await perch(200);
    await flatten();
    // an end stone pillar 3 high under the bed, so that the bed is level with the head's box (the head's middle at about (0.5, g + 3.5, 7))
    await ask(`${END} fill 1 ${g} 6 1 ${g + 2} 6 end_stone`);
    await ask(`${END} setblock 1 ${g + 3} 6 white_bed[facing=south,part=foot]`);
    await ask(`${END} setblock 1 ${g + 3} 7 white_bed[facing=south,part=head]`);
    // the body 4.6 m from the bed (the right click reaches 5), east of it, the wall (if any) between
    if (wallBetween) await ask(`${END} fill 3 ${g} 3 3 ${g + 5} 9 obsidian`);
    await standAt(4.5, g, 4.5); await sleep(1200);
    const healthBefore = Number(actor.health), deathsBefore = actorDeaths;
    const dragonBefore = await dragonHealthServer();
    const run = await act([{ do: 'use', at: [{ x: 1, y: g + 3, z: 6 }] }], 12);
    await sleep(800);
    const dragonAfter = await dragonHealthServer();
    trials.push({ label, lines: run.lines, ok: run.ok, healthLost: round(healthBefore - Number(actor.health), 1), died: actorDeaths > deathsBefore, dragonBefore, dragonAfter, dragonLoss: dragonBefore !== null && dragonAfter !== null ? round(dragonBefore - dragonAfter, 1) : null });
    await ask(`effect give ${ACTOR} minecraft:instant_health 1 5`); await sleep(500);
  }
  clearInterval(keep);
  releaseReflex();
  out.trials = trials;
  return out;
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
  const phaseTimer = setInterval(() => { const d = dragonEntity(); const p = d ? dragonPhaseOf(actor, d) : null; if (p !== lastPhase) { events.push([rel(), 'phase', p]); lastPhase = p; } }, 100);
  holdReflexOff();
  await perch(6); await standForHeadDistance(3.0); await sleep(1500);
  // The dragon at 6 health (one blow and a little): kept on the perch and the actor near its head, as in the hand scene; the crystals heal it, so it is kept low.
  const follow = setInterval(() => {
    const dragon = dragonEntity(); if (!dragon || phaseNow() === 9 || (entityHealth(actor, dragon) ?? 1) <= 0) return; // dying: leave it to die
    void standForHeadDistance(3.5); void ask(`${END} data modify entity ${DRAGON} DragonPhase set value 6`); void ask(`${END} data modify entity ${DRAGON} Health set value 6.0f`);
  }, 1200);
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
