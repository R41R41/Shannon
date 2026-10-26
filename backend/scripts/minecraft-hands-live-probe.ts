#!/usr/bin/env node
// Model-free live check of the act hands (place, make, pillarUp, go, mine, smelt, obsidian, portal, fight) on a real Minecraft
// server, through the road the production body uses: NativeCommonFcaBody.execute(command) for the skill `act`, which opens the
// action (executeAction), resolves the skill through the catalog's schema, runs InstantSkill.run (a second executeAction and the
// act's own createMotorPort), and renders the receipt. Nothing here calls runAct(bot, ...) directly: run 40 (2026-10-27) lost 65 of
// 68 places with "Motor owner expired" because go left the act's motor port in the body's dig and placeBlock, and a simulator that
// calls runAct on a bare bot never goes through a port that outlives its act.
//
// A scene builds one situation with server commands (the operator bot is op; the actor, `MinebotTrial`, is a survival player), runs
// one or more consecutive acts, and judges them by what the SERVER holds afterwards (blocks seen by the operator, the actor's
// inventory and position read with /data, the dimension) as well as by the receipt. The scenes run on ONE body in a fixed order,
// without reconnecting, so what one act leaves behind meets the next act (go, then place, then make, then pillarUp).
//
// Env (set by scripts/lab/run-hands-live.sh; the lab world is new and isolated, no model and no paid API is reachable):
//   MINECRAFT_HANDS_NO_LLM=true  MINECRAFT_HANDS_PORT=<25570..25599>  MINECRAFT_HANDS_WORLD_DIRECTORY=/home/azureuser/minecraft/progressive-lab-XXXX
//   MINECRAFT_HANDS_SCENES=place_table,go_dig_wall   (names or prefixes; default: all)
//   MINECRAFT_HANDS_REPORT=<file>   (the whole report as JSON)
//   MINECRAFT_HANDS_SCENE_SECONDS=<n>   (overrides each scene's act deadline)
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { NativeCommonFcaBody } from '../src/services/minebot/integration/commonFca/nativeBody.js';

const port = Number(process.env.MINECRAFT_HANDS_PORT);
const worldDirectory = process.env.MINECRAFT_HANDS_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_HANDS_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25570 || port > 25599
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_HANDS_WORLD_REQUIRED');
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GOOGLE_API_KEY', 'GEMINI_API_KEY']) {
  if (process.env[key]) throw new Error(`HANDS_PROBE_REFUSES_PAID_KEY:${key}`);
}
if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'offline-test-not-used') throw new Error('HANDS_PROBE_REFUSES_PAID_KEY:OPENAI_API_KEY');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`)
  || !properties.includes('level-type=minecraft\\:flat')) throw new Error('ISOLATED_HANDS_WORLD_CONFIGURATION_INVALID');

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (text: string) => console.log(`[${stamp()}] ${text}`);
const sceneSeconds = Number(process.env.MINECRAFT_HANDS_SCENE_SECONDS ?? 0) || 0;
const reportFile = process.env.MINECRAFT_HANDS_REPORT ?? '';

// The arena: a stone slab (y 90..99) of 33 x 33 under open air (y 100..112), rebuilt for every scene. The body stands at (0.5, 100, 0.5).
const HALF = 16, FLOOR = 99, SKY = 112, BOTTOM = 90;
const ACTOR = 'MinebotTrial';

interface Check { name: string; passed: boolean; detail?: string }
interface ActRun {
  label: string; hands: string[]; outcome: string; ok: boolean; wallMs: number; actMs: number | null; failureType?: string; stoppedBy?: string; stoppedWhy?: string;
  lines: string[]; at?: unknown; from: number[] | null; to: number[] | null; dimension: string; hp: number | null;
  packDelta: Record<string, number>; packDeltaClient: Record<string, number>; goDug: number | null; goPlaced: number | null; hostDigRestored: boolean; hostPlaceRestored: boolean;
  motorExpired: boolean; error?: string; receipt?: string;
}
interface SceneReport { name: string; title: string; passed: boolean; startedAt: string; ms: number; acts: ActRun[]; checks: Check[]; notes: string[]; deaths: number; setupWarnings: string[] }

const operator = await createProbeBot(port);
const actor: any = await createProbeBot(port, ACTOR);
const body = new NativeCommonFcaBody(actor, { serverId: 'hands-live-probe',
  capture: async () => { throw new Error('no picture in the lab'); }, rendererConfigured: () => false });
let deaths = 0, disconnected: string | null = null;
actor.on('death', () => { deaths++; });
actor.on('end', (reason: unknown) => { disconnected ??= `end:${String(reason)}`; });
actor.on('kicked', (reason: unknown) => { disconnected ??= `kicked:${JSON.stringify(reason).slice(0, 200)}`; });
actor.on('error', (error: Error) => { log(`ACTOR_ERROR ${String(error?.message ?? error).slice(0, 200)}`); });
operator.on('end', (reason: unknown) => { disconnected ??= `operator-end:${String(reason)}`; });
operator.on('kicked', (reason: unknown) => { disconnected ??= `operator-kicked:${JSON.stringify(reason).slice(0, 200)}`; });

// ---- server access: commands through the operator, what they answer, and server-side reads ----------------------------------------------
const messageString = (message: unknown): string => {
  try { return typeof message === 'string' ? message : String((message as { toString(): string }).toString()); } catch { return ''; }
};
const ERROR_WORDS = /Unknown or incomplete|Incorrect argument|Expected|Invalid|No entity was found|Could not|Unrecognized|not found|That position|isn't|cannot|Cannot/u;
/** Commands whose "nothing to do" answer is normal (kill with nobody, clear with an empty pack): only a malformed one is a warning. */
const SOFT_COMMANDS = /^(kill|clear|effect clear|item replace|gamerule)\b/u;
const MALFORMED = /Unknown or incomplete|Incorrect argument|Expected|Unrecognized|\[timeout\]/u;
/** One server command as the operator; what the server answered (the lines between the command and a marker). */
async function ask(command: string, timeoutMs = 10_000, withJson = false): Promise<string> {
  const marker = `HANDSASK_${randomUUID().split('-').join('').slice(0, 10)}`;
  const seen: string[] = [];
  const answer = await new Promise<string>(resolve => {
    let timer: NodeJS.Timeout | undefined;
    const done = (suffix = '') => { if (timer) clearTimeout(timer); operator.removeListener('message', listener as never); resolve(seen.join('\n') + suffix); };
    const listener = (message: unknown) => {
      const text = messageString(message);
      if (text.includes(marker)) done();
      else seen.push(withJson ? `${text} [json ${(() => { try { return JSON.stringify((message as { json?: unknown }).json); } catch { return "?"; } })()}]` : text);
    };
    timer = setTimeout(() => done('\n[timeout]'), timeoutMs);
    operator.on('message', listener as never);
    operator.chat(`/${command}`);
    operator.chat(`/tellraw @s ${JSON.stringify({ text: marker })}`);
  });
  await sleep(250); // the vanilla server disconnects a client that chats too fast
  return answer;
}

/**
 * How many of each named item the SERVER says the actor holds (`/clear <actor> <item> 0` only counts; the client's copy can lag, see
 * the inventory-sync probe). /data get is no use: the chat message flattens the NBT and loses its braces.
 */
let packRawLogged = 0;
async function packServer(names: readonly string[]): Promise<Record<string, number>> {
  const pack: Record<string, number> = {};
  for (const name of names) {
    const text = await ask(`clear ${ACTOR} minecraft:${name} 0`, 10_000, true);
    // The chat text drops the number ("Found  matching item(s)"): it is in the message's json, as {"":<n>}.
    const found = /(?:^|\n)Found [^\n]*\[json \{"with":\[\{"":(\d+)\}/u.exec(text);
    if (!found && !/No items were found/u.test(text) && packRawLogged++ < 8) log(`PACK_RAW ${name}: ${JSON.stringify(text.slice(0, 300))}`);
    pack[name] = Number(found?.[1] ?? 0);
  }
  return pack;
}
const packClient = (): Record<string, number> => Object.fromEntries(Object.entries((actor.inventory.items() as Array<{ name: string; count: number }>)
  .reduce((sum, item) => { sum[item.name] = (sum[item.name] ?? 0) + item.count; return sum; }, {} as Record<string, number>)));
async function posServer(): Promise<number[] | null> {
  const text = await ask(`data get entity ${ACTOR} Pos`);
  const numbers = [...text.matchAll(/(-?\d+(?:\.\d+)?)d/gu)].map(match => Number(match[1]));
  return numbers.length >= 3 ? numbers.slice(-3) : null;
}
const dimensionOf = () => String(actor.game?.dimension ?? '').replace(/^minecraft:/u, '');
const blockName = (x: number, y: number, z: number): string | null => operator.blockAt(new Vec3(x, y, z))?.name ?? null;
const countBlocks = (name: string, box: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }) => {
  let count = 0;
  for (let x = box.x0; x <= box.x1; x++) for (let y = box.y0; y <= box.y1; y++) for (let z = box.z0; z <= box.z1; z++) if (blockName(x, y, z) === name) count++;
  return count;
};
const delta = (before: Record<string, number>, after: Record<string, number>) => {
  const out: Record<string, number> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) if ((after[name] ?? 0) !== (before[name] ?? 0)) out[name] = (after[name] ?? 0) - (before[name] ?? 0);
  return out;
};

// ---- scene machinery ---------------------------------------------------------------------------------------------------------------------
const context = { scopeKey: 'hands-live', taskId: 'hands-task', taskRevision: 1, bodyId: 'minecraft:hands-live-probe', sessionId: 'hands-session', generation: 1,
  goal: 'hands live probe', completionCondition: 'none' };
let commandNumber = 0;

class Scene {
  readonly acts: ActRun[] = []; readonly checks: Check[] = []; readonly notes: string[] = []; readonly setupWarnings: string[] = [];
  deathsAtStart = deaths;
  /** The items whose count the server is asked for before and after each act (one /clear query each). */
  watch: string[] = [];
  constructor(readonly name: string, readonly title: string, readonly seconds: number) {}

  /** One setup command; an answer that reads like an error is kept (a scene built wrong must not pass quietly). */
  async cmd(command: string): Promise<string> {
    const answer = await ask(command);
    if ((SOFT_COMMANDS.test(command) ? MALFORMED : ERROR_WORDS).test(answer) || answer.includes('[timeout]')) this.setupWarnings.push(`${command.slice(0, 80)} => ${answer.replace(/\s+/gu, ' ').slice(0, 160)}`);
    return answer;
  }
  /** The arena back to a clean slab, the actor on it with an empty pack. */
  async reset(options: { difficulty?: string; time?: string } = {}): Promise<void> {
    await this.cmd(`difficulty ${options.difficulty ?? 'peaceful'}`);
    await this.cmd(`time set ${options.time ?? 'day'}`);
    await this.cmd('kill @e[type=!minecraft:player]');
    await this.cmd(`fill ${-HALF} ${BOTTOM} ${-HALF} ${HALF} ${FLOOR} ${HALF} minecraft:stone`);
    await this.cmd(`fill ${-HALF} ${FLOOR + 1} ${-HALF} ${HALF} ${SKY} ${HALF} minecraft:air`);
    await this.cmd(`gamemode survival ${ACTOR}`);
    await this.cmd(`clear ${ACTOR}`);
    await this.cmd(`effect clear ${ACTOR}`);
    await this.cmd(`execute in minecraft:overworld run tp ${ACTOR} 0.5 ${FLOOR + 1} 0.5 -90 0`);
    await this.cmd(`effect give ${ACTOR} minecraft:instant_health 1 5 true`);
    await this.cmd(`effect give ${ACTOR} minecraft:saturation 5 10 true`);
    actor.pathfinder?.stop(); actor.clearControlStates?.();
  }
  async give(items: Record<string, number>): Promise<void> {
    for (const [name, count] of Object.entries(items)) await this.cmd(`give ${ACTOR} minecraft:${name} ${count}`);
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const held = packClient();
      if (Object.entries(items).every(([name, count]) => (held[name] ?? 0) >= count)) return;
      await sleep(150);
    }
    this.notes.push(`give: the client's pack did not show ${JSON.stringify(items)} in 5 s`);
  }
  /** Waits until the actor's own client sees the blocks (name by cell) and stands on the slab at the start. */
  async settle(expect: Array<[number, number, number, string]> = []): Promise<boolean> {
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      const p = actor.entity?.position as Vec3 | undefined;
      const seen = expect.every(([x, y, z, name]) => actor.blockAt(new Vec3(x, y, z))?.name === name);
      if (p && dimensionOf() === 'overworld' && Math.abs(p.x - 0.5) < 1.5 && Math.abs(p.z - 0.5) < 1.5 && p.y >= FLOOR + 0.9 && p.y < FLOOR + 2
        && actor.entity.onGround && actor.blockAt(new Vec3(0, FLOOR, 0))?.name === 'stone' && seen) { await sleep(400); return true; }
      await sleep(150);
    }
    this.notes.push('settle: the actor or the blocks were not as set after 10 s');
    return false;
  }
  check(name: string, passed: boolean, detail?: string): void { this.checks.push({ name, passed: !!passed, ...(detail ? { detail } : {}) }); }

  /** One act command through the production body (NativeCommonFcaBody.execute). */
  async act(label: string, input: Record<string, unknown>, seconds = this.seconds): Promise<ActRun> {
    seconds = sceneSeconds || seconds;
    const hands = (input.hands as Array<{ do: string }>).map(hand => hand.do);
    const before = { server: await posServer(), pack: await packServer(this.watch), client: packClient(), hp: Number(actor.health), dig: actor.dig, place: actor.placeBlock };
    const id = `hands-${++commandNumber}`;
    const command: any = { schemaVersion: 1, id, serverId: 'hands-live-probe', connectionId: 'hands-live', kind: 'skill', skill: 'act', arguments: input,
      context, lease: { id: 'hands-lease', generation: 1, holder: 'hands-task' }, deadlineAt: new Date(Date.now() + seconds * 1000).toISOString() };
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort('probe_watchdog'), (seconds + 20) * 1000);
    const started = Date.now();
    let receipt: any = null, error: string | undefined;
    try { receipt = await body.execute(command, controller.signal); }
    catch (thrown) { error = String((thrown as Error)?.message ?? thrown); }
    clearTimeout(watchdog);
    const wallMs = Date.now() - started;
    await sleep(700); // the server's last packets (a drop picked up, a block placed) reach the client
    let parsed: any = null;
    try { parsed = JSON.parse(receipt?.result ?? ''); } catch { parsed = null; }
    const after = { server: await posServer(), pack: await packServer(this.watch), client: packClient() };
    const lines: string[] = Array.isArray(parsed?.lines) ? parsed.lines.map((line: any) => `${line.i}.${line.do} ${line.status}: ${String(line.line).slice(0, 330)}`) : [];
    const goLine = (Array.isArray(parsed?.lines) ? parsed.lines : []).filter((line: any) => line.do === 'go').map((line: any) => String(line.line)).join(' ');
    const counted = /掘\s*(\d+)・置\s*(\d+)/u.exec(goLine);
    const run: ActRun = { label, hands, outcome: receipt?.outcome ?? 'threw', ok: parsed ? parsed.ok === true : receipt?.outcome === 'completed',
      wallMs, actMs: typeof parsed?.ms === 'number' ? parsed.ms : null, failureType: receipt?.failureType, stoppedBy: parsed?.stoppedBy, stoppedWhy: parsed?.stoppedWhy,
      lines, at: parsed?.at, from: before.server, to: after.server, dimension: dimensionOf(), hp: Number.isFinite(Number(actor.health)) ? Math.round(Number(actor.health) * 10) / 10 : null,
      packDelta: delta(before.pack, after.pack), packDeltaClient: delta(before.client, after.client), goDug: counted ? Number(counted[1]) : null, goPlaced: counted ? Number(counted[2]) : null,
      hostDigRestored: actor.dig === before.dig, hostPlaceRestored: actor.placeBlock === before.place,
      motorExpired: /Motor owner expired/u.test(`${receipt?.result ?? ''} ${error ?? ''}`), ...(error ? { error } : {}),
      ...(parsed ? {} : { receipt: String(receipt?.result ?? '').slice(0, 400) }) };
    this.acts.push(run);
    log(`ACT ${this.name}/${label} ${run.ok ? 'ok' : 'FAILED'} ${(wallMs / 1000).toFixed(1)}s ${lines.map(line => line.slice(0, 120)).join(' | ')}${error ? ` ERROR ${error}` : ''}`);
    return run;
  }
  /** The act did what was asked: ok, and no "Motor owner expired" anywhere. */
  expectOk(run: ActRun, name = `${run.label}: act ok`): void {
    this.check(name, run.ok && !run.motorExpired, run.ok ? undefined : `${run.stoppedBy ?? run.outcome} ${run.stoppedWhy ?? run.failureType ?? run.error ?? ''} ${run.lines.at(-1) ?? ''}`.trim().slice(0, 300));
    if (run.motorExpired) this.check(`${run.label}: no Motor owner expired`, false, 'the receipt says Motor owner expired');
  }
  /** After a go: the body's own dig and placeBlock are the functions it had before (go counts on the host and puts them back by identity). */
  expectHostRestored(run: ActRun): void {
    this.check(`${run.label}: host dig/placeBlock put back`, run.hostDigRestored && run.hostPlaceRestored,
      `dig ${run.hostDigRestored ? 'same' : 'DIFFERENT'}, placeBlock ${run.hostPlaceRestored ? 'same' : 'DIFFERENT'}`);
  }
  report(startedAt: number, startedIso: string): SceneReport {
    const passed = this.checks.length > 0 && this.checks.every(check => check.passed) && this.acts.length > 0;
    return { name: this.name, title: this.title, passed, startedAt: startedIso, ms: Date.now() - startedAt, acts: this.acts, checks: this.checks, notes: this.notes,
      deaths: deaths - this.deathsAtStart, setupWarnings: this.setupWarnings };
  }
}

const fill = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, block: string) => `fill ${x0} ${y0} ${z0} ${x1} ${y1} ${z1} minecraft:${block}`;
const cellAt = (x: number, y: number, z: number) => ({ x, y, z });
const actorCell = () => { const p = actor.entity?.position as Vec3 | undefined; return p ? { x: p.x, y: p.y, z: p.z } : null; };

// ---- the scenes ----------------------------------------------------------------------------------------------------------------------------
type Define = (s: Scene) => Promise<void>;
const scenes: Array<{ name: string; title: string; seconds: number; run: Define }> = [];
const scene = (name: string, title: string, seconds: number, run: Define) => scenes.push({ name, title, seconds, run });

function placeTableScene(suffix: string): Define {
  return async s => {
    s.watch = ['crafting_table'];
    await s.reset(); await s.give({ crafting_table: 1 }); await s.settle();
    const run = await s.act('place', { hands: [{ do: 'place', block: 'crafting_table', at: [cellAt(1, FLOOR + 1, 0)] }] });
    s.expectOk(run);
    await sleep(500);
    s.check('server: crafting_table at (1,100,0)', blockName(1, FLOOR + 1, 0) === 'crafting_table', `the block there is ${blockName(1, FLOOR + 1, 0)}`);
    s.check('pack: crafting_table used', (run.packDelta.crafting_table ?? 0) === -1, JSON.stringify(run.packDelta));
    if (suffix) s.notes.push('runs after the go scenes: the body has been through go already');
  };
}
function makePickaxeScene(suffix: string): Define {
  return async s => {
    s.watch = ['wooden_pickaxe', 'crafting_table', 'oak_planks', 'stick'];
    await s.reset(); await s.give({ crafting_table: 1, oak_planks: 5 }); await s.settle();
    const run = await s.act('make', { hands: [{ do: 'make', item: 'wooden_pickaxe' }] });
    s.expectOk(run);
    s.check('server: wooden_pickaxe in the pack', (run.packDelta.wooden_pickaxe ?? 0) >= 1, JSON.stringify(run.packDelta));
    const tables = countBlocks('crafting_table', { x0: -4, y0: FLOOR + 1, z0: -4, x1: 4, y1: FLOOR + 3, z1: 4 });
    s.check('server: a crafting_table stands near (made on, from the pack)', tables >= 1, `${tables} within 4 blocks`);
    if (suffix) s.notes.push('runs after the go scenes');
  };
}
function pillarScene(suffix: string): Define {
  return async s => {
    s.watch = ['cobblestone'];
    await s.reset(); await s.give({ cobblestone: 8 }); await s.settle();
    const run = await s.act('pillarUp', { hands: [{ do: 'pillarUp', n: 3, block: 'cobblestone' }] });
    s.expectOk(run);
    await sleep(500);
    const y = run.to?.[1] ?? 0;
    s.check('server: the body stands 3 levels up (y ~ 103)', y >= FLOOR + 3.9 && y <= FLOOR + 4.5, `y=${y}`);
    const column = [0, 1, 2].map(up => blockName(0, FLOOR + 1 + up, 0));
    s.check('server: three cobblestone in the column', column.every(name => name === 'cobblestone'), column.join(','));
    if (suffix) s.notes.push('runs after the go scenes');
  };
}

scene('place_table', 'place: a crafting table next to the feet', 60, placeTableScene(''));
scene('make_pickaxe', 'make: a wooden pickaxe (3x3, table from the pack, planks to sticks)', 60, makePickaxeScene(''));
scene('pillar3', 'pillarUp: three levels with cobblestone', 60, pillarScene(''));

scene('go_dig_wall', 'go: through a 3-thick stone wall (canDig stone, stone pickaxe)', 90, async s => {
  s.watch = ['stone_pickaxe', 'cobblestone'];
  await s.reset(); await s.cmd(fill(4, FLOOR + 1, -HALF, 6, SKY, HALF, 'stone')); await s.give({ stone_pickaxe: 1 });
  await s.settle([[5, FLOOR + 1, 0, 'stone']]);
  const run = await s.act('go', { hands: [{ do: 'go', to: cellAt(10, FLOOR + 1, 0), canDig: ['stone'], maxDig: 20, seconds: 60 }] });
  s.expectOk(run); s.expectHostRestored(run);
  const x = run.to?.[0] ?? 0;
  s.check('server: the body is past the wall (x > 7)', x > 7, `x=${x}`);
  s.check('go dug the wall (掘 >= 2)', (run.goDug ?? 0) >= 2, `掘 ${run.goDug}`);
  s.check('server: the wall has a hole at the feet row', [4, 5, 6].every(wx => blockName(wx, FLOOR + 1, 0) === 'air'), [4, 5, 6].map(wx => blockName(wx, FLOOR + 1, 0)).join(','));
});
scene('go_bridge_gap', 'go: across a 3-wide gap (canPlace cobblestone)', 90, async s => {
  s.watch = ['cobblestone'];
  await s.reset(); await s.cmd(fill(3, 95, -HALF, 5, FLOOR, HALF, 'air')); await s.give({ cobblestone: 16 });
  await s.settle([[4, FLOOR, 0, 'air']]);
  const run = await s.act('go', { hands: [{ do: 'go', to: cellAt(9, FLOOR + 1, 0), canPlace: ['cobblestone'], maxPlace: 10, seconds: 60 }] });
  s.expectOk(run); s.expectHostRestored(run);
  const x = run.to?.[0] ?? 0;
  s.check('server: the body is across the gap (x > 8)', x > 8, `x=${x}`);
  s.check('go laid blocks (置 >= 3)', (run.goPlaced ?? 0) >= 3, `置 ${run.goPlaced}`);
  const laid = countBlocks('cobblestone', { x0: 3, y0: 95, z0: -3, x1: 5, y1: FLOOR + 1, z1: 3 });
  s.check('server: cobblestone stands in the gap', laid >= 3, `${laid} cobblestone in the gap area`);
});
scene('go_around_cliff', 'go: round a cliff to a goal behind it (no digging, no laying)', 90, async s => {
  s.watch = ['cobblestone'];
  await s.reset(); await s.cmd(fill(3, FLOOR + 1, -HALF, 8, FLOOR + 6, 8, 'stone'));
  await s.settle([[5, FLOOR + 2, 0, 'stone']]);
  const run = await s.act('go', { hands: [{ do: 'go', to: cellAt(12, FLOOR + 1, 0), seconds: 60 }] });
  s.expectOk(run); s.expectHostRestored(run);
  const p = run.to ?? [0, 0, 0];
  s.check('server: the body is at the goal (within 1.5)', Math.hypot(p[0] - 12.5, p[2] - 0.5) <= 1.5 && p[1] < FLOOR + 2, `at ${p.map(n => Math.round(n * 10) / 10)}`);
  s.check('go dug and laid nothing', (run.goDug ?? 0) === 0 && (run.goPlaced ?? 0) === 0, `掘 ${run.goDug} 置 ${run.goPlaced}`);
});

// What go left behind meets the plain hands again: the same scenes, after the gos.
scene('place_table_after_go', 'place: a crafting table (after the go scenes)', 60, placeTableScene('after'));
scene('make_pickaxe_after_go', 'make: a wooden pickaxe (after the go scenes)', 60, makePickaxeScene('after'));
scene('pillar3_after_go', 'pillarUp: three levels (after the go scenes)', 60, pillarScene('after'));

scene('mine_iron', 'mine: four of six joined iron_ore (stone pickaxe)', 90, async s => {
  s.watch = ['raw_iron', 'iron_ore'];
  await s.reset(); await s.give({ stone_pickaxe: 1 });
  for (const y of [FLOOR + 1, FLOOR + 2]) for (const x of [6, 7, 8]) await s.cmd(`setblock ${x} ${y} 0 minecraft:iron_ore`);
  await s.settle([[8, FLOOR + 2, 0, 'iron_ore']]);
  const run = await s.act('mine', { hands: [{ do: 'mine', block: 'iron_ore', at: [cellAt(6, FLOOR + 1, 0)], count: 4 }] });
  s.expectOk(run);
  s.check('server: 4 raw_iron in the pack', (run.packDelta.raw_iron ?? 0) >= 4, JSON.stringify(run.packDelta));
  await sleep(500);
  const left = countBlocks('iron_ore', { x0: 5, y0: FLOOR + 1, z0: -1, x1: 9, y1: FLOOR + 3, z1: 1 });
  s.check('server: two iron_ore are left of the six', left === 2, `${left} left`);
});
scene('smelt_load', 'smelt: eight raw_iron and two coal into a furnace', 90, async s => {
  s.watch = ['raw_iron', 'coal', 'furnace'];
  await s.reset(); await s.cmd(`setblock 3 ${FLOOR + 1} 0 minecraft:furnace`); await s.give({ raw_iron: 8, coal: 2 });
  await s.settle([[3, FLOOR + 1, 0, 'furnace']]);
  const run = await s.act('smelt', { hands: [{ do: 'smelt', items: [{ item: 'raw_iron', count: 8 }], fuel: 'coal', fuelCount: 2, at: [cellAt(3, FLOOR + 1, 0)] }] });
  s.expectOk(run);
  const data = await s.cmd(`data get block 3 ${FLOOR + 1} 0`);
  s.notes.push(`furnace: ${data.replace(/\s+/gu, ' ').slice(0, 300)}`);
  s.check('server: the furnace holds the raw_iron', /raw_iron/u.test(data) || /iron_ingot/u.test(data), data.replace(/\s+/gu, ' ').slice(0, 120));
  s.check('pack: the raw_iron left the pack', (run.packDelta.raw_iron ?? 0) <= -1, JSON.stringify(run.packDelta));
  s.check('pack: coal was put in as fuel', (run.packDelta.coal ?? 0) <= -1, JSON.stringify(run.packDelta));
});
scene('obsidian', 'obsidian: a lava pool made into one obsidian with the water bucket (diamond pickaxe)', 150, async s => {
  s.watch = ['obsidian', 'water_bucket', 'bucket', 'cobblestone'];
  await s.reset(); await s.cmd(fill(6, FLOOR, -1, 8, FLOOR, 1, 'lava'));
  await s.give({ water_bucket: 1, diamond_pickaxe: 1, cobblestone: 8 });
  await s.settle([[7, FLOOR, 0, 'lava']]);
  const run = await s.act('obsidian', { hands: [{ do: 'obsidian', at: [cellAt(6, FLOOR, 0)], count: 1, canPlace: ['cobblestone'], maxPlace: 6 }] });
  s.expectOk(run);
  s.check('server: an obsidian is in the pack', (run.packDelta.obsidian ?? 0) >= 1, JSON.stringify(run.packDelta));
  s.check('server: the water bucket is back in the pack (not left as water)', (run.packDelta.water_bucket ?? 0) === 0 && (run.packDelta.bucket ?? 0) === 0, JSON.stringify(run.packDelta));
  s.check('the body did not burn (hp stayed)', (run.hp ?? 0) >= 12, `hp ${run.hp}`);
});

// The run-40 regression: go, then place / dig / make / pillarUp as acts of their own (each with its own motor port).
const CHAIN_KIT = { stone_pickaxe: 1, cobblestone: 24, crafting_table: 1, oak_planks: 5 };
async function chainWorld(s: Scene): Promise<void> {
  await s.reset(); await s.cmd(fill(4, FLOOR + 1, -HALF, 6, SKY, HALF, 'stone')); await s.cmd(fill(9, 95, -HALF, 11, FLOOR, HALF, 'air'));
  await s.give(CHAIN_KIT); await s.settle([[5, FLOOR + 1, 0, 'stone'], [10, FLOOR, 0, 'air']]);
}
const GO_CHAIN = { do: 'go', to: cellAt(14, FLOOR + 1, 0), canDig: ['stone'], canPlace: ['cobblestone'], maxDig: 20, maxPlace: 12, seconds: 90 };
scene('regress_go_then_acts', 'regression: go (dig + bridge), then place, dig, make, pillarUp as separate acts', 200, async s => {
  s.watch = ['cobblestone', 'wooden_pickaxe', 'crafting_table', 'oak_planks', 'stick'];
  await chainWorld(s);
  const go = await s.act('1 go', { hands: [GO_CHAIN] }, 120);
  s.expectOk(go); s.expectHostRestored(go);
  s.check('go dug (掘 > 0)', (go.goDug ?? 0) > 0, `掘 ${go.goDug}`);
  s.check('go laid (置 > 0)', (go.goPlaced ?? 0) > 0, `置 ${go.goPlaced}`);
  const placeRun = await s.act('2 place', { hands: [{ do: 'place', block: 'cobblestone', at: [cellAt(15, FLOOR + 1, 0)] }] }, 40);
  s.expectOk(placeRun);
  await sleep(400);
  s.check('server: the cobblestone stands at (15,100,0)', blockName(15, FLOOR + 1, 0) === 'cobblestone', `the block there is ${blockName(15, FLOOR + 1, 0)}`);
  const digRun = await s.act('3 dig', { hands: [{ do: 'dig', at: [cellAt(15, FLOOR + 1, 0)] }] }, 40);
  s.expectOk(digRun);
  await sleep(400);
  s.check('server: the cobblestone at (15,100,0) is gone', blockName(15, FLOOR + 1, 0) === 'air', `the block there is ${blockName(15, FLOOR + 1, 0)}`);
  const make = await s.act('4 make', { hands: [{ do: 'make', item: 'wooden_pickaxe' }] }, 60);
  s.expectOk(make);
  s.check('server: wooden_pickaxe made', (make.packDelta.wooden_pickaxe ?? 0) >= 1, JSON.stringify(make.packDelta));
  const pillar = await s.act('5 pillarUp', { hands: [{ do: 'pillarUp', n: 2, block: 'cobblestone' }] }, 60);
  s.expectOk(pillar);
  const y = pillar.to?.[1] ?? 0;
  s.check('server: two levels up after the pillar', y >= FLOOR + 2.9, `y=${y}`);
});
scene('regress_one_act', 'the same chain as ONE act (hands share the act\'s one port)', 200, async s => {
  s.watch = ['cobblestone', 'wooden_pickaxe', 'crafting_table', 'oak_planks', 'stick'];
  await chainWorld(s);
  const run = await s.act('go+place+dig+make+pillarUp', { hands: [GO_CHAIN,
    { do: 'place', block: 'cobblestone', at: [cellAt(15, FLOOR + 1, 0)] }, { do: 'dig', at: [cellAt(15, FLOOR + 1, 0)] },
    { do: 'make', item: 'wooden_pickaxe' }, { do: 'pillarUp', n: 2, block: 'cobblestone' }] }, 180);
  s.expectOk(run); s.expectHostRestored(run);
  s.check('go dug and laid', (run.goDug ?? 0) > 0 && (run.goPlaced ?? 0) > 0, `掘 ${run.goDug} 置 ${run.goPlaced}`);
  s.check('server: wooden_pickaxe made', (run.packDelta.wooden_pickaxe ?? 0) >= 1, JSON.stringify(run.packDelta));
  s.check('server: two levels up at the end', (run.to?.[1] ?? 0) >= FLOOR + 2.9, `y=${run.to?.[1]}`);
});
scene('place_after_chain', 'place: a crafting table once more, after the chains', 60, placeTableScene('after'));

scene('fight_zombie', 'fight: one zombie with an iron sword', 90, async s => {
  await s.reset({ difficulty: 'normal', time: 'midnight' });
  await s.give({ iron_sword: 1, cooked_beef: 8 });
  await s.cmd(`summon minecraft:zombie 8.5 ${FLOOR + 1} 0.5`);
  await s.cmd('item replace entity @e[type=minecraft:zombie,limit=1,sort=nearest] armor.head with minecraft:leather_helmet');
  await s.settle();
  const alive = await s.cmd('execute if entity @e[type=minecraft:zombie]');
  s.notes.push(`zombie alive before: ${/Test passed/u.test(alive)}`);
  const run = await s.act('fight', { hands: [{ do: 'fight', target: 'zombie', seconds: 40 }] });
  s.expectOk(run);
  const after = await s.cmd('execute if entity @e[type=minecraft:zombie]');
  s.check('server: the zombie is dead', !/Test passed/u.test(after), after.replace(/\s+/gu, ' ').slice(0, 100));
  s.check('the body lived (hp > 0)', (run.hp ?? 0) > 0 && deaths === s.deathsAtStart, `hp ${run.hp}, deaths ${deaths - s.deathsAtStart}`);
});
scene('portal', 'portal: ten obsidian, flint and steel, into the Nether', 150, async s => {
  s.watch = ['obsidian', 'flint_and_steel', 'cobblestone'];
  await s.reset(); await s.give({ obsidian: 10, flint_and_steel: 1, cobblestone: 16 }); await s.settle();
  const run = await s.act('portal', { hands: [{ do: 'portal', at: [cellAt(6, FLOOR + 2, 6)], axis: 'x', enter: true, canPlace: ['cobblestone'], maxPlace: 12, seconds: 100 }] }, 140);
  s.expectOk(run);
  const end = Date.now() + 20_000;
  while (Date.now() < end && dimensionOf() !== 'the_nether') await sleep(300);
  const askNether = await s.cmd(`execute as ${ACTOR} at @s if dimension minecraft:the_nether`);
  s.check('the body is in the Nether (dimension changed)', dimensionOf() === 'the_nether' && /Test passed/u.test(askNether), `client ${dimensionOf()}, server ${askNether.replace(/\s+/gu, ' ').slice(0, 60)}`);
  const frame = countBlocks('obsidian', { x0: 5, y0: FLOOR + 1, z0: 6, x1: 8, y1: FLOOR + 6, z1: 6 });
  const lit = countBlocks('nether_portal', { x0: 6, y0: FLOOR + 2, z0: 6, x1: 7, y1: FLOOR + 4, z1: 6 });
  s.check('server: the frame stands (10 obsidian) and burns', frame === 10 && lit >= 1, `${frame} obsidian, ${lit} portal blocks`);
  const left = (await packServer(["obsidian"])).obsidian ?? 0;
  s.notes.push(`obsidian left in the pack: ${left}`);
  // The way back is a command: the lab is not a trip.
  await s.cmd(`execute in minecraft:overworld run tp ${ACTOR} 0.5 ${FLOOR + 1} 0.5`);
});

// ---- run -----------------------------------------------------------------------------------------------------------------------------------
const wanted = (process.env.MINECRAFT_HANDS_SCENES ?? '').split(',').map(name => name.trim()).filter(Boolean);
const chosen = scenes.filter(entry => !wanted.length || wanted.some(name => entry.name === name || entry.name.startsWith(name)));
const reports: SceneReport[] = [];
const startedAll = Date.now();
let fatal: string | undefined;
try {
  await ask('say hands live probe ready');
  const rule = await ask('gamerule spawn_mobs false');
  log(`SETUP gamerule spawn_mobs: ${rule.replace(/\s+/gu, ' ').slice(0, 100)}`);
  for (const command of ['gamemode spectator ShannonProbe', 'tp ShannonProbe 0 130 0', 'time set day', 'weather clear']) await ask(command);
  await sleep(3000);
  for (const entry of chosen) {
    if (disconnected) { log(`SKIP ${entry.name}: ${disconnected}`); break; }
    const s = new Scene(entry.name, entry.title, entry.seconds);
    const startedAt = Date.now(), startedIso = new Date(startedAt).toISOString();
    log(`SCENE ${entry.name} begins: ${entry.title}`);
    try {
      await Promise.race([entry.run(s), sleep((sceneSeconds || entry.seconds) * 1000 * 3 + 60_000).then(() => { throw new Error('SCENE_TIMEOUT'); })]);
    } catch (error) {
      s.check('the scene ran to its end', false, String((error as Error)?.message ?? error).slice(0, 300));
      actor.interruptExecution = true; actor.pathfinder?.stop(); actor.clearControlStates?.();
      await sleep(1500); actor.interruptExecution = false;
    }
    const report = s.report(startedAt, startedIso);
    reports.push(report);
    console.log(`HANDS_SCENE ${JSON.stringify(report)}`);
    log(`SCENE ${entry.name} ${report.passed ? 'PASSED' : 'FAILED'} (${(report.ms / 1000).toFixed(1)}s) ${report.checks.filter(check => !check.passed).map(check => `${check.name} [${check.detail ?? ''}]`).join('; ')}`);
  }
} catch (error) {
  fatal = String((error as Error)?.stack ?? error).slice(0, 800);
  log(`FATAL ${fatal}`);
  process.exitCode = 1;
} finally {
  const failed = reports.filter(report => !report.passed).map(report => report.name);
  const summary = { passed: failed.length === 0 && reports.length === chosen.length && !fatal, scenes: reports.length, planned: chosen.length, failed, deaths,
    durationMs: Date.now() - startedAll, disconnected, fatal, port, worldDirectory };
  const table = ['| scene | result | s | acts | what the server says / why it failed |', '| --- | --- | --- | --- | --- |']
    .concat(reports.map(report => `| ${report.name} | ${report.passed ? 'PASS' : 'FAIL'} | ${(report.ms / 1000).toFixed(0)} | ${report.acts.map(run => `${run.label}:${run.ok ? 'ok' : 'no'}${run.actMs !== null ? ` ${(run.actMs / 1000).toFixed(1)}s` : ''}`).join(', ')} | `
      + `${(report.passed ? report.checks.map(check => check.name) : report.checks.filter(check => !check.passed).map(check => `${check.name} [${check.detail ?? ''}]`)).join('; ').replace(/\|/gu, '/')} |`));
  console.log('HANDS_TABLE_BEGIN');
  console.log(table.join('\n'));
  console.log('HANDS_TABLE_END');
  console.log(`HANDS_RESULT ${JSON.stringify(summary)}`);
  if (reportFile) { try { fs.writeFileSync(reportFile, JSON.stringify({ summary, scenes: reports }, null, 2), { mode: 0o600 }); } catch (error) { log(`REPORT_WRITE_FAILED ${String(error)}`); } }
  if (!summary.passed) process.exitCode = 1;
  try { await body.dispose(); } catch { /* the lab is closing */ }
  closeProbeBot(actor); closeProbeBot(operator);
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
}
