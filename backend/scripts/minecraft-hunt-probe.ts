#!/usr/bin/env node
// Model-free live check of the hunts of the dragon sprint's S2 (the blaze camp, the enderman's roofed hole, bartering gold, the thrown eye against /locate, the portal room's
// frames) on a real, isolated Minecraft server, through the road the production body uses: NativeCommonFcaBody.execute(command) for the skill `act` (and `find-structure`).
// No model and no paid key. The numbers are the product: rods a minute, pearls, the eye's bearing against the one /locate gives, blows taken, deaths.
//
// The world is a staged natural one (scripts/lab/lab-world.sh start <key>: the Nether fortress with its blaze spawners, a warped forest, the stronghold with its twelve frames,
// pre-generated; places in <key>.sites.json). Env (set by scripts/lab/run-hunt-lab.sh):
//   MINECRAFT_HUNT_NO_LLM=true  MINECRAFT_HUNT_PORT=<25570..25599>  MINECRAFT_HUNT_WORLD_DIRECTORY=/home/azureuser/minecraft/progressive-lab-XXXX
//   MINECRAFT_HUNT_SITES=<file>        the places of the world (x, y, z; the Nether's are the Nether's)
//   MINECRAFT_HUNT_SCENES=blaze_hold,barter    names or prefixes (default: all)
//   MINECRAFT_HUNT_SECONDS=<n>         the length of the timed scenes (blaze camps: default 240)
//   MINECRAFT_HUNT_REPORT=<file>       the whole report as JSON
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { NativeCommonFcaBody } from '../src/services/minebot/integration/commonFca/nativeBody.js';
import { madeStamp } from './lab/madeStamp.js';

const port = Number(process.env.MINECRAFT_HUNT_PORT);
const worldDirectory = process.env.MINECRAFT_HUNT_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_HUNT_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25570 || port > 25599
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_HUNT_WORLD_REQUIRED');
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GOOGLE_API_KEY', 'GEMINI_API_KEY']) {
  if (process.env[key]) throw new Error(`HUNT_PROBE_REFUSES_PAID_KEY:${key}`);
}
if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'offline-test-not-used') throw new Error('HUNT_PROBE_REFUSES_PAID_KEY:OPENAI_API_KEY');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)) throw new Error('ISOLATED_HUNT_WORLD_CONFIGURATION_INVALID');
const sitesFile = process.env.MINECRAFT_HUNT_SITES ?? '';
const sites: Record<string, any> = sitesFile ? JSON.parse(fs.readFileSync(sitesFile, 'utf8')) : {};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (text: string) => console.log(`[${stamp()}] ${text}`);
const timedSeconds = Number(process.env.MINECRAFT_HUNT_SECONDS ?? 0) || 0;
const reportFile = process.env.MINECRAFT_HUNT_REPORT ?? '';
const ACTOR = 'MinebotTrial';

const operator = await createProbeBot(port);
const actor: any = await createProbeBot(port, ACTOR);
const body = new NativeCommonFcaBody(actor, { serverId: 'hunt-probe', capture: async () => { throw new Error('no picture in the lab'); }, rendererConfigured: () => false });
let deaths = 0, disconnected: string | null = null;
actor.on('death', () => { deaths++; });
actor.on('end', (reason: unknown) => { disconnected ??= `end:${String(reason)}`; });
actor.on('kicked', (reason: unknown) => { disconnected ??= `kicked:${JSON.stringify(reason).slice(0, 200)}`; });
actor.on('error', (error: Error) => { log(`ACTOR_ERROR ${String(error?.message ?? error).slice(0, 200)}`); });
operator.on('end', (reason: unknown) => { disconnected ??= `operator-end:${String(reason)}`; });
operator.on('kicked', (reason: unknown) => { disconnected ??= `operator-kicked:${JSON.stringify(reason).slice(0, 200)}`; });

// ---- server access ---------------------------------------------------------------------------------------------------------------------
const messageString = (message: unknown): string => { try { return typeof message === 'string' ? message : String((message as { toString(): string }).toString()); } catch { return ''; } };
async function ask(command: string, timeoutMs = 12_000, withJson = false): Promise<string> {
  const marker = `HUNTASK_${randomUUID().split('-').join('').slice(0, 10)}`;
  const seen: string[] = [];
  const answer = await new Promise<string>(resolve => {
    let timer: NodeJS.Timeout | undefined;
    const done = (suffix = '') => { if (timer) clearTimeout(timer); operator.removeListener('message', listener as never); resolve(seen.join('\n') + suffix); };
    const listener = (message: unknown) => {
      const text = messageString(message);
      if (text.includes(marker)) done();
      else seen.push(withJson ? `${text} [json ${(() => { try { return JSON.stringify((message as { json?: unknown }).json); } catch { return '?'; } })()}]` : text);
    };
    timer = setTimeout(() => done('\n[timeout]'), timeoutMs);
    operator.on('message', listener as never);
    operator.chat(`/${command}`);
    operator.chat(`/tellraw @s ${JSON.stringify({ text: marker })}`);
  });
  await sleep(250);
  return answer;
}
/** How many of an item the SERVER says the actor holds (`/clear <actor> <item> 0` only counts). */
async function countServer(name: string): Promise<number> {
  const text = await ask(`clear ${ACTOR} minecraft:${name} 0`, 12_000, true);
  const found = /(?:^|\n)Found [^\n]*\[json \{"with":\[\{"":(\d+)\}/u.exec(text);
  return Number(found?.[1] ?? 0);
}
const dimensionOf = () => String(actor.game?.dimension ?? '').replace(/^minecraft:/u, '');
const packClient = (): Record<string, number> => ((actor.inventory.items() as Array<{ name: string; count: number }>)
  .reduce((sum, item) => { sum[item.name] = (sum[item.name] ?? 0) + item.count; return sum; }, {} as Record<string, number>));
const delta = (before: Record<string, number>, after: Record<string, number>) => {
  const out: Record<string, number> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) if ((after[name] ?? 0) !== (before[name] ?? 0)) out[name] = (after[name] ?? 0) - (before[name] ?? 0);
  return out;
};
const r1 = (value: number) => Math.round(value * 10) / 10;
const shieldUsed = () => Number(actor.inventory?.slots?.[45]?.durabilityUsed ?? 0);

// ---- the commands every scene uses ------------------------------------------------------------------------------------------------------
const context = { scopeKey: 'hunt', taskId: 'hunt-task', taskRevision: 1, bodyId: 'minecraft:hunt-probe', sessionId: 'hunt-session', generation: 1, goal: 'hunt probe', completionCondition: 'none' };
let commandNumber = 0;
interface ActRun { label: string; ok: boolean; wallMs: number; actMs: number | null; lines: string[]; json: any; stoppedBy?: string; stoppedWhy?: string; hp: number | null; pack: Record<string, number>; error?: string }
async function runSkill(skill: string, args: Record<string, unknown>, seconds: number): Promise<{ receipt: any; parsed: any; wallMs: number; error?: string }> {
  const id = `hunt-${++commandNumber}`;
  const command: any = { schemaVersion: 1, id, serverId: 'hunt-probe', connectionId: 'hunt', kind: 'skill', skill, arguments: args,
    context: { ...context, ...madeStamp(body) }, lease: { id: 'hunt-lease', generation: 1, holder: 'hunt-task' }, deadlineAt: new Date(Date.now() + seconds * 1000).toISOString() };
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort('probe_watchdog'), (seconds + 20) * 1000);
  const started = Date.now();
  let receipt: any = null, error: string | undefined;
  try { receipt = await body.execute(command, controller.signal); } catch (thrown) { error = String((thrown as Error)?.message ?? thrown); }
  clearTimeout(watchdog);
  const wallMs = Date.now() - started;
  await sleep(500);
  let parsed: any = null;
  try { parsed = JSON.parse(receipt?.result ?? ''); } catch { parsed = null; }
  return { receipt, parsed, wallMs, ...(error ? { error } : {}) };
}
async function act(label: string, hands: unknown[], seconds: number, extra: Record<string, unknown> = {}): Promise<ActRun> {
  const before = packClient();
  const { receipt, parsed, wallMs, error } = await runSkill('act', { hands, ...extra }, seconds);
  const lines: string[] = Array.isArray(parsed?.lines) ? parsed.lines.map((line: any) => `${line.i}.${line.do} ${line.status}: ${String(line.line).slice(0, 400)}`) : [];
  const run: ActRun = { label, ok: parsed ? parsed.ok === true : receipt?.outcome === 'completed', wallMs, actMs: typeof parsed?.ms === 'number' ? parsed.ms : null, lines, json: parsed,
    stoppedBy: parsed?.stoppedBy, stoppedWhy: parsed?.stoppedWhy, hp: Number.isFinite(Number(actor.health)) ? r1(Number(actor.health)) : null, pack: delta(before, packClient()), ...(error ? { error } : {}) };
  log(`ACT ${label} ${run.ok ? 'ok' : 'NO'} ${(wallMs / 1000).toFixed(1)}s hp ${run.hp} ${run.stoppedBy ? `stoppedBy ${run.stoppedBy} ${String(run.stoppedWhy ?? '').slice(0, 80)} ` : ''}${lines.map(line => line.slice(0, 200)).join(' | ')}${error ? ` ERROR ${error}` : ''}`);
  return run;
}

/** Sets the actor up: survival, an empty pack, then these things (armour by `armor`), full health and food; and puts it at a place. */
async function equip(items: Record<string, number>, options: { armor?: 'iron' | 'diamond' | 'none'; shield?: boolean; effects?: string[]; goldBoots?: boolean } = {}): Promise<void> {
  for (const command of ['gamemode survival ' + ACTOR, 'clear ' + ACTOR, 'effect clear ' + ACTOR, 'kill @e[type=minecraft:item]']) await ask(command);
  const armor = options.armor ?? 'iron';
  if (armor !== 'none') {
    for (const [slot, piece] of [['head', 'helmet'], ['chest', 'chestplate'], ['legs', 'leggings'], ['feet', 'boots']] as const) {
      const material = options.goldBoots && slot === 'feet' ? 'golden' : armor;
      await ask(`item replace entity ${ACTOR} armor.${slot} with minecraft:${material}_${piece}`);
    }
  } else if (options.goldBoots) await ask(`item replace entity ${ACTOR} armor.feet with minecraft:golden_boots`);
  if (options.shield !== false) await ask(`item replace entity ${ACTOR} weapon.offhand with minecraft:shield`);
  for (const [name, count] of Object.entries(items)) await ask(`give ${ACTOR} minecraft:${name} ${count}`);
  for (const effect of options.effects ?? []) await ask(`effect give ${ACTOR} minecraft:${effect} 900 0 true`);
  await ask(`effect give ${ACTOR} minecraft:instant_health 1 5 true`);
  await ask(`effect give ${ACTOR} minecraft:saturation 10 10 true`);
  await sleep(1500);
}
async function placeActor(dimension: 'overworld' | 'the_nether', x: number, y: number, z: number, clearance = 40): Promise<void> {
  await ask(`execute in minecraft:${dimension} run forceload add ${Math.floor(x) - clearance} ${Math.floor(z) - clearance} ${Math.floor(x) + clearance} ${Math.floor(z) + clearance}`);
  await sleep(3000);
  await ask(`execute in minecraft:${dimension} run tp ${ACTOR} ${x + 0.5} ${y} ${z + 0.5}`);
  const until = Date.now() + 25_000;
  while (Date.now() < until) {
    const at = actor.entity?.position as Vec3 | undefined;
    if (at && dimensionOf() === dimension && Math.abs(at.x - (x + 0.5)) < 3 && Math.abs(at.z - (z + 0.5)) < 3 && actor.entity.onGround) break;
    await sleep(250);
  }
  await sleep(1200);
}

interface Result { name: string; title: string; ms: number; data: Record<string, unknown>; notes: string[]; deaths: number }
const results: Result[] = [];
const scenes: Array<{ name: string; title: string; run: (note: (text: string) => void) => Promise<Record<string, unknown>> }> = [];
const scene = (name: string, title: string, run: (note: (text: string) => void) => Promise<Record<string, unknown>>) => scenes.push({ name, title, run });
const lineHas = (run: ActRun, pattern: RegExp) => run.lines.some(line => pattern.test(line));

// ===== the blaze camp ======================================================================================================================
async function blazeCamp(kind: 'hold' | 'fight', effects: string[], note: (text: string) => void, near = false): Promise<Record<string, unknown>> {
  const stand = sites.blazeStand as number[] | undefined;
  if (!stand) throw new Error('no blazeStand in the sites');
  const seconds = timedSeconds || 240;
  await ask('difficulty normal'); await ask('time set midnight'); await ask('weather clear');
  await ask('execute in minecraft:the_nether run kill @e[type=minecraft:blaze]');
  await equip({ diamond_sword: 1, cooked_beef: 24, golden_apple: 3, cobblestone: 64 }, { armor: 'iron', shield: true, effects });
  await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  const start = Date.now();
  let rods0 = await countServer('blaze_rod');
  const metrics = { acts: 0, okActs: 0, reflexStops: 0, blazesKilled: 0, blows: 0, landed: 0, held: 0, hpLost: 0, lowestHp: 20, rodsFromPickup: 0, standDrift: 0, shieldWear: 0, deathsHere: 0, burnedActs: 0 };
  const shield0 = shieldUsed();
  const spawnerNear = sites.blazeSpawner as number[] | undefined;
  while (Date.now() - start < seconds * 1000 && !disconnected) {
    if (Number(actor.health) <= 0) break;
    // The planner's way to a camp: `go` to the spawner with a range, then hold; or (the staged stand) back to a cell the site file names, 4 to 6 blocks off.
    const there = near && spawnerNear ? { do: 'go', to: { x: spawnerNear[0], y: spawnerNear[1], z: spawnerNear[2] }, range: 2.6, seconds: 20 } : { do: 'go', to: { x: stand[0], y: stand[1], z: stand[2] }, range: 1, seconds: 20 };
    const hands = kind === 'hold'
      ? [...(near ? [there] : []), { do: 'attack', target: 'blaze', hold: true, seconds: 25 }, { do: 'pickup', range: 8 }, ...(near ? [] : [there])]
      : [...(near ? [there] : []), { do: 'fight', target: 'blaze', seconds: 25, retreatHp: 8 }, { do: 'pickup', range: 8 }, ...(near ? [] : [there])];
    const hpBefore = Number(actor.health);
    const run = await act(`${kind}#${metrics.acts + 1}`, hands, 70, { accept: ['blaze'] });
    metrics.acts++; if (run.ok) metrics.okActs++;
    if (run.stoppedBy === 'reflex') metrics.reflexStops++;
    const text = run.lines.join(' ');
    metrics.blazesKilled += (text.match(/倒した (\d+)/gu) ?? []).reduce((sum, hit) => sum + Number(hit.replace(/\D+/gu, '')), 0) + (text.match(/fight 済 blaze/gu) ?? []).length;
    metrics.blows += (text.match(/(\d+)回打った/gu) ?? []).reduce((sum, hit) => sum + Number(hit.replace(/\D+/gu, '')), 0);
    metrics.held += (text.match(/見送り (\d+)/gu) ?? []).reduce((sum, hit) => sum + Number(hit.replace(/\D+/gu, '')), 0);
    metrics.hpLost += Math.max(0, hpBefore - Number(actor.health));
    metrics.lowestHp = Math.min(metrics.lowestHp, Number(actor.health));
    if (/燃え|fire|burn/u.test(`${run.stoppedWhy ?? ''}`)) metrics.burnedActs++;
    const here = actor.entity?.position as Vec3 | undefined;
    if (here && spawnerNear) metrics.standDrift = Math.max(metrics.standDrift, r1(Math.hypot(here.x - stand[0] - 0.5, here.z - stand[2] - 0.5)));
    // Eat when hungry or hurt (the head's job; the probe stands in for it between acts).
    if (Number(actor.health) < 12 || Number(actor.food) < 14) await act('eat', [{ do: 'eat' }], 15);
    if (Number(actor.health) < 9) { note(`health ${actor.health}: the camp stops`); break; }
  }
  const rods = (await countServer('blaze_rod')) - rods0;
  const minutes = (Date.now() - start) / 60_000;
  metrics.shieldWear = shieldUsed() - shield0;
  metrics.deathsHere = deaths;
  return { seconds: r1((Date.now() - start) / 1000), rods, rodsPerMinute: r1(rods / Math.max(minutes, 0.1)), ...metrics, shieldBroke: !actor.inventory?.slots?.[45] || actor.inventory.slots[45].name !== 'shield', effects };
}
scene('blaze_hold', 'blaze camp: attack hold, iron armour, shield, no fire resistance, from the staged stand (4 to 6 blocks off the spawner)', note => blazeCamp('hold', [], note));
scene('blaze_hold_near', 'blaze camp: attack hold, iron armour, shield, no fire resistance, after a go to within 2.6 blocks of the spawner', note => blazeCamp('hold', [], note, true));
scene('blaze_fight_near', 'blaze camp: fight hand after a go to within 2.6 blocks of the spawner', note => blazeCamp('fight', [], note, true));
scene('blaze_hold_fireres', 'blaze camp: attack hold with fire resistance', note => blazeCamp('hold', ['fire_resistance'], note));
scene('blaze_fight', 'blaze camp: fight hand, no fire resistance', note => blazeCamp('fight', [], note));

// ===== a map of the blaze camp's ground (what the planner has to read to choose a camp cell) ===================================================
scene('map_blaze', 'a map of the cells round the blaze spawner: layers from 3 below to 3 above, 17 by 17, S spawner, @ the staged stand, B brick, # fence, ~ lava, n netherrack, . air', async () => {
  const spawner = sites.blazeSpawner as number[], stand = sites.blazeStand as number[];
  await ask('difficulty peaceful');
  await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  await sleep(2000);
  const glyph = (x: number, y: number, z: number): string => {
    if (x === stand[0] && y === stand[1] && z === stand[2]) return '@';
    const name = actor.blockAt(new Vec3(x, y, z))?.name;
    if (!name) return '?';
    if (name === 'air' || name === 'cave_air') return '.';
    if (name === 'spawner') return 'S';
    if (name.includes('fence')) return '#';
    if (name === 'lava') return '~';
    if (name.includes('nether_brick')) return 'B';
    if (name === 'netherrack') return 'n';
    if (name.includes('stairs')) return '/';
    if (name.includes('slab')) return '_';
    if (name === 'soul_sand') return 's';
    return 'x';
  };
  const layers: string[] = [];
  for (let dy = 3; dy >= -3; dy--) {
    const y = spawner[1] + dy;
    layers.push(`--- y=${y} (${dy >= 0 ? '+' : ''}${dy} from the spawner)  x ${spawner[0] - 8}..${spawner[0] + 8} across, z ${spawner[2] - 8} (top) .. ${spawner[2] + 8}`);
    for (let z = spawner[2] - 8; z <= spawner[2] + 8; z++) { let row = ''; for (let x = spawner[0] - 8; x <= spawner[0] + 8; x++) row += glyph(x, y, z); layers.push(`${String(z).padStart(5)} ${row}`); }
  }
  for (const line of layers) log(`MAP ${line}`);
  return { spawner, stand, layers: layers.length };
});

// ===== bartering ==============================================================================================================================
/** A flat netherrack plate with open air over it, at y=120 (the Nether's own roof is cut away over it): no tree, wall, hole, wither skeleton or fortress fire to meet. Returns the standing height. */
async function netherPlate(x: number, z: number, half = 20, y = 120): Promise<number> {
  await ask(`execute in minecraft:the_nether run forceload add ${x - 32} ${z - 32} ${x + 32} ${z + 32}`); await sleep(4000);
  await ask(`execute in minecraft:the_nether run fill ${x - half} ${y - 3} ${z - half} ${x + half} ${y - 1} ${z + half} minecraft:netherrack`);
  await ask(`execute in minecraft:the_nether run fill ${x - half} ${y} ${z - half} ${x + half} ${y + 8} ${z + half} minecraft:air`);
  return y;
}
/** What the SERVER says of the nearest piglin: its health, and who it has set itself against (its brain's attack target); for the exchange that did not go as it should. */
async function piglinDiagnosis(): Promise<string> {
  const health = await ask('execute in minecraft:the_nether run data get entity @e[type=minecraft:piglin,limit=1,sort=nearest] Health');
  const target = await ask('execute in minecraft:the_nether run data get entity @e[type=minecraft:piglin,limit=1,sort=nearest] Brain.memories."minecraft:attack_target"');
  const admiring = await ask('execute in minecraft:the_nether run data get entity @e[type=minecraft:piglin,limit=1,sort=nearest] Brain.memories."minecraft:admiring_disabled"');
  return `health[${health.replace(/s+/gu, ' ').slice(0, 70)}] attackTarget[${target.replace(/s+/gu, ' ').slice(0, 110)}] admiringDisabled[${admiring.replace(/s+/gu, ' ').slice(0, 70)}]`;
}
scene('barter', 'barter: the golden boots put on by the equip hand, then gold to a piglin on a plate in the Nether', async note => {
  const stand = (sites.blazeStand ?? sites.netherArrival) as number[];
  const seconds = timedSeconds || 150;
  await ask('difficulty normal'); await ask('time set noon');
  await ask('execute in minecraft:the_nether run kill @e[type=minecraft:piglin]');
  await equip({ diamond_sword: 1, gold_ingot: 40, golden_boots: 1, cooked_beef: 8 }, { armor: 'none', shield: true });
  const y = await netherPlate(stand[0], stand[2]);
  await placeActor('the_nether', stand[0], y, stand[2], 24);
  // The gold armour is put on by the hand a planner would use, and read back from the SERVER.
  const wear = await act('wear', [{ do: 'equip', item: 'golden_boots' }], 15);
  const worn = /passed/iu.test(await ask(`execute if items entity ${ACTOR} armor.feet minecraft:golden_boots`));
  await ask(`execute in minecraft:the_nether run summon minecraft:piglin ${stand[0] + 2.5} ${y} ${stand[2] + 0.5} {PersistenceRequired:1b}`);
  await sleep(2500);
  const start = Date.now();
  const gained: Record<string, number> = {};
  let exchanges = 0, refused = 0, nothingReturned = 0, rounds = 0;
  const lines: string[] = [];
  const stalls: string[] = [];
  const exchangeMs: number[] = [];
  while (Date.now() - start < seconds * 1000 && !disconnected) {
    rounds++;
    const piglin = (Object.values(actor.entities ?? {}) as any[]).filter(entity => entity?.name === 'piglin' && entity.position).sort((a, b) => a.position.distanceTo(actor.entity.position) - b.position.distanceTo(actor.entity.position))[0];
    const gap = piglin?.position ? r1(piglin.position.distanceTo(actor.entity.position)) : null;
    const run = await act(`barter#${rounds}`, [{ do: 'use', item: 'gold_ingot', target: 'piglin' }], 40);
    lines.push(`d=${gap} ${run.lines[0] ?? ''}`);
    if (run.ok) { exchanges++; exchangeMs.push(run.wallMs); for (const [name, count] of Object.entries(run.pack)) if (name !== 'gold_ingot' && count > 0) gained[name] = (gained[name] ?? 0) + count; }
    else {
      refused++;
      if (/barter_nothing_returned|手放した|投げた物が見えなかった/u.test(run.lines[0] ?? '')) nothingReturned++;
      stalls.push(`#${rounds} d=${gap} ${run.stoppedBy ?? ''} ${(run.lines[0] ?? '').slice(0, 200)} || server: ${await piglinDiagnosis()}`);
      if (refused >= 5) { note('five refusals in all: stopped'); break; }
    }
    if (Number(actor.health) < 8) { note('health low: stopped'); break; }
  }
  const elapsed = (Date.now() - start) / 1000;
  await ask('execute in minecraft:the_nether run kill @e[type=minecraft:piglin]');
  const pearls = gained.ender_pearl ?? 0;
  return { wearLine: (wear.lines[0] ?? '').slice(0, 160), wornOnServer: worn, rounds, exchanges, refused, nothingReturned, seconds: r1(elapsed), exchangesPerMinute: r1(exchanges / Math.max(elapsed / 60, 0.1)),
    meanExchangeSeconds: exchangeMs.length ? r1(exchangeMs.reduce((sum, ms) => sum + ms, 0) / exchangeMs.length / 1000) : null, gained, pearls, goldLeft: await countServer('gold_ingot'),
    sampleLines: lines.slice(0, 6), stalls: stalls.slice(0, 5), hp: actor.health };
});

// ===== the enderman's roofed hole ==============================================================================================================
async function endermanHunt(where: 'platform' | 'warped', note: (text: string) => void): Promise<Record<string, unknown>> {
  const stand = (where === 'warped' ? sites.warpedStand : sites.blazeStand ?? sites.netherArrival) as number[];
  await ask('difficulty normal'); await ask('time set midnight');
  await ask('execute in minecraft:the_nether run kill @e[type=minecraft:enderman]');
  await equip({ diamond_sword: 1, cobblestone: 64, cooked_beef: 16, golden_apple: 2 }, { armor: 'iron', shield: true });
  let y = stand[1];
  if (where === 'platform') {
    // A flat netherrack plate with open air over it, so that the roof's plan meets no tree, wall or hole.
    y = await netherPlate(stand[0], stand[2]);
  }
  await placeActor('the_nether', stand[0], y, stand[2], 24);
  const rows: Array<Record<string, unknown>> = [];
  const total = timedSeconds ? Math.max(1, Math.floor(timedSeconds / 60)) : 4;
  let pearls = 0, kills = 0, laidTotal = 0;
  for (let i = 0; i < total && !disconnected; i++) {
    if (Number(actor.health) < 10) { note(`health ${actor.health}: stopped before enderman ${i + 1}`); break; }
    const angle = (i * 70 + 25) * Math.PI / 180, distance = 13 + (i % 3) * 3;
    const ex = stand[0] + Math.round(Math.cos(angle) * distance), ez = stand[2] + Math.round(Math.sin(angle) * distance);
    await ask(`execute in minecraft:the_nether run summon minecraft:enderman ${ex + 0.5} ${y + 1} ${ez + 0.5}`);
    await sleep(1500);
    const pearlsBefore = await countServer('ender_pearl'), blocksBefore = await countServer('cobblestone');
    const hpBefore = Number(actor.health);
    const run = await act(`enderman#${i + 1}`, [{ do: 'fight', target: 'enderman', seconds: 50, retreatHp: 8 }, { do: 'pickup', range: 6 }], 90);
    const pearlsAfter = await countServer('ender_pearl'), blocksAfter = await countServer('cobblestone');
    const line = run.lines[0] ?? '';
    const killed = /死んだ/u.test(line);
    if (killed) kills++;
    pearls += pearlsAfter - pearlsBefore; laidTotal += Math.max(0, blocksBefore - blocksAfter);
    rows.push({ i: i + 1, enderman: [ex, ez], ok: run.ok, killed, seconds: r1(run.wallMs / 1000), hpLost: r1(Math.max(0, hpBefore - Number(actor.health))), cobblestoneUsed: blocksBefore - blocksAfter, pearlDelta: pearlsAfter - pearlsBefore,
      line: line.slice(0, 260), stoppedBy: run.stoppedBy });
    await ask('execute in minecraft:the_nether run kill @e[type=minecraft:enderman]');
    // the roof is left standing; the next enderman is fought from the same hole when the body is still in it
  }
  return { where, endermen: rows.length, kills, pearls, blocksLaid: laidTotal, rows, finalHp: actor.health };
}
scene('ender_platform', 'enderman: a flat plate in the Nether, four endermen 13 to 19 blocks off', note => endermanHunt('platform', note));
scene('ender_warped', 'enderman: the warped forest itself, four endermen', note => endermanHunt('warped', note));

// ===== the thrown eye against /locate =========================================================================================================
function bearingBetween(from: { x: number; z: number }, to: { x: number; z: number }): number { return (Math.atan2(to.x - from.x, -(to.z - from.z)) * 180 / Math.PI + 360) % 360; }
const wrap = (degrees: number) => ((degrees + 540) % 360) - 180;
let locateShown = 0;
async function locateFrom(x: number, y: number, z: number): Promise<{ x: number; z: number } | null> {
  // The answer is a translatable message with the coordinates in a nested one; the plain text is tried first, then the JSON form (which keeps the keys).
  const text = await ask(`execute in minecraft:overworld positioned ${x} ${y} ${z} run locate structure minecraft:stronghold`, 30_000, true);
  const plain = /\[(-?\d+), ~?(?:-?\d+)?, ?(-?\d+)\]/u.exec(text) ?? /(-?\d+), ~, (-?\d+)/u.exec(text);
  if (plain) return { x: Number(plain[1]), z: Number(plain[2]) };
  const numbers = [...text.matchAll(/"(-?\d{2,6})"|"text":"(-?\d{2,6})"|:(-?\d{2,6})[,}\]]/gu)].map(hit => Number(hit[1] ?? hit[2] ?? hit[3]));
  if (locateShown++ < 2) log(`NOTE locate answer: ${text.replace(/\s+/gu, ' ').slice(0, 700)} -> numbers ${numbers.slice(0, 8).join(',')}`);
  // [x, "~", z] and then the distance: the "~" is not a number, so the numbers are x, z, distance.
  return numbers.length >= 2 ? { x: numbers[0], z: numbers[1] } : null;
}
async function eyeFrom(x: number, z: number, y = 200): Promise<{ run: ActRun; eye: any; located: { x: number; z: number } | null }> {
  await ask(`execute in minecraft:overworld run forceload add ${x - 16} ${z - 16} ${x + 16} ${z + 16}`); await sleep(2500);
  await ask(`execute in minecraft:overworld run fill ${x - 2} ${y - 1} ${z - 2} ${x + 2} ${y - 1} ${z + 2} minecraft:stone`);
  await ask(`execute in minecraft:overworld run fill ${x - 2} ${y} ${z - 2} ${x + 2} ${y + 4} ${z + 2} minecraft:air`);
  const located = await locateFrom(x, y, z);
  await ask('clear ' + ACTOR); await ask(`give ${ACTOR} minecraft:ender_eye 2`);
  await ask(`execute in minecraft:overworld run tp ${ACTOR} ${x + 0.37} ${y} ${z + 0.61}`);
  const until = Date.now() + 20_000;
  while (Date.now() < until && !(dimensionOf() === 'overworld' && actor.entity?.onGround && Math.abs(actor.entity.position.x - (x + 0.37)) < 1.5)) await sleep(250);
  await sleep(800);
  const run = await act('eye', [{ do: 'use', item: 'ender_eye' }], 40);
  return { run, eye: run.json?.eye ?? null, located };
}
scene('eye_locate', 'the thrown eye: ten throws, the bearing against /locate stronghold', async note => {
  const centre = (sites.strongholdPortalCenter ?? sites.strongholdSurface) as number[];
  await ask('difficulty peaceful'); await ask('time set noon'); await ask('weather clear');
  await equip({}, { armor: 'none', shield: false });
  const offsets: Array<[number, number]> = [[220, 180], [-260, 140], [140, -330], [-180, -240], [380, 60], [-50, 420], [300, -300], [-420, -120], [90, 150], [-110, -60]];
  const rows: Array<Record<string, unknown>> = [];
  for (const [dx, dz] of offsets.slice(0, Number(process.env.MINECRAFT_HUNT_THROWS ?? 0) || offsets.length)) {
    if (disconnected) break;
    const x = centre[0] + dx, z = centre[2] + dz;
    const { run, eye, located } = await eyeFrom(x, z);
    const origin = eye?.origin as { x: number; z: number } | undefined;
    const truth = origin && located ? bearingBetween(origin, located) : null;
    const error = eye && truth !== null ? r1(Math.abs(wrap(eye.bearingDeg - truth)) * 100) / 100 : null;
    const unitError = eye?.unit && origin && located ? (() => { const t = { x: located.x - origin.x, z: located.z - origin.z }; const len = Math.hypot(t.x, t.z); return Math.abs(wrap(Math.atan2(eye.unit.x, -eye.unit.z) * 180 / Math.PI - Math.atan2(t.x / len, -t.z / len) * 180 / Math.PI)); })() : null;
    rows.push({ at: [x, z], located, distance: located && origin ? Math.round(Math.hypot(located.x - origin.x, located.z - origin.z)) : null, measured: eye?.bearingDeg ?? null, truth: truth === null ? null : Math.round(truth * 100) / 100,
      errorDeg: error, unitErrorDeg: unitError === null ? null : Math.round(unitError * 1000) / 1000, flew: eye?.flew, rise: eye?.rise, samples: eye?.samples, ms: eye?.ms, fate: eye?.fate, arrived: eye?.arrived, down: eye?.down ?? false, ok: run.ok, line: (run.lines[0] ?? '').slice(0, 200) });
    if (!eye) note(`no eye in the result at ${x},${z}: ${(run.lines[0] ?? '').slice(0, 160)}`);
  }
  const errors = rows.map(row => row.errorDeg).filter((value): value is number => typeof value === 'number');
  const fates = rows.reduce((sum, row) => { const key = String(row.fate); sum[key] = (sum[key] ?? 0) + 1; return sum; }, {} as Record<string, number>);
  return { throws: rows.length, measured: errors.length, maxErrorDeg: errors.length ? Math.max(...errors) : null, meanErrorDeg: errors.length ? r1(errors.reduce((a, b) => a + b, 0) / errors.length * 1000) / 1000 : null, fates, rows };
});
scene('eye_near', 'the thrown eye near the stronghold: within 12 blocks the eye goes to the stronghold itself, right above it it sinks', async note => {
  const portal = (sites.strongholdPortalCenter ?? sites.strongholdSurface) as number[];
  await ask('difficulty peaceful'); await ask('time set noon');
  await equip({}, { armor: 'none', shield: false });
  // The eye flies to where /locate points (the stronghold's start), which is not the portal room: the throws are made round THAT place.
  const target = await locateFrom(portal[0], 150, portal[2]);
  note(`/locate from the portal room (${portal[0]},${portal[2]}) says ${target ? `${target.x},${target.z}` : 'nothing we could read'}`);
  const centre = [target?.x ?? portal[0], 0, target?.z ?? portal[2]];
  const rows: Array<Record<string, unknown>> = [];
  for (const [dx, dz] of [[0, 0], [3, 2], [6, 5], [-8, 4], [-5, -9], [10, 1], [14, -6], [0, 22], [30, 0], [-45, 20]] as Array<[number, number]>) {
    if (disconnected) break;
    const { run, eye, located } = await eyeFrom(centre[0] + dx, centre[2] + dz);
    const origin = eye?.origin as { x: number; z: number } | undefined;
    const end = eye?.end as { x: number; z: number } | undefined;
    rows.push({ at: [centre[0] + dx, centre[2] + dz], located, distance: located && origin ? r1(Math.hypot(located.x - origin.x, located.z - origin.z)) : null, flew: eye?.flew ?? null, arrived: eye?.arrived ?? null, down: eye?.down ?? false,
      endToLocatedBlocks: end && located ? r1(Math.hypot(end.x - located.x, end.z - located.z)) : null, rise: eye?.rise ?? null, fate: eye?.fate ?? null, line: (run.lines[0] ?? '').slice(0, 200) });
  }
  return { throws: rows.length, rows };
});

// ===== the frames =============================================================================================================================
scene('frame_search', 'find-structure stronghold: the frames within a radius of an estimate, and the ring points when there are none', async note => {
  const centre = (sites.strongholdPortalCenter ?? sites.strongholdSurface) as number[];
  const frames = (sites.strongholdFrames ?? []) as number[][];
  await ask('difficulty peaceful'); await ask('time set noon');
  await equip({}, { armor: 'none', shield: false });
  const rows: Array<Record<string, unknown>> = [];
  // [where the body stands, relative to the portal room], [the estimate's error]
  const cases: Array<{ stand: [number, number]; error: [number, number]; radius: number }> = [
    { stand: [0, 0], error: [0, 0], radius: 64 }, { stand: [40, -30], error: [15, -20], radius: 64 }, { stand: [90, 60], error: [-20, 25], radius: 128 },
    { stand: [140, 20], error: [30, 10], radius: 128 }, { stand: [-100, -110], error: [0, 0], radius: 128 }, { stand: [200, 180], error: [10, 10], radius: 128 }, { stand: [0, 0], error: [140, 0], radius: 128 },
  ];
  for (const item of cases) {
    if (disconnected) break;
    const sx = centre[0] + item.stand[0], sz = centre[2] + item.stand[1], y = 150;
    await ask(`execute in minecraft:overworld run forceload add ${sx - 16} ${sz - 16} ${sx + 16} ${sz + 16}`); await sleep(2500);
    await ask(`execute in minecraft:overworld run fill ${sx - 2} ${y - 1} ${sz - 2} ${sx + 2} ${y - 1} ${sz + 2} minecraft:stone`);
    await ask(`execute in minecraft:overworld run fill ${sx - 2} ${y} ${sz - 2} ${sx + 2} ${y + 4} ${sz + 2} minecraft:air`);
    await ask(`execute in minecraft:overworld run tp ${ACTOR} ${sx + 0.5} ${y} ${sz + 0.5}`);
    const until = Date.now() + 25_000;
    while (Date.now() < until && !(dimensionOf() === 'overworld' && actor.entity?.onGround && Math.abs(actor.entity.position.x - (sx + 0.5)) < 1.5)) await sleep(250);
    await sleep(2500);                                                                   // the chunks the server sends around the new place
    const cx = centre[0] + item.error[0], cz = centre[2] + item.error[1];
    const started = Date.now();
    const { receipt, wallMs } = await runSkill('find-structure', { structureType: 'stronghold', radius: item.radius, x: cx, z: cz }, 30);
    const text = String(receipt?.result ?? '');
    const found = /エンドポータルの枠を発見: (\d+)個/u.exec(text);
    const inRadius = (frames as any[]).filter(frame => Math.hypot((Array.isArray(frame) ? frame[0] : frame.x) - cx, (Array.isArray(frame) ? frame[2] : frame.z) - cz) <= item.radius).length;
    rows.push({ stand: [sx, sz], estimate: [cx, cz], radius: item.radius, truthFramesInRadius: inRadius, foundFrames: found ? Number(found[1]) : 0, ms: Date.now() - started - 0 * wallMs, text: text.slice(0, 420) });
  }
  const wrong = rows.filter(row => (row.truthFramesInRadius as number) > 0 && (row.foundFrames as number) === 0).length;
  return { cases: rows.length, framesMissedWhereTheyAre: wrong, rows };
});

// ---- run -----------------------------------------------------------------------------------------------------------------------------------
const wanted = (process.env.MINECRAFT_HUNT_SCENES ?? '').split(',').map(name => name.trim()).filter(Boolean);
const chosen = scenes.filter(entry => !wanted.length || wanted.some(name => entry.name === name || entry.name.startsWith(name)));
const startedAll = Date.now();
let fatal: string | undefined;
try {
  await ask('say hunt probe ready');
  for (const command of ['gamemode spectator ShannonProbe', 'time set day', 'weather clear', 'gamerule doMobSpawning false']) await ask(command);
  await sleep(2000);
  for (const entry of chosen) {
    if (disconnected) { log(`SKIP ${entry.name}: ${disconnected}`); break; }
    const startedAt = Date.now(), notes: string[] = [], deathsAtStart = deaths;
    log(`SCENE ${entry.name} begins: ${entry.title}`);
    let data: Record<string, unknown> = {};
    try { data = await Promise.race([entry.run(text => { notes.push(text); log(`NOTE ${text}`); }), sleep(40 * 60_000).then(() => { throw new Error('SCENE_TIMEOUT'); })]); }
    catch (error) {
      notes.push(`the scene stopped: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
      actor.interruptExecution = true; actor.pathfinder?.stop(); actor.clearControlStates?.();
      await sleep(1500); actor.interruptExecution = false;
    }
    const result: Result = { name: entry.name, title: entry.title, ms: Date.now() - startedAt, data, notes, deaths: deaths - deathsAtStart };
    results.push(result);
    console.log(`HUNT_SCENE ${JSON.stringify({ ...result, data: { ...result.data, rows: undefined } })}`);
    log(`SCENE ${entry.name} done in ${(result.ms / 1000).toFixed(0)} s, deaths ${result.deaths}`);
  }
} catch (error) {
  fatal = String((error as Error)?.stack ?? error).slice(0, 800);
  log(`FATAL ${fatal}`);
  process.exitCode = 1;
} finally {
  const summary = { scenes: results.length, planned: chosen.length, deaths, durationMs: Date.now() - startedAll, disconnected, fatal, port, worldDirectory };
  console.log(`HUNT_RESULT ${JSON.stringify(summary)}`);
  if (reportFile) { try { fs.writeFileSync(reportFile, JSON.stringify({ summary, results }, null, 2), { mode: 0o600 }); } catch (error) { log(`REPORT_WRITE_FAILED ${String(error)}`); } }
  try { await body.dispose(); } catch { /* the lab is closing */ }
  closeProbeBot(actor); closeProbeBot(operator);
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
}
