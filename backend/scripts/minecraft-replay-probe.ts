#!/usr/bin/env node
// Model-free replay of a paid run's acts on its own ground: the world the run left, copied into an isolated lab and put back (cell by
// cell, /setblock) to the moment of the act (lab/run-ground.py), the body placed where it stood, with what it held, and the SAME act
// (the same arguments, from the run's ops) sent through the production body's road: NativeCommonFcaBody.execute for the skill `act`.
// What the act says is compared with what the paid run's act said (the code, the seconds, the steps, digs, places and redraws).
//
// While the act runs, every route search is traced (mineflayer-pathfinder's getPathFromTo and the executor's path_update): its goal,
// its time limit, the status it ended with (success / partial / timeout / noPath), the nodes it looked at, the time it took and the
// time spent in the movements' getNeighbors. The body's position is traced every tick (feet, vertical speed, on the ground). After the
// act, a case may ask for the same search again from the same place with longer limits (`search`), to tell "no way" from "no time".
//
// Env (set by scripts/lab/run-replay.sh; the lab is isolated and loopback, no model and no paid API is reachable):
//   MINECRAFT_REPLAY_NO_LLM=true  MINECRAFT_REPLAY_PORT=<25570..25599>  MINECRAFT_REPLAY_WORLD_DIRECTORY=/home/azureuser/minecraft/progressive-lab-XXXX
//   MINECRAFT_REPLAY_CASES=<cases.json>  MINECRAFT_REPLAY_ONLY=c1220,c135  MINECRAFT_REPLAY_REPORT=<file>
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { Vec3 } from 'vec3';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { NativeCommonFcaBody } from '../src/services/minebot/integration/commonFca/nativeBody.js';
import { ensureReflexLedger } from '../src/services/minebot/utils/reflexLedger.js';
import { installIncidents } from '../src/services/minebot/utils/incidents.js';
import { SceneSaver } from '../src/services/minebot/utils/sceneSave.js';

const port = Number(process.env.MINECRAFT_REPLAY_PORT);
const worldDirectory = process.env.MINECRAFT_REPLAY_WORLD_DIRECTORY ?? '';
if (process.env.MINECRAFT_REPLAY_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25570 || port > 25599
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory)) throw new Error('ISOLATED_REPLAY_WORLD_REQUIRED');
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GOOGLE_API_KEY', 'GEMINI_API_KEY']) {
  if (process.env[key]) throw new Error(`REPLAY_PROBE_REFUSES_PAID_KEY:${key}`);
}
if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'offline-test-not-used') throw new Error('REPLAY_PROBE_REFUSES_PAID_KEY:OPENAI_API_KEY');
const properties = fs.readFileSync(path.join(worldDirectory, 'server.properties'), 'utf8').split('\n');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${port}`) || !properties.includes('online-mode=false')) throw new Error('ISOLATED_REPLAY_WORLD_CONFIGURATION_INVALID');

interface Item { slot: string; id: string; count: number; damage?: number }
/**
 * `before`: server commands just before the act is sent (run 43's drowned: a creature summoned beside the body); `during`: commands at ms after it is sent
 * (one killed, as the run's target went out of sight). The act's health and the body's reflexes (its ledger) are kept for these.
 */
interface CaseAct { label: string; arguments: Record<string, unknown>; seconds: number; delayMs?: number; replaceActor?: boolean; expect?: { line?: string; ms?: number; code?: string; outcome?: string };
  before?: string[]; during?: Array<{ ms: number; cmd: string }> }
interface Case {
  name: string; title: string; forceload: [number, number, number, number]; restore: Array<[number, number, number, string]>;
  actor: { pos: [number, number, number]; yaw?: number; pitch?: number; health?: number; food?: number; items: Item[] };
  time?: number; difficulty?: string; acts: CaseAct[]; watch?: Array<[number, number, number]>;
  /** A case started from a scene (scripts/lab/scene-case.py): the creatures and items of the world are the scene's, so nothing is killed first. */
  keepEntities?: boolean;
  search?: { timeouts: number[]; variants?: number };
}
const cases: Case[] = JSON.parse(fs.readFileSync(process.env.MINECRAFT_REPLAY_CASES ?? '', 'utf8'));
const only = (process.env.MINECRAFT_REPLAY_ONLY ?? '').split(',').map(name => name.trim()).filter(Boolean);
const chosen = cases.filter(entry => !only.length || only.includes(entry.name));
const reportFile = process.env.MINECRAFT_REPLAY_REPORT ?? '';
const ACTOR = 'I_am_Shannon';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (text: string) => console.log(`[${stamp()}] ${text}`);

const operator: any = await createProbeBot(port);
const actor: any = await createProbeBot(port, ACTOR);
// 2026-10-28: the replayed acts write the black box as production does (MINEBOT_BLACKBOX_DIR), and with MINECRAFT_REPLAY_SCENES=on a heavy failure
// also saves the scene of the lab's world (to start a replay from it, `scene-case.py`).
installIncidents(actor, { holdFile: path.join(process.env.MINECRAFT_REPLAY_OUT ?? '/tmp', 'replay-hold.json'),
  scene: process.env.MINECRAFT_REPLAY_SCENES === 'on' ? new SceneSaver({ command: (text, timeoutMs) => ask(text, timeoutMs), serverDir: worldDirectory,
    root: path.join(process.env.MINECRAFT_REPLAY_OUT ?? '/tmp', 'scenes'), ignore: [ACTOR, 'ShannonProbe'] }) : null });
const body = new NativeCommonFcaBody(actor, { serverId: 'replay-probe', capture: async () => { throw new Error('no picture in the lab'); }, rendererConfigured: () => false });
let deaths = 0, disconnected: string | null = null;
const chat: Array<{ t: number; text: string }> = [];
actor.on('death', () => { deaths++; log('ACTOR_DEATH'); });
actor.on('end', (reason: unknown) => { disconnected ??= `end:${String(reason)}`; });
actor.on('kicked', (reason: unknown) => { disconnected ??= `kicked:${JSON.stringify(reason).slice(0, 200)}`; });
operator.on('end', (reason: unknown) => { disconnected ??= `operator-end:${String(reason)}`; });
operator.on('message', (message: any) => { const text = String(message?.toString?.() ?? ''); if (/I_am_Shannon|suffocat|died|fell|drown/u.test(text)) chat.push({ t: Date.now(), text: text.slice(0, 200) }); });

async function ask(command: string, timeoutMs = 10_000): Promise<string> {
  const marker = `REPLAYASK_${randomUUID().split('-').join('').slice(0, 10)}`;
  const seen: string[] = [];
  const answer = await new Promise<string>(resolve => {
    let timer: NodeJS.Timeout | undefined;
    const done = (suffix = '') => { if (timer) clearTimeout(timer); operator.removeListener('message', listener as never); resolve(seen.join('\n') + suffix); };
    const listener = (message: unknown) => { const text = String((message as any)?.toString?.() ?? ''); if (text.includes(marker)) done(); else seen.push(text); };
    timer = setTimeout(() => done('\n[timeout]'), timeoutMs);
    operator.on('message', listener as never);
    operator.chat(`/${command}`);
    operator.chat(`/tellraw @s ${JSON.stringify({ text: marker })}`);
  });
  await sleep(120);
  return answer;
}
const BAD = /Unknown or incomplete|Incorrect argument|Expected|Invalid|Could not|Unrecognized|\[timeout\]/u;

// ---- the traces ----------------------------------------------------------------------------------------------------------------------
interface SearchTrace { atMs: number; via: string; goal: string; timeout: number | null; from: number[]; status: string; visited: number; generated: number; ms: number;
  cost: number | null; pathLength: number; pathEnd: number[] | null; toBreak: number; toPlace: number; neighborMs: number; neighborCalls: number; chunks: number }
let actStarted = 0;
let searches: SearchTrace[] = [];
/** The movements and goals the act's own searches were given (the first ones are drawn again, with longer limits, after the act). */
let captured: Array<{ movements: any; goal: any }> = [];
const nav = actor.pathfinder;
const originalFromTo = nav.getPathFromTo.bind(nav);
const goalText = (goal: any): string => {
  try {
    const name = goal?.constructor?.name ?? '?';
    if (Array.isArray(goal?.goals)) return `${name}[${goal.goals.map(goalText).join(';')}]`;
    const keys = ['x', 'y', 'z', 'rangeSq', 'range'].filter(key => typeof goal?.[key] === 'number').map(key => `${key}=${Math.round(goal[key] * 100) / 100}`);
    return `${name}(${keys.join(',')})`;
  } catch { return '?'; }
};
nav.getPathFromTo = function* (movements: any, startPos: any, goal: any, options: any = {}) {
  if (!movements.__replayTimer) {
    const inner = movements.getNeighbors;
    movements.__replayTimer = { ms: 0, calls: 0 };
    movements.getNeighbors = function (node: any) {
      const t = performance.now();
      try { return inner.call(this, node); } finally { movements.__replayTimer.ms += performance.now() - t; movements.__replayTimer.calls++; }
    };
  }
  const timer = movements.__replayTimer; const ms0 = timer.ms, calls0 = timer.calls;
  const record: SearchTrace = { atMs: Date.now() - actStarted, via: 'getPathFromTo', goal: goalText(goal), timeout: options?.timeout ?? null,
    from: [startPos.x, startPos.y, startPos.z].map((v: number) => Math.round(v * 100) / 100), status: 'begun', visited: 0, generated: 0, ms: 0, cost: null,
    pathLength: 0, pathEnd: null, toBreak: 0, toPlace: 0, neighborMs: 0, neighborCalls: 0, chunks: 0 };
  searches.push(record);
  if (actStarted) captured.push({ movements, goal });
  const inner = originalFromTo(movements, startPos, goal, options);
  for (;;) {
    const step = inner.next();
    if (step.done) return step.value;
    const result = step.value?.result;
    if (result) {
      record.status = String(result.status); record.visited = result.visitedNodes ?? 0; record.generated = result.generatedNodes ?? 0; record.ms = Math.round(result.time ?? 0);
      record.cost = typeof result.cost === 'number' ? Math.round(result.cost * 10) / 10 : null; record.pathLength = result.path?.length ?? 0;
      const end = result.path?.[result.path.length - 1]; record.pathEnd = end ? [end.x, end.y, end.z] : null;
      record.toBreak = (result.path ?? []).reduce((sum: number, node: any) => sum + (node?.toBreak?.length ?? 0), 0);
      record.toPlace = (result.path ?? []).reduce((sum: number, node: any) => sum + (node?.toPlace?.length ?? 0), 0);
      record.neighborMs = Math.round(timer.ms - ms0); record.neighborCalls = timer.calls - calls0; record.chunks = step.value?.astarContext?.visitedChunks?.size ?? 0;
    }
    yield step.value;
  }
};
actor.on('path_update', (result: any) => {
  if (!actStarted) return;
  const last = searches[searches.length - 1];
  searches.push({ atMs: Date.now() - actStarted, via: 'path_update', goal: last?.goal ?? '?', timeout: null, from: [], status: String(result?.status), visited: result?.visitedNodes ?? 0,
    generated: result?.generatedNodes ?? 0, ms: Math.round(result?.time ?? 0), cost: null, pathLength: result?.path?.length ?? 0,
    pathEnd: result?.path?.length ? [result.path[result.path.length - 1].x, result.path[result.path.length - 1].y, result.path[result.path.length - 1].z] : null,
    toBreak: 0, toPlace: 0, neighborMs: 0, neighborCalls: 0, chunks: 0 });
});
actor.on('path_reset', (reason: unknown) => { if (actStarted) searches.push({ atMs: Date.now() - actStarted, via: `path_reset:${String(reason)}`, goal: '', timeout: null, from: [], status: '', visited: 0, generated: 0, ms: 0, cost: null, pathLength: 0, pathEnd: null, toBreak: 0, toPlace: 0, neighborMs: 0, neighborCalls: 0, chunks: 0 }); });
let motion: Array<[number, number, number, number, number, number]> = [];
actor.on('physicsTick', () => {
  if (!actStarted) return;
  const p = actor.entity?.position, v = actor.entity?.velocity;
  if (p && motion.length < 20000) motion.push([Date.now() - actStarted, Math.round(p.x * 100) / 100, Math.round(p.y * 1000) / 1000, Math.round(p.z * 100) / 100, Math.round((v?.y ?? 0) * 1000) / 1000, actor.entity?.onGround ? 1 : 0]);
});

// ---- the case ------------------------------------------------------------------------------------------------------------------------
const slotOf = (slot: string) => /^\d+$/u.test(slot) ? `container.${slot}` : slot; // 0-35 container.N; armor.head, armor.chest, armor.legs, armor.feet, weapon.offhand
async function placeActor(c: Case, warnings: string[]): Promise<void> {
  const [x, y, z] = c.actor.pos;
  for (const command of [`gamemode survival ${ACTOR}`, `clear ${ACTOR}`, `effect clear ${ACTOR}`, `execute in minecraft:overworld run tp ${ACTOR} ${x} ${y} ${z} ${c.actor.yaw ?? 0} ${c.actor.pitch ?? 0}`]) {
    const answer = await ask(command); if (BAD.test(answer)) warnings.push(`${command} => ${answer.slice(0, 120)}`);
  }
  for (const item of c.actor.items) {
    const component = item.damage ? `[damage=${item.damage}]` : '';
    const command = `item replace entity ${ACTOR} ${slotOf(item.slot)} with minecraft:${item.id}${component} ${item.count}`;
    const answer = await ask(command); if (BAD.test(answer)) warnings.push(`${command} => ${answer.slice(0, 120)}`);
  }
  await ask(`effect give ${ACTOR} minecraft:instant_health 1 10 true`);
  await sleep(600);
  const hp = c.actor.health ?? 20;
  if (hp < 20) { const answer = await ask(`damage ${ACTOR} ${20 - hp} minecraft:generic`); if (BAD.test(answer)) warnings.push(`damage => ${answer.slice(0, 120)}`); }
  actor.pathfinder?.stop(); actor.clearControlStates?.();
}
async function settle(c: Case, warnings: string[]): Promise<void> {
  const [x, y, z] = c.actor.pos;
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const p = actor.entity?.position;
    const near = p && Math.abs(p.x - x) < 0.6 && Math.abs(p.z - z) < 0.6 && Math.abs(p.y - y) < 1.2;
    const seen = (c.watch ?? []).every(([wx, wy, wz]) => !!actor.blockAt(new Vec3(wx, wy, wz)));
    if (near && seen && actor.entity.onGround) { await sleep(1500); return; }
    await sleep(200);
  }
  warnings.push(`settle: actor at ${JSON.stringify(actor.entity?.position)} onGround=${actor.entity?.onGround} after 20 s`);
}
const lineOf = (parsed: any) => (Array.isArray(parsed?.lines) ? parsed.lines : []).map((line: any) => `${line.i}.${line.do} ${line.status}: ${String(line.line)}`);
const counts = (text: string) => {
  const m = /道 (\d+) 歩・掘 (\d+)・置 (\d+)・引き直し (\d+) 回/u.exec(text);
  return m ? { steps: Number(m[1]), dug: Number(m[2]), placed: Number(m[3]), redraws: Number(m[4]) } : null;
};
const codeOf = (text: string) => /go 止まった (\w+)/u.exec(text)?.[1] ?? (/stuck|dead_end|limit_\w+|no_\w+/u.exec(text)?.[0] ?? '');

const reports: any[] = [];
try {
  await ask('gamerule spawn_mobs false');
  for (const command of ['gamemode spectator ShannonProbe', 'weather clear']) await ask(command);
  for (const c of chosen) {
    if (disconnected) { log(`SKIP ${c.name}: ${disconnected}`); break; }
    const warnings: string[] = []; const started = Date.now();
    log(`CASE ${c.name}: ${c.title}`);
    await ask(`difficulty ${c.difficulty ?? 'normal'}`);
    await ask(`time set ${c.time ?? 6000}`);
    const [fx0, fz0, fx1, fz1] = c.forceload;
    const fl = await ask(`forceload add ${fx0} ${fz0} ${fx1} ${fz1}`); if (BAD.test(fl)) warnings.push(`forceload => ${fl.slice(0, 120)}`);
    await ask(`tp ShannonProbe ${c.actor.pos[0]} ${c.actor.pos[1] + 3} ${c.actor.pos[2]}`);
    if (!c.keepEntities) await ask('kill @e[type=!minecraft:player]');
    await sleep(3000);
    // Every block the case changes (its own /setblock of the ground, then the body's digs and lays) is noted as it was, and put back after the case:
    // the next case meets the ground as staged.
    const changed = new Map<string, string>();
    const stateText = (block: any) => { try { const props = block.getProperties?.() ?? {}; const keys = Object.keys(props).sort(); return `${block.name}${keys.length ? `[${keys.map(key => `${key}=${props[key]}`).join(',')}]` : ''}`; } catch { return String(block?.name ?? 'air'); } };
    const onChange = (before: any, after: any) => { const p = after?.position ?? before?.position; if (!p) return; const key = `${p.x} ${p.y} ${p.z}`; if (!changed.has(key) && before) changed.set(key, stateText(before)); };
    operator.on('blockUpdate', onChange);
    // the ground at the moment: the lowest cells first (what falls is laid on what holds it)
    const restore = [...c.restore].sort((a, b) => a[1] - b[1]);
    let restored = 0;
    for (const [x, y, z, state] of restore) {
      const answer = await ask(`setblock ${x} ${y} ${z} minecraft:${state}`);
      if (/Could not set the block/u.test(answer)) restored++; // already that block
      else if (BAD.test(answer)) warnings.push(`setblock ${x} ${y} ${z} ${state} => ${answer.slice(0, 100)}`); else restored++;
    }
    if (!c.keepEntities) await ask('kill @e[type=minecraft:item]');
    await sleep(1500);
    const mismatch = restore.filter(([x, y, z, state]) => operator.blockAt(new Vec3(x, y, z))?.name !== state.split('[')[0]).map(cell => cell.join(' ')).slice(0, 20);
    log(`GROUND ${c.name}: ${restored}/${restore.length} cells set, ${mismatch.length} not as asked ${mismatch.slice(0, 5).join(' | ')}`);
    await placeActor(c, warnings);
    await settle(c, warnings);
    const acts: any[] = [];
    for (const act of c.acts) {
      if (disconnected) break;
      if (act.delayMs) await sleep(act.delayMs); // the pause the paid run had before this act (its judgment)
      if (act.replaceActor) { await placeActor(c, warnings); await settle(c, warnings); } // the body put back where the case begins
      searches = []; motion = [];
      const id = `replay-${c.name}-${act.label}`;
      const command: any = { schemaVersion: 1, id, serverId: 'replay-probe', connectionId: 'replay', kind: 'skill', skill: 'act', arguments: act.arguments,
        context: { scopeKey: 'replay', taskId: 'replay-task', taskRevision: 1, bodyId: 'minecraft:replay-probe', sessionId: 'replay-session', generation: 1, goal: 'replay', completionCondition: 'none' },
        lease: { id: 'replay-lease', generation: 1, holder: 'replay-task' }, deadlineAt: new Date(Date.now() + act.seconds * 1000).toISOString() };
      for (const command of act.before ?? []) { const answer = await ask(command); if (BAD.test(answer)) warnings.push(`${command} => ${answer.slice(0, 100)}`); }
      const ledger = ensureReflexLedger(actor);
      const ledgerMark = ledger.entriesSince(-1).at(-1)?.seq ?? -1;
      const healths: Array<[number, number]> = [];
      const onHealth = () => { if (actStarted) healths.push([Date.now() - actStarted, Math.round(Number(actor.health ?? 0) * 10) / 10]); };
      actor.on('health', onHealth);
      const timers = (act.during ?? []).map(({ ms, cmd }) => setTimeout(() => { void ask(cmd); }, ms));
      const from = actor.entity?.position?.clone();
      const controller = new AbortController();
      const watchdog = setTimeout(() => controller.abort('probe_watchdog'), (act.seconds + 30) * 1000);
      let receipt: any = null, error: string | undefined;
      actStarted = Date.now();
      try { receipt = await body.execute(command, controller.signal); } catch (thrown) { error = String((thrown as Error)?.message ?? thrown); }
      const wallMs = Date.now() - actStarted;
      clearTimeout(watchdog);
      for (const timer of timers) clearTimeout(timer);
      actor.removeListener('health', onHealth);
      const reflexes = ledger.entriesSince(ledgerMark).map(entry => ({ atMs: entry.at - actStarted, kind: entry.kind, outcome: entry.outcome, detail: entry.detail.slice(0, 160) }));
      const near = (Object.values(actor.entities ?? {}) as any[]).filter(e => e !== actor.entity && e?.position && e.type !== 'player' && e.name !== 'item' && actor.entity?.position && e.position.distanceTo(actor.entity.position) <= 16)
        .map(e => `${e.name}#${e.id}@${e.position.distanceTo(actor.entity.position).toFixed(1)}m`);
      if (reflexes.length || healths.length || act.before || act.during) log(`BODY ${c.name}/${act.label}: health ${healths.map(([t, h]) => `${(t / 1000).toFixed(1)}s:${h}`).join(' ')} reflexes ${reflexes.map(r => `${(r.atMs / 1000).toFixed(1)}s ${r.kind}/${r.outcome}`).join(' ') || 'none'} near ${near.join(' ') || 'none'}`);
      await sleep(800);
      actStarted = 0;
      let parsed: any = null; try { parsed = JSON.parse(receipt?.result ?? ''); } catch { parsed = null; }
      const lines = lineOf(parsed);
      const stopLine = lines.find((line: string) => / stopped: /u.test(line)) ?? lines.at(-1) ?? '';
      const got = { outcome: receipt?.outcome ?? 'threw', ms: parsed?.ms ?? null, code: codeOf(stopLine), counts: counts(stopLine), line: stopLine };
      const want = act.expect ? { ...act.expect, code: act.expect.code ?? codeOf(act.expect.line ?? ''), counts: counts(act.expect.line ?? '') } : null;
      const sameCode = !!want && got.code === want.code;
      const sameMs = !!want && typeof want.ms === 'number' && typeof got.ms === 'number' && Math.abs(got.ms - want.ms) <= Math.max(1500, want.ms * 0.1);
      const sameCounts = !!want && JSON.stringify(got.counts) === JSON.stringify(want.counts);
      log(`ACT ${c.name}/${act.label} ${((got.ms ?? wallMs) / 1000).toFixed(1)}s code=${got.code} (paid run: ${want?.code} ${((want?.ms ?? 0) / 1000).toFixed(1)}s) ${stopLine.slice(0, 220)}`);
      const plans = searches.filter(s => s.via === 'getPathFromTo');
      log(`SEARCHES ${c.name}/${act.label}: ${plans.length} drawn; ${plans.map(s => `${s.status}/${s.visited}n/${s.ms}ms/t${s.timeout}`).join(' ')}`);
      acts.push({ label: act.label, from: from ? [from.x, from.y, from.z] : null, to: actor.entity?.position ? [actor.entity.position.x, actor.entity.position.y, actor.entity.position.z] : null,
        hp: actor.health, food: actor.food, wallMs, healths, reflexes, got, want, same: { code: sameCode, ms: sameMs, counts: sameCounts }, lines, error, searches, motion: motion.filter((_, i) => i % 2 === 0 || i === motion.length - 1) });
    }
    // the same search again, from the same place, with longer limits: no way, or no time?
    const extra: any[] = [];
    if (c.search && !disconnected && captured.length) {
      const { movements, goal } = captured[0];
      for (const timeout of c.search.timeouts) {
        const t0 = performance.now(); const timer = movements.__replayTimer ?? { ms: 0, calls: 0 }; const ms0 = timer.ms, calls0 = timer.calls;
        let result: any = null, error: string | undefined;
        try {
          const generator = originalFromTo(movements, actor.entity.position, goal, { timeout });
          result = generator.next().value?.result;
          for (let rounds = 0; result?.status === 'partial' && rounds < 100000; rounds++) { await new Promise<void>(resolve => setImmediate(resolve)); result = generator.next().value?.result ?? result; }
        } catch (thrown) { error = String((thrown as Error)?.message ?? thrown).slice(0, 200); }
        const path = result?.path ?? [];
        const entry = { goal: goalText(goal), timeout, status: result?.status ?? 'error', visited: result?.visitedNodes ?? 0, ms: Math.round(performance.now() - t0), cost: result?.cost,
          pathLength: path.length, toBreak: path.reduce((sum: number, node: any) => sum + (node?.toBreak?.length ?? 0), 0), toPlace: path.reduce((sum: number, node: any) => sum + (node?.toPlace?.length ?? 0), 0),
          pathEnd: path.length ? [path[path.length - 1].x, path[path.length - 1].y, path[path.length - 1].z] : null, neighborMs: Math.round(timer.ms - ms0), neighborCalls: timer.calls - calls0,
          path: path.slice(0, 200).map((node: any) => [node.x, node.y, node.z, node.toBreak?.length ?? 0, node.toPlace?.length ?? 0]), error };
        extra.push(entry);
        log(`SEARCH_AGAIN ${c.name} timeout=${timeout}: ${entry.status} ${entry.visited} nodes ${entry.ms} ms cost=${entry.cost} path=${entry.pathLength} break=${entry.toBreak} place=${entry.toPlace} neighbors=${entry.neighborCalls}/${entry.neighborMs}ms ${error ?? ''}`);
        if (entry.status === 'success') break;
      }
    }
    // Where the search's time goes: the same first search for `variants` ms, with one cost taken away at a time (nodes looked at in that time).
    if (c.search?.variants && !disconnected && captured.length) {
      const { movements, goal } = captured[0];
      const { Movements } = (await import('mineflayer-pathfinder')).default as any;
      const host = actor;
      const toolOf = host.pathfinder.bestHarvestTool;
      const runVariant = async (name: string, m: any, prepare: () => () => void) => {
        const undo = prepare();
        const t0 = performance.now(); let result: any = null, error: string | undefined;
        try {
          const generator = originalFromTo(m, actor.entity.position, goal, { timeout: c.search!.variants });
          result = generator.next().value?.result;
          for (let rounds = 0; result?.status === 'partial' && rounds < 100000; rounds++) { await new Promise<void>(resolve => setImmediate(resolve)); result = generator.next().value?.result ?? result; }
        } catch (thrown) { error = String((thrown as Error)?.message ?? thrown).slice(0, 200); }
        finally { undo(); }
        const entry = { variant: name, status: result?.status ?? 'error', visited: result?.visitedNodes ?? 0, ms: Math.round(performance.now() - t0), cost: result?.cost, error };
        extra.push(entry);
        log(`VARIANT ${c.name} ${name}: ${entry.status} ${entry.visited} nodes in ${entry.ms} ms (${Math.round(entry.visited / Math.max(1, entry.ms) * 1000)} nodes/s) ${error ?? ''}`);
      };
      const memoTool = () => { const memo = new Map<string, unknown>(); host.pathfinder.bestHarvestTool = (block: any) => { const key = String(block?.stateId ?? block?.type); if (!memo.has(key)) memo.set(key, toolOf(block)); return memo.get(key); }; return () => { host.pathfinder.bestHarvestTool = toolOf; }; };
      const hostBot = (m: any) => () => { const before = m.bot; m.bot = host; return () => { m.bot = before; }; };
      await runVariant('go の movements のまま（act の port 経由）', movements, () => () => {});
      await runVariant('bot を体そのものに（port を外す）', movements, hostBot(movements));
      await runVariant('port を外し、道具選びを種類ごとに覚える', movements, () => { const a = hostBot(movements)(); const b = memoTool(); return () => { b(); a(); }; });
      await runVariant('上に加えて、ブロックの読みを覚える（探索の間）', movements, () => {
        const a = hostBot(movements)(); const b = memoTool();
        const getBlock = movements.getBlock; const memo = new Map<string, any>();
        movements.getBlock = function (pos: any, dx: number, dy: number, dz: number) { if (!pos) return getBlock.call(this, pos, dx, dy, dz); const key = `${pos.x + dx},${pos.y + dy},${pos.z + dz}`; let hit = memo.get(key); if (!hit) { hit = getBlock.call(this, pos, dx, dy, dz); memo.set(key, hit); } return hit; };
        return () => { movements.getBlock = getBlock; b(); a(); };
      });
      const plain = new Movements(host); plain.canDig = true; plain.allow1by1towers = false; plain.allowParkour = true;
      await runVariant('pathfinder の素の movements（掘る可、体の手の決まり無し）', plain, () => () => {});
    }
    captured = [];
    operator.removeListener('blockUpdate', onChange);
    await ask(`gamemode spectator ${ACTOR}`); // out of the way of the blocks put back (a body inside one suffocates)
    const back = [...changed.entries()].sort((a, b) => Number(a[0].split(' ')[1]) - Number(b[0].split(' ')[1]));
    for (const [cell, state] of back) await ask(`setblock ${cell} minecraft:${state}`);
    await ask('kill @e[type=minecraft:item]');
    log(`UNDO ${c.name}: ${back.length} cells the case changed are put back`);
    reports.push({ name: c.name, title: c.title, ms: Date.now() - started, warnings, acts, extra, deaths, chat: chat.splice(0), undone: back.length });
    console.log(`REPLAY_CASE ${JSON.stringify({ name: c.name, warnings, acts: acts.map(a => ({ label: a.label, got: a.got, want: a.want, same: a.same })) })}`);
    await ask(`forceload remove ${fx0} ${fz0} ${fx1} ${fz1}`);
  }
} catch (caught) {
  log(`FATAL ${String((caught as Error)?.stack ?? caught).slice(0, 800)}`);
  process.exitCode = 1;
} finally {
  if (reportFile) fs.writeFileSync(reportFile, JSON.stringify({ port, worldDirectory, deaths, disconnected, cases: reports }, null, 1), { mode: 0o600 });
  console.log(`REPLAY_RESULT ${JSON.stringify({ cases: reports.length, planned: chosen.length, deaths, disconnected })}`);
  try { await body.dispose(); } catch { /* closing */ }
  closeProbeBot(actor); closeProbeBot(operator);
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
}
