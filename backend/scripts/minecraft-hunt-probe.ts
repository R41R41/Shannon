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
  await equip({ diamond_sword: 1, shield: 2, cooked_beef: 24, golden_apple: 3, cobblestone: 64 }, { armor: 'iron', shield: true, effects });
  await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  const start = Date.now();
  let rods0 = await countServer('blaze_rod');
  const metrics = { acts: 0, okActs: 0, reflexStops: 0, blazesKilled: 0, blows: 0, landed: 0, held: 0, hpLost: 0, lowestHp: 20, rodsFromPickup: 0, standDrift: 0, shieldWear: 0, deathsHere: 0, burnedActs: 0 };
  const shield0 = shieldUsed();
  const spawnerNear = sites.blazeSpawner as number[] | undefined;
  let failStreak = 0;
  // The planner asks where to camp: find-structure blaze_spawner names the spawner and the cells within three blocks of it that have no edge and no fire.
  let campCell: number[] | null = null;
  if (near) {
    const found = await runSkill('find-structure', { structureType: 'blaze_spawner' }, 20);
    const answer = String(found.receipt?.result ?? '');
    note(`find-structure blaze_spawner: ${answer.slice(0, 420)}`);
    const first = /野営向きの足場[^:]*: \((-?\d+), (-?\d+), (-?\d+)\)/u.exec(answer);
    if (first) campCell = [Number(first[1]), Number(first[2]), Number(first[3])];
  }
  while (Date.now() - start < seconds * 1000 && !disconnected) {
    if (Number(actor.health) <= 0) break;
    // The planner's way to a camp: `go` to the spawner with a range, then hold; or (the staged stand) back to a cell the site file names, 4 to 6 blocks off.
    const there = near && campCell ? { do: 'go', to: { x: campCell[0], y: campCell[1], z: campCell[2] }, range: 0.6, seconds: 20 }
      : near && spawnerNear ? { do: 'go', to: { x: spawnerNear[0], y: spawnerNear[1], z: spawnerNear[2] }, range: 2.6, seconds: 20 } : { do: 'go', to: { x: stand[0], y: stand[1], z: stand[2] }, range: 1, seconds: 20 };
    const hands = kind === 'hold'
      ? [...(near ? [there] : []), { do: 'attack', target: 'blaze', hold: true, seconds: 25 }, { do: 'pickup', range: 8 }, ...(near ? [] : [there])]
      : [...(near ? [there] : []), { do: 'fight', target: 'blaze', seconds: 25, retreatHp: 8 }, { do: 'pickup', range: 8 }, ...(near ? [] : [there])];
    const hpBefore = Number(actor.health);
    const run = await act(`${kind}#${metrics.acts + 1}`, hands, 70, { accept: ['blaze'] });
    metrics.acts++; if (run.ok) metrics.okActs++;
    // A planner that is told a camp cell is unsafe does not ask for it twenty times in a second: it waits, and after five in a row it gives the camp up.
    if (run.ok) failStreak = 0; else { failStreak++; await sleep(2000); if (failStreak >= 5) { note(`${failStreak} acts in a row failed: the camp is lost (${(run.lines[0] ?? '').slice(0, 140)})`); break; } }
    if (run.stoppedBy === 'reflex') metrics.reflexStops++;
    const text = run.lines.join(' ');
    metrics.blazesKilled += (text.match(/倒した (\d+)/gu) ?? []).reduce((sum, hit) => sum + Number(hit.replace(/\D+/gu, '')), 0) + (text.match(/fight 済 blaze/gu) ?? []).length;
    metrics.blows += (text.match(/(\d+)回打った/gu) ?? []).reduce((sum, hit) => sum + Number(hit.replace(/\D+/gu, '')), 0)
      + (text.match(/与えた打撃 (\d+)/gu) ?? []).reduce((sum, hit) => sum + Number(hit.replace(/\D+/gu, '')), 0);
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
    // On the ground there (the warped forest is not flat): the first solid cell with two open cells over it, within a few blocks of the body's own height.
    const open = (block: any) => block && (block.name === 'air' || block.name === 'cave_air');
    const groundAt = (gx: number, gz: number): number | null => {
      let best: number | null = null;
      for (let gy = y + 12; gy >= y - 12; gy--) {
        const floor = actor.blockAt(new Vec3(gx, gy, gz)), head1 = actor.blockAt(new Vec3(gx, gy + 1, gz)), head2 = actor.blockAt(new Vec3(gx, gy + 2, gz)), head3 = actor.blockAt(new Vec3(gx, gy + 3, gz));
        if (floor && floor.boundingBox === 'block' && !floor.name.includes('leaves') && open(head1) && open(head2) && open(head3) && (best === null || Math.abs(gy + 1 - y) < Math.abs(best - y))) best = gy + 1;
      }
      return best;
    };
    // The planner hunts the ones it can see: the eye's line from the body to the enderman's eyes (2.55 over its feet) is clear of solid blocks (the first two metres, where the roof will be, are not counted).
    const seenFromBody = (gx: number, gy: number, gz: number): boolean => {
      const from = actor.entity.position.offset(0, 1.62, 0), to = new Vec3(gx + 0.5, gy + 2.55, gz + 0.5), length = from.distanceTo(to), steps = Math.ceil(length / 0.4);
      for (let k = 1; k < steps; k++) {
        if (k * 0.4 < 2) continue;
        const point = from.plus(to.minus(from).scaled(k / steps)), block = actor.blockAt(point);
        if (!block || block.boundingBox === 'block') return false;
      }
      return true;
    };
    let spot: { x: number; z: number; y: number } | null = null;
    if (where === 'warped') {
      for (let attempt = 0; attempt < 36 && !spot; attempt++) {
        const a = (i * 70 + 25 + attempt * 41) * Math.PI / 180, d = 13 + ((attempt * 5) % 8);
        const gx = stand[0] + Math.round(Math.cos(a) * d), gz = stand[2] + Math.round(Math.sin(a) * d), gy = groundAt(gx, gz);
        if (gy !== null && seenFromBody(gx, gy, gz)) spot = { x: gx, z: gz, y: gy };
      }
      if (!spot) { note(`no open ground in the body's sight at 13 to 20 blocks round ${stand[0]},${stand[2]} (36 tries): enderman ${i + 1} is skipped`); continue; }
    } else {
      for (const [jx, jz] of [[0, 0], [2, 0], [0, 2], [-2, 0], [0, -2]] as Array<[number, number]>) {
        const found = groundAt(ex + jx, ez + jz);
        if (found !== null) { spot = { x: ex + jx, z: ez + jz, y: found }; break; }
      }
    }
    await ask(`execute in minecraft:the_nether run summon minecraft:enderman ${(spot?.x ?? ex) + 0.5} ${spot?.y ?? y + 1} ${(spot?.z ?? ez) + 0.5}`);
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
scene('locate_start', 'where /locate says the stronghold starts, against the staged portal room (the eye flies to the start, not to the room)', async () => {
  const portal = (sites.strongholdPortalCenter ?? sites.strongholdSurface) as number[];
  await ask('difficulty peaceful');
  const here = await locateFrom(portal[0], 150, portal[2]);
  const away = await locateFrom(portal[0] + 120, 150, portal[2] - 90);
  const offset = here ? { dx: portal[0] - here.x, dz: portal[2] - here.z, distance: r1(Math.hypot(portal[0] - here.x, portal[2] - here.z)), bearingDegStartToRoom: r1(bearingBetween(here, { x: portal[0], z: portal[2] })) } : null;
  return { portal: [portal[0], portal[1], portal[2]], startFromTheRoom: here, startFromAway: away, sameStart: !!here && !!away && here.x === away.x && here.z === away.z, offset };
});
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

// ===== the road to the End: the pieces between the hunts ======================================================================================
/** The frames of the staged portal room as the site file has them. */
interface SiteFrame { x: number; y: number; z: number; facing: 'north' | 'south' | 'east' | 'west'; eye: boolean }
const serverTest = async (command: string): Promise<boolean> => /passed/iu.test(await ask(command));

scene('craft_eyes', 'blaze rods to blaze powder to eyes of ender, by the craft hand alone (no table)', async () => {
  await ask('difficulty peaceful');
  await equip({ blaze_rod: 3, ender_pearl: 6 }, { armor: 'none', shield: false });
  const powder = await act('powder', [{ do: 'craft', item: 'blaze_powder', count: 6 }], 20);
  const eyes = await act('eyes', [{ do: 'craft', item: 'ender_eye', count: 6 }], 20);
  return { powderLine: (powder.lines[0] ?? '').slice(0, 300), eyesLine: (eyes.lines[0] ?? '').slice(0, 300), packAfter: packClient(), ok: powder.ok && eyes.ok };
});

scene('fire_dig', 'a fire block beside the body (fireballs leave them on the spawner room\'s floor): the dig hand puts it out, and go refuses to end beside one', async () => {
  const stand = (sites.blazeStand ?? sites.netherArrival) as number[];
  await ask('difficulty peaceful');
  const y = await netherPlate(stand[0], stand[2]);
  await equip({ iron_pickaxe: 1, cooked_beef: 4 }, { armor: 'iron', shield: false });
  await placeActor('the_nether', stand[0], y, stand[2], 24);
  const fx = stand[0] + 2, fz = stand[2];
  const nameAt = (x: number, yy: number, z: number) => actor.blockAt(new Vec3(x, yy, z))?.name ?? null;
  await ask(`execute in minecraft:the_nether run setblock ${fx} ${y} ${fz} minecraft:fire`);
  await sleep(800);
  const before = nameAt(fx, y, fz);
  const goNear = await act('go-beside-fire', [{ do: 'go', to: { x: fx - 1, y, z: fz }, range: 0.6, seconds: 10 }], 20);
  const out = await act('put-out', [{ do: 'dig', at: [{ x: fx, y, z: fz }], collect: false }], 20);
  await sleep(500);
  const after = nameAt(fx, y, fz);
  return { fireBefore: before, goBesideFireLine: (goNear.lines[0] ?? '').slice(0, 260), putOutLine: (out.lines[0] ?? '').slice(0, 260), blockAfter: after, putOut: after !== 'fire' };
});

scene('craft_diag', 'why craft ender_eye ends with "missing ingredient": the grid, the cursor and the count the server holds after each craft', async () => {
  await ask('difficulty peaceful');
  await equip({ blaze_powder: 3, ender_pearl: 3 }, { armor: 'none', shield: false });
  const slotsOf = () => (actor.inventory.slots as any[]).map((slot, index) => slot ? `${index}:${slot.name}x${slot.count}` : null).filter(Boolean).slice(0, 14);
  const cursorOf = () => { const c = (actor.inventory as any).selectedItem; return c ? `${c.name}x${c.count}` : null; };
  const server = async () => ({ eyes: await countServer('ender_eye'), pearls: await countServer('ender_pearl'), powder: await countServer('blaze_powder') });
  const steps: Array<Record<string, unknown>> = [];
  steps.push({ step: 'start', pack: packClient(), slots: slotsOf(), cursor: cursorOf(), server: await server() });
  for (let i = 1; i <= 3; i++) {
    const run = await act(`eye${i}`, [{ do: 'craft', item: 'ender_eye', count: 1 }], 20);
    steps.push({ step: `craft ${i}`, line: (run.lines[0] ?? '').slice(0, 200), pack: packClient(), slots: slotsOf(), cursor: cursorOf(), server: await server() });
  }
  return { steps };
});

scene('end_portal', 'the portal room: the missing eyes put into the frames by the use hand from each side, then into the portal, to the End', async note => {
  const frames = (sites.strongholdFrames ?? []) as SiteFrame[];
  const stand = (sites.strongholdStand ?? sites.strongholdPortalCenter) as number[];
  if (frames.length < 12) throw new Error('no strongholdFrames in the sites');
  await ask('difficulty peaceful'); await ask('time set noon');
  await equip({ ender_eye: 12, cobblestone: 16, cooked_beef: 8 }, { armor: 'none', shield: false });
  await placeActor('overworld', stand[0], stand[1], stand[2], 24);
  const cx = Math.round(frames.reduce((sum, frame) => sum + frame.x, 0) / frames.length), cz = Math.round(frames.reduce((sum, frame) => sum + frame.z, 0) / frames.length), fy = frames[0].y;
  const started = Date.now();
  const lines: string[] = [];
  let eyesGiven = 0, failures = 0;
  // Frame by frame, as a planner given the frames' places would: `go` to within three blocks of the frame (stone to lay if a step needs it), then `use` the eye on it.
  for (const frame of frames.filter(frame => !frame.eye)) {
    const hands = [{ do: 'go', to: { x: frame.x, y: frame.y, z: frame.z }, range: 3, seconds: 25, canPlace: ['cobblestone'], maxPlace: 8 },
      { do: 'use', item: 'ender_eye', at: [{ x: frame.x, y: frame.y, z: frame.z }] }];
    const run = await act(`frame-${frame.x},${frame.z}`, hands, 60);
    lines.push(...run.lines.map(line => line.slice(0, 220)));
    eyesGiven += run.lines.filter(line => /枠に目をはめた/u.test(line)).length;
    if (!run.ok) failures++;
  }
  const opened = await serverTest(`execute if block ${cx} ${fy} ${cz} minecraft:end_portal`);
  const eyesPlaced = await (async () => { let n = 0; for (const frame of frames) if (await serverTest(`execute if block ${frame.x} ${frame.y} ${frame.z} minecraft:end_portal_frame[eye=true]`)) n++; return n; })();
  note(`portal opened on the server: ${opened}; frames with an eye: ${eyesPlaced}/12 after ${((Date.now() - started) / 1000).toFixed(0)} s`);
  // Into the portal: first what a planner might try (go: it is told to use walk), then walk with the portal as its target.
  let entered = false, enterLine = '';
  if (opened) {
    const tryGo = await act('enter-go', [{ do: 'go', to: { x: cx, y: fy, z: cz }, range: 0.6, seconds: 20 }], 30);
    enterLine = `go: ${(tryGo.lines[0] ?? '').slice(0, 260)}`;
    const enter = await act('enter-walk', [{ do: 'walk', to: { x: cx, y: fy, z: cz }, seconds: 40 }], 60);
    enterLine += ` | walk: ${(enter.lines[0] ?? '').slice(0, 300)}`;
    const until = Date.now() + 12_000;
    while (Date.now() < until && dimensionOf() !== 'the_end') await sleep(250);
    entered = dimensionOf() === 'the_end';
  }
  return { framesNeeded: frames.filter(frame => !frame.eye).length, eyesGivenByTheLines: eyesGiven, eyesPlacedOnServer: eyesPlaced, failedActs: failures, portalOpened: opened, enteredTheEnd: entered, dimension: dimensionOf(),
    seconds: r1((Date.now() - started) / 1000), enterLine, lines: lines.slice(0, 12) };
});

scene('map_portal', 'a map of the portal room: layers from 3 below to 3 above the frames, 21 by 21 round their middle (Q frame, R frame with an eye, P portal, ~ lava, b stone bricks, S spawner)', async () => {
  const frames = (sites.strongholdFrames ?? []) as SiteFrame[];
  const stand = (sites.strongholdStand ?? sites.strongholdPortalCenter) as number[];
  await ask('difficulty peaceful');
  await placeActor('overworld', stand[0], stand[1], stand[2], 24);
  await sleep(1500);
  const cx = Math.round(frames.reduce((sum, frame) => sum + frame.x, 0) / frames.length), cz = Math.round(frames.reduce((sum, frame) => sum + frame.z, 0) / frames.length), fy = frames[0].y;
  const glyph = (x: number, y: number, z: number): string => {
    const block = actor.blockAt(new Vec3(x, y, z));
    const name = block?.name;
    if (!name) return '?';
    if (x === Math.floor(actor.entity.position.x) && z === Math.floor(actor.entity.position.z) && y === Math.floor(actor.entity.position.y)) return '@';
    if (name === 'air' || name === 'cave_air') return '.';
    if (name === 'end_portal_frame') { try { return (block as any).getProperties().eye === true || (block as any).getProperties().eye === 'true' ? 'R' : 'Q'; } catch { return 'Q'; } }
    if (name === 'end_portal') return 'P';
    if (name === 'lava') return '~';
    if (name === 'water') return 'w';
    if (name === 'spawner') return 'S';
    if (name.includes('stone_brick')) return name.includes('stairs') ? '/' : name.includes('slab') ? '_' : 'b';
    if (name === 'iron_bars') return '|';
    if (name.includes('torch')) return 'i';
    if (name.includes('stairs')) return '/';
    return 'x';
  };
  for (let y = fy + 3; y >= fy - 3; y--) {
    log(`MAP --- y=${y} (${y - fy >= 0 ? '+' : ''}${y - fy} from the frames)  x ${cx - 10}..${cx + 10} across, z ${cz - 10} (top) .. ${cz + 10}`);
    for (let z = cz - 10; z <= cz + 10; z++) { let row = ''; for (let x = cx - 10; x <= cx + 10; x++) row += glyph(x, y, z); log(`MAP ${String(z).padStart(5)} ${row}`); }
  }
  return { centre: [cx, fy, cz] };
});

scene('stronghold_descent', 'from the surface over the portal room down to its floor by go with a pickaxe and stone to lay', async () => {
  const surface = sites.strongholdSurface as number[];
  const stand = (sites.strongholdStand ?? sites.strongholdPortalCenter) as number[];
  await ask('difficulty peaceful'); await ask('time set noon');
  await equip({ iron_pickaxe: 1, iron_sword: 1, cobblestone: 64, cooked_beef: 16 }, { armor: 'iron', shield: false });
  await placeActor('overworld', surface[0], surface[1], surface[2], 24);
  const started = Date.now();
  const tries: string[] = [];
  let arrived = false;
  for (let attempt = 0; attempt < 4 && !arrived && !disconnected; attempt++) {
    const run = await act(`descend#${attempt + 1}`, [{ do: 'go', to: { x: stand[0], y: stand[1], z: stand[2] }, range: 1.5, seconds: 110, maxDig: 120, maxPlace: 24,
      canDig: ['stone', 'dirt', 'grass_block', 'gravel', 'sand', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'cobblestone', 'stone_bricks'], canPlace: ['cobblestone'] }], 150);
    tries.push((run.lines[0] ?? '').slice(0, 360));
    const here = actor.entity?.position as Vec3 | undefined;
    arrived = !!here && Math.hypot(here.x - (stand[0] + 0.5), here.z - (stand[2] + 0.5)) < 3 && Math.abs(here.y - stand[1]) < 3;
    if (Number(actor.health) < 8) break;
  }
  const here = actor.entity?.position as Vec3 | undefined;
  return { arrived, seconds: r1((Date.now() - started) / 1000), finalAt: here ? [r1(here.x), r1(here.y), r1(here.z)] : null, hp: actor.health, tries };
});

const netherWalk = async (note: (text: string) => void, which: Array<'fortress' | 'warped'>, start?: number[]): Promise<Record<string, unknown>> => {
  const arrival = sites.netherArrival as number[];
  const targets: Array<{ name: string; to: number[] }> = which.map(name => ({ name, to: (name === 'fortress' ? sites.blazeStand : sites.warpedStand) as number[] }));
  await ask('difficulty normal'); await ask('time set noon');
  // Three pickaxes: t46 (c2, basalt delta) broke the one iron pickaxe after about 250 digs, 125 m into the walk, and the act ended as `tool_broke`.
  // 192 stones: t49 (c4, 244 m from the fortress) laid all 64 in about 170 m of bridging and stopped on `no_blocks` 73 m short.
  await equip({ iron_pickaxe: 3, diamond_sword: 1, cobblestone: 192, cooked_beef: 24, golden_apple: 3 }, { armor: 'iron', shield: true });
  // What the planner would give `go` for a leg this long (the limits are the schema's own top: maxDig 200, maxPlace 100; the walk is told to take as long as it needs).
  const glyph = (x: number, y: number, z: number): string => {
    const name = actor.blockAt(new Vec3(x, y, z))?.name;
    if (!name) return '?';
    const p = actor.entity.position;
    if (Math.floor(p.x) === x && Math.floor(p.y) === y && Math.floor(p.z) === z) return '@';
    if (name === 'air' || name === 'cave_air') return '.';
    if (name === 'lava') return '~';
    if (name === 'magma_block') return 'M';
    if (name === 'netherrack') return '#';
    if (name === 'soul_sand' || name === 'soul_soil') return 's';
    if (name === 'fire' || name === 'soul_fire') return 'f';
    if (name.includes('basalt') || name.includes('blackstone')) return 'b';
    if (name.includes('nether_brick')) return 'B';
    if (name === 'cobblestone') return 'c';
    if (name.includes('quartz')) return 'q';
    if (name === 'glowstone') return 'g';
    if (name.includes('warped') || name.includes('crimson') || name.includes('nylium') || name.includes('wart')) return 'w';
    return 'x';
  };
  let maps = 0;
  const mapAround = (label: string, radius = 6) => {
    if (maps >= 4) return;
    maps++;
    const p = actor.entity.position, bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    for (let y = by + 2; y >= by - 3; y--) {
      log(`MAP ${label} y=${y} (${y - by >= 0 ? '+' : ''}${y - by})  x ${bx - radius}..${bx + radius} across, z ${bz - radius} (top)..${bz + radius}`);
      for (let z = bz - radius; z <= bz + radius; z++) { let row = ''; for (let x = bx - radius; x <= bx + radius; x++) row += glyph(x, y, z); log(`MAP ${String(z).padStart(5)} ${row}`); }
    }
  };
  const legs: Array<Record<string, unknown>> = [];
  let from = start ?? arrival;
  for (const target of targets) {
    await placeActor('the_nether', from[0], from[1], from[2], 24);
    const started = Date.now(), hp0 = Number(actor.health);
    const trail: string[] = [];
    let reached = false, tries = 0, slow = 0;
    // The limits and the dig list are the planner's to change; here they change the way the lines say ("maxDig を増やす", "canDig に足す").
    let maxDig = 120, maxPlace = 40;
    const canDig = ['netherrack', 'basalt', 'blackstone'];
    const leftOf = () => { const here = actor.entity?.position as Vec3 | undefined; return here ? Math.hypot(here.x - (target.to[0] + 0.5), here.z - (target.to[2] + 0.5)) : Infinity; };
    for (; tries < 10 && !reached && !disconnected; tries++) {
      const before = leftOf();
      const run = await act(`${target.name}#${tries + 1}`, [{ do: 'go', to: { x: target.to[0], y: target.to[1], z: target.to[2] }, range: 3, seconds: 100, maxDig, maxPlace, canDig: [...canDig], canPlace: ['cobblestone'] }], 140);
      const here = actor.entity?.position as Vec3 | undefined;
      const left = leftOf();
      const line = run.lines[0] ?? '';
      trail.push(`[${here ? `${r1(here.x)},${r1(here.y)},${r1(here.z)}` : '?'} left ${r1(left)}] ${line.slice(0, 230)}`);
      const named = /が ([a-z_]+) で登れない（掘ってよい物に無い）/u.exec(line)?.[1];
      if (named && !canDig.includes(named) && canDig.length < 12) { canDig.push(named); note(`canDig gets ${named} (the line said so)`); }
      if (/limit_dig/u.test(line) && maxDig < 200) maxDig = Math.min(200, maxDig + 60);
      if (/limit_place/u.test(line) && maxPlace < 100) maxPlace = Math.min(100, maxPlace + 30);
      reached = !!here && left < 5 && Math.abs(here.y - target.to[1]) < 6;
      if (Number(actor.health) < 9) { note(`health ${actor.health}: the walk to the ${target.name} stops`); break; }
      // A hop that got nowhere (under 3 m nearer) twice running: what a planner would take as shut, and give up on.
      slow = before - left < 3 ? slow + 1 : 0;
      if (!reached && (before - left < 3 || tries === 0)) mapAround(`${target.name}#${tries + 1}`);
      const refusedAt = /置きを断られた \((-?\d+),(-?\d+),(-?\d+)\)/u.exec(line);
      if (refusedAt) {
        // What stood at the cell the server would not take a block in, and who was near it (the black box says only the body's overlap and jump).
        try {
          const cell = new Vec3(Number(refusedAt[1]), Number(refusedAt[2]), Number(refusedAt[3]));
          const at = (dx: number, dy: number, dz: number) => String(actor.blockAt(cell.offset(dx, dy, dz))?.name ?? '?');
          const near = Object.values(actor.entities as Record<string, any>).filter(entity => entity?.position && entity !== actor.entity && entity.position.distanceTo(cell.offset(0.5, 0.5, 0.5)) <= 6)
            .map(entity => `${entity.name ?? entity.type}@${r1(entity.position.distanceTo(cell.offset(0.5, 0.5, 0.5)))}`).slice(0, 8);
          log(`REFUSED ${refusedAt[1]},${refusedAt[2]},${refusedAt[3]} now ${at(0, 0, 0)}; below ${at(0, -1, 0)} above ${at(0, 1, 0)}; sides +x ${at(1, 0, 0)} -x ${at(-1, 0, 0)} +z ${at(0, 0, 1)} -z ${at(0, 0, -1)}; entities within 6 m: ${near.join(' ') || 'none'}; body ${here ? `${r1(here.x)},${r1(here.y)},${r1(here.z)}` : '?'} onGround ${actor.entity?.onGround}`);
        } catch (error) { log(`REFUSED unknown: ${String(error).slice(0, 120)}`); }
      }
      if (!reached && /not_loaded/u.test(line)) {
        // How far the loaded ground goes: the columns the body holds (chunk coordinates) against the body's and the aim's.
        try {
          const columns = (actor.world as any).getColumns?.() ?? [];
          const xs = columns.map((c: any) => c.chunkX), zs = columns.map((c: any) => c.chunkZ);
          log(`LOADED ${columns.length} columns, chunk x ${Math.min(...xs)}..${Math.max(...xs)} z ${Math.min(...zs)}..${Math.max(...zs)}; body chunk ${here ? `${Math.floor(here.x / 16)},${Math.floor(here.z / 16)}` : '?'}; aim chunk ${Math.floor(target.to[0] / 16)},${Math.floor(target.to[2] / 16)}`);
        } catch (error) { log(`LOADED unknown: ${String(error).slice(0, 120)}`); }
      }
      if (slow >= 2) { note(`the walk to the ${target.name} gained under 3 m twice running at ${here ? `${r1(here.x)},${r1(here.y)},${r1(here.z)}` : '?'}`); break; }
      if (Number(actor.health) < 14 || Number(actor.food) < 14) await act('eat', [{ do: 'eat' }], 15);
    }
    legs.push({ target: target.name, from, to: target.to, straightMetres: Math.round(Math.hypot(target.to[0] - from[0], target.to[2] - from[2])), reached, tries: tries, seconds: r1((Date.now() - started) / 1000), hpLost: r1(Math.max(0, hp0 - Number(actor.health))), trail });
    if (!reached) break;
    from = target.to;
  }
  return { legs: legs.map(leg => ({ ...leg, trail: undefined })), trails: legs.map(leg => leg.trail), finalHp: actor.health, packAfter: packClient() };
};
scene('nether_walk', 'the walk in the Nether from the portal side to the fortress and then to the warped forest by go hops (lava, ghasts, soul sand are the world\'s)', note => netherWalk(note, ['fortress', 'warped']));
scene('nether_warped', 'the walk in the Nether from the portal side straight to the warped forest by go hops', note => netherWalk(note, ['warped']));
scene('tool_broke', 'a pickaxe with three uses left breaks in the middle of a go through a netherrack wall: the act stops, and its line says the tool broke and what to do', async () => {
  const stand = sites.netherArrival as number[];
  await ask('difficulty peaceful');
  const y = await netherPlate(stand[0], stand[2]);
  await ask(`execute in minecraft:the_nether run fill ${stand[0] + 4} ${y} ${stand[2] - 20} ${stand[0] + 13} ${y + 7} ${stand[2] + 20} minecraft:netherrack`);
  await equip({ 'iron_pickaxe[damage=247]': 1, cooked_beef: 4 }, { armor: 'none', shield: false });
  await placeActor('the_nether', stand[0], y, stand[2], 24);
  const run = await act('through-the-wall', [{ do: 'go', to: { x: stand[0] + 16, y, z: stand[2] }, range: 1, seconds: 40, maxDig: 60, canDig: ['netherrack'] }], 60);
  const pickaxes = (actor.inventory.items() as any[]).filter(item => /pickaxe/u.test(String(item.name))).map(item => String(item.name));
  return { ok: run.ok, stoppedBy: run.stoppedBy ?? null, stoppedWhy: String(run.stoppedWhy ?? '').slice(0, 200), line: (run.lines[0] ?? '').slice(0, 320), pickaxesLeft: pickaxes };
});
scene('nether_leg2','the walk in the Nether from the fortress\'s stand to the warped forest by go hops (the second leg of nether_walk alone)', note => netherWalk(note, ['warped'], sites.blazeStand as number[]));

// ===== the probe kinds (what the LLM-centric mode can call: act and probe, no catalog skill) =================================================
scene('probe_kinds', 'probe kind=camp at the blaze spawner and kind=frames at the stronghold, against find-structure\'s own answers (they must say the same)', async note => {
  const stand = sites.blazeStand as number[];
  const portal = (sites.strongholdPortalCenter ?? sites.strongholdSurface) as number[];
  await ask('difficulty peaceful');
  await equip({}, { armor: 'none', shield: false });
  await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  const campProbe = await runSkill('probe', { kind: 'camp' }, 20);
  const campSkill = await runSkill('find-structure', { structureType: 'blaze_spawner' }, 20);
  let camp: any = null;
  try { camp = JSON.parse(String(campProbe.receipt?.result ?? '')); } catch { camp = null; }
  note(`probe camp: ${String(campProbe.receipt?.result ?? '').slice(0, 360)}`);
  const sx = portal[0] + 20, sz = portal[2] + 20, y = 150;
  await ask(`execute in minecraft:overworld run forceload add ${sx - 16} ${sz - 16} ${sx + 16} ${sz + 16}`); await sleep(2500);
  await ask(`execute in minecraft:overworld run fill ${sx - 2} ${y - 1} ${sz - 2} ${sx + 2} ${y - 1} ${sz + 2} minecraft:stone`);
  await ask(`execute in minecraft:overworld run fill ${sx - 2} ${y} ${sz - 2} ${sx + 2} ${y + 4} ${sz + 2} minecraft:air`);
  await ask(`execute in minecraft:overworld run tp ${ACTOR} ${sx + 0.5} ${y} ${sz + 0.5}`);
  const until = Date.now() + 25_000;
  while (Date.now() < until && !(dimensionOf() === 'overworld' && actor.entity?.onGround && Math.abs(actor.entity.position.x - (sx + 0.5)) < 1.5)) await sleep(250);
  await sleep(2500);
  const framesProbe = await runSkill('probe', { kind: 'frames', radius: 64, x: portal[0], z: portal[2] }, 20);
  const framesSkill = await runSkill('find-structure', { structureType: 'stronghold', radius: 64, x: portal[0], z: portal[2] }, 20);
  let frames: any = null;
  try { frames = JSON.parse(String(framesProbe.receipt?.result ?? '')); } catch { frames = null; }
  note(`probe frames: ${String(framesProbe.receipt?.result ?? '').slice(0, 360)}`);
  return { campFound: camp?.found ?? null, campCells: camp?.cells?.length ?? null, campFirst: camp?.cells?.[0] ?? null, campSameAsSkill: camp?.text === String(campSkill.receipt?.result ?? ''),
    framesFound: frames?.found?.length ?? null, framesSameAsSkill: frames?.text === String(framesSkill.receipt?.result ?? ''), framesNext: frames?.next?.length ?? null };
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
