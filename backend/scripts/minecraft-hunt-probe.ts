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
import { blackBoxOf } from '../src/services/minebot/utils/blackbox.js';
import { exposureFromSpawner, hideoutsFrom, campSite } from '../src/services/minebot/utils/huntCamp.js';
import { bodyReader } from '../src/services/minebot/utils/localMap.js';

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
  let failStreak = 0, boxesLeft = 6;
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
    // The black box (the last 90 s: hurts with the hostiles near and the body's yaw, the shield, the hands) of an act that cost health, read with HUNT_KEEP=1.
    if (boxesLeft > 0 && (hpBefore - Number(actor.health) >= 4 || Number(actor.health) < 10)) { boxesLeft--; await dumpBox('blaze_hurt', `${kind}#${metrics.acts} hp ${hpBefore} -> ${actor.health}: ${(run.lines[0] ?? '').slice(0, 160)}`); }
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

// The protocol a head can script from the body's own words (S2, 2026-11-02): at the camp cell `probe kind=camp` names, fight (or hold) with accept blaze and stopIf hpBelow 12; when the act stops
// on the health, go to the hideout the same probe names (a footing no blaze of the spawner can see), eat, wait until the health is back, and return. The head's time to read and decide is a
// pause between acts (`thinkMs`). A pickaxe is in the pack (a real run has them: the floor's cover reflex digs with it).
async function blazeProtocol(kind: 'hold' | 'fight', note: (text: string) => void, options: { thinkMs?: number; stopHp?: number; backHp?: number; retreat?: boolean; body?: boolean } = {}): Promise<Record<string, unknown>> {
  const stand = sites.blazeStand as number[] | undefined;
  if (!stand) throw new Error('no blazeStand in the sites');
  const thinkMs = options.thinkMs ?? 5000, stopHp = options.stopHp ?? 12, backHp = options.backHp ?? 18, retreatOn = options.retreat !== false, bodyMode = options.body === true;
  const seconds = timedSeconds || 300;
  await ask('difficulty normal'); await ask('time set midnight'); await ask('weather clear');
  await ask('execute in minecraft:the_nether run kill @e[type=minecraft:blaze]');
  await equip({ diamond_sword: 1, iron_pickaxe: 1, shield: 2, cooked_beef: 24, golden_apple: 3, cobblestone: 64 }, { armor: 'iron', shield: true });
  await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  const start = Date.now();
  const rods0 = await countServer('blaze_rod');
  const shield0 = shieldUsed();
  const m = { acts: 0, okActs: 0, kills: 0, retreats: 0, recovered: 0, noHideout: 0, hpLostInActs: 0, hpLostOnTheWayOut: 0, hpLostWhileThinking: 0, hpLostOnTheWayBack: 0, lowestHp: 20, secondsBelow10: 0, secondsAway: 0, eats: 0, boxes: 0 };
  let boxesLeft = 4;
  const track: number[] = [];
  const sampler = setInterval(() => { const hp = Number(actor.health); if (Number.isFinite(hp)) { track.push(r1(hp)); m.lowestHp = Math.min(m.lowestHp, hp); if (hp < 10) m.secondsBelow10++; } }, 1000);
  const hp = () => Number(actor.health);
  const readCamp = async (): Promise<any> => { const found = await runSkill('probe', { kind: 'camp' }, 20); try { return JSON.parse(String(found.receipt?.result ?? '')); } catch { return null; } };
  const canPlace = ['cobblestone', 'netherrack'];
  let failStreak = 0;
  try {
    while (Date.now() - start < seconds * 1000 && !disconnected && hp() > 0) {
      const camp = await readCamp();
      const cell = camp?.cells?.[0] as { x: number; y: number; z: number } | undefined;
      if (!cell) { note(`no camp cell: ${String(camp?.text ?? '').slice(0, 200)}`); break; }
      const hands = [{ do: 'go', to: { x: cell.x, y: cell.y, z: cell.z }, range: 0.6, seconds: 20, canPlace, maxPlace: 30 },
        kind === 'hold' ? { do: 'attack', target: 'blaze', hold: true, seconds: 20 } : { do: 'fight', target: 'blaze', seconds: bodyMode ? 40 : 20 }, { do: 'pickup', range: 8 }];
      const before = hp();
      const run = await act(`${kind}#${m.acts + 1}`, hands, bodyMode ? 90 : 60, { accept: ['blaze'], ...(bodyMode ? {} : { stopIf: { hpBelow: stopHp } }) });
      m.acts++; if (run.ok) m.okActs++;
      const text = run.lines.join(' ');
      m.kills += (text.match(/倒した (\d+)/gu) ?? []).reduce((sum, hit) => sum + Number(hit.replace(/\D+/gu, '')), 0) + (text.match(/fight 済 blaze/gu) ?? []).length;
      m.hpLostInActs += Math.max(0, before - hp());
      if (bodyMode && /退いた先/u.test(text)) { m.retreats++; if (hp() >= backHp) m.recovered++; }
      if (!run.ok && run.stoppedBy !== 'stopIf' && !(bodyMode && /退いた先/u.test(text))) { failStreak++; await sleep(2000); if (failStreak >= 5) { note(`${failStreak} acts in a row failed: the camp is lost (${(run.lines[0] ?? '').slice(0, 160)})`); break; } } else failStreak = 0;
      if (hp() <= 0) break;
      if (!bodyMode && hp() < stopHp) {
        m.retreats++;
        const lowAt = Date.now();
        if (boxesLeft > 0 && hp() < 8) { boxesLeft--; m.boxes++; await dumpBox('blaze_low', `${kind}#${m.acts} hp ${before} -> ${r1(hp())}: ${(run.lines[0] ?? '').slice(0, 160)}`); }
        const hpThen = hp();
        await sleep(thinkMs);                       // the head reads the stop and decides
        m.hpLostWhileThinking += Math.max(0, hpThen - hp());
        if (retreatOn) {
          const now = await readCamp();
          const spot = now?.hideouts?.[0] as { x: number; y: number; z: number; steps: number } | undefined;
          if (!spot) { m.noHideout++; note(`no hideout in the answer: ${String(now?.text ?? '').slice(-160)}`); }
          const hpOut = hp();
          const out = await act('retreat', [{ do: 'go', to: spot ? { x: spot.x, y: spot.y, z: spot.z } : { x: stand[0], y: stand[1], z: stand[2] }, range: 0.6, seconds: 25, canPlace, maxPlace: 30 }], 40, { accept: ['blaze'] });
          m.hpLostOnTheWayOut += Math.max(0, hpOut - hp());
          if (!out.ok) note(`retreat go: ${(out.lines[0] ?? '').slice(0, 200)}`);
          // Eat and wait until the health is back (at most 50 s).
          const waitUntil = Date.now() + 50_000;
          while (Date.now() < waitUntil && hp() > 0 && hp() < backHp && !disconnected) {
            if (hp() < 7 && packClient().golden_apple) { await act('apple', [{ do: 'eat', item: 'golden_apple' }], 15); m.eats++; }
            else if (Number(actor.food) < 20) { await act('eat', [{ do: 'eat' }], 15); m.eats++; }
            await sleep(1500);
          }
          if (hp() >= backHp) m.recovered++;
        } else {
          // No retreat: only eat and wait where it stands (what a head without the hideouts has).
          const waitUntil = Date.now() + 30_000;
          while (Date.now() < waitUntil && hp() > 0 && hp() < backHp && !disconnected) {
            if (Number(actor.food) < 20) { await act('eat', [{ do: 'eat' }], 15); m.eats++; }
            await sleep(1500);
          }
        }
        m.secondsAway += (Date.now() - lowAt) / 1000;
        // (the way back is the loop's next go to the camp cell: its health is counted in the act)
        if (hp() < 9) { note(`health ${r1(hp())} after the retreat: stop`); break; }
      }
      await sleep(thinkMs);
    }
  } finally { clearInterval(sampler); }
  const rods = (await countServer('blaze_rod')) - rods0;
  const minutes = (Date.now() - start) / 60_000;
  const lowSeconds = track.filter(value => value < 12).length;
  return { seconds: r1((Date.now() - start) / 1000), rods, rodsPerMinute: r1(rods / Math.max(minutes, 0.1)), ...m, secondsAway: r1(m.secondsAway), secondsBelow12: lowSeconds, shieldWear: shieldUsed() - shield0, deathsHere: deaths,
    hpTrack: track.filter((_, index) => index % 5 === 0).join(' '), kind, thinkMs, stopHp, backHp, retreatOn, bodyMode };
}
scene('blaze_proto_fight', 'the head\'s protocol at the c1 camp (fight, accept blaze, stopIf hpBelow 12 → hideout → eat → back), 5 s of thinking between acts', note => blazeProtocol('fight', note));
scene('blaze_proto_body', 'the body\x27s own retreat (fight with no retreatHp and no stopIf: below 10 hearts to a hideout, eat, rest to 18, the hand ends), 40 s fights, 5 s of thinking between acts', note => blazeProtocol('fight', note, { body: true }));
scene('blaze_proto_body_b', 'the same again (a second sample)', note => blazeProtocol('fight', note, { body: true }));
scene('blaze_proto_hold', 'the same protocol with attack hold in place of fight', note => blazeProtocol('hold', note));
// The sortie protocol (S2, 2026-11-02): the body rests at the hideout, where nothing sees it, and goes out for one short act at a time: [go to the camp cell, fight a few seconds, pick up, go back to the
// hideout]. The head's thinking time is spent at the hideout, not in the blazes' sight. The next sortie starts when the health is back (backHp).
async function blazeSortie(note: (text: string) => void, options: { fightSeconds?: number; backHp?: number; retreatHp?: number; thinkMs?: number; nearest?: boolean; r59?: boolean } = {}): Promise<Record<string, unknown>> {
  const stand = sites.blazeStand as number[] | undefined;
  if (!stand) throw new Error('no blazeStand in the sites');
  const fightSeconds = options.fightSeconds ?? 12, backHp = options.backHp ?? 18, thinkMs = options.thinkMs ?? 5000;
  const seconds = timedSeconds || 300;
  await ask('difficulty normal'); await ask('time set midnight'); await ask('weather clear');
  await ask('execute in minecraft:the_nether run kill @e[type=minecraft:blaze]');
  await equip(options.r59 ? { stone_sword: 1, diamond_pickaxe: 1, shield: 1, cooked_porkchop: 7, cobblestone: 173 } : { diamond_sword: 1, iron_pickaxe: 1, shield: 2, cooked_beef: 24, golden_apple: 3, cobblestone: 64 }, { armor: 'iron', shield: true });
  await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  const start = Date.now();
  const rods0 = await countServer('blaze_rod');
  const shield0 = shieldUsed();
  const m = { sorties: 0, kills: 0, hpLostInSorties: 0, worstSortie: 0, lowestHp: 20, secondsBelow10: 0, restSeconds: 0, eats: 0, failedActs: 0, reflexStops: 0, boxes: 0 };
  let boxesLeft = 3;
  const track: number[] = [];
  const sampler = setInterval(() => { const value = Number(actor.health); if (Number.isFinite(value)) { track.push(r1(value)); m.lowestHp = Math.min(m.lowestHp, value); if (value < 10) m.secondsBelow10++; } }, 1000);
  const hp = () => Number(actor.health);
  const readCamp = async (): Promise<any> => { const found = await runSkill('probe', { kind: 'camp' }, 20); try { return JSON.parse(String(found.receipt?.result ?? '')); } catch { return null; } };
  const canPlace = ['cobblestone', 'netherrack'];
  let failStreak = 0, lastCell: { x: number; y: number; z: number } | undefined, lastSpot: { x: number; y: number; z: number } | undefined;
  const deaths0 = deaths;
  try {
    while (Date.now() - start < seconds * 1000 && !disconnected && hp() > 0 && deaths === deaths0) {
      const camp = await readCamp();
      // (what the probe said last is kept when it says nothing: a head that has read the camp once does not lose it to a fire)
      const hideouts = ((camp?.hideouts ?? []) as Array<{ x: number; y: number; z: number; steps: number; away: number }>).slice();
      if (options.nearest) hideouts.sort((a, b) => a.steps - b.steps);
      const cell = (camp?.cells?.[0] ?? lastCell) as { x: number; y: number; z: number } | undefined;
      const spot = (hideouts[0] ?? lastSpot) as { x: number; y: number; z: number; away?: number } | undefined;
      if (!camp?.cells?.[0] || !hideouts[0]) note(`the probe said: cells ${JSON.stringify((camp?.cells ?? []).length)} hideouts ${hideouts.length}; ${String(camp?.text ?? '').slice(-160)}`);
      if (!cell || !spot) { note(`no camp cell or hideout and none known: ${String(camp?.text ?? '').slice(0, 200)}`); break; }
      lastCell = cell; lastSpot = spot;
      // At the hideout: eat and wait until the health is back.
      const restFrom = Date.now();
      while (Date.now() - restFrom < 60_000 && hp() > 0 && hp() < backHp && !disconnected) {
        if (hp() < 7 && packClient().golden_apple) { await act('apple', [{ do: 'eat', item: 'golden_apple' }], 15); m.eats++; }
        else if (Number(actor.food) < 20) { await act('eat', [{ do: 'eat' }], 15); m.eats++; }
        await sleep(1500);
      }
      m.restSeconds += (Date.now() - restFrom) / 1000;
      const before = hp();
      const hands = [{ do: 'go', to: { x: cell.x, y: cell.y, z: cell.z }, range: 0.6, seconds: 20, canPlace, maxPlace: 30 },
        { do: 'fight', target: 'blaze', seconds: fightSeconds, ...(options.retreatHp ? { retreatHp: options.retreatHp } : {}), onFail: 'continue' }, { do: 'pickup', range: 8, onFail: 'continue' },
        { do: 'go', to: { x: spot.x, y: spot.y, z: spot.z }, range: 0.8, seconds: 25, canPlace, maxPlace: 30 }];
      const run = await act(`sortie#${m.sorties + 1}`, hands, 90, { accept: ['blaze'] });
      m.sorties++;
      const text = run.lines.join(' ');
      m.kills += (text.match(/fight 済 blaze/gu) ?? []).length;
      if (run.stoppedBy === 'reflex') m.reflexStops++;
      const lost = Math.max(0, before - Math.min(before, hp()));
      m.hpLostInSorties += lost; m.worstSortie = Math.max(m.worstSortie, lost);
      if (boxesLeft > 0 && (lost >= 8 || hp() < 8)) { boxesLeft--; m.boxes++; await dumpBox('blaze_sortie', `sortie#${m.sorties} hp ${r1(before)} -> ${r1(hp())}: ${(run.lines[1] ?? run.lines[0] ?? '').slice(0, 160)}`); }
      if (!run.ok) {
        m.failedActs++;
        // Not at the hideout (a reflex took the body, or a go stopped): the way there again at once, before anything else.
        const out = await act('to the hideout', [{ do: 'go', to: { x: spot.x, y: spot.y, z: spot.z }, range: 0.8, seconds: 25, canPlace, maxPlace: 30 }], 40, { accept: ['blaze'] });
        if (!out.ok) { failStreak++; note(`to the hideout: ${(out.lines[0] ?? '').slice(0, 180)}`); if (failStreak >= 4) { note('four failed ways to the hideout: stop'); break; } } else failStreak = 0;
      } else failStreak = 0;
      await sleep(thinkMs);
    }
  } finally { clearInterval(sampler); }
  const rods = (await countServer('blaze_rod')) - rods0;
  const minutes = (Date.now() - start) / 60_000;
  return { seconds: r1((Date.now() - start) / 1000), rods, rodsPerMinute: r1(rods / Math.max(minutes, 0.1)), ...m, hpLostInSorties: r1(m.hpLostInSorties), worstSortie: r1(m.worstSortie), restSeconds: r1(m.restSeconds), shieldWear: shieldUsed() - shield0, deathsHere: deaths,
    hpTrack: track.filter((_, index) => index % 5 === 0).join(' '), fightSeconds, backHp, thinkMs };
}
scene('blaze_sortie', 'the sortie protocol at the c1 camp: rest at the hideout, then [go to the camp cell, fight 12 s, pick up, go back to the hideout], 5 s of thinking at the hideout', note => blazeSortie(note));
scene('blaze_r59_sortie', 'the sortie protocol with the run59 pack (stone sword, one shield, 7 pork, 173 cobblestone), blows from behind the raised shield, 600 s', note => blazeSortie(note, { r59: true }));
scene('blaze_sortie_b', 'the sortie protocol again (a second sample)', note => blazeSortie(note));
scene('blaze_sortie_near', 'the sortie protocol resting at the NEAREST hideout (by steps) whether or not it is within the spawner\x27s 16 m', note => blazeSortie(note, { nearest: true }));
scene('blaze_sortie_long', 'the sortie protocol with 25 s fights and retreatHp 11', note => blazeSortie(note, { fightSeconds: 25, retreatHp: 11 }));
// The loop in ONE act (S2, 2026-11-02): the head names the whole cycle once and the body runs it with no gap for the head's thinking between sorties: [go to the camp cell, fight (only if the
// go got there), pick up, go to the hideout, eat, wait], repeated. A stop (a reflex, a failed go) ends the act: the head's next act goes to the hideout first.
async function blazeLoop(note: (text: string) => void, options: { fightSeconds?: number; waitSeconds?: number; passes?: number } = {}): Promise<Record<string, unknown>> {
  const stand = sites.blazeStand as number[] | undefined;
  if (!stand) throw new Error('no blazeStand in the sites');
  const fightSeconds = options.fightSeconds ?? 12, waitSeconds = options.waitSeconds ?? 12, passes = options.passes ?? 8, thinkMs = 4500;
  const seconds = timedSeconds || 300;
  await ask('difficulty normal'); await ask('time set midnight'); await ask('weather clear');
  await ask('execute in minecraft:the_nether run kill @e[type=minecraft:blaze]');
  await equip({ diamond_sword: 1, iron_pickaxe: 1, shield: 2, cooked_beef: 24, golden_apple: 3, cobblestone: 64 }, { armor: 'iron', shield: true });
  await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  const start = Date.now();
  const rods0 = await countServer('blaze_rod');
  const shield0 = shieldUsed();
  const m = { acts: 0, passesDone: 0, kills: 0, reflexStops: 0, failedActs: 0, lowestHp: 20, secondsBelow10: 0, boxes: 0, restarts: 0 };
  let boxesLeft = 3;
  const track: number[] = [];
  const sampler = setInterval(() => { const value = Number(actor.health); if (Number.isFinite(value)) { track.push(r1(value)); m.lowestHp = Math.min(m.lowestHp, value); if (value < 10) m.secondsBelow10++; } }, 1000);
  const hp = () => Number(actor.health);
  const readCamp = async (): Promise<any> => { const found = await runSkill('probe', { kind: 'camp' }, 20); try { return JSON.parse(String(found.receipt?.result ?? '')); } catch { return null; } };
  const canPlace = ['cobblestone', 'netherrack'];
  let lastCell: { x: number; y: number; z: number } | undefined, lastSpot: { x: number; y: number; z: number } | undefined, failStreak = 0;
  const deaths0 = deaths;
  try {
    while (Date.now() - start < seconds * 1000 && !disconnected && hp() > 0 && deaths === deaths0) {
      const camp = await readCamp();
      const cell = (camp?.cells?.[0] ?? lastCell) as { x: number; y: number; z: number } | undefined, spot = (camp?.hideouts?.[0] ?? lastSpot) as { x: number; y: number; z: number } | undefined;
      if (!cell || !spot) { note('no camp cell or hideout and none known'); break; }
      lastCell = cell; lastSpot = spot;
      const hideout = { x: spot.x, y: spot.y, z: spot.z };
      // At the hideout first, until the health is back.
      const restFrom = Date.now();
      while (Date.now() - restFrom < 40_000 && hp() > 0 && hp() < 18 && !disconnected) { if (Number(actor.food) < 20) await act('eat', [{ do: 'eat' }], 15); await sleep(1500); }
      const before = hp();
      const hands = [
        { do: 'go', to: { x: cell.x, y: cell.y, z: cell.z }, range: 0.6, seconds: 20, canPlace, maxPlace: 30, onFail: 'continue' },
        { do: 'fight', target: 'blaze', seconds: fightSeconds, dependsOn: [1], onFail: 'continue' },
        { do: 'pickup', range: 8, onFail: 'continue' },
        { do: 'go', to: hideout, range: 0.8, seconds: 25, canPlace, maxPlace: 30 },
        { do: 'eat', onFail: 'continue' },
        { do: 'wait', seconds: waitSeconds },
      ];
      const run = await act(`loop#${m.acts + 1}`, hands, 420, { accept: ['blaze'], repeat: passes });
      m.acts++;
      const text = run.lines.join(' ');
      m.kills += (text.match(/fight 済 blaze/gu) ?? []).length;
      m.passesDone += Number(run.json?.repeat?.done ?? 0);
      if (run.stoppedBy === 'reflex') m.reflexStops++;
      if (boxesLeft > 0 && hp() < 8) { boxesLeft--; m.boxes++; await dumpBox('blaze_loop', `loop#${m.acts} hp ${r1(before)} -> ${r1(hp())}: ${(run.lines[1] ?? run.lines[0] ?? '').slice(0, 160)}`); }
      if (!run.ok) {
        m.failedActs++;
        note(`loop#${m.acts} stopped (${run.stoppedBy ?? ''} ${String(run.stoppedWhy ?? '').slice(0, 90)}): ${(run.lines.find(line => /stopped|failed/u.test(line)) ?? '').slice(0, 220)}`);
        await sleep(thinkMs);                    // the head reads the stop
        const out = await act('to the hideout', [{ do: 'go', to: hideout, range: 0.8, seconds: 25, canPlace, maxPlace: 30 }], 40, { accept: ['blaze'] });
        if (!out.ok) { failStreak++; if (failStreak >= 4) { note('four failed ways to the hideout: stop'); break; } } else failStreak = 0;
        m.restarts++;
      }
    }
  } finally { clearInterval(sampler); }
  const rods = (await countServer('blaze_rod')) - rods0;
  const minutes = (Date.now() - start) / 60_000;
  return { seconds: r1((Date.now() - start) / 1000), rods, rodsPerMinute: r1(rods / Math.max(minutes, 0.1)), ...m, shieldWear: shieldUsed() - shield0, deathsHere: deaths, hpTrack: track.filter((_, index) => index % 5 === 0).join(' '), fightSeconds, waitSeconds, passes };
}
scene('blaze_loop', 'the whole sortie cycle as ONE act with repeat 8: [go camp, fight 12 s if there, pick up, go hideout, eat, wait 12 s]', note => blazeLoop(note));
scene('blaze_loop_b', 'the loop again (a second sample)', note => blazeLoop(note));
// shield_rush (S2, 2026-11-03): the scripted head rests at the hideout, picks the blaze nearest the camp cell from the entities it knows (an id), then ONE act [go to the camp cell, attack #id style=shield_rush
// with retreatTo = the hideout]; reads the result (status, code, hits, rods, hp, shield) and goes again, with the 5 s of thinking between acts. Run59's pack.
async function blazeRush(note: (text: string) => void, options: { retreatHp?: number; shieldReserve?: number; seconds?: number } = {}): Promise<Record<string, unknown>> {
  const stand = sites.blazeStand as number[] | undefined;
  if (!stand) throw new Error('no blazeStand in the sites');
  const seconds = timedSeconds || 600, thinkMs = 5000;
  await ask('difficulty normal'); await ask('time set midnight'); await ask('weather clear');
  await ask('execute in minecraft:the_nether run kill @e[type=minecraft:blaze]');
  await equip({ stone_sword: 1, diamond_pickaxe: 1, shield: 1, cooked_porkchop: 7, cobblestone: 173 }, { armor: 'iron', shield: true });
  await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  const start = Date.now(), rods0 = await countServer('blaze_rod'), shield0 = shieldUsed();
  const m = { rushes: 0, killed: 0, retreated: 0, failed: 0, cut: 0, codes: {} as Record<string, number>, hits: 0, lowestHp: 20, eats: 0, restSeconds: 0, exposedSeconds: 0 };
  const track: number[] = [];
  const sampler = setInterval(() => { const value = Number(actor.health); if (Number.isFinite(value)) { track.push(r1(value)); m.lowestHp = Math.min(m.lowestHp, value); } }, 1000);
  const hp = () => Number(actor.health);
  const readCamp = async (): Promise<any> => { const found = await runSkill('probe', { kind: 'camp' }, 20); try { return JSON.parse(String(found.receipt?.result ?? '')); } catch { return null; } };
  const canPlace = ['cobblestone', 'netherrack'];
  let lastCell: { x: number; y: number; z: number } | undefined, lastSpot: { x: number; y: number; z: number } | undefined;
  const deaths0 = deaths;
  try {
    while (Date.now() - start < seconds * 1000 && !disconnected && hp() > 0 && deaths === deaths0) {
      const camp = await readCamp();
      const cell = (camp?.cells?.[0] ?? lastCell) as { x: number; y: number; z: number } | undefined, spot = (camp?.hideouts?.[0] ?? lastSpot) as { x: number; y: number; z: number } | undefined;
      if (!cell || !spot) { note('no camp cell or hideout and none known'); break; }
      if (!lastCell) { const at = (dy: number) => actor.blockAt(new Vec3(spot.x, spot.y + dy, spot.z))?.name; note(`hideout ${JSON.stringify(spot)} blocks below/feet/head: ${at(-1)}/${at(0)}/${at(1)}; all hideouts ${JSON.stringify(camp?.hideouts ?? [])}`); }
      lastCell = cell; lastSpot = spot;
      const restFrom = Date.now();
      while (Date.now() - restFrom < 60_000 && hp() > 0 && hp() < 18 && !disconnected) { if (Number(actor.food) < 20) { await act('eat', [{ do: 'eat' }], 15); m.eats++; } await sleep(1500); }
      m.restSeconds += (Date.now() - restFrom) / 1000;
      const blazes = (Object.values(actor.entities ?? {}) as any[]).filter(entity => String(entity?.name) === 'blaze' && entity.position)
        .sort((a, b) => a.position.distanceTo(new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5)) - b.position.distanceTo(new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5)));
      if (!blazes.length) { await sleep(3000); continue; }
      await sleep(thinkMs);                                     // the head's thinking, at the hideout
      const rodsBefore = packClient().blaze_rod ?? 0, outAt = Date.now();
      const run = await act(`rush#${m.rushes + 1}`, [
        { do: 'go', to: { x: cell.x, y: cell.y, z: cell.z }, range: 0.6, seconds: 20, canPlace, maxPlace: 10, onFail: 'continue' },
        { do: 'attack', target: `#${blazes[0].id}`, style: 'shield_rush', seconds: options.seconds ?? 60, retreatHp: options.retreatHp ?? 12, retreatTo: { x: spot.x, y: spot.y, z: spot.z },
          area: { center: { x: cell.x, y: cell.y, z: cell.z }, radius: 5, maxDrop: 0 }, shieldReserve: options.shieldReserve ?? 60, onCrossfire: 'retreat', pickup: 'target_drops' }], 90, { accept: ['blaze'] });
      m.rushes++; m.exposedSeconds += (Date.now() - outAt) / 1000;
      const rush = ((run.json?.lines ?? []) as any[]).map(line => line.shieldRush).find(Boolean);
      if (rush) {
        m[rush.status as 'killed' | 'retreated' | 'failed' | 'cut'] = (m[rush.status as 'killed' | 'retreated' | 'failed' | 'cut'] ?? 0) + 1;
        if (rush.code) m.codes[rush.code] = (m.codes[rush.code] ?? 0) + 1;
        m.hits += Number(rush.hits ?? 0);
      }
      note(`rush#${m.rushes}: hp ${r1(hp())} rods +${(packClient().blaze_rod ?? 0) - rodsBefore} ${rush ? `${rush.status} ${rush.code ?? ''} hits ${rush.hits} hp ${r1(rush.hpMin)}→${r1(rush.hpEnd)} shield ${rush.shieldBefore}→${rush.shieldAfter} safe ${rush.safe} at ${rush.at ? `${rush.at.x},${rush.at.y},${rush.at.z}` : ''}` : (run.lines[1] ?? run.lines[0] ?? '').slice(0, 200)}`);
      if ((!run.ok && !rush) || (rush && !rush.safe)) {
        const out = await act('to the hideout', [{ do: 'go', to: { x: spot.x, y: spot.y, z: spot.z }, range: 0.8, seconds: 25, canPlace, maxPlace: 30 }], 40, { accept: ['blaze'] });
        if (!out.ok) note(`to the hideout: ${(out.lines[0] ?? '').slice(0, 160)}`);
      }
    }
  } finally { clearInterval(sampler); }
  const rods = (await countServer('blaze_rod')) - rods0;
  return { seconds: r1((Date.now() - start) / 1000), rods, ...m, shieldWear: shieldUsed() - shield0, deathsHere: deaths, hpTrack: track.filter((_, index) => index % 5 === 0).join(' ') };
}
scene('blaze_rush', 'shield_rush from the scripted head: rest at the hideout, pick the nearest blaze id, ONE act [go to the camp cell, attack #id shield_rush, retreatTo the hideout], repeat; run59 pack', note => blazeRush(note));
// The nook (S2, 2026-11-02): the camp cell has walls on two sides; the body closes the other two sides to the head's height with cobblestone (the top stays open: a blaze sees in only from straight
// above), leaves the head cell of the side that faces the spawner open as a window, and holds there. Measures what the camp costs with a room's worth of blazes that can see only through the window.
async function blazeNook(note: (text: string) => void, options: { window?: boolean; seconds?: number; bow?: boolean; r59?: boolean; corner?: 'toward' | 'away'; fight?: boolean; peek?: boolean; lure?: boolean; calm?: boolean; rest?: boolean; lid?: boolean; cap?: boolean } = {}): Promise<Record<string, unknown>> {
  const stand = sites.blazeStand as number[] | undefined, spawner = sites.blazeSpawner as number[] | undefined;
  if (!stand || !spawner) throw new Error('no blazeStand or blazeSpawner in the sites');
  const seconds = options.seconds ?? (timedSeconds || 240);
  await ask('difficulty normal'); await ask('time set midnight'); await ask('weather clear');
  await ask('execute in minecraft:the_nether run kill @e[type=minecraft:blaze]');
  await equip(options.r59 ? { stone_sword: 1, diamond_pickaxe: 1, shield: 1, cooked_porkchop: 7, cobblestone: 173 } : { diamond_sword: 1, iron_pickaxe: 1, shield: 2, cooked_beef: 24, golden_apple: 3, cobblestone: 64, ...(options.bow ? { bow: 1, arrow: 64 } : {}) }, { armor: 'iron', shield: true });
  await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  // calm: the spawner is quiet while the body walks to the cell and closes its corner (a blaze standing in the cell to be closed made the build fail in the first samples)
  if (options.calm) { await ask('gamerule doMobSpawning false'); await ask('execute in minecraft:the_nether run kill @e[type=minecraft:blaze]'); }
  const camp = await runSkill('probe', { kind: 'camp' }, 20);
  let cell: { x: number; y: number; z: number } | undefined;
  try { cell = JSON.parse(String(camp.receipt?.result ?? '')).cells?.[0]; } catch { cell = undefined; }
  if (!cell) throw new Error('no camp cell');
  const solidAt = (x: number, y: number, z: number) => { const b = actor.blockAt(new Vec3(x, y, z)); return !!b && b.boundingBox === 'block'; };
  // the four sides; those open (at the feet or the head) are closed, the one toward the spawner keeps its head cell open as the window
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  const toward = [...sides].sort((a, b) => ((spawner[0] - cell!.x) * b[0] + (spawner[2] - cell!.z) * b[1]) - ((spawner[0] - cell!.x) * a[0] + (spawner[2] - cell!.z) * a[1]))[0];
  const place: Array<{ x: number; y: number; z: number }> = [];
  // corner: only the one open side (toward the spawner, or the other) is closed, two high; the other stays open as the front
  const open2 = sides.filter(([dx, dz]) => !solidAt(cell!.x + dx, cell!.y, cell!.z + dz) && !solidAt(cell!.x + dx, cell!.y + 1, cell!.z + dz));
  const closeOnly = options.corner ? (options.corner === 'toward' ? open2.find(([dx, dz]) => dx === toward[0] && dz === toward[1]) : open2.find(([dx, dz]) => !(dx === toward[0] && dz === toward[1]))) : null;
  for (const [dx, dz] of options.corner ? (closeOnly ? [closeOnly] : []) : sides) {
    const x = cell.x + dx, z = cell.z + dz;
    if (options.corner) { for (const dy of [0, 1]) if (!solidAt(x, cell.y + dy, z)) place.push({ x, y: cell.y + dy, z }); continue; }
    if (!solidAt(x, cell.y, z)) place.push({ x, y: cell.y, z });
    const window = options.window !== false && dx === toward[0] && dz === toward[1];
    if (!window && !solidAt(x, cell.y + 1, z)) place.push({ x, y: cell.y + 1, z });
  }
  note(`camp cell ${JSON.stringify(cell)}, window side ${JSON.stringify(toward)}, to place ${JSON.stringify(place.map(p => [p.x, p.y, p.z]))}`);
  const canPlace = ['cobblestone'];
  const started = Date.now();
  const rods0 = await countServer('blaze_rod'), shield0 = shieldUsed();
  let killed = 0, exposed = 0;
  const onDead = (entity: any) => { if (String(entity?.name ?? '') === 'blaze') killed++; };
  actor.on('entityDead', onDead);
  const track: number[] = [];
  const sampler = setInterval(() => { const value = Number(actor.health); if (Number.isFinite(value)) track.push(r1(value)); }, 1000);
  // census: every 30 s, the blazes the client knows: their offsets from the body (x z y) and the distance, for what the spawner does with a lid
  const census = setInterval(() => { try { const me = actor.entity.position as Vec3; const list = (Object.values(actor.entities ?? {}) as any[]).filter(entity => String(entity?.name) === 'blaze' && entity.position).map(entity => `${r1(entity.position.x - me.x)},${r1(entity.position.z - me.z)},${r1(entity.position.y - me.y)}`); note(`census ${Math.round((Date.now() - started) / 1000)} s: ${list.length} blazes [${list.join(' ')}]`); } catch { /* a note */ } }, options.lid ? 30_000 : 3_600_000);
  try {
    const there = await act('go to the camp cell', [{ do: 'go', to: { x: cell.x, y: cell.y, z: cell.z }, range: 0.6, seconds: 25, canPlace, maxPlace: 10 }], 40, { accept: ['blaze'] });
    note(`go: hp ${actor.health} ${(there.lines[0] ?? '').slice(0, 160)}`);
    const built = await act('build the nook', [{ do: 'place', at: place, block: 'cobblestone' }], 40, { accept: ['blaze'] });
    note(`place: hp ${actor.health} ${built.lines.join(' | ').slice(0, 400)}`);
    const inside = actor.entity.position as Vec3;
    // lid: the room's layer above the floor is filled with cobblestone but for the 3x3 round the spawner and the head cell of the body, so the only floor a blaze can be put on (it needs the cell and the one over it free)
    // is round the spawner, within a sword's reach of the camp cell (S2, 2026-11-03: the spawner is quiet while this is laid)
    if (options.lid) {
      const lidY = spawner[1] + 1, nether = 'execute in minecraft:the_nether run';
      await ask(`${nether} fill ${spawner[0] - 2} ${lidY} ${spawner[2] - 2} ${spawner[0] + 2} ${lidY} ${spawner[2] + 2} minecraft:cobblestone replace minecraft:air`);
      await ask(`${nether} fill ${spawner[0] - 1} ${lidY} ${spawner[2] - 1} ${spawner[0] + 1} ${lidY} ${spawner[2] + 1} minecraft:air`);
      await ask(`${nether} setblock ${cell.x} ${lidY} ${cell.z} minecraft:air`);
      // cap: the 3x3 gets a roof two cells over the floor too, so what spawns there cannot rise (a cage of 3x3x2: nothing leaves it, and the count of six near the spawner stays true)
      if (options.cap) await ask(`${nether} fill ${spawner[0] - 1} ${lidY + 1} ${spawner[2] - 1} ${spawner[0] + 1} ${lidY + 1} ${spawner[2] + 1} minecraft:cobblestone replace minecraft:air`);
      // the head cell of the body is the way out of the cage (census, cap1: blazes at 14 m): its column gets the roof too
      if (options.cap) await ask(`${nether} setblock ${cell.x} ${lidY + 1} ${cell.z} minecraft:cobblestone`);
      note(`lid laid at y=${lidY} over the 5x5 round the spawner but the 3x3 and the body's head cell`);
    }
    if (options.calm) await ask('gamerule doMobSpawning true');
    note(`standing at ${r1(inside.x)},${r1(inside.y)},${r1(inside.z)}; closed cells now: ${place.map(p => `${p.x},${p.y},${p.z}=${actor.blockAt(new Vec3(p.x, p.y, p.z))?.name}`).join(' ')}`);
    let n = 0;
    // peek: from the corner it steps out to the cell in front (toward the spawner), strikes a few seconds, and is back in the corner (a step or two), the pause in the corner
    const front = options.peek || options.lure ? ((): { x: number; y: number; z: number } | null => { const open = sides.filter(([dx, dz]) => !solidAt(cell!.x + dx, cell!.y, cell!.z + dz) && !place.some(q => q.x === cell!.x + dx && q.z === cell!.z + dz)); const pick = open.find(([dx, dz]) => dx === toward[0] && dz === toward[1]) ?? open[0]; return pick ? { x: cell!.x + pick[0], y: cell!.y, z: cell!.z + pick[1] } : null; })() : null;
    if (options.peek || options.lure) note(`front cell ${JSON.stringify(front)}`);
    while (Date.now() - started < seconds * 1000 && !disconnected && Number(actor.health) > 0) {
      // lure: a short step out to the front cell to be seen (no strike), back in the corner, then hold there for what came close
      if (options.lure && front) {
        const outAt = Date.now();
        const out = await act(`lure#${++n}`, [{ do: 'go', to: front, range: 0.4, seconds: 5, onFail: 'continue' }, { do: 'wait', seconds: 2 }, { do: 'go', to: { x: cell.x, y: cell.y, z: cell.z }, range: 0.3, seconds: 8 }], 30, { accept: ['blaze'] });
        exposed += (Date.now() - outAt) / 1000;
        const run = await act(`hold#${n}`, [{ do: 'attack', target: 'blaze', hold: true, seconds: 15 }], 30, { accept: ['blaze'] });
        note(`lure#${n}: hp ${r1(Number(actor.health))} kills ${killed} out ${r1((Date.now() - outAt) / 1000)}s ${out.ok ? '' : 'STOP '}${run.lines.join(' | ').slice(0, 200)}`);
        if (Number(actor.health) < 14 && Number(actor.food) < 20) await act('eat', [{ do: 'eat' }], 15);
        if (Number(actor.health) < 8) break;
        const waitFrom = Date.now();
        while (Number(actor.health) < 16 && Date.now() - waitFrom < 40_000) await sleep(2000);
        continue;
      }
      if (options.peek && front) {
        const run = await act(`peek#${++n}`, [{ do: 'go', to: front, range: 0.4, seconds: 6, onFail: 'continue' }, { do: 'fight', target: 'blaze', seconds: 6, retreatHp: 1, onFail: 'continue' }, { do: 'go', to: { x: cell.x, y: cell.y, z: cell.z }, range: 0.3, seconds: 8 }], 40, { accept: ['blaze'] });
        note(`peek#${n}: hp ${r1(Number(actor.health))} ${run.lines.join(' | ').slice(0, 300)}`);
        if (Number(actor.health) < 14 && Number(actor.food) < 20) await act('eat', [{ do: 'eat' }], 15);
        await sleep(Number(actor.health) < 16 ? 8000 : 3000);
        if (Number(actor.health) < 8) break;
        continue;
      }
      const run = await act(`hold#${++n}`, [options.bow ? { do: 'shoot', target: 'blaze', n: 3, item: 'bow', onFail: 'continue' } : options.fight ? { do: 'fight', target: 'blaze', seconds: 20, onFail: 'continue' } : { do: 'attack', target: 'blaze', hold: true, seconds: 20 }], 40, { accept: ['blaze'] });
      if (options.bow && !run.ok) await sleep(1500);
      if (options.corner && Number(actor.health) < 14 && Number(actor.food) < 20) await act('eat', [{ do: 'eat' }], 15);
      note(`hold#${n}: hp ${r1(Number(actor.health))} ${run.lines.join(' | ').slice(0, 260)}`);
      if (options.rest) {
        // the head's turn between acts: back to the corner if the fight's retreat took the body away, then eat and wait there for the health (rest and go again as often as it takes)
        const here = actor.entity.position as Vec3;
        if (Math.hypot(here.x - (cell.x + 0.5), here.z - (cell.z + 0.5)) > 2.5 && Number(actor.health) > 0) await act('back to the corner', [{ do: 'go', to: { x: cell.x, y: cell.y, z: cell.z }, range: 0.6, seconds: 25, canPlace: ['cobblestone'], maxPlace: 6, onFail: 'continue' }], 40, { accept: ['blaze'] });
        const waitFrom = Date.now();
        while (Number(actor.health) > 0 && Number(actor.health) < 18 && Date.now() - waitFrom < 40_000) { if (Number(actor.food) < 20 && Number(actor.health) < 14) await act('eat', [{ do: 'eat' }], 15); await sleep(1500); }
        exposed += (Date.now() - waitFrom) / 1000 * 0;
        continue;
      }
      if (Number(actor.health) < 8) break;
    }
  } finally { clearInterval(sampler); clearInterval(census); actor.removeListener('entityDead', onDead); }
  return { seconds: r1((Date.now() - started) / 1000), kills: killed, rodsOnTheFloor: (await countServer('blaze_rod')) - rods0, shieldWear: shieldUsed() - shield0, deathsHere: deaths, lowestHp: Math.min(...track, 20), hpTrack: track.filter((_, index) => index % 5 === 0).join(' '), placed: place.length, window: options.window !== false, ...(options.lure ? { secondsOut: r1(exposed) } : {}) };
}
scene('blaze_nook', 'the nook: the camp cell closed on its open sides to the head height with a window at the head toward the spawner, then attack hold for 240 s', note => blazeNook(note));
scene('blaze_nook_bow', 'the nook with its window, and a bow: shoot blazes through the window from 2-4 m, 240 s', note => blazeNook(note, { bow: true }));
scene('blaze_r59_nook', 'run59 pack: the window nook, attack hold 300 s', note => blazeNook(note, { r59: true, seconds: 300 }));
scene('blaze_r59_corner_toward', 'run59 pack: only the side toward the spawner closed (two high), the other open as the front, hold 300 s', note => blazeNook(note, { r59: true, corner: 'toward', seconds: 300 }));
scene('blaze_r59_corner_away', 'run59 pack: only the side away from the spawner closed, the side toward it open as the front, hold 300 s', note => blazeNook(note, { r59: true, corner: 'away', seconds: 300 }));
scene('blaze_r59_corner_fight', 'run59 pack: corner (away closed) with fight 20 s acts', note => blazeNook(note, { r59: true, corner: 'away', fight: true, seconds: 300 }));
scene('blaze_r59_corner_away_long', 'run59 pack: the away-side corner (two blocks), hold, eating under 14 hearts, 600 s', note => blazeNook(note, { r59: true, corner: 'away', seconds: 600 }));
scene('blaze_r59_corner_toward_long', 'run59 pack: the toward-side corner, hold, eating under 14 hearts, 600 s', note => blazeNook(note, { r59: true, corner: 'toward', seconds: 600 }));
scene('blaze_r59_corner_lure', 'run59 pack: the away-side corner; steps out to the front cell 5 s to be seen (no strike), back in, hold 15 s, rest to 16 hearts; 600 s', note => blazeNook(note, { r59: true, corner: 'away', lure: true, seconds: 600 }));
scene('blaze_r59_corner_calm_fight', 'run59 pack: the away-side corner built while the spawner is quiet, then fight 20 s acts, 600 s (the shield-up blow rule)', note => blazeNook(note, { r59: true, corner: 'away', fight: true, calm: true, seconds: 600 }));
scene('blaze_r59_corner_calm_hold', 'run59 pack: the away-side corner built while the spawner is quiet, then attack hold, 600 s', note => blazeNook(note, { r59: true, corner: 'away', calm: true, seconds: 600 }));
scene('blaze_r59_corner_calm_rest_fight', 'run59 pack: the away-side corner built while the spawner is quiet; fight 20 s acts, back to the corner, eat and wait to 18 hearts, again; 600 s', note => blazeNook(note, { r59: true, corner: 'away', fight: true, calm: true, rest: true, seconds: 600 }));
scene('blaze_r59_lid_fight', 'run59 pack: the room lidded to a 3x3 round the spawner, the away-side corner, fight 20 s acts and rest; 600 s', note => blazeNook(note, { r59: true, corner: 'away', fight: true, calm: true, rest: true, lid: true, seconds: 600 }));
scene('blaze_r59_lid_hold', 'run59 pack: the room lidded to a 3x3 round the spawner, the away-side corner, attack hold and rest; 600 s', note => blazeNook(note, { r59: true, corner: 'away', calm: true, rest: true, lid: true, seconds: 600 }));
scene('blaze_r59_cap_fight', 'run59 pack: the lid and a roof over the 3x3 (a cage of 3x3x2 round the spawner), the away-side corner, fight 20 s acts and rest; 600 s', note => blazeNook(note, { r59: true, corner: 'away', fight: true, calm: true, rest: true, lid: true, cap: true, seconds: 600 }));
scene('blaze_r59_cap_hold', 'run59 pack: the cage of 3x3x2 round the spawner, the away-side corner, attack hold and rest; 600 s', note => blazeNook(note, { r59: true, corner: 'away', calm: true, rest: true, lid: true, cap: true, seconds: 600 }));
scene('blaze_r59_corner_peek', 'run59 pack: the away-side corner; steps out to the front cell, strikes 6 s, back in the corner; 600 s', note => blazeNook(note, { r59: true, corner: 'away', peek: true, seconds: 600 }));
// The low slit (S2, 2026-11-03; Codex's first candidate): the body stands one block LOWER than the spawner room's floor in a pocket behind the room's west wall; the wall has ONE opening, the cell at the
// room's floor level (the pocket's head cell). Built here with commands (the feasibility of the shape: can it strike through the slit, how much does it take, can it get the rods), not by the body.
// The lane (S2, 2026-11-03; the coordinator's workflow answer, first form): the whole spawn box (spawner ±4 across, the floors and the roof) is filled with cobblestone, then ONE lane is cut: the cell next to
// the spawner stays a plug, the next three cells (a 1-wide, 2-high tunnel, floor and roof of cobblestone) are the only free space in the box, and the body stands in a sealed cell at the end of it, outside the
// box. A spawner that finds no free spot tries again at once, so what spawns is put in the lane, within a sword's reach of the body. Built here with commands (the mechanism, not the body's building); the
// blazes are NOT killed (the answer asked for the state with survivors) but the spawner is quiet while the lane is laid.
async function blazeLane(note: (text: string) => void, options: { seconds?: number } = {}): Promise<Record<string, unknown>> {
  const stand = sites.blazeStand as number[] | undefined, spawner = sites.blazeSpawner as number[] | undefined;
  if (!stand || !spawner) throw new Error('no blazeStand or blazeSpawner in the sites');
  const seconds = options.seconds ?? (timedSeconds || 600);
  await ask('difficulty normal'); await ask('time set midnight'); await ask('weather clear');
  await equip({ stone_sword: 1, diamond_pickaxe: 1, shield: 1, cooked_porkchop: 7, cobblestone: 173 }, { armor: 'iron', shield: true });
  await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  const nether = 'execute in minecraft:the_nether run';
  const [sx, sy, sz] = spawner;
  const solidAt = (x: number, y: number, z: number) => { const b = actor.blockAt(new Vec3(x, y, z)); return !!b && b.boundingBox === 'block'; };
  const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const score = (d: [number, number]) => { let n = 0; for (let k = 2; k <= 6; k++) for (const dy of [0, 1]) if (solidAt(sx + d[0] * k, sy + dy, sz + d[1] * k)) n++; return n; };
  const dir = [...dirs].sort((a, b) => score(b) - score(a))[0];
  note(`spawner ${spawner}, lane direction ${dir} (solid cells along it: ${score(dir)} of 10)`);
  await ask('gamerule doMobSpawning false');
  // the whole spawn box: the floors and a roof over them, x and z ±4
  await ask(`${nether} fill ${sx - 4} ${sy - 1} ${sz - 4} ${sx + 4} ${sy + 2} ${sz + 4} minecraft:cobblestone replace minecraft:air`);
  // the lane: cells 2, 3, 4 along the direction, two high, a floor under them; the plug (cell 1) stays stone
  const at = (k: number, dy: number, off = 0): number[] => [sx + dir[0] * k + (dir[1] !== 0 ? off : 0), sy + dy, sz + dir[1] * k + (dir[0] !== 0 ? off : 0)];
  for (let k = 2; k <= 4; k++) {
    const a = at(k, 0), b = at(k, 1);
    await ask(`${nether} fill ${a[0]} ${a[1]} ${a[2]} ${b[0]} ${b[1]} ${b[2]} minecraft:air`);
    const f = at(k, -1); await ask(`${nether} setblock ${f[0]} ${f[1]} ${f[2]} minecraft:cobblestone`);
  }
  // the standing cell, cell 5, outside the box: a shell of cobblestone round it, then the cell opens onto the lane
  const c5a = at(5, -1, -1), c5b = at(6, 2, 1);
  const lo = [Math.min(c5a[0], c5b[0]), Math.min(c5a[1], c5b[1]), Math.min(c5a[2], c5b[2])], hi = [Math.max(c5a[0], c5b[0]), Math.max(c5a[1], c5b[1]), Math.max(c5a[2], c5b[2])];
  await ask(`${nether} fill ${lo[0]} ${lo[1]} ${lo[2]} ${hi[0]} ${hi[1]} ${hi[2]} minecraft:cobblestone`);
  const s0 = at(5, 0), s1 = at(5, 1);
  await ask(`${nether} fill ${s0[0]} ${s0[1]} ${s0[2]} ${s1[0]} ${s1[1]} ${s1[2]} minecraft:air`);
  note(`lane laid: plug ${at(1, 0)}, lane ${at(2, 0)}..${at(4, 1)}, stand cell ${s0}`);
  await sleep(1500);
  await ask(`${nether} tp ${ACTOR} ${s0[0] + 0.5} ${s0[1]} ${s0[2] + 0.5} facing ${sx + 0.5} ${sy + 0.5} ${sz + 0.5}`);
  await sleep(2500);
  const started = Date.now(), rods0 = await countServer('blaze_rod'), shield0 = shieldUsed();
  let killed = 0;
  const onDead = (entity: any) => { if (String(entity?.name ?? '') === 'blaze') killed++; };
  actor.on('entityDead', onDead);
  const track: number[] = [];
  const sampler = setInterval(() => { const value = Number(actor.health); if (Number.isFinite(value)) track.push(r1(value)); }, 1000);
  const census = setInterval(() => {
    try {
      const me = actor.entity.position as Vec3;
      const list = (Object.values(actor.entities ?? {}) as any[]).filter(entity => String(entity?.name) === 'blaze' && entity.position)
        .map(entity => `${r1(entity.position.x - me.x)},${r1(entity.position.z - me.z)},${r1(entity.position.y - me.y)}`);
      note(`census ${Math.round((Date.now() - started) / 1000)} s: ${list.length} blazes [${list.join(' ')}] kills ${killed}`);
    } catch { /* a note */ }
  }, 30_000);
  await ask('gamerule doMobSpawning true');
  let n = 0;
  try {
    while (Date.now() - started < seconds * 1000 && !disconnected && Number(actor.health) > 0) {
      const run = await act(`hold#${++n}`, [{ do: 'attack', target: 'blaze', hold: true, seconds: 20 }], 40, { accept: ['blaze'] });
      if (Number(actor.health) < 14 && Number(actor.food) < 20) await act('eat', [{ do: 'eat' }], 15);
      note(`hold#${n}: hp ${r1(Number(actor.health))} kills ${killed} ${run.lines.join(' | ').slice(0, 220)}`);
      // what fell in the lane is fetched from the stand cell's mouth (a pickup of what is within reach, then back)
      if (/落とし物 blaze_rod/u.test(run.lines.join(' '))) {
        const fetched = await act('fetch', [{ do: 'pickup', range: 4, onFail: 'continue' }, { do: 'go', to: { x: s0[0], y: s0[1], z: s0[2] }, range: 0.4, seconds: 8, onFail: 'continue' }], 30, { accept: ['blaze'] });
        note(`fetch: hp ${r1(Number(actor.health))} ${fetched.lines.join(' | ').slice(0, 200)}`);
      }
      const waitFrom = Date.now();
      while (Number(actor.health) > 0 && Number(actor.health) < 16 && Date.now() - waitFrom < 40_000) await sleep(2000);
    }
  } finally { clearInterval(sampler); clearInterval(census); actor.removeListener('entityDead', onDead); }
  return { seconds: r1((Date.now() - started) / 1000), kills: killed, killsPerMin: r1(killed / Math.max((Date.now() - started) / 60_000, 0.1)), rods: (await countServer('blaze_rod')) - rods0, shieldWear: shieldUsed() - shield0, deathsHere: deaths, lowestHp: Math.min(...track, 20), hpTrack: track.filter((_, index) => index % 5 === 0).join(' ') };
}
// Light against the spawner (S2, 2026-11-03; the coordinator's order d47, step 2): does a spawn box of light level 15 stop the spawner's blazes? The spawner is quiet while the box is filled with `light` blocks (they
// have no collision: the free space stays), the body waits in a sealed cell next to the box, and for 180 s the blazes the client knows near the spawner are counted every 15 s. Run once without the light for the
// baseline. The survivors are killed at the start so that what is counted was spawned during the run.
async function blazeLight(note: (text: string) => void, options: { lit: boolean; seconds?: number; torchSpacing?: number }): Promise<Record<string, unknown>> {
  const stand = sites.blazeStand as number[] | undefined, spawner = sites.blazeSpawner as number[] | undefined;
  if (!stand || !spawner) throw new Error('no blazeStand or blazeSpawner in the sites');
  const seconds = options.seconds ?? 180;
  await ask('difficulty normal'); await ask('time set midnight'); await ask('weather clear');
  await equip({ stone_sword: 1, diamond_pickaxe: 1, shield: 1, cooked_porkchop: 7, cobblestone: 173 }, { armor: 'iron', shield: true });
  await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  const nether = 'execute in minecraft:the_nether run';
  const [sx, sy, sz] = spawner;
  await ask('gamerule doMobSpawning false');
  await ask(`${nether} kill @e[type=minecraft:blaze]`);
  let torches = 0, tried = 0;
  if (options.torchSpacing) {
    // torches (light 14) set by the scripted head's own cover of the box: the cells a blaze could be put on are the air cells at the spawner's layer with something solid under them; a torch lights every cell
    // within two blocks of it to 12 or more, so torches are chosen greedily until each such cell has one within two (the spacing option only names the run)
    const free = (x: number, y: number, z: number) => { const b = actor.blockAt(new Vec3(x, y, z)); return !!b && b.boundingBox !== 'block' && !['lava', 'fire', 'water'].includes(b.name); };
    // targets: every feet cell a blaze's box fits in (the cell and the one over it free) in the three layers the spawner uses (feet one under to one over the spawner's); candidates: the floor cells of the spawner's layer
    const cellsToLight: Array<[number, number, number]> = [], candidates: Array<[number, number]> = [];
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
      const x = sx + dx, z = sz + dz, below = actor.blockAt(new Vec3(x, sy - 1, z));
      if (!(dx === 0 && dz === 0) && free(x, sy, z) && below && below.boundingBox === 'block') candidates.push([x, z]);
      for (const y of [sy - 1, sy, sy + 1]) if (!(dx === 0 && dz === 0 && y === sy) && free(x, y, z) && free(x, y + 1, z)) cellsToLight.push([x, y, z]);
    }
    const dist = (a: [number, number, number], t: [number, number]) => Math.abs(a[0] - t[0]) + Math.abs(a[2] - t[1]) + Math.abs(a[1] - sy);
    const uncovered = new Set(cellsToLight.map(c => c.join(',')));
    const chosen: Array<[number, number]> = [];
    while (uncovered.size) {
      let best: [number, number] | null = null, bestN = 0;
      for (const t of candidates) {
        let n = 0; for (const key of uncovered) { const c = key.split(',').map(Number) as [number, number, number]; if (dist(c, t) <= 2) n++; }
        if (n > bestN) { bestN = n; best = t; }
      }
      if (!best) break;
      chosen.push(best);
      for (const key of [...uncovered]) { const c = key.split(',').map(Number) as [number, number, number]; if (dist(c, best) <= 2) uncovered.delete(key); }
    }
    for (const [x, z] of chosen) { await ask(`${nether} setblock ${x} ${sy} ${z} minecraft:torch`); torches++; }
    note(`torches placed: ${torches} for ${cellsToLight.length} feet cells to light, ${uncovered.size} left uncovered`);
  }
  if (options.lit) await ask(`${nether} fill ${sx - 4} ${sy - 1} ${sz - 4} ${sx + 4} ${sy + 2} ${sz + 4} minecraft:light[level=15] replace minecraft:air`);
  // a sealed cell for the body, east of the box at distance 6 on the side with the most solid cells; just a shell, no opening toward the spawner but a window one cell high
  const cx = sx + 6, cy = sy, cz = sz;
  await ask(`${nether} fill ${cx - 1} ${cy - 1} ${cz - 1} ${cx + 1} ${cy + 2} ${cz + 1} minecraft:cobblestone`);
  await ask(`${nether} fill ${cx} ${cy} ${cz} ${cx} ${cy + 1} ${cz} minecraft:air`);
  await sleep(1500);
  await ask(`${nether} tp ${ACTOR} ${cx + 0.5} ${cy} ${cz + 0.5}`);
  await sleep(2000);
  await ask('gamerule doMobSpawning true');
  const started = Date.now();
  const counts: number[] = [];
  const near = (): number => (Object.values(actor.entities ?? {}) as any[]).filter(entity => String(entity?.name) === 'blaze' && entity.position
    && Math.abs(entity.position.x - sx) <= 5 && Math.abs(entity.position.z - sz) <= 5 && Math.abs(entity.position.y - sy) <= 5).length;
  while (Date.now() - started < seconds * 1000 && !disconnected && Number(actor.health) > 0) {
    await sleep(15_000);
    counts.push(near());
    note(`light=${options.lit} ${Math.round((Date.now() - started) / 1000)} s: ${counts[counts.length - 1]} blazes near the spawner`);
  }
  const lightAt = await ask(`${nether} data get block ${sx + 1} ${sy} ${sz}`);
  return { lit: options.lit, torches, seconds: r1((Date.now() - started) / 1000), counts: counts.join(' '), maxNear: Math.max(...counts, 0), probeBlock: lightAt.replace(/\s+/gu, ' ').slice(0, 120), deathsHere: deaths };
}
scene('blaze_light_off', 'baseline: the spawn box as it is, blazes near the spawner counted every 15 s for 180 s after killing the survivors', note => blazeLight(note, { lit: false }));
scene('blaze_torch_3', 'torches on the floor in a grid of spacing 3 over the spawn box, blazes near the spawner counted every 15 s for 180 s', note => blazeLight(note, { lit: false, torchSpacing: 3 }));
scene('blaze_torch_4', 'torches on the floor in a grid of spacing 4 over the spawn box (fewer), blazes counted for 180 s', note => blazeLight(note, { lit: false, torchSpacing: 4 }));
scene('blaze_light_on', 'light blocks of level 15 over the whole spawn box, blazes near the spawner counted every 15 s for 180 s after killing the survivors', note => blazeLight(note, { lit: true }));
scene('blaze_lane', 'the lane: the spawn box filled with cobblestone but a 1-wide 2-high lane of three cells beyond the plugged cell beside the spawner; the body in a sealed cell at its end, attack hold; 600 s, survivors not killed', note => blazeLane(note));
// The lane built BY THE BODY's hands (S2, 2026-11-03): the scripted head reads probe kind=lane (no spawner given: the near one), takes the first candidate (fewest cobblestones), and builds what the probe lists in the order
// it lists it, with go and place hands (up to 4 cells per group, a go to a floor cell within reach first), the blazes alive and shooting. Then it re-reads the plan (what still stands to be built outside the lane), goes to the
// waiting cell and holds for the rest of the time, fetching what falls. Measures the time to build, the lowest health while building, the cobblestones used and the kills after.
async function blazeLaneBuild(note: (text: string) => void, options: { holdSeconds?: number; groupSize?: number; away?: boolean; awaySeconds?: number; fill?: boolean; torches?: boolean; settle?: boolean; lidOnly?: boolean; window?: number; ambush?: boolean } = {}): Promise<Record<string, unknown>> {
  const stand = sites.blazeStand as number[] | undefined;
  if (!stand) throw new Error('no blazeStand in the sites');
  const holdSeconds = options.holdSeconds ?? 300, groupSize = options.groupSize ?? 5, thinkMs = 5000;
  await ask('difficulty normal'); await ask('time set midnight'); await ask('weather clear');
  await equip({ stone_sword: 1, diamond_pickaxe: 1, shield: 1, cooked_porkchop: 7, cobblestone: 173, ...(options.torches ? { torch: 24 } : {}) }, { armor: 'iron', shield: true });
  await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  const readLane = async (): Promise<any> => { const found = await runSkill('probe', { kind: 'lane' }, 25); try { return JSON.parse(String(found.receipt?.result ?? '')); } catch { return null; } };
  const hp = () => Number(actor.health);
  const track: number[] = [];
  const sampler = setInterval(() => { const value = hp(); if (Number.isFinite(value)) track.push(r1(value)); }, 1000);
  const cobble0 = packClient().cobblestone ?? 0;
  const t0 = Date.now(), deaths0 = deaths;
  // timeline (the coordinator's order d49: the seconds the body is exposed, by stretch)
  const blazesKnown = () => (Object.values(actor.entities ?? {}) as any[]).filter(e => String(e?.name) === 'blaze').length;
  const mark = (label: string) => note(`T+${r1((Date.now() - t0) / 1000)} s [${label}] hp ${r1(hp())} blazes known ${blazesKnown()} cobble ${packClient().cobblestone ?? 0} torch ${packClient().torch ?? 0}`);
  mark('start');
  // settle: the head's turn between steps at the cover: what came back is fought from the cover (attack hold 15 s) and the health is waited for (eat when low), up to a budget; the seconds are told
  let settledMs = 0;
  const settle = async (why: string, budgetMs = 90_000) => {
    const from = Date.now();
    while (Date.now() - from < budgetMs && !disconnected && hp() > 0 && (blazesKnown() > 0 || hp() < 16)) {
      if (hp() < 14 && Number(actor.food) < 20) await act('eat', [{ do: 'eat' }], 15);
      if (blazesKnown() > 0 && hp() >= 9) await act('hold (settle)', [{ do: 'attack', target: 'blaze', hold: true, seconds: 15 }], 30, { accept: ['blaze'] });
      else await sleep(2000);
    }
    settledMs += Date.now() - from; mark(`settled (${why}) ${r1((Date.now() - from) / 1000)} s`);
  };
  if (options.away) {
    // the clearing-away: the room fills for a minute (the spawner runs with the body near), the body goes far off (the spawner stops, what it made fades), waits, and comes back to build
    const arrival = sites.netherArrival as number[] | undefined;
    if (!arrival) throw new Error('no netherArrival in the sites');
    await act('warm', [{ do: 'wait', seconds: 40 }], 60, { accept: ['blaze'] });
    note(`blazes known before leaving: ${(Object.values(actor.entities ?? {}) as any[]).filter(e => String(e?.name) === 'blaze').length}`);
    await placeActor('the_nether', arrival[0], arrival[1], arrival[2], 24);
    await sleep((options.awaySeconds ?? 150) * 1000);
    await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
    await sleep(5000);   // (the blocks under the body arrive after the move: a fill read at once said there was no floor)
    // (a body put down before the blocks under it had arrived falls to the floor below: it is put on the stand again, up to three times)
    for (let again = 0; again < 3 && !disconnected && Math.abs(actor.entity.position.y - stand[1]) > 0.7; again++) {
      note(`the body stands at y ${r1(actor.entity.position.y)}, not on the stand (y ${stand[1]}): put back (${again + 1})`);
      await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
      await sleep(4000);
    }
    if (options.lidOnly) {
      // (a fireball's push drops a body that stands beside an open hole: every open neighbour of the stand with no full floor one or two cells down is walled at feet height first)
      const cellAt = (x: number, y: number, z: number) => actor.blockAt(new Vec3(x, y, z));
      const sealed: Array<{ x: number; y: number; z: number }> = [];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const x = stand[0] + dx, z = stand[2] + dz, feet = cellAt(x, stand[1], z);
        if (!feet || feet.boundingBox === 'block') continue;
        if (cellAt(x, stand[1] - 1, z)?.boundingBox !== 'block' && cellAt(x, stand[1] - 2, z)?.boundingBox !== 'block') sealed.push({ x, y: stand[1], z });
      }
      if (sealed.length) {
        const run = await act('seal the holes beside the stand', [{ do: 'place', at: sealed, block: 'cobblestone', onFail: 'continue' }], 30, { accept: ['blaze'] });
        note(`sealed ${sealed.length} open neighbours of the stand at feet height: ${run.lines.join(' ').slice(0, 200)}`);
      } else note('no open neighbour of the stand without a floor');
    }
    mark('back from away');
    note(`back at the stand after ${options.awaySeconds ?? 150} s away; blazes known now: ${(Object.values(actor.entities ?? {}) as any[]).filter(e => String(e?.name) === 'blaze').length}`);
  }
  if (options.settle) await settle('after the return');
  if (options.torches) {
    // torches first: a greedy cover of the spawner's box (the free cells of the three layers within two blocks of a torch on the floor of the spawner's layer), set with go and place in acts of six
    const sp = sites.blazeSpawner as number[], [tx, ty, tz] = sp;
    const free = (x: number, y: number, z: number) => { const b = actor.blockAt(new Vec3(x, y, z)); return !!b && b.boundingBox !== 'block' && !['lava', 'fire', 'water'].includes(b.name); };
    const targets: Array<[number, number, number]> = [], candidates: Array<[number, number]> = [];
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
      const x = tx + dx, z = tz + dz, below = actor.blockAt(new Vec3(x, ty - 1, z));
      if (!(dx === 0 && dz === 0) && free(x, ty, z) && below && below.boundingBox === 'block') candidates.push([x, z]);
      for (const y of [ty - 1, ty, ty + 1]) if (!(dx === 0 && dz === 0 && y === ty) && free(x, y, z) && free(x, y + 1, z)) targets.push([x, y, z]);
    }
    const dist = (a: [number, number, number], t: [number, number]) => Math.abs(a[0] - t[0]) + Math.abs(a[2] - t[1]) + Math.abs(a[1] - ty);
    const open = new Set(targets.map(c0 => c0.join(',')));
    const chosen: Array<[number, number]> = [];
    while (open.size) {
      let best: [number, number] | null = null, bestN = 0;
      for (const t of candidates) { let n = 0; for (const key of open) { if (dist(key.split(',').map(Number) as [number, number, number], t) <= 2) n++; } if (n > bestN) { bestN = n; best = t; } }
      if (!best) break;
      chosen.push(best);
      for (const key of [...open]) if (dist(key.split(',').map(Number) as [number, number, number], best) <= 2) open.delete(key);
    }
    note(`torch cover: ${chosen.length} torches for ${targets.length} cells, ${open.size} left uncovered`);
    for (let i = 0; i < chosen.length && hp() > 6 && !disconnected; i += 6) {
      const batch = chosen.slice(i, i + 6);
      await sleep(thinkMs);
      const hands: unknown[] = [];
      for (const [x, z] of batch) { hands.push({ do: 'go', to: { x, y: ty, z }, range: 2.2, seconds: 8, onFail: 'continue' }); hands.push({ do: 'place', at: [{ x, y: ty, z }], block: 'torch', onFail: 'continue' }); }
      const run = await act(`torches#${i / 6 + 1}`, hands.slice(0, 12), 60, { accept: ['blaze'] });
      note(`torches#${i / 6 + 1} hp ${r1(hp())}: ${run.lines.join(' ').slice(0, 220)}`);
    }
    mark('torches done');
  }
  let json = await readLane();
  // (a probe read just after the move may see unloaded or empty blocks: read again, up to three times, until half of the cells have a standing cell)
  for (let again = 0; again < 3 && json?.found; again++) {
    const rows = (json.candidates?.[0]?.build ?? []) as any[];
    const withStand = rows.filter(row => row[4] !== null && row[4] !== undefined).length;
    if (rows.length === 0 || withStand >= rows.length / 2) break;
    note(`probe read ${again + 1}: standing cells for ${withStand} of ${rows.length}; read again in 8 s`);
    await sleep(8000);
    json = await readLane();
  }
  mark('probe read');
  if (!json?.found) { clearInterval(sampler); throw new Error(`no lane report: ${String(json?.text ?? '').slice(0, 200)}`); }
  const c = json.candidates[0], cells = json.cells as Array<[number, number, number, string | null, string]>, facts = json.facts as Array<[number, boolean | null, number, number, string, boolean]>;
  const spawnerCell = json.spawner as { x: number; y: number; z: number };
  const wait = cells[c.waiting[0]];
  note(`probe text: ${String(json.text ?? '').slice(0, 700)}`);
  note(`probe text tail: ${String(json.text ?? '').slice(700, 1500)}; stand cells in the plan: ${(c.build as any[]).filter(row => row[4] !== null && row[4] !== undefined).length} of ${c.build.length}; groups ${new Set((c.build as any[]).map(row => row[5])).size}`);
  {
    const reasons: Record<string, number> = {};
    for (const row of c.build as any[]) { const why = (json.standFacts as any[])?.[(json.facts as any[])[row[0]][6]]?.[0] ?? (row[4] === null ? '?' : 'stand'); reasons[String(why)] = (reasons[String(why)] ?? 0) + 1; }
    const ys = (c.build as any[]).map(row => cells[(json.facts as any[])[row[0]][0]][1]);
    note(`why no standing cell, per placement: ${JSON.stringify(reasons)}; placement heights ${Math.min(...ys)}..${Math.max(...ys)}; spawner y ${spawnerCell.y}; body at ${actor.entity.position.floored().toString()}`);
  }
  if (options.lidOnly) {
    // (a picture of the room, a layer per height: # block, . open, ~ lava/water/fire, ? unloaded, S spawner, B body, L a lid cell of the plan, s a cell the plan stands in)
    const planned = new Map<string, string>();
    for (const row of c.build as any[]) { const cell = cells[(json.facts as any[])[row[0]][0]]; planned.set(`${cell[0]},${cell[1]},${cell[2]}`, 'L'); if (row[4] !== null && row[4] !== undefined) { const sc = cells[row[4]]; planned.set(`${sc[0]},${sc[1]},${sc[2]}`, 's'); } }
    const bp = actor.entity.position.floored();
    for (let y = spawnerCell.y - 2; y <= spawnerCell.y + 3; y++) {
      const lines: string[] = [];
      for (let z = spawnerCell.z - 7; z <= spawnerCell.z + 7; z++) {
        let line = '';
        for (let x = spawnerCell.x - 9; x <= spawnerCell.x + 5; x++) {
          const b = actor.blockAt(new Vec3(x, y, z));
          let ch = !b ? '?' : /lava|water|fire/u.test(b.name) ? '~' : b.boundingBox === 'block' ? '#' : '.';
          if (x === spawnerCell.x && y === spawnerCell.y && z === spawnerCell.z) ch = 'S';
          else if (x === bp.x && y === bp.y && z === bp.z) ch = 'B';
          else planned.has(`${x},${y},${z}`) && (ch = planned.get(`${x},${y},${z}`)!);
          line += ch;
        }
        lines.push(line);
      }
      note(`map y=${y} (x ${spawnerCell.x - 9}..${spawnerCell.x + 5}, z ${spawnerCell.z - 7} down to ${spawnerCell.z + 7}): ${lines.join('/')}`);
    }
  }
  note(`lane candidate ${c.direction}: required ${JSON.stringify(c.required)}; waiting cell ${wait.slice(0, 3)}; ${c.build.length} placements; spawn spaces ${json.spawn?.spaces}; blazes in the count box ${json.blaze?.count}`);
  // the probe's own order and groups (each placement: the cell, its part, the cell to stand in and the number of its group)
  // the window: the head-height cells next to the body's cell on the side of the spawner (the ones nearest the line to the spawner) stay open, so a blaze near it can be seen and struck, and its fireballs come in there
  const windowKeys = new Set<string>();
  if (options.window && stand) {
    const ux = Math.sign(spawnerCell.x - stand[0]), uz = Math.sign(spawnerCell.z - stand[2]);
    const dirLen = Math.hypot(spawnerCell.x - stand[0], spawnerCell.z - stand[2]) || 1;
    const cand: Array<{ key: string; off: number }> = [];
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if ((dx === 0 && dz === 0) || dx * ux < 0 || dz * uz < 0) continue;
      const off = Math.abs(dx * (spawnerCell.z - stand[2]) - dz * (spawnerCell.x - stand[0])) / dirLen;
      cand.push({ key: `${stand[0] + dx},${stand[1] + 1},${stand[2] + dz}`, off: off + (dx !== 0 && dz !== 0 ? 0.3 : 0) });
    }
    cand.sort((a, b) => a.off - b.off);
    for (const k of cand.slice(0, options.window)) windowKeys.add(k.key);
    note(`window cells left open: ${[...windowKeys].join(' ')}`);
  }
  const placementsOf = (cand: any, table: any[], factTable: any[]) => (cand.build as Array<[number, number, number | null, number, number | null, number | null]>)
    .filter(([f]) => table[factTable[f][0]][4] === 'air')
    .filter(([, part]) => !options.lidOnly || part === 3)
    .filter(([f]) => !windowKeys.has(`${table[factTable[f][0]][0]},${table[factTable[f][0]][1]},${table[factTable[f][0]][2]}`))
    .map(([f, part, , , stand, group]) => ({ at: { x: table[factTable[f][0]][0], y: table[factTable[f][0]][1], z: table[factTable[f][0]][2] }, part: ['enclosure', 'roof', 'plug', 'lid'][part] ?? String(part),
      stand: stand === null || stand === undefined ? null : { x: table[stand][0], y: table[stand][1], z: table[stand][2] }, group: group ?? -1 }));
  let placements = placementsOf(c, cells, facts);
  const canPlace = ['cobblestone'];
  let built = 0, failedCells = 0, acts = 0, aborted = '', passes = 0, lastLeft = Infinity;
  // passes: each pass builds what the probe lists as still to be set (a cell a blaze stood in is tried again in the next pass), at most 8 passes
  for (let pass = 0; pass < 8 && placements.length && !disconnected && hp() > 0 && deaths === deaths0 && !aborted; pass++) {
    passes++;
    // the groups in the order of their first cell; a group is the cells that go on being set from one standing cell
    const groups: Array<typeof placements> = [];
    for (const p of placements) { const last = groups[groups.length - 1]; if (last && p.group !== -1 && last[0].group === p.group) last.push(p); else groups.push([p]); }
    // the cover first (the waiting cell's enclosure, the plug and the roof of the lane), then the lid; two groups to one act (12 hands: a go and up to five places each)
    const rank = (g: typeof placements) => ['enclosure', 'plug', 'roof', 'lid'].indexOf(g[0].part);
    // (in the fill run the probe's own order stands: it puts each cell after the one it is set against; the cover-first order broke that: "nothing_to_set_against" for the enclosure)
    if (!options.fill) groups.sort((a, b) => rank(a) - rank(b));
    if (options.fill) {
      // the cover to go back to: the waiting cell once it can be stood in (its enclosure is a part of the plan), else the stand the body came to
      const openCell = (x: number, y: number, z: number) => { const c = actor.blockAt(new Vec3(x, y, z)); return !!c && c.boundingBox !== 'block'; };
      const retreatNow = () => { const below = actor.blockAt(new Vec3(wait[0], wait[1] - 1, wait[2])); return below && below.boundingBox === 'block' && openCell(wait[0], wait[1], wait[2]) && openCell(wait[0], wait[1] + 1, wait[2]) ? { x: wait[0], y: wait[1], z: wait[2] } : { x: stand[0], y: stand[1], z: stand[2] }; };
      // the fill hand: the groups of this pass as they are (a stand cell and up to eight cells each), twelve groups to an act, health floor 10, back to the waiting cell
      const withStand = groups.filter(g => g[0].stand);
      const phases = [withStand];
      let stopFill = false;
      for (const phase of phases) {
        const arg = phase.map(g => ({ stand: g[0].stand!, at: g.slice(0, 8).map(p => p.at) }));
        for (let gi = 0; gi < arg.length && !stopFill && !disconnected && hp() > 0 && deaths === deaths0; gi += 12) {
          if (hp() < 6) { aborted = `hp ${r1(hp())} at pass ${pass} group ${gi}/${arg.length}`; stopFill = true; break; }
          if (options.settle && (blazesKnown() > 1 || hp() < 16)) await settle(`before fill#${acts + 1}`);
          await sleep(thinkMs);
          const retreat = retreatNow();
          // (the head's own turn: fire on the cover cell is put out by a dig before the fill; the names are said)
          { const nm = (dy: number) => String(actor.blockAt(new Vec3(retreat.x, retreat.y + dy, retreat.z))?.name); const names = [nm(-1), nm(0), nm(1)]; note(`cover cell ${retreat.x},${retreat.y},${retreat.z}: under ${names[0]} / feet ${names[1]} / head ${names[2]}`);
            const fires = [0, 1].filter(dy => /fire/u.test(nm(dy))).map(dy => ({ x: retreat.x, y: retreat.y + dy, z: retreat.z }));
            if (fires.length) { const put = await act('put the fire out', [{ do: 'dig', at: fires, collect: false, onFail: 'continue' }], 20, { accept: ['blaze'] }); note(`fire put out: ${put.lines.join(' | ').slice(0, 160)}`); } }
          const run = await act(`fill#${++acts}`, [{ do: 'fill', block: 'cobblestone', groups: arg.slice(gi, gi + 12), retreatHp: 10, retreatTo: retreat, seconds: 60 }], 90, { accept: ['blaze'] });
          const f = ((run.json?.lines ?? []) as any[]).map(line => line.fill).find(Boolean);
          built += Number(f?.placed ?? 0); failedCells += Array.isArray(f?.remaining) ? f.remaining.length : 0;
          note(`fill#${acts} pass ${pass} (retreat ${retreat.x},${retreat.y},${retreat.z}) hp ${r1(hp())}: ${f ? `${f.status} ${f.code ?? ''} placed ${f.placed} remaining ${f.remaining?.length} skipped ${JSON.stringify(f.skippedBy)} reasons ${JSON.stringify(f.reasons)} hp ${r1(f.hpMin)}→${r1(f.hpEnd)} ${f.elapsedMs} ms safe ${f.safe}` : run.lines.join(' ').slice(0, 200)}`);
          if (f && (f.status === 'cut' || f.code === 'HP_FLOOR' || f.code === 'NO_STAND')) { stopFill = true; break; }
        }
        if (stopFill) break;
      }
      groups.length = 0;
    }
    for (let gi = 0; gi < groups.length && !disconnected && hp() > 0 && deaths === deaths0; gi += 2) {
      if (hp() < 6) { aborted = `hp ${r1(hp())} at pass ${pass} group ${gi}/${groups.length}`; break; }
      const pair = groups.slice(gi, gi + 2);
      const head = pair[0][0];
      await sleep(thinkMs);
      const hands: unknown[] = [];
      for (const group of pair) {
        const floor = group[0].stand ?? { x: wait[0], y: wait[1], z: wait[2] };
        hands.push({ do: 'go', to: floor, range: 0.8, seconds: 12, onFail: 'continue' });
        for (const p of group.slice(0, 5)) hands.push({ do: 'place', at: [p.at], block: 'cobblestone', onFail: 'continue' });
      }
      const run = await act(`build#${++acts}`, hands.slice(0, 12), 60, { accept: ['blaze'] });
      const text = run.lines.join(' ');
      built += hands.length; failedCells += (text.match(/置けない|止まった/gu) ?? []).length;
      if (acts % 4 === 1 || /反射/u.test(text)) note(`build#${acts} pass ${pass} (${head.part}) hp ${r1(hp())}: ${text.slice(0, 200)}`);
    }
    json = await readLane();
    const again = json?.candidates?.find((x: any) => x.direction === c.direction);
    if (!again) break;
    placements = placementsOf(again, json.cells, json.facts);
    note(`pass ${pass} done: ${placements.length} cells still to set, required ${JSON.stringify(again.required)}, blazes in the count box ${json?.blaze?.count}`);
    if (placements.length >= lastLeft) break;
    lastLeft = placements.length;
  }
  const buildSeconds = (Date.now() - t0) / 1000, lowestWhileBuilding = Math.min(...track, 20), cobbleUsed = cobble0 - (packClient().cobblestone ?? 0);
  note(`built in ${r1(buildSeconds)} s: ${acts} acts, ${built} placements tried, ${failedCells} groups with a failure, cobblestone used ${cobbleUsed}, lowest hp ${r1(lowestWhileBuilding)} ${aborted}`);
  json = await readLane();
  const after = json?.candidates?.find((x: any) => x.direction === c.direction);
  note(`after the build: required ${JSON.stringify(after?.required)}, remainingOutsideLane ${after?.remainingOutsideLane}, unknown ${after?.unknownOutsideLane}, blazes in the count box ${json?.blaze?.count}`);
  // the hold
  // the cover to hold in: the waiting cell when it can be stood in, else the stand the body came to (a lid-only build has no waiting cell)
  const holdOpen = (dy: number) => { const b = actor.blockAt(new Vec3(wait[0], wait[1] + dy, wait[2])); return !!b && (dy < 0 ? b.boundingBox === 'block' : b.boundingBox !== 'block'); };
  const holdCell = holdOpen(-1) && holdOpen(0) && holdOpen(1) ? { x: wait[0], y: wait[1], z: wait[2] } : { x: stand[0], y: stand[1], z: stand[2] };
  { const here = holdCell;
    mark('hold begins'); await act('to the hold cell', [{ do: 'go', to: here, range: 0.5, seconds: 15, onFail: 'continue' }], 30, { accept: ['blaze'] }); }
  const rods0 = packClient().blaze_rod ?? 0, holdStart = Date.now();
  let killed = 0, shieldHits = 0, woundsTaken = 0, unseenActs = 0;
  const killedAt = new Map<number, number>();
  const onDead = (entity: any) => { if (String(entity?.name ?? '') === 'blaze') { killed++; killedAt.set(entity.id, Date.now()); } };
  actor.on('entityDead', onDead);
  // each second, every blaze within 12 m: its distance from the eyes, whether the line from the eyes to it is clear, and the height difference (read at the end as a table: does a blaze come on while it cannot see the body, and stop while it can)
  const watchRows = new Map<number, Array<{ t: number; d: number; los: boolean; dy: number; box: number; line: boolean }>>();
  const watch = setInterval(() => {
    try {
      const eye = actor.entity.position.offset(0, 1.62, 0);
      for (const e of Object.values(actor.entities ?? {}) as any[]) {
        if (String(e?.name) !== 'blaze' || !e.position) continue;
        const target = e.position.offset(0, 0.9, 0), delta = target.minus(eye), d = delta.norm();
        if (d > 12 || d < 0.1) continue;
        const hit = (actor.world as any).raycast(eye, delta.normalize(), d, (b: any) => b.boundingBox === 'block');
        // (the distance from the eye to the box of the blaze, 0.6 wide and 1.8 high, and whether a line from the eye to its feet, middle or top is clear: what a sword can reach, not the blaze's own eye-to-eye sight)
        const px = e.position.x, py = e.position.y, pz = e.position.z;
        const box = Math.hypot(Math.max(px - 0.3 - eye.x, 0, eye.x - (px + 0.3)), Math.max(py - eye.y, 0, eye.y - (py + 1.8)), Math.max(pz - 0.3 - eye.z, 0, eye.z - (pz + 0.3)));
        const line = [0.1, 0.9, 1.7].some(h => { const to = e.position.offset(0, h, 0), v = to.minus(eye), len = v.norm(); return len < 0.1 || !(actor.world as any).raycast(eye, v.normalize(), len, (b: any) => b.boundingBox === 'block'); });
        const rows = watchRows.get(e.id) ?? []; rows.push({ t: Date.now(), d, los: !hit, dy: e.position.y - actor.entity.position.y, box, line }); watchRows.set(e.id, rows);
      }
    } catch { /* a raycast on an unloaded chunk: skip this second */ }
  }, 1000);
  const watchReport = () => {
    const bands: Array<[string, (d: number) => boolean]> = [['<2m', d => d < 2], ['2-3m', d => d >= 2 && d < 3], ['3-5m', d => d >= 3 && d < 5], ['5-12m', d => d >= 5]];
    const out: string[] = [];
    for (const los of [false, true]) for (const [label, inBand] of bands) {
      const rates: number[] = [], levels: number[] = [];
      for (const rows of watchRows.values()) for (let i = 0; i + 1 < rows.length; i++) if (rows[i].los === los && inBand(rows[i].d)) { rates.push(rows[i + 1].d - rows[i].d); levels.push(rows[i].dy); }
      if (rates.length) out.push(`${los ? 'sees' : 'blind'} ${label}: ${rates.length} s, change of distance ${r1(rates.reduce((a, b) => a + b, 0) / rates.length)} m/s (${r1(rates.filter(v => v < -0.15).length / rates.length * 100)}% closing, ${r1(rates.filter(v => Math.abs(v) <= 0.15).length / rates.length * 100)}% still), height diff ${r1(levels.reduce((a, b) => a + b, 0) / levels.length)}`);
    }
    // (one line a blaze: when it was first seen, how long it was within 12 m, when it fell, its nearest box distance, the seconds a sword could have struck it)
    const ids = [...watchRows.keys()].sort((a, b) => watchRows.get(a)![0].t - watchRows.get(b)![0].t).slice(0, 40);
    for (const id of ids) {
      const rows = watchRows.get(id)!, died = killedAt.get(id);
      out.push(`#${id}: first seen T+${r1((rows[0].t - holdStart) / 1000)} s, ${rows.length} s within 12 m, ${died ? `fell T+${r1((died - holdStart) / 1000)} s` : 'alive'}, nearest box ${r1(Math.min(...rows.map(r => r.box)))} m, sword could strike ${rows.filter(r => r.box <= 3 && r.line).length} s (box within 3 m and a clear line), eyes see each other ${rows.filter(r => r.los).length} s`);
    }
    return out;
  };
  let n = 0, outs = 0, retreats = 0, climbs = 0;
  // the attack cell for an ambush: a cell with a floor and open feet and head, 1.5 to 3 m from the spawner across, within a block of its height, the nearest of them to the cover cell
  const attackCell = (() => {
    if (!options.ambush) return null;
    let best: { x: number; y: number; z: number; score: number } | null = null;
    for (let x = spawnerCell.x - 3; x <= spawnerCell.x + 3; x++) for (let z = spawnerCell.z - 3; z <= spawnerCell.z + 3; z++) for (let y = spawnerCell.y - 1; y <= spawnerCell.y + 1; y++) {
      const hd = Math.hypot(x - spawnerCell.x, z - spawnerCell.z);
      if (hd < 1.5 || hd > 3) continue;
      const under = actor.blockAt(new Vec3(x, y - 1, z)), feet = actor.blockAt(new Vec3(x, y, z)), head = actor.blockAt(new Vec3(x, y + 1, z));
      if (!under || !feet || !head || under.boundingBox !== 'block' || feet.boundingBox === 'block' || head.boundingBox === 'block' || /lava|fire|magma|spawner/u.test(under.name + feet.name + head.name)) continue;
      const score = Math.hypot(x - holdCell.x, y - holdCell.y, z - holdCell.z) + hd * 0.5;
      if (!best || score < best.score) best = { x, y, z, score };
    }
    return best;
  })();
  if (attackCell) note(`ambush: attack cell ${attackCell.x},${attackCell.y},${attackCell.z}, cover cell ${holdCell.x},${holdCell.y},${holdCell.z}`);
  else if (options.ambush) note('ambush: no attack cell near the spawner');
  // the counting box of the spawner (its block grown by four: x, y, z from -4 to +5), the burning flag of the body (the first bit of its flags), and the health lost: a drop of more than 1.25 at once is a fireball, a smaller one while burning is the fire
  const boxCount = () => (Object.values(actor.entities ?? {}) as any[]).filter(e => String(e?.name) === 'blaze' && e.position
    && e.position.x + 0.3 > spawnerCell.x - 4 && e.position.x - 0.3 < spawnerCell.x + 5 && e.position.y + 1.8 > spawnerCell.y - 4 && e.position.y < spawnerCell.y + 5
    && e.position.z + 0.3 > spawnerCell.z - 4 && e.position.z - 0.3 < spawnerCell.z + 5).length;
  const burning = () => { const flags = (actor.entity as any)?.metadata?.[0]; return typeof flags === 'number' && (flags & 1) !== 0; };
  let burnLoss = 0, hitLoss = 0, smallLoss = 0, burnSeconds = 0, lastHp = hp();
  const lossWatch = setInterval(() => {
    const h = hp();
    if (!Number.isFinite(h)) return;
    if (burning()) burnSeconds += 0.25;
    if (h < lastHp) { const drop = lastHp - h; if (drop > 1.25) hitLoss += drop; else if (burning()) burnLoss += drop; else smallLoss += drop; }
    lastHp = h;
  }, 250);
  try {
    while (Date.now() - holdStart < holdSeconds * 1000 && !disconnected && hp() > 0 && deaths === deaths0) {
      if (attackCell) {
        // spawn-triggered: in the cover until a blaze is in the counting box (9x9x9 round the spawner) and there are four or fewer; then out to the attack cell and 3 s holds while that stays so,
        // the health is 14 or more and the body is not on fire; back to the cover at once when not, and rest to 18 there
        const aPos = new Vec3(attackCell.x + 0.5, attackCell.y, attackCell.z + 0.5);
        const atAttack = () => actor.entity.position.distanceTo(aPos) < 1.3;
        // (a push may have dropped the body into the pit below the cover: back up by the way, placing and digging cobblestone, before anything else)
        if (actor.entity.position.y < holdCell.y - 1.5) {
          const up = await act('climb back to the cover', [{ do: 'go', to: holdCell, range: 0.6, seconds: 20, canPlace: ['cobblestone'], maxPlace: 8, onFail: 'continue' }], 40, { accept: ['blaze'] });
          if (++climbs <= 5) note(`the body is at y ${r1(actor.entity.position.y)}, below the cover (y ${holdCell.y}): ${up.lines.join(' ').slice(0, 200)}`);
          continue;
        }
        const count = boxCount(), afire = burning();
        if (count === 0 || count > 4 || hp() < 14 || afire) {
          // (the path search may run out of its 1.5 s slice on the way back: the same go is said again, up to four times, and the body rests only once it is in the cover)
          const atCover = () => actor.entity.position.distanceTo(new Vec3(holdCell.x + 0.5, holdCell.y, holdCell.z + 0.5)) < 1.5;
          if (!atCover()) {
            retreats++;
            for (let tryNo = 1; tryNo <= 4 && !atCover() && !disconnected && hp() > 0; tryNo++) {
              const back = await act('back to the cover', [{ do: 'go', to: holdCell, range: 0.5, seconds: 12, onFail: 'continue' }], 25, { accept: ['blaze'] });
              if (retreats <= 8 || tryNo > 1) note(`back to the cover #${retreats}.${tryNo} (box count ${count}, hp ${r1(hp())}, ${afire ? 'on fire' : 'not on fire'}): ${back.lines.join(' ').slice(0, 120)}`);
            }
            if (!atCover()) continue;
          }
          if (hp() < 18) {
            for (let w = 0; w < 6 && hp() < 18 && !disconnected && hp() > 0; w++) { if (Number(actor.food) < 20) await act('eat', [{ do: 'eat' }], 15); { const rest = await act('rest', [{ do: 'attack', target: 'blaze', hold: true, seconds: 5 }], 15, { accept: ['blaze'] }); if (/倒した [1-9]/u.test(rest.lines.join(' '))) note(`struck in the cover: ${rest.lines.join(' ').slice(0, 160)}`); } }
            note(`rested in the cover: hp ${r1(hp())}`);
          } else await act('hold in the cover', [{ do: 'attack', target: 'blaze', hold: true, seconds: 2 }], 10, { accept: ['blaze'] });
          continue;
        }
        if (!atAttack()) {
          // (a fireball leaves fire on the cells: fire in or beside the attack cell is dug out first, the way the fill puts it out)
          const fires: Array<{ x: number; y: number; z: number }> = [];
          for (const [dx, dy, dz] of [[0, 0, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] as const) {
            const b = actor.blockAt(new Vec3(attackCell.x + dx, attackCell.y + dy, attackCell.z + dz));
            if (b && /fire/u.test(b.name)) fires.push({ x: attackCell.x + dx, y: attackCell.y + dy, z: attackCell.z + dz });
          }
          if (fires.length) { const put = await act('put the fire out at the attack cell', [{ do: 'dig', at: fires, collect: false, onFail: 'continue' }], 20, { accept: ['blaze'] }); note(`fire put out at the attack cell: ${put.lines.join(' | ').slice(0, 140)}`); }
          const goOut = await act(`out#${++outs}`, [{ do: 'go', to: { x: attackCell.x, y: attackCell.y, z: attackCell.z }, range: 0.6, seconds: 12, canPlace: ['cobblestone'], maxPlace: 4, onFail: 'continue' }], 25, { accept: ['blaze'] });
          if (outs <= 3 || /止まった|失敗/u.test(goOut.lines.join(' '))) note(`out#${outs} (box count ${count}, hp ${r1(hp())}): ${goOut.lines.join(' ').slice(0, 200)}`);
        }
      }
      const run = await act(`hold#${++n}`, [{ do: 'attack', target: 'blaze', hold: true, seconds: attackCell ? 3 : 20 }], 40, { accept: ['blaze'] });
      { const text = run.lines.join(' '); shieldHits += Number(/被弾 (\d+)回/u.exec(text)?.[1] ?? 0); woundsTaken += Number(/受けた傷 ([\d.]+)/u.exec(text)?.[1] ?? 0); if (/見えない/u.test(text)) unseenActs++; }
      if (hp() < 14 && Number(actor.food) < 20) await act('eat', [{ do: 'eat' }], 15);
      if (/落とし物 blaze_rod/u.test(run.lines.join(' '))) await act('fetch', [{ do: 'pickup', range: 4, onFail: 'continue' }, { do: 'go', to: holdCell, range: 0.4, seconds: 8, onFail: 'continue' }], 30, { accept: ['blaze'] });
      if (n % 3 === 1) note(`hold#${n}: hp ${r1(hp())} kills ${killed} rods +${(packClient().blaze_rod ?? 0) - rods0}`);
    }
  } finally { clearInterval(sampler); clearInterval(watch); clearInterval(lossWatch); actor.removeListener('entityDead', onDead); }
  note(`health lost: ${r1(hitLoss)} in single drops over 1.25 (fireballs), ${r1(burnLoss)} while burning, ${r1(smallLoss)} other; burning ${r1(burnSeconds)} s; out ${outs} times, back ${retreats} times`);
  for (const line of watchReport()) note(`blaze watch ${line}`);
  return { buildSeconds: r1(buildSeconds), acts, placementsTried: built, failedGroups: failedCells, cobbleUsed, lowestWhileBuilding: r1(lowestWhileBuilding), aborted, holdSeconds: r1((Date.now() - holdStart) / 1000), kills: killed,
    killsPerMin: r1(killed / Math.max((Date.now() - holdStart) / 60_000, 0.1)), rods: (packClient().blaze_rod ?? 0) - rods0, deathsHere: deaths, lowestHp: Math.min(...track, 20), remainingOutsideLane: after?.remainingOutsideLane ?? null, shieldHits, woundsTaken: r1(woundsTaken), actsWithBlazeUnseen: unseenActs, holdActs: n, hitLoss: r1(hitLoss), burnLoss: r1(burnLoss), burnSeconds: r1(burnSeconds), outs, retreats };
}
scene('blaze_ambush', 'the lid cover set with the fill hand after clearing away; in the cover until one to four blazes are in the counting box, then out to a cell beside the spawner and 3 s strikes; back at once when none, more than four, below 14 hp or on fire (rest to 18); health lost split into fireball drops and fire; a blaze table at the end; 480 s', note => blazeLaneBuild(note, { away: true, fill: true, lidOnly: true, ambush: true, holdSeconds: 480 }));
scene('blaze_lid_window', 'the lid only with a window: two head-height cells next to the body towards the spawner stay open; fill, then attack hold 400 s; timeline marks', note => blazeLaneBuild(note, { away: true, fill: true, lidOnly: true, window: 2, holdSeconds: 400 }));
scene('blaze_lid_fill', 'the lid only (the lid cells of the lane probe) set with the fill hand right after clearing away, no torches, then attack hold from the cover for 300 s; timeline marks', note => blazeLaneBuild(note, { away: true, fill: true, lidOnly: true, holdSeconds: 300 }));
scene('blaze_lane_fill_settle', 'the lane set with the fill hand after clearing away: fight from the cover what came back, torches first, fill, settle between steps; timeline marks', note => blazeLaneBuild(note, { away: true, fill: true, torches: true, settle: true }));
scene('blaze_lane_fill_torch', 'the lane set with the fill hand after clearing away, torches first (a greedy cover of the box), timeline marks', note => blazeLaneBuild(note, { away: true, fill: true, torches: true }));
scene('blaze_lane_fill', 'the lane set with the fill hand after clearing away: the room fills 40 s, the body goes far off 150 s, comes back, probe lane, fill acts (12 groups each, health floor 10), then a 300 s hold', note => blazeLaneBuild(note, { away: true, fill: true }));
scene('blaze_lane_build_away', 'the lane built after clearing away: the room fills for 40 s, the body goes to the Nether arrival for 150 s, comes back and builds from the probe, then a 300 s hold', note => blazeLaneBuild(note, { away: true }));
scene('blaze_lane_build', 'the lane built by the scripted head from probe kind=lane with go and place hands while the blazes are alive, then a 300 s hold', note => blazeLaneBuild(note));
async function blazeSlit(note: (text: string) => void, options: { seconds?: number; fetch?: boolean; flush?: boolean } = {}): Promise<Record<string, unknown>> {
  const stand = sites.blazeStand as number[] | undefined, spawner = sites.blazeSpawner as number[] | undefined;
  if (!stand || !spawner) throw new Error('no blazeStand or blazeSpawner in the sites');
  const seconds = options.seconds ?? (timedSeconds || 300);
  await ask('difficulty normal'); await ask('time set midnight'); await ask('weather clear');
  await ask('execute in minecraft:the_nether run kill @e[type=minecraft:blaze]');
  await equip({ stone_sword: 1, diamond_pickaxe: 1, shield: 1, cooked_porkchop: 7, cobblestone: 173 }, { armor: 'iron', shield: true });
  await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  const solidAt = (x: number, y: number, z: number) => { const b = actor.blockAt(new Vec3(x, y, z)); return !!b && b.boundingBox === 'block'; };
  const sy = spawner[1], sz = spawner[2];
  let wallX = spawner[0] - 1;
  while (wallX > spawner[0] - 8 && !solidAt(wallX, sy, sz)) wallX--;
  note(`spawner ${spawner}, west wall x=${wallX} (${actor.blockAt(new Vec3(wallX, sy, sz))?.name}), behind it x=${wallX - 1}: ${actor.blockAt(new Vec3(wallX - 1, sy, sz))?.name}`);
  const nether = 'execute in minecraft:the_nether run';
  // a cobblestone shell around the pocket (two cells: feet at sy-1, head at sy), then the pocket cells air, then the wall cell at the room's floor level air (the slit)
  await ask(`${nether} fill ${wallX - 3} ${sy - 3} ${sz - 2} ${wallX} ${sy + 2} ${sz + 2} minecraft:cobblestone`);
  const px = options.flush ? wallX : wallX - 1;   // flush: the pocket IS the wall cell (no partition): the room cell beside it is the opening
  await ask(`${nether} fill ${px} ${sy - 1} ${sz} ${px} ${sy} ${sz} minecraft:air`);
  await ask(`${nether} setblock ${wallX} ${sy} ${sz} minecraft:air`);
  await sleep(1500);
  note(`pocket ${actor.blockAt(new Vec3(wallX - 1, sy - 1, sz))?.name}/${actor.blockAt(new Vec3(wallX - 1, sy, sz))?.name}, slit ${actor.blockAt(new Vec3(wallX, sy, sz))?.name}, under the slit ${actor.blockAt(new Vec3(wallX, sy - 1, sz))?.name}, over it ${actor.blockAt(new Vec3(wallX, sy + 1, sz))?.name}`);
  await ask(`${nether} tp ${ACTOR} ${px + 0.5} ${sy - 1} ${sz + 0.5} facing ${wallX + 3} ${sy} ${sz}`);
  await sleep(2500);
  const started = Date.now();
  const rods0 = await countServer('blaze_rod'), shield0 = shieldUsed();
  let killed = 0;
  const onDead = (entity: any) => { if (String(entity?.name ?? '') === 'blaze') killed++; };
  actor.on('entityDead', onDead);
  const track: number[] = [];
  const sampler = setInterval(() => { const value = Number(actor.health); if (Number.isFinite(value)) track.push(r1(value)); }, 1000);
  let n = 0;
  try {
    while (Date.now() - started < seconds * 1000 && !disconnected && Number(actor.health) > 0) {
      const run = await act(`hold#${++n}`, [{ do: 'attack', target: 'blaze', hold: true, seconds: 20 }], 40, { accept: ['blaze'] });
      if (Number(actor.health) < 14 && Number(actor.food) < 20) await act('eat', [{ do: 'eat' }], 15);
      note(`hold#${n}: hp ${r1(Number(actor.health))} kills ${killed} ${run.lines.join(' | ').slice(0, 220)}`);
      if (Number(actor.health) < 8) break;
    }
  } finally { clearInterval(sampler); actor.removeListener('entityDead', onDead); }
  const onFloor = await ask(`${nether} execute as @e[type=minecraft:item,x=${wallX},y=${sy},z=${sz},distance=..9] run data get entity @s Item.id`);
  note(`items near the slit: ${onFloor.replace(/\s+/gu, ' ').slice(0, 300)}`);
  let fetched = 0;
  if (options.fetch && Number(actor.health) > 6) {
    const rodsBefore = packClient().blaze_rod ?? 0;
    const run = await act('fetch', options.flush ? [{ do: 'go', to: { x: wallX + 1, y: sy, z: sz }, range: 0.4, seconds: 6, onFail: 'continue' }, { do: 'pickup', range: 6, onFail: 'continue' }, { do: 'go', to: { x: px, y: sy - 1, z: sz }, range: 0.4, seconds: 6, onFail: 'continue' }] : [{ do: 'dig', at: [{ x: wallX, y: sy - 1, z: sz }], onFail: 'continue' }, { do: 'go', to: { x: wallX, y: sy - 1, z: sz }, range: 0.4, seconds: 6, onFail: 'continue' }, { do: 'pickup', range: 4, onFail: 'continue' }, { do: 'go', to: { x: wallX - 1, y: sy - 1, z: sz }, range: 0.4, seconds: 6, onFail: 'continue' }, { do: 'place', at: [{ x: wallX, y: sy - 1, z: sz }], block: 'cobblestone', onFail: 'continue' }], 40, { accept: ['blaze'] });
    fetched = (packClient().blaze_rod ?? 0) - rodsBefore;
    note(`fetch: hp ${r1(Number(actor.health))} rods ${fetched} ${run.lines.join(' | ').slice(0, 320)}`);
  }
  return { seconds: r1((Date.now() - started) / 1000), kills: killed, rodsInServerPack: (await countServer('blaze_rod')) - rods0, fetched, shieldWear: shieldUsed() - shield0, deathsHere: deaths, lowestHp: Math.min(...track, 20), hpTrack: track.filter((_, index) => index % 5 === 0).join(' ') };
}
scene('blaze_slit_low', 'the low slit: a pocket one block below the room floor behind the west wall, one opening at the floor level, attack hold 300 s, then fetch the rods through the wall cell', note => blazeSlit(note, { fetch: true }));
scene('blaze_slit_flush', 'the low slit with no partition: the pocket is in the wall plane one block below the floor, the room cell beside it is the opening; hold 300 s, fetch', note => blazeSlit(note, { fetch: true, flush: true }));
// A blow with the shield raised and with it lowered (S2, 2026-11-03; Codex's mechanism check for shield_rush): the precedent (mine-ai-mcp) strikes with the shield held up, the body's own notes say the server refuses
// such a blow. A still iron golem (no AI, 100 hp) on a clean platform; eight swings 0.8 s apart each way; the golem's health is read from the server after each way.
async function blowShieldCompare(note: (text: string) => void): Promise<Record<string, unknown>> {
  const stand = sites.blazeStand as number[] | undefined;
  if (!stand) throw new Error('no blazeStand in the sites');
  const nether = 'execute in minecraft:the_nether run';
  await ask('gamerule doMobSpawning false'); await ask('difficulty normal');
  await ask(`${nether} kill @e[type=minecraft:blaze]`);
  await equip({ stone_sword: 1, shield: 1 }, { armor: 'iron', shield: true });
  await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  const px = stand[0], py = stand[1] + 20, pz = stand[2];
  await ask(`${nether} fill ${px - 4} ${py - 1} ${pz - 4} ${px + 4} ${py - 1} ${pz + 4} minecraft:cobblestone`);
  await ask(`${nether} fill ${px - 4} ${py} ${pz - 4} ${px + 4} ${py + 4} ${pz + 4} minecraft:air`);
  await ask(`${nether} tp ${ACTOR} ${px + 0.5} ${py} ${pz + 0.5}`);
  await sleep(2000);
  const healthOf = async (): Promise<number> => { const text = await ask(`${nether} data get entity @e[tag=dummy,limit=1] Health`); const found = /following entity data: ([\d.]+)f/u.exec(text); return found ? Number(found[1]) : -1; };
  const out: Record<string, unknown> = {};
  for (const mode of ['raised', 'lowered', 'raised_again'] as const) {
    await ask(`${nether} kill @e[tag=dummy]`);
    await ask(`${nether} summon minecraft:iron_golem ${px + 2.5} ${py} ${pz + 0.5} {NoAI:1b,Tags:["dummy"],PersistenceRequired:1b}`);
    await sleep(1500);
    const golem = actor.nearestEntity((entity: any) => entity?.name === 'iron_golem');
    if (!golem) { note(`${mode}: no golem seen`); continue; }
    const before = await healthOf();
    let used = 'n/a';
    if (mode === 'lowered') { try { actor.deactivateItem(); } catch { /* none */ } } else { try { actor.activateItem(true); } catch (error) { note(`activate failed: ${String(error)}`); } }
    await sleep(500);
    used = String((actor as any).usingHeldItem);
    for (let swing = 0; swing < 8; swing++) {
      try { await actor.lookAt(golem.position.offset(0, golem.height * 0.6, 0), true); actor.attack(golem); } catch (error) { note(`attack failed: ${String(error)}`); }
      await sleep(800);
    }
    const after = await healthOf();
    out[mode] = { golemHp: `${before}→${after}`, usingHeldItem: used };
    note(`${mode}: golem ${before}→${after} (a stone sword hit is 5 minus the golem's armour, 8 swings), usingHeldItem ${used}`);
    try { actor.deactivateItem(); } catch { /* none */ }
    await sleep(800);
  }
  await ask(`${nether} kill @e[tag=dummy]`);
  await ask('gamerule doMobSpawning true');
  return out;
}
scene('blow_shield_compare', 'strikes a still iron golem eight times with the shield raised, lowered, raised again: does the blow land, and how much', note => blowShieldCompare(note));
scene('blaze_nook_sealed','the nook with no window (sealed to the head height, top open): hold for 120 s', note => blazeNook(note, { window: false, seconds: 120 }));
// Sniping (S2, 2026-11-02): a bow from a cell far enough from the spawner room that few of its blazes see the body and their fire (spread grows with the square root of the distance) mostly misses.
async function blazeSnipe(note: (text: string) => void, at: [number, number, number]): Promise<Record<string, unknown>> {
  const stand = sites.blazeStand as number[] | undefined, spawner = sites.blazeSpawner as number[] | undefined;
  if (!stand || !spawner) throw new Error('no blazeStand or blazeSpawner in the sites');
  const seconds = timedSeconds || 240;
  await ask('difficulty normal'); await ask('time set midnight'); await ask('weather clear');
  await ask('execute in minecraft:the_nether run kill @e[type=minecraft:blaze]');
  await equip({ bow: 1, arrow: 64, diamond_sword: 1, iron_pickaxe: 1, shield: 2, cooked_beef: 24, golden_apple: 3, cobblestone: 64 }, { armor: 'iron', shield: true });
  await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  let killed = 0;
  const onDead = (entity: any) => { if (String(entity?.name ?? '') === 'blaze') killed++; };
  actor.on('entityDead', onDead);
  const start = Date.now();
  const rods0 = await countServer('blaze_rod'), arrows0 = packClient().arrow ?? 0, shield0 = shieldUsed();
  const track: number[] = [];
  const sampler = setInterval(() => { const value = Number(actor.health); if (Number.isFinite(value)) track.push(r1(value)); }, 1000);
  const m = { shootActs: 0, shotsFired: 0, hits: 0, noTarget: 0, lowestHp: 20, hpLost: 0 };
  const canPlace = ['cobblestone', 'netherrack'];
  try {
    const walked = await act('to the snipe cell', [{ do: 'go', to: { x: at[0], y: at[1], z: at[2] }, range: 0.8, seconds: 40, canPlace, maxPlace: 30 }], 60, { accept: ['blaze'] });
    note(`at the snipe cell: ${(walked.lines[0] ?? '').slice(0, 200)}`);
    let seenNone = 0;
    while (Date.now() - start < seconds * 1000 && !disconnected && Number(actor.health) > 0) {
      const before = Number(actor.health);
      const run = await act(`shoot#${m.shootActs + 1}`, [{ do: 'shoot', target: 'blaze', n: 3, item: 'bow', onFail: 'continue' }], 30, { accept: ['blaze'] });
      m.shootActs++;
      const text = run.lines.join(' ');
      const tally = /当たり (\d+)\/(\d+)/u.exec(text);
      if (tally) { m.hits += Number(tally[1]); m.shotsFired += Number(tally[2]); }
      if (!run.ok) { seenNone++; m.noTarget++; if (m.noTarget <= 3) note(`shoot: ${text.slice(0, 220)}`); await sleep(1500); } else seenNone = 0;
      m.hpLost += Math.max(0, before - Number(actor.health)); m.lowestHp = Math.min(m.lowestHp, Number(actor.health));
      if (Number(actor.health) < 9) { note(`health ${r1(Number(actor.health))}: stop`); break; }
    }
  } finally { clearInterval(sampler); actor.removeListener('entityDead', onDead); }
  const arrowsUsed = arrows0 - (packClient().arrow ?? 0);
  return { seconds: r1((Date.now() - start) / 1000), kills: killed, arrowsUsed, hpTrack: track.filter((_, index) => index % 5 === 0).join(' '), shieldWear: shieldUsed() - shield0, deathsHere: deaths, rodsOnTheFloorNotPicked: (await countServer('blaze_rod')) - rods0, at, ...m, hpLost: r1(m.hpLost) };
}
scene('blaze_snipe_a', 'a bow from the bridge east of the c1 spawner room (153,74,76: 13 m, in sight of about 6 tenths of its hover places)', note => blazeSnipe(note, [153, 74, 76]));
scene('blaze_snipe_b', 'a bow from further along the bridge (154,74,75), inside the 16 m the spawner needs a player within', note => blazeSnipe(note, [154, 74, 75]));
scene('blaze_proto_fight_stay', 'the same as blaze_proto_fight but with no retreat: only eat and wait where the body stands (a head that does not know a hideout)', note => blazeProtocol('fight', note, { retreat: false }));

// ===== a map of the blaze camp's ground (what the planner has to read to choose a camp cell) ===================================================
// The ground round the camp as the retreat reads it (S2, 2026-11-02): for each standable cell the share of the spawner's hover places that see it, in tenths (0 = a hideout), # a solid cell, S the spawner, C a camp cell, H a hideout.
async function mapExpose(which: number, note: (text: string) => void): Promise<Record<string, unknown>> {
  const first = sites.blazeSpawner as number[], stand = sites.blazeStand as number[];
  const others = ((sites.blazeSpawners ?? []) as number[][]).filter(entry => entry[0] !== first[0] || entry[1] !== first[1] || entry[2] !== first[2]);
  const spawner = which === 0 ? first : others[which - 1];
  if (!spawner) throw new Error('no such spawner in the sites');
  await ask('difficulty peaceful');
  if (which === 0) await placeActor('the_nether', stand[0], stand[1], stand[2], 40);
  else { await ask('gamemode spectator ' + ACTOR); await placeActor('the_nether', spawner[0], spawner[1] + 2, spawner[2], 40); }
  await sleep(3000);
  const read = bodyReader(actor) as any;
  const spot = { x: spawner[0], y: spawner[1], z: spawner[2] };
  const camp = campSite(read, spot, 4).cells;
  const hides = hideoutsFrom(read, spot, camp[0] ?? { x: stand[0], y: stand[1], z: stand[2] }, 6);
  note(`camp cells ${JSON.stringify(camp.map(c => [c.x, c.y, c.z]))} hideouts ${JSON.stringify(hides.map(h => [h.x, h.y, h.z, h.steps]))}`);
  const standable = (x: number, y: number, z: number) => { const f = read(x, y, z), h = read(x, y + 1, z), g = read(x, y - 1, z); return !!f && !!h && !!g && !f.solid && !h.solid && g.solid && !/lava|magma|fire/u.test(`${f.name}${g.name}`); };
  for (let dy = 3; dy >= -4; dy--) {
    const y = spawner[1] + dy;
    log(`EXPO --- y=${y} (${dy >= 0 ? '+' : ''}${dy} from the spawner)  x ${spawner[0] - 14}..${spawner[0] + 26} across, z ${spawner[2] - 16} (top) .. ${spawner[2] + 16}`);
    for (let z = spawner[2] - 16; z <= spawner[2] + 16; z++) {
      let row = '';
      for (let x = spawner[0] - 14; x <= spawner[0] + 26; x++) {
        const b = read(x, y, z);
        if (x === spawner[0] && y === spawner[1] && z === spawner[2]) { row += 'S'; continue; }
        if (camp.some(c => c.x === x && c.y === y && c.z === z)) { row += 'C'; continue; }
        if (hides.some(h => h.x === x && h.y === y && h.z === z)) { row += 'H'; continue; }
        if (!b) { row += '?'; continue; }
        if (b.solid) { row += '#'; continue; }
        if (standable(x, y, z)) row += String(Math.min(9, Math.floor(exposureFromSpawner(read, spot, { x, y, z }) * 10)));
        else row += ' ';
      }
      log(`EXPO ${String(z).padStart(5)} ${row}`);
    }
  }
  return { camp: camp.length, hideouts: hides.length, spawner };
}
scene('map_expose', 'the exposure of the standable cells round the blaze spawner (x −14..+26, z −16..+16 of it, the layers 4 below to 3 above): the digit is the tenths of the spawner\x27s hover places that see the cell', note => mapExpose(0, note));
scene('map_expose2', 'the same round the other spawner of the sites file', note => mapExpose(1, note));
scene('map_blaze2', 'the same map round the OTHER spawner of the sites file (read from the first stand: both are within the loaded ground)', async () => {
  const first = sites.blazeSpawner as number[], stand = sites.blazeStand as number[];
  const others = ((sites.blazeSpawners ?? []) as number[][]).filter(s => s[0] !== first[0] || s[1] !== first[1] || s[2] !== first[2]);
  if (!others.length) throw new Error('no second spawner in the sites');
  const spawner = others[0];
  await ask('difficulty peaceful');
  await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  await sleep(2500);
  const glyph = (x: number, y: number, z: number): string => {
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
    return 'x';
  };
  let air = 0, total = 0;
  for (let dy = 3; dy >= -3; dy--) {
    const y = spawner[1] + dy;
    log(`MAP2 --- y=${y} (${dy >= 0 ? '+' : ''}${dy} from the spawner)  x ${spawner[0] - 8}..${spawner[0] + 8} across, z ${spawner[2] - 8} (top) .. ${spawner[2] + 8}`);
    for (let z = spawner[2] - 8; z <= spawner[2] + 8; z++) {
      let row = '';
      for (let x = spawner[0] - 8; x <= spawner[0] + 8; x++) { const g = glyph(x, y, z); row += g; if (Math.abs(x - spawner[0]) <= 4 && Math.abs(z - spawner[2]) <= 4 && Math.abs(dy) <= 1) { total++; if (g === '.') air++; } }
      log(`MAP2 ${String(z).padStart(5)} ${row}`);
    }
  }
  return { spawner, airShareInSpawnBox: Math.round(100 * air / Math.max(1, total)) / 100, cellsLooked: total };
});
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

scene('fire_feet', 'fire in the cell the body stands in and in the one over its head (a blaze\'s fireball leaves it): the lava reflex puts it out with a dig where the body stands, and walks the body out only when that does not do it', async () => {
  const stand = (sites.blazeStand ?? sites.netherArrival) as number[];
  await ask('difficulty peaceful');
  const y = await netherPlate(stand[0], stand[2]);
  await equip({ iron_pickaxe: 1, diamond_sword: 1, cooked_beef: 4 }, { armor: 'iron', shield: false });
  await placeActor('the_nether', stand[0], y, stand[2], 24);
  const nameAt = (x: number, yy: number, z: number) => actor.blockAt(new Vec3(x, yy, z))?.name ?? null;
  const trials: Array<Record<string, unknown>> = [];
  for (const where of ['feet', 'head', 'both', 'feet']) {
    const at = actor.entity.position as Vec3;
    const bx = Math.floor(at.x), bz = Math.floor(at.z), by = Math.floor(at.y + 0.01);
    const engagedBefore = actor.lavaReflex?.engagements ?? -1, hp0 = Number(actor.health), p0 = at.clone();
    if (where !== 'head') await ask(`execute in minecraft:the_nether run setblock ${bx} ${by} ${bz} minecraft:fire`);
    if (where !== 'feet') await ask(`execute in minecraft:the_nether run setblock ${bx} ${by + 1} ${bz} minecraft:fire`);
    const t0 = Date.now();
    let goneAfter: number | null = null;
    while (Date.now() - t0 < 4000) { await sleep(100); if (nameAt(bx, by, bz) !== 'fire' && nameAt(bx, by + 1, bz) !== 'fire') { goneAfter = Date.now() - t0; break; } }
    await sleep(700);
    const now = actor.entity.position as Vec3;
    trials.push({ where, goneAfterMs: goneAfter, engagements: (actor.lavaReflex?.engagements ?? -1) - engagedBefore, hpLost: r1(hp0 - Number(actor.health)), movedBlocks: r1(now.distanceTo(p0)), reflexInstalled: !!actor.lavaReflex, puncher: typeof actor.punchOutFire });
    await ask(`effect give ${ACTOR} minecraft:instant_health 1 3 true`);
    await ask(`execute in minecraft:the_nether run setblock ${bx} ${by} ${bz} minecraft:air`);
    await ask(`execute in minecraft:the_nether run setblock ${bx} ${by + 1} ${bz} minecraft:air`);
    await placeActor('the_nether', stand[0], y, stand[2], 24);
  }
  return { trials };
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

/** When a go's line says the server would not take a block (`置きを断られた (x,y,z)`): what is at that cell now and round it, and who is near it (the black box says only the body's overlap and jump). */
async function refusedReport(line: string): Promise<void> {
  const found = /置きを断られた \((-?\d+),(-?\d+),(-?\d+)\)/u.exec(line);
  if (!found) return;
  try {
    const cell = new Vec3(Number(found[1]), Number(found[2]), Number(found[3]));
    const here = actor.entity?.position as Vec3 | undefined;
    const at = (dx: number, dy: number, dz: number) => String(actor.blockAt(cell.offset(dx, dy, dz))?.name ?? '?');
    const middle = cell.offset(0.5, 0.5, 0.5);
    const near = Object.values(actor.entities as Record<string, any>).filter(entity => entity?.position && entity !== actor.entity && entity.position.distanceTo(middle) <= 6)
      .map(entity => `${entity.name ?? entity.type}@${r1(entity.position.distanceTo(middle))}`).slice(0, 8);
    log(`REFUSED ${found[1]},${found[2]},${found[3]} now ${at(0, 0, 0)}; below ${at(0, -1, 0)} above ${at(0, 1, 0)}; sides +x ${at(1, 0, 0)} -x ${at(-1, 0, 0)} +z ${at(0, 0, 1)} -z ${at(0, 0, -1)}; entities within 6 m: ${near.join(' ') || 'none'}; body ${here ? `${r1(here.x)},${r1(here.y)},${r1(here.z)}` : '?'} onGround ${actor.entity?.onGround}`);
  } catch (error) { log(`REFUSED unknown: ${String(error).slice(0, 120)}`); }
  // The black box's last 90 s (route searches with their places, digs, the server's block changes near the body, hurts) written for this stop: read with HUNT_KEEP=1.
  try {
    const dumped = await blackBoxOf(actor)?.dump('refused', `probe: ${line.slice(0, 200)}`);
    log(dumped ? `REFUSED black box ${dumped.file} (${dumped.bytes} bytes)` : 'REFUSED no black box on this body');
  } catch (error) { log(`REFUSED black box failed: ${String(error).slice(0, 120)}`); }
}
/** The black box's last 90 s written for a stop of a go (`kind`), read with HUNT_KEEP=1: the route searches, their places and digs, the server's block changes near the body. */
async function dumpBox(kind: string, line: string): Promise<void> {
  try {
    const dumped = await blackBoxOf(actor)?.dump(kind, `probe: ${line.slice(0, 200)}`);
    log(dumped ? `BOX ${kind} ${dumped.file} (${dumped.bytes} bytes)` : `BOX ${kind}: no black box on this body`);
  } catch (error) { log(`BOX ${kind} failed: ${String(error).slice(0, 120)}`); }
}
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
      const run = await act(`${target.name}#${tries + 1}`, [{ do: 'go', to: { x: target.to[0], y: target.to[1], z: target.to[2] }, range: 3, seconds: 100, maxDig, maxPlace, canDig: [...canDig], canPlace: ['cobblestone', 'netherrack'] }], 140);
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
      // (a hop cut by a reflex is the world's doing, not the way being shut: it is not counted, a planner would go on)
      slow = run.stoppedBy === 'reflex' ? slow : before - left < 3 ? slow + 1 : 0;
      if (!reached && (before - left < 3 || tries === 0)) mapAround(`${target.name}#${tries + 1}`);
      await refusedReport(line);
      if (/search_timeout/u.test(line)) await dumpBox('search_timeout', line);
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
scene('climb_pillar', 'go up to a platform 10 above the plate by laying stones under the feet (no digging): how often the server takes the first block of each climb', async note => {
  const stand = sites.netherArrival as number[];
  const x = stand[0], z = stand[2];
  await ask('difficulty peaceful');
  const y = await netherPlate(x, z);
  await ask(`execute in minecraft:the_nether run fill ${x - 4} ${y + 9} ${z - 4} ${x + 8} ${y + 20} ${z + 4} minecraft:air`);
  await ask(`execute in minecraft:the_nether run fill ${x + 1} ${y + 9} ${z - 1} ${x + 3} ${y + 9} ${z + 1} minecraft:netherrack`);
  const rows: Array<Record<string, unknown>> = [];
  for (let attempt = 1; attempt <= 3 && !disconnected; attempt++) {
    await equip({ cobblestone: 64, cooked_beef: 4 }, { armor: 'none', shield: false });
    await placeActor('the_nether', x, y, z, 24);
    const run = await act(`pillar#${attempt}`, [{ do: 'go', to: { x: x + 2, y: y + 10, z }, range: 1, seconds: 60, maxPlace: 30, canPlace: ['cobblestone'] }], 90);
    const here = actor.entity?.position as Vec3 | undefined;
    await refusedReport(run.lines[0] ?? '');
    rows.push({ attempt, ok: run.ok, at: here ? [r1(here.x), r1(here.y), r1(here.z)] : null, line: (run.lines[0] ?? '').slice(0, 300) });
    note(`pillar#${attempt}: ${run.ok ? 'ok' : 'NO'} ${(run.lines[0] ?? '').slice(0, 200)}`);
  }
  return { rows };
});
scene('bridge_void', 'a bridge of stones over a void 52 long, a safety floor 7 below: how often the server refuses a block of the bridge, and what stands at the cell', async note => {
  const stand = sites.netherArrival as number[];
  const x = stand[0], z = stand[2], y = 100;
  await ask('difficulty peaceful'); await ask('time set noon');
  const nether = 'execute in minecraft:the_nether run';
  await ask(`${nether} forceload add ${x - 16} ${z - 16} ${x + 96} ${z + 16}`); await sleep(5000);
  await ask(`${nether} fill ${x - 8} ${y - 12} ${z - 5} ${x + 92} ${y + 8} ${z + 5} minecraft:air`);
  await ask(`${nether} fill ${x - 8} ${y - 3} ${z - 5} ${x + 8} ${y - 1} ${z + 5} minecraft:netherrack`);
  await ask(`${nether} fill ${x + 9} ${y - 8} ${z - 5} ${x + 60} ${y - 8} ${z + 5} minecraft:netherrack`);
  await ask(`${nether} fill ${x + 61} ${y - 3} ${z - 5} ${x + 92} ${y - 1} ${z + 5} minecraft:netherrack`);
  const rows: Array<Record<string, unknown>> = [];
  for (let attempt = 1; attempt <= 3 && !disconnected; attempt++) {
    await ask(`${nether} fill ${x + 9} ${y - 3} ${z - 5} ${x + 60} ${y - 1} ${z + 5} minecraft:air`);   // the bridge of the attempt before is taken down
    await equip({ cobblestone: 128, cooked_beef: 4 }, { armor: 'iron', shield: false });
    await placeActor('the_nether', x, y, z, 24);
    const run = await act(`bridge#${attempt}`, [{ do: 'go', to: { x: x + 70, y, z }, range: 1, seconds: 100, maxPlace: 100, canPlace: ['cobblestone'] }], 130);
    const here = actor.entity?.position as Vec3 | undefined;
    await refusedReport(run.lines[0] ?? '');
    rows.push({ attempt, ok: run.ok, at: here ? [r1(here.x), r1(here.y), r1(here.z)] : null, seconds: r1(run.wallMs / 1000), line: (run.lines[0] ?? '').slice(0, 300) });
    note(`bridge#${attempt}: ${run.ok ? 'ok' : 'NO'} ${(run.lines[0] ?? '').slice(0, 220)}`);
  }
  return { rows };
});
scene('ghast_walk', 'a ghast over an open room while go crosses it (iron armour, shield, diamond sword): health lost, the stops of the go, who is alive at the end', async note => {
  const stand = sites.netherArrival as number[];
  const x = stand[0], z = stand[2], y = 100;
  await ask('difficulty normal'); await ask('time set noon');
  const nether = 'execute in minecraft:the_nether run';
  await ask(`${nether} forceload add ${x - 40} ${z - 40} ${x + 40} ${z + 40}`); await sleep(5000);
  await ask(`${nether} fill ${x - 36} ${y - 3} ${z - 36} ${x + 36} ${y - 1} ${z + 36} minecraft:netherrack`);
  // (a fill is at most 32,768 blocks: the room is cleared in slabs)
  for (let zz = z - 36; zz <= z + 36; zz += 12) await ask(`${nether} fill ${x - 36} ${y} ${zz} ${x + 36} ${y + 24} ${Math.min(zz + 11, z + 36)} minecraft:air`);
  await ask(`${nether} kill @e[type=minecraft:ghast]`);
  await equip({ diamond_sword: 1, cooked_beef: 8, golden_apple: 2 }, { armor: 'iron', shield: true });
  await placeActor('the_nether', x - 30, y, z, 24);
  await ask(`${nether} summon minecraft:ghast ${x + 5} ${y + 9} ${z + 4}`);
  const ghastAlive = () => Object.values(actor.entities as Record<string, any>).filter(entity => entity?.name === 'ghast' && entity.position && (entity.health === undefined || entity.health > 0)).length;
  const hp0 = Number(actor.health), started = Date.now();
  const rows: Array<Record<string, unknown>> = [];
  let low = hp0;
  for (let hop = 1; hop <= 5 && !disconnected; hop++) {
    const run = await act(`ghast#${hop}`, [{ do: 'go', to: { x: x + 30, y, z }, range: 2, seconds: 60 }], 90);
    const here = actor.entity?.position as Vec3 | undefined;
    low = Math.min(low, Number(actor.health));
    rows.push({ hop, ok: run.ok, hp: run.hp, at: here ? [r1(here.x), r1(here.y), r1(here.z)] : null, stoppedBy: run.stoppedBy ?? null, line: (run.lines[0] ?? '').slice(0, 220) });
    if (run.ok || Number(actor.health) < 8) break;
    if (Number(actor.health) < 14) await act('eat', [{ do: 'eat' }], 15);
  }
  note(`ghast: ${rows.length} hops, ${r1((Date.now() - started) / 1000)} s, health ${hp0} -> ${r1(Number(actor.health))} (lowest ${r1(low)}), ghasts alive ${ghastAlive()}`);
  await ask(`${nether} kill @e[type=minecraft:ghast]`);
  return { hops: rows.length, seconds: r1((Date.now() - started) / 1000), hpBefore: hp0, hpAfter: r1(Number(actor.health)), hpLowest: r1(low), reached: rows.at(-1)?.ok === true, rows };
});
scene('wall_hand', 'the body shut into two blocks of cobblestone with no pickaxe: the wall reflex digs it out by hand (10 s a block) and does not give up at its old 10 s limit', async note => {
  const stand = sites.netherArrival as number[];
  await ask('difficulty peaceful');
  const y = await netherPlate(stand[0], stand[2]);
  await equip({ cooked_beef: 4 }, { armor: 'none', shield: false });
  await placeActor('the_nether', stand[0], y, stand[2], 24);
  await sleep(1500);
  const p = actor.entity.position as Vec3;
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
  const hp0 = Number(actor.health);
  const started = Date.now();
  for (const dy of [0, 1]) await ask(`execute in minecraft:the_nether run setblock ${bx} ${by + dy} ${bz} minecraft:cobblestone`);
  const eyeBlock = () => String(actor.blockAt(new Vec3(Math.floor(actor.entity.position.x), Math.floor(actor.entity.position.y + 1.62), Math.floor(actor.entity.position.z)))?.name ?? '?');
  let minHp = hp0;
  await sleep(1500);
  const until = Date.now() + 60_000;
  while (Date.now() < until && !disconnected && eyeBlock() === 'cobblestone') { minHp = Math.min(minHp, Number(actor.health)); await sleep(250); }
  const seconds = r1((Date.now() - started) / 1000);
  note(`out of the stone after ${seconds} s, eye block ${eyeBlock()}, health ${hp0} -> ${r1(Number(actor.health))} (lowest ${r1(minHp)})`);
  return { escaped: eyeBlock() !== 'cobblestone', seconds, hpBefore: hp0, hpAfter: r1(Number(actor.health)), hpLowest: r1(minHp) };
});
scene('tool_broke','a pickaxe with three uses left breaks in the middle of a go through a netherrack wall: the act stops, and its line says the tool broke and what to do', async () => {
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
scene('nether_stuck_c4', 'c4 only: the fortress leg from (155,78,60), where a leg ended on search_timeout twice running (t53)', note => netherWalk(note, ['fortress'], [155, 78, 60]));
scene('nether_leg2','the walk in the Nether from the fortress\'s stand to the warped forest by go hops (the second leg of nether_walk alone)', note => netherWalk(note, ['warped'], sites.blazeStand as number[]));

// ===== the probe kinds (what the LLM-centric mode can call: act and probe, no catalog skill) =================================================
scene('probe_kinds', 'probe kind=camp at the blaze spawner and kind=frames at the stronghold, against find-structure\'s own answers (they must say the same)', async note => {
  const stand = sites.blazeStand as number[];
  const portal = (sites.strongholdPortalCenter ?? sites.strongholdSurface) as number[];
  await ask('difficulty peaceful');
  await equip({}, { armor: 'none', shield: false });
  await placeActor('the_nether', stand[0], stand[1], stand[2], 24);
  const campStarted = Date.now();
  const campProbe = await runSkill('probe', { kind: 'camp' }, 20);
  note(`probe camp took ${Date.now() - campStarted} ms`);
  const campSkill = await runSkill('find-structure', { structureType: 'blaze_spawner' }, 20);
  let camp: any = null;
  try { camp = JSON.parse(String(campProbe.receipt?.result ?? '')); } catch { camp = null; }
  note(`probe camp: ${String(campProbe.receipt?.result ?? '').slice(0, 1800)}`);
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
  return { campFound: camp?.found ?? null, campCells: camp?.cells?.length ?? null, campFirst: camp?.cells?.[0] ?? null, campHideouts: camp?.hideouts ?? null, campSameAsSkill: camp?.text === String(campSkill.receipt?.result ?? ''),
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
