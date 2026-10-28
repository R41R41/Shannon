#!/usr/bin/env node
// "Continue" on a real isolated server and without any model (continue contracts 10, bench B; owner 2026-10-28): the body's side of the boundaries
// 2 (the four counts of vertical against the record of operations), 4 (the handover from the melee reflex), 5 (death at each moment), 6 (an old owner
// cannot act after a new one), 7 (a dimension and a death in another), and the measurements of the contract's first values (the reservation's window,
// the server's tick, the record of hand starts). The probe plays the head's part: it sends the commands the head would, with the life and what the
// decision read. It writes what the body really said into <out>/produced (the same form as scripts/lab/continue-produce.ts, bench "B").
// Env (scripts/lab/run-continue-lab.sh): MINECRAFT_CONTINUE_NO_LLM=true, MINECRAFT_CONTINUE_PORT, MINECRAFT_CONTINUE_WORLD_DIRECTORY,
// MINECRAFT_CONTINUE_OUT, MINECRAFT_CONTINUE_REPORT, MINECRAFT_CONTINUE_SCENES (comma list of scene names), SHANNON_BODY_REV, MINECRAFT_PROBE_FLOOR=default.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { NativeCommonFcaBody } from '../src/services/minebot/integration/commonFca/nativeBody.js';
import { installIncidents } from '../src/services/minebot/utils/incidents.js';
import { SceneSaver, selfNames } from '../src/services/minebot/utils/sceneSave.js';
import { bodyRevision } from '../src/services/minebot/utils/bodyRevision.js';
import { executeAction, createMotorPort, physicalRoots, physicalActionBusy } from '../src/services/minebot/execution/ActionExecution.js';
import { opLogOf } from '../src/services/minebot/utils/opLog.js';

const port = Number(process.env.MINECRAFT_CONTINUE_PORT);
const worldDirectory = process.env.MINECRAFT_CONTINUE_WORLD_DIRECTORY ?? '';
const out = process.env.MINECRAFT_CONTINUE_OUT ?? '';
if (process.env.MINECRAFT_CONTINUE_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25570 || port > 25599
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory) || !out) throw new Error('ISOLATED_CONTINUE_WORLD_REQUIRED');
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) if (process.env[key]) throw new Error(`CONTINUE_PROBE_REFUSES_PAID_KEY:${key}`);
if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'offline-test-not-used') throw new Error('CONTINUE_PROBE_REFUSES_PAID_KEY:OPENAI_API_KEY');

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const log = (text: string) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${text}`);
const ACTOR = 'MinebotTrial', FLOOR = 99;
const wanted = new Set((process.env.MINECRAFT_CONTINUE_SCENES ?? '').split(',').map(name => name.trim()).filter(Boolean));
const runs = (name: string) => wanted.size === 0 || wanted.has(name);
const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
const check = (name: string, passed: boolean, detail = '') => { checks.push({ name, passed, detail: detail.slice(0, 500) }); log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail.slice(0, 300)}` : ''}`); };
const measures: Record<string, unknown> = {};
const rev = bodyRevision();
const producedDir = path.join(out, 'produced');
fs.mkdirSync(producedDir, { recursive: true });
function produce(name: string, answers: string | null, body: Record<string, unknown>): void {
  let fixtureSha256: string | null = null;
  try { fixtureSha256 = answers ? createHash('sha256').update(fs.readFileSync(path.resolve('tests/fixtures/continue', `${answers}.json`))).digest('hex') : null; } catch { fixtureSha256 = null; }
  fs.writeFileSync(path.join(producedDir, `${name.replace(/\//gu, '--')}.json`), JSON.stringify({ producedBy: 'backend/scripts/minecraft-continue-lab-probe.ts', bench: 'B',
    bodyRevision: rev, madeAt: new Date().toISOString(), answers, fixtureSha256, ...body }, null, 1));
}

const operator: any = await createProbeBot(port);
async function ask(command: string, timeoutMs = 10_000): Promise<string> {
  const marker = `CONTASK_${randomUUID().split('-').join('').slice(0, 10)}`;
  const seen: string[] = [];
  const answer = await new Promise<string>(resolve => {
    let timer: NodeJS.Timeout | undefined;
    const listener = (message: unknown) => { const text = String((message as any)?.toString?.() ?? ''); if (text.includes(marker)) done(); else seen.push(text); };
    const done = (suffix = '') => { if (timer) clearTimeout(timer); operator.removeListener('message', listener); resolve(seen.join('\n') + suffix); };
    timer = setTimeout(() => done('\n[timeout]'), timeoutMs);
    operator.on('message', listener);
    operator.chat(`/${command}`);
    operator.chat(`/tellraw @s ${JSON.stringify({ text: marker })}`);
  });
  await sleep(200);
  return answer;
}
const holdFile = path.join(out, 'hold.json');
let current: any = null;
const scene = new SceneSaver({ command: (text, timeoutMs) => ask(text, timeoutMs), serverDir: worldDirectory, root: path.join(out, 'scenes'), self: () => selfNames(current), ignore: [operator.username] });

async function connect(): Promise<{ actor: any; body: NativeCommonFcaBody }> {
  const actor: any = await createProbeBot(port, ACTOR);
  current = actor;
  installIncidents(actor, { holdFile, scene });
  const body = new NativeCommonFcaBody(actor, { serverId: 'continue-lab', capture: async () => { throw new Error('no picture'); }, rendererConfigured: () => false });
  body.bindConnection('lab-connection-1');
  body.noteHead('hb-lab');
  return { actor, body };
}
let commandNumber = 0;
/** What the head would put on a command: the life and what its decision read, from the body's observation. */
function made(body: NativeCommonFcaBody, over: Record<string, unknown> = {}) {
  const observation = body.observe(); const s = observation.state as any;
  const madeIn = { life: s.life.life, dim: s.life.dimension, dimSince: s.life.dimensionSince, bodyBoot: s.bodyRun.bodyBoot, connectionId: s.bodyRun.connectionId, headBoot: 'hb-lab', obsSeq: observation.sequence, ...over };
  return { life: madeIn.life as number, headBoot: 'hb-lab', madeIn };
}
function commandOf(body: NativeCommonFcaBody, args: Record<string, unknown>, options: { stamp?: ReturnType<typeof made>; seconds?: number; skill?: string; id?: string } = {}): any {
  const id = options.id ?? `lab:q${++commandNumber}`;
  return { schemaVersion: 1, id, serverId: 'continue-lab', connectionId: 'lab-connection-1', kind: 'skill', skill: options.skill ?? 'act', arguments: args,
    context: { scopeKey: 'lab', taskId: 'continue-lab-task', taskRevision: 1, bodyId: 'minecraft:continue-lab', sessionId: 'continue-session', generation: 1, goal: 'lab', completionCondition: 'none',
      ...(options.stamp ?? made(body)) },
    lease: { id: 'continue-lease', generation: 1, holder: 'continue-lab-task' }, deadlineAt: new Date(Date.now() + (options.seconds ?? 90) * 1000).toISOString() };
}
async function act(body: NativeCommonFcaBody, args: Record<string, unknown>, options: { stamp?: ReturnType<typeof made>; seconds?: number; signal?: AbortSignal; id?: string } = {}) {
  const command = commandOf(body, args, options);
  const started = Date.now();
  const receipt: any = await body.execute(command, options.signal ?? new AbortController().signal);
  let parsed: any = null; try { parsed = JSON.parse(receipt.result ?? ''); } catch { parsed = null; }
  const lines = (parsed?.lines ?? []).map((line: any) => `${line.i}.${line.do} ${line.status}/${line.goal}/${line.end}${line.code ? `/${line.code}` : ''}`);
  log(`ACT ${command.id} ${((Date.now() - started) / 1000).toFixed(1)}s ${receipt.outcome} ${receipt.failureType ?? ''} ${lines.join(' | ').slice(0, 200)}`);
  return { command, receipt, parsed, lines, ms: Date.now() - started, startedAt: started };
}
async function arena(): Promise<void> {
  await ask('gamerule spawn_mobs false'); await ask('gamerule do_mob_spawning false'); await ask('time set 6000'); await ask('weather clear'); await ask('gamerule keep_inventory true');
  await ask('gamemode spectator ' + operator.username);
  await ask('fill -16 90 -16 16 99 16 minecraft:stone'); await ask('fill -16 100 -16 16 112 16 minecraft:air');
  await ask('kill @e[type=!player]');
}
async function reset(actor: any): Promise<void> {
  await ask('kill @e[type=!player]');
  await ask(`gamemode survival ${ACTOR}`); await ask(`effect clear ${ACTOR}`); await ask(`tp ${ACTOR} 0.5 ${FLOOR + 1} 0.5`); await ask(`clear ${ACTOR}`);
  await ask(`effect give ${ACTOR} minecraft:saturation 5 5 true`);
  await sleep(1500);
  if (actor.health < 20) { await ask(`effect give ${ACTOR} minecraft:instant_health 1 5 true`); await sleep(500); }
}
const opLines = (): any[] => {
  const file = opLogOf(current)?.file;
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
};

const report: Record<string, unknown> = { startedAt: new Date().toISOString(), bodyRevision: rev };
let { actor, body } = { actor: null as any, body: null as any as NativeCommonFcaBody };
try {
  await arena();
  ({ actor, body } = await connect());
  await reset(actor);
  await sleep(2000);

  // ---- measurements that need no scene: the observation's new fields, the version, the server's tick, the hand-start record
  if (runs('basics')) {
    const observation = body.observe(); const state = observation.state as any;
    check('the observation carries the life, the run ids, the control view and the utilities', state.life?.life >= 1 && state.bodyRun?.bodyBoot && state.bodyRun?.connectionId === 'lab-connection-1'
      && state.control?.holder?.kind && state.world?.utilities?.radius === 8 && observation.facts.life === state.life.life, JSON.stringify({ life: state.life, run: state.bodyRun, holder: state.control?.holder, utilities: state.world?.utilities }));
    check('the body version has a revision and the catalog hash', typeof body.bodyVersion().revision === 'string' && body.bodyVersion().catalogHash.length === 16, JSON.stringify(body.bodyVersion()));
    const refused = await act(body, { hands: [{ do: 'wait', seconds: 0.2 }] }, { stamp: { life: undefined as never, headBoot: 'hb-lab', madeIn: undefined as never } });
    check('a command without a life is refused and no hand moves', refused.receipt.failureType === 'life_missing' && refused.receipt.bodyTimes?.motorOps === undefined, JSON.stringify([refused.receipt.failureType, refused.receipt.unit]));
    const wait = await act(body, { hands: [{ do: 'wait', seconds: 0.3 }, { do: 'jump' }] });
    check('an act carries unit and bodyTimes with the lock, and the lines carry both axes', wait.receipt.unit?.goal === 'done' && wait.receipt.unit?.end === 'finished' && !!wait.receipt.bodyTimes?.lockAt
      && wait.parsed?.lines?.every((line: any) => line.goal && line.end), JSON.stringify([wait.receipt.unit, wait.receipt.bodyTimes]));
    const starts = opLines().filter(entry => entry.k === 'hand_start' && entry.ids?.command === wait.command.id);
    check('the record of hand starts is written for every hand, apart from the black box ring', starts.length === 2 && starts[0].ids.hand === 1 && starts[0].pos && typeof starts[0].inventory === 'string' && Array.isArray(starts[0].lastOps), JSON.stringify(starts[0] ?? null).slice(0, 300));
    produce('measure/hand-start', 'measure/hand-start', { output: { handStart: starts[0] ?? null, bodyTimes: wait.receipt.bodyTimes, unit: wait.receipt.unit } });
    await sleep(11_000);
    const events = (body.events as any)?.pending?.(64) ?? [];
    const tick = events.find((event: any) => event.kind === 'server.tick');
    check('the server\'s tick is told with its raw answer, its time per tick and whether it is frozen', !!tick && 'raw' in tick.data && 'parsedMspt' in tick.data && 'frozen' in tick.data, JSON.stringify(tick ?? null));
    measures.serverTick = tick?.data ?? null;
    produce('measure/server-tick', null, { output: { event: tick ?? null } });
  }

  // ---- boundary 4: the handover from the melee reflex
  if (runs('handover')) {
    await ask(`give ${ACTOR} minecraft:iron_sword 1`); await ask(`give ${ACTOR} minecraft:shield 1`); await ask(`item replace entity ${ACTOR} weapon.offhand with minecraft:shield`);
    const trials: Array<Record<string, unknown>> = [];
    for (let trial = 1; trial <= 6; trial++) {
      await reset(actor);
      await ask(`give ${ACTOR} minecraft:iron_sword 1`); await ask(`item replace entity ${ACTOR} weapon.offhand with minecraft:shield`);
      await ask(`effect give ${ACTOR} minecraft:resistance 600 1 true`);
      await sleep(800);
      await ask('summon minecraft:zombie 2.5 100 0.5 {PersistenceRequired:1b,Tags:["lab_enemy"]}');
      // wait for the melee reflex to hold the body with the zombie as its enemy
      const began = Date.now();
      let reflexSeen: any = null;
      while (Date.now() - began < 12_000) {
        const roots = physicalRoots(actor).filter(root => root.capability === 'floor-melee' || root.capability === 'floor-last-stand');
        const mark = actor.floorReflexes?.handTarget;
        if (roots.length && mark && Date.now() - mark.at < 1500) { reflexSeen = { capability: roots[0].capability, target: mark.target, shieldUp: actor.shieldBlock?.up === true }; break; }
        await sleep(15);
      }
      if (!reflexSeen) { trials.push({ trial, reflex: null }); continue; }
      const sentAt = Date.now();
      const result = await act(body, { hands: [{ do: 'fight', target: `#${reflexSeen.target}`, stance: 'fight', seconds: 8 }] }, { seconds: 30 });
      const handover = result.parsed?.handover ?? null;
      const reservedAt = handover ? Date.parse(result.receipt.bodyTimes?.lockAt ?? '') - handover.waitedMs : null;
      trials.push({ trial, reflex: reflexSeen, sentToLockMs: Date.parse(result.receipt.bodyTimes?.lockAt ?? '') - sentAt, handover,
        stopToSettledMs: handover && reservedAt ? Date.parse(handover.reflexSettledAt) - reservedAt : null,
        settledToLockMs: handover ? Date.parse(result.receipt.bodyTimes?.lockAt ?? '') - Date.parse(handover.reflexSettledAt) : null,
        reflexWaitMs: result.receipt.bodyTimes?.reflexWaitMs ?? null, outcome: result.receipt.outcome, unit: result.receipt.unit, shieldDuringHandoverRuns: null });
      if (trial === 1) produce('control/r45-attack-waited-6-4s', 'control/r45-attack-waited-6-4s', { output: { trial: trials.at(-1), result: result.parsed } });
    }
    report.handoverTrials = trials;
    const withReflex = trials.filter(entry => entry.reflex);
    check('the melee reflex took the body with the zombie as its enemy in most of the trials', withReflex.length >= 3, `${withReflex.length}/${trials.length}`);
    const confirmed = withReflex.filter(entry => (entry.handover as any)?.confirmed === true);
    check('an act for the same enemy takes the body over: confirmed, in most trials', confirmed.length >= Math.ceil(withReflex.length / 2), `${confirmed.length}/${withReflex.length}: ${JSON.stringify(withReflex.map(entry => (entry.handover as any)?.confirmed ?? null))}`);
    check('the act waits far less than the 6.4 s of run 45', withReflex.every(entry => Number(entry.sentToLockMs) < 2500), JSON.stringify(withReflex.map(entry => entry.sentToLockMs)));
    check('the shield is kept when it was up (shield "kept"), never lowered by the handover itself', confirmed.every(entry => !(entry.reflex as any).shieldUp || (entry.handover as any).shield === 'kept'), JSON.stringify(confirmed.map(entry => [(entry.reflex as any).shieldUp, (entry.handover as any).shield])));
    measures.handover = { windowMs: 300, trials: trials.map(entry => ({ trial: entry.trial, sentToLockMs: entry.sentToLockMs, stopToSettledMs: entry.stopToSettledMs, settledToLockMs: entry.settledToLockMs, waitedMs: (entry.handover as any)?.waitedMs ?? null, confirmed: (entry.handover as any)?.confirmed ?? null, shield: (entry.handover as any)?.shield ?? null })) };
  }

  // ---- boundary 4 (other enemy, low health, a reflex that is not taken from)
  if (runs('handover_not_taken')) {
    await reset(actor);
    await ask(`give ${ACTOR} minecraft:iron_sword 1`); await ask(`effect give ${ACTOR} minecraft:resistance 600 1 true`);
    await ask('summon minecraft:zombie 2.5 100 0.5 {PersistenceRequired:1b,Tags:["lab_enemy"]}'); await ask('summon minecraft:zombie -2.5 100 0.5 {PersistenceRequired:1b,Tags:["lab_enemy"]}');
    let seen: any = null; const began = Date.now();
    while (Date.now() - began < 12_000) { const mark = actor.floorReflexes?.handTarget; if (physicalRoots(actor).some(root => root.capability === 'floor-melee') && mark && Date.now() - mark.at < 1500) { seen = mark; break; } await sleep(15); }
    const others = Object.values(actor.entities as Record<string, any>).filter((entity: any) => entity?.name === 'zombie' && entity.id !== seen?.target).map((entity: any) => entity.id);
    if (seen && others.length) {
      const result = await act(body, { hands: [{ do: 'fight', target: `#${others[0]}`, stance: 'fight', seconds: 6 }] }, { seconds: 30 });
      check('an act for another enemy is not a handover (it waits for the hand that runs, as before)', !result.parsed?.handover || result.parsed.handover.confirmed === false, JSON.stringify(result.parsed?.handover ?? null));
      produce('control/different-target', 'control/different-target', { output: { reflexTarget: seen.target, actTarget: others[0], handover: result.parsed?.handover ?? null, unit: result.receipt.unit, bodyTimes: result.receipt.bodyTimes } });
    } else check('two enemies were set up for the different-target scene', false, JSON.stringify({ seen, others }));
    await reset(actor);
  }

  // ---- boundary 5: a death at each moment
  if (runs('death')) {
    for (const moment of ['running_hand', 'waiting_for_reflex']) {
      await reset(actor);
      const before = body.observe().facts.life as number;
      const stamp = made(body);
      let killedAt = 0;
      if (moment === 'waiting_for_reflex') {
        // a reflex that holds the body (the floor's flag; the act waits for it)
        actor.floorReflexes.busy = 'flee';
        setTimeout(async () => { killedAt = Date.now(); await ask(`kill ${ACTOR}`); actor.floorReflexes.busy = null; }, 1200);
      } else setTimeout(async () => { killedAt = Date.now(); await ask(`kill ${ACTOR}`); }, 1500);
      const result = await act(body, { hands: [{ do: 'wait', seconds: 6 }, { do: 'jump' }] }, { stamp, seconds: 30 });
      await sleep(4000);
      const after = body.observe();
      const oldOps = opLines().filter(entry => entry.k === 'op' && entry.command === result.command.id && Date.parse(entry.t) > killedAt + 50);
      check(`death while ${moment}: the old command ends cut or not run, with a death reason, and sent no operation after the death`, oldOps.length === 0 && /death|stale_life|cancelled/u.test(`${result.parsed?.outcome?.cutBy ?? ''}${result.receipt.failureType ?? ''}`),
        JSON.stringify({ cutBy: result.parsed?.outcome?.cutBy, failure: result.receipt.failureType, unit: result.receipt.unit, oldOps: oldOps.length }));
      check(`death while ${moment}: the life number went up by one and the death count with it`, (after.facts.life as number) === before + 1 && (after.state as any).life.advancedBy === 'death', JSON.stringify((after.state as any).life));
      if (moment === 'running_hand') produce('life/r45-death-then-old-attack', 'life/r45-death-then-old-attack', { output: { receipt: { outcome: result.receipt.outcome, unit: result.receipt.unit, bodyTimes: result.receipt.bodyTimes, failureType: result.receipt.failureType }, result: result.parsed, lifeBefore: before, lifeAfter: (after.state as any).life } });
      await sleep(2500);
      const stale = await act(body, { hands: [{ do: 'wait', seconds: 0.2 }] }, { stamp });
      check(`an old command that arrives after the death is not started (stale_life), nothing moves`, stale.receipt.failureType === 'stale_life', JSON.stringify([stale.receipt.failureType, stale.receipt.unit]));
      await sleep(1500);
    }
  }

  // ---- boundary 6: an old owner's operations are refused after a new owner began
  if (runs('stale_owner')) {
    await reset(actor);
    let old: any = null;
    await executeAction(actor, 'look-at', 8000, async () => { old = createMotorPort(actor); await sleep(100); return { success: true, result: 'old' }; }, { waitForQuiescence: true });
    await sleep(300);
    let newKeysKept = false, oldRefused = false;
    const second = executeAction(actor, 'jump', 8000, async () => {
      const mine: any = createMotorPort(actor);
      mine.setControlState('forward', true);
      try { old?.setControlState('back', true); } catch { oldRefused = true; }
      try { old?.clearControlStates(); } catch { oldRefused = oldRefused && true; }
      newKeysKept = actor.controlState?.forward === true && actor.controlState?.back !== true;
      mine.clearControlStates();
      return { success: true, result: 'second' };
    }, { waitForQuiescence: true });
    await second;
    check('after a new owner began, the old owner\'s keys, clear and goals are refused and the new owner\'s keys stay', oldRefused && newKeysKept, JSON.stringify({ oldRefused, newKeysKept }));
    produce('control/stale-owner-cleanup', 'control/stale-owner-cleanup', { output: { oldRefused, newKeysKept } });
  }

  // ---- boundary 7: a dimension is not a death; a command made before it does not start; a death in another dimension is a death
  if (runs('dimension')) {
    await reset(actor);
    const before = made(body);
    const lifeBefore = body.observe().facts.life as number;
    await ask(`execute in minecraft:the_nether run tp ${ACTOR} 0 120 0`); await sleep(6000);
    const nether = body.observe(); const netherState = nether.state as any;
    check('a portal-like change of dimension keeps the life and moves the dimension generation', nether.facts.life === lifeBefore && netherState.life.dimension === 'the_nether' && netherState.life.dimensionSince !== before.madeIn.dimSince, JSON.stringify(netherState.life));
    const old = await act(body, { hands: [{ do: 'wait', seconds: 0.2 }] }, { stamp: before });
    check('a command made in the overworld does not start in the nether (dimension_changed)', old.receipt.failureType === 'dimension_changed', JSON.stringify([old.receipt.failureType, old.receipt.unit]));
    const fresh = await act(body, { hands: [{ do: 'wait', seconds: 0.2 }] });
    check('a command made for the nether starts', fresh.receipt.outcome === 'completed', JSON.stringify([fresh.receipt.outcome, fresh.receipt.failureType]));
    await ask(`kill ${ACTOR}`); await sleep(4500);
    const afterDeath = body.observe();
    check('a death in another dimension is a death: the life goes up by one', afterDeath.facts.life === lifeBefore + 1 && (afterDeath.state as any).life.advancedBy === 'death', JSON.stringify((afterDeath.state as any).life));
    produce('life/portal-is-not-death', 'life/portal-is-not-death', { output: { lifeBefore, netherLife: netherState.life, afterDeathLife: (afterDeath.state as any).life, oldCommand: { failureType: old.receipt.failureType, unit: old.receipt.unit } } });
    await sleep(1500);
  }

  // ---- boundary 2 and the vertical hand: the four counts against the record of operations
  if (runs('vertical')) {
    await ask('fill -8 60 -8 8 99 8 minecraft:stone'); await ask('fill -8 100 -8 8 112 8 minecraft:air');
    for (const spec of [
      { name: 'stairs', hand: { do: 'vertical', dir: 'down', shape: 'stairs', toward: 'south', toY: 90, canDig: ['stone', 'dirt', 'gravel'], maxDig: 80, canPlace: ['cobblestone'], maxPlace: 10, liquid: 'stop', seconds: 90 } },
      { name: 'shaft', hand: { do: 'vertical', dir: 'down', shape: 'shaft', toY: 84, canDig: ['stone', 'dirt'], maxDig: 40, liquid: 'stop', seconds: 90 } },
      { name: 'pillar', hand: { do: 'vertical', dir: 'up', shape: 'pillar', toY: 108, canDig: ['stone', 'dirt'], canPlace: ['cobblestone'], maxPlace: 12, liquid: 'stop', seconds: 90 } },
    ]) {
      await reset(actor);
      await ask('fill -8 60 -8 8 99 8 minecraft:stone'); await ask('fill -8 100 -8 8 112 8 minecraft:air');
      await ask(`give ${ACTOR} minecraft:cobblestone 32`); await ask(`give ${ACTOR} minecraft:diamond_pickaxe 1`);
      await ask(`tp ${ACTOR} 0.5 ${spec.name === 'pillar' ? 100 : 100} 0.5`); await sleep(1500);
      const result = await act(body, { hands: [spec.hand] }, { seconds: 120 });
      await sleep(500);
      const progress = result.parsed?.lines?.[0]?.progress;
      const ops = opLines().filter(entry => entry.k === 'op' && entry.command === result.command.id);
      const count = (name: string) => ops.filter(entry => entry.op === name).length;
      report[`vertical_${spec.name}`] = { line: result.parsed?.lines?.[0], ops: { dig: count('dig'), placeBlock: count('placeBlock') }, receipt: result.receipt.unit };
      check(`vertical ${spec.name}: the hand ends with a progress in steps and the four counts`, !!progress && progress.unit === 'step' && typeof progress.done === 'number' && !!progress.work, JSON.stringify(progress ?? null));
      check(`vertical ${spec.name}: work.dug equals the digs sent, placeAttempts the places sent (the record of operations)`, !!progress?.work && progress.work.dug === count('dig') && (progress.work.placeAttempts ?? 0) === count('placeBlock'),
        JSON.stringify({ work: progress?.work, dig: count('dig'), place: count('placeBlock') }));
      produce(`vertical/r45-${spec.name === 'stairs' ? 'hold1-stairs-down' : spec.name === 'shaft' ? 'hold5-shaft-down' : 'hold7-pillar-up'}`, `vertical/r45-${spec.name === 'stairs' ? 'hold1-stairs-down' : spec.name === 'shaft' ? 'hold5-shaft-down' : 'hold7-pillar-up'}`,
        { substitute: 'an arena of stone, not the real run\'s ground', input: { hand: spec.hand }, output: { result: result.parsed, receiptUnit: result.receipt.unit, bodyTimes: result.receipt.bodyTimes, opCounts: { dig: count('dig'), placeBlock: count('placeBlock') } } });
    }
    // the same ground, a go that the server will not let lay its blocks: the real go's progress with the search and the two distances
    await reset(actor);
    await ask('fill 3 95 -16 5 99 16 minecraft:air'); await ask(`give ${ACTOR} minecraft:cobblestone 16`);
    await ask(`tp ${ACTOR} 0.5 ${FLOOR + 1} 0.5`); await ask(`gamemode adventure ${ACTOR}`); await sleep(2000);
    const go = await act(body, { hands: [{ do: 'go', to: { x: 9, y: FLOOR + 1, z: 0 }, canPlace: ['cobblestone'], maxPlace: 10, seconds: 40 }] }, { seconds: 90 });
    const line = go.parsed?.lines?.[0];
    check('a go that stops reports its progress in metres with the two distances and the last search', !!line?.progress && line.progress.unit === 'meter' && typeof line.progress.fromStopM === 'number', JSON.stringify(line ?? null).slice(0, 400));
    produce('result/r45-hold1-go-partial', 'result/r45-hold1-go-partial', { substitute: 'adventure mode makes the go stop, as the incident lab does', output: { result: go.parsed, receiptUnit: go.receipt.unit } });
    await ask(`gamemode survival ${ACTOR}`);
  }

  // ---- the events a receipt carries and the internal reader of the rest
  if (runs('events')) {
    await reset(actor);
    await ask(`give ${ACTOR} minecraft:cobblestone 30`);
    const placeHands = Array.from({ length: 4 }, (_, index) => ({ do: 'place', block: 'cobblestone', at: [{ x: 1 + index, y: FLOOR + 1, z: 3 }], face: 'down' }));
    const result = await act(body, { hands: placeHands }, { seconds: 60 });
    const carried = (result.parsed?.lines ?? []).flatMap((line: any) => line.delta ?? []);
    check('the places are told as events with the reason placed and delivery numbers from 0', carried.length >= 1 && carried.every((event: any) => event.reason === 'placed' && typeof event.deliverySeq === 'number' && event.count < 0), JSON.stringify(carried.slice(0, 3)));
    const page = await act(body, { command: result.command.id, fromSeq: 0, max: 50 }, { skill: 'events' });
    let reply: any = null; try { reply = JSON.parse(page.receipt.result ?? ''); } catch { reply = null; }
    check('the internal reader gives the same events by page, and says it is done', reply?.done === true && reply.total === carried.length && reply.events.length === carried.length && reply.lost === false, JSON.stringify(reply ?? null).slice(0, 300));
    produce('promise/table-crafted-placed-picked', 'promise/table-crafted-placed-picked', { substitute: 'cobblestone placed (the real run\'s crafting table steps are the lab\'s next)', output: { result: result.parsed, page: reply } });
  }
  report.stats = null;
  closeProbeBot(actor);
} catch (error) {
  check('the probe ran to its end', false, String((error as Error)?.stack ?? error).slice(0, 500));
} finally {
  report.measures = measures;
  report.checks = checks;
  const passed = checks.length > 0 && checks.every(entry => entry.passed);
  if (process.env.MINECRAFT_CONTINUE_REPORT) fs.writeFileSync(process.env.MINECRAFT_CONTINUE_REPORT, JSON.stringify(report, null, 1));
  console.log(`CONTINUE_RESULT ${JSON.stringify({ passed, checks: checks.length, failed: checks.filter(entry => !entry.passed).map(entry => entry.name), measures })}`);
  closeProbeBot(operator);
  process.exit(passed ? 0 : 1);
}
