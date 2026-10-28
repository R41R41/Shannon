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
import { CommonFcaControlLoop } from '../src/services/minebot/integration/commonFca/controlLoop.js';
import { installIncidents } from '../src/services/minebot/utils/incidents.js';
import { SceneSaver, selfNames } from '../src/services/minebot/utils/sceneSave.js';
import { bodyRevision } from '../src/services/minebot/utils/bodyRevision.js';
import { executeAction, createMotorPort, physicalRoots, preemptLowerPriorityActions } from '../src/services/minebot/execution/ActionExecution.js';
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
  // The commands go through the body's control loop (accept, begin, the end: what a receipt really carries), with a head that is only a script: its replies hold
  // the next commands and the acknowledgements, and its start-up id.
  const loop = new CommonFcaControlLoop({ baseUrl: 'http://127.0.0.1:9', token: 'lab', serverId: 'continue-lab', actuator: body, connectionId: 'lab-connection-1', pollMilliseconds: 40,
    fetcher: (async (_url: unknown, init: { body: string }) => {
      const poll = JSON.parse(init.body);
      for (const receipt of poll.receipts ?? []) { receipts.set(receipt.id, receipt); }
      const commands = outbox.splice(0, 8);
      return { ok: true, json: async () => ({ schemaVersion: 1, mode: 'common-fca', headBoot: 'hb-lab', commands, cancel: cancels.splice(0), acknowledged: (poll.receipts ?? []).map((r: any) => r.id) }) };
    }) as never });
  loop.start();
  currentLoop = loop;
  return { actor, body };
}
const outbox: any[] = [], cancels: string[] = [];
const receipts = new Map<string, any>();
let currentLoop: CommonFcaControlLoop | null = null;
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
async function act(body: NativeCommonFcaBody, args: Record<string, unknown>, options: { stamp?: ReturnType<typeof made>; seconds?: number; signal?: AbortSignal; id?: string; skill?: string } = {}) {
  const command = commandOf(body, args, options);
  const started = Date.now();
  outbox.push(command);
  const waitUntil = Date.now() + (options.seconds ?? 90) * 1000 + 20_000;
  if (options.signal) options.signal.addEventListener('abort', () => cancels.push(command.id), { once: true });
  while (!receipts.has(command.id) && Date.now() < waitUntil) await sleep(15);
  const receipt: any = receipts.get(command.id);
  if (!receipt) throw new Error(`no receipt for ${command.id}`);
  let parsed: any = null; try { parsed = JSON.parse(receipt.result ?? ''); } catch { parsed = null; }
  const lines = (parsed?.lines ?? []).map((line: any) => `${line.i}.${line.do} ${line.status}/${line.goal}/${line.end}${line.code ? `/${line.code}` : ''}`);
  log(`ACT ${command.id} ${((Date.now() - started) / 1000).toFixed(1)}s ${receipt.outcome} ${receipt.failureType ?? ''} ${lines.join(' | ').slice(0, 200)}`);
  return { command, receipt, parsed, lines, ms: Date.now() - started, startedAt: started };
}
async function arena(): Promise<void> {
  await ask('difficulty normal'); await ask('gamerule spawn_mobs false'); await ask('gamerule do_mob_spawning false'); await ask('time set 6000'); await ask('weather clear'); await ask('gamerule keep_inventory true');
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
    const starts = opLines().filter(entry => entry.kind === 'hand_start' && entry.ids?.command === wait.command.id);
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
      await ask('summon minecraft:zombie 2.5 100 0.5 {PersistenceRequired:1b,Tags:["lab_enemy"],equipment:{head:{id:"minecraft:leather_helmet",count:1}}}');
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
    await ask('summon minecraft:zombie 2.5 100 0.5 {PersistenceRequired:1b,Tags:["lab_enemy"],equipment:{head:{id:"minecraft:leather_helmet",count:1}}}'); await ask('summon minecraft:zombie -2.5 100 0.5 {PersistenceRequired:1b,Tags:["lab_enemy"],equipment:{head:{id:"minecraft:leather_helmet",count:1}}}');
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

  // ---- A-6 (10): the handover with the shield really up (arrows keep the resident shield raised), a last stand's hit taken over, and no new reflex hand after the cap
  const shieldNotes = (since: number): any[] => opLines().filter(entry => entry.kind === 'shield_state' && Date.parse(entry.at) >= since);
  if (runs('handover_shield')) {
    const trials: Array<Record<string, unknown>> = [];
    for (let trial = 1; trial <= 6; trial++) {
      await reset(actor);
      await ask('give ' + ACTOR + ' minecraft:iron_sword 1'); await ask('item replace entity ' + ACTOR + ' weapon.offhand with minecraft:shield');
      await ask('effect give ' + ACTOR + ' minecraft:resistance 600 1 true');
      await sleep(800);
      await ask('summon minecraft:zombie 2.5 100 0.5 {PersistenceRequired:1b,Tags:["lab_enemy"],equipment:{head:{id:"minecraft:leather_helmet",count:1}}}');
      // arrows from the east keep coming at the body: the resident shield goes up for them
      let streaming = true;
      void (async () => { while (streaming) { await ask('summon minecraft:arrow 7.5 101.6 0.5 {Motion:[-2.5d,0d,0d],pickup:0b,damage:0.5d}'); await sleep(250); } })();
      const began = Date.now();
      let seen: any = null;
      while (Date.now() - began < 14_000) {
        const roots = physicalRoots(actor).filter(root => root.capability === 'floor-melee' || root.capability === 'floor-last-stand');
        const mark = actor.floorReflexes?.handTarget;
        if (roots.length && mark && Date.now() - mark.at < 1500 && actor.shieldBlock?.up === true) { seen = { capability: roots[0].capability, target: mark.target, shieldUp: true }; break; }
        await sleep(10);
      }
      if (!seen) { streaming = false; trials.push({ trial, reflex: null, shieldUpSeen: actor.shieldBlock?.up === true }); continue; }
      const sentAt = Date.now();
      const result = await act(body, { hands: [{ do: 'fight', target: '#' + seen.target, stance: 'fight', seconds: 6 }] }, { seconds: 30 });
      streaming = false;
      const handover = result.parsed?.handover ?? null;
      const notes = shieldNotes(sentAt - 50);
      const phase = (name: string) => notes.find(entry => entry.phase === name) ?? null;
      trials.push({ trial, reflex: seen, handover, sentToLockMs: Date.parse(result.receipt.bodyTimes?.lockAt ?? '') - sentAt,
        notes: { reserve: phase('reserve'), stop: phase('stop'), claim: phase('claim'), first_op: phase('first_op') }, outcome: result.receipt.outcome, unit: result.receipt.unit,
        hitsTaken: ((body.observe().state as any).combat?.recentHits ?? []).length });
      await sleep(500);
    }
    report.handoverShieldTrials = trials;
    const withReflex = trials.filter(entry => entry.reflex);
    const confirmed = withReflex.filter(entry => (entry.handover as any)?.confirmed === true);
    check('A-6 (10) shield: in at least one trial the melee reflex held the body with the resident shield really up (the case the shield question needs)', withReflex.length >= 1, withReflex.length + '/' + trials.length);
    check('A-6 (10) shield: of the confirmed handovers made with the shield up at the reservation, the record of the actual state agrees with what the receipt says (kept only when it was up at the reservation, the claim and the first operation, with nothing lowered or deactivated; else dropped)',
      confirmed.every(entry => {
        const n: any = entry.notes, shield = (entry.handover as any).shield;
        if (!n.reserve) return false;
        const unbroken = n.reserve.up === true && n.claim?.up === true && n.claim?.loweredSince === 0 && n.claim?.deactivatedSince === 0 && (!n.first_op || n.first_op.up === true);
        return n.reserve.up === true ? shield === (unbroken ? 'kept' : 'dropped') : shield === 'none';
      }), JSON.stringify(confirmed.map(entry => ({ shield: (entry.handover as any).shield, notes: entry.notes }))).slice(0, 480));
    measures.handoverShield = trials.map(entry => ({ trial: entry.trial, reflex: (entry.reflex as any)?.capability ?? null, shield: (entry.handover as any)?.shield ?? null, confirmed: (entry.handover as any)?.confirmed ?? null,
      up: ['reserve', 'stop', 'claim', 'first_op'].map(name => (entry.notes as any)?.[name]?.up ?? null), loweredSince: (entry.notes as any)?.claim?.loweredSince ?? null, deactivatedSince: (entry.notes as any)?.claim?.deactivatedSince ?? null }));
    produce('measure/handover-shield-up', null, { output: { trials } });
    await reset(actor);
  }

  if (runs('handover_last_stand')) {
    await reset(actor);
    // a closed room, three cells long, with a floor that cannot be dug: no way away from a lit creeper (the creeper's blast is made harmless, and the body is not hurt by it)
    await ask('fill -1 99 -1 3 103 1 minecraft:obsidian'); await ask('fill 0 100 0 2 101 0 minecraft:air'); await ask('fill 0 99 0 2 99 0 minecraft:bedrock');
    await ask('give ' + ACTOR + ' minecraft:iron_sword 1'); await ask('effect give ' + ACTOR + ' minecraft:resistance 600 4 true');
    await ask('tp ' + ACTOR + ' 0.5 100 0.5'); await sleep(1200);
    await ask('summon minecraft:creeper 2.5 100 0.5 {PersistenceRequired:1b,Tags:["lab_enemy"],Fuse:200,ignited:1b,ExplosionRadius:0b}');
    const began = Date.now();
    let seen: any = null;
    while (Date.now() - began < 12_000) {
      const roots = physicalRoots(actor).filter(root => root.capability === 'floor-last-stand' || root.capability === 'floor-melee');
      const mark = actor.floorReflexes?.handTarget;
      if (roots.length && mark && Date.now() - mark.at < 1500) { seen = { capability: roots[0].capability, target: mark.target }; break; }
      await sleep(10);
    }
    let result: any = null;
    if (seen) {
      const sentAt = Date.now();
      result = await act(body, { hands: [{ do: 'fight', target: '#' + seen.target, stance: 'fight', seconds: 5 }] }, { seconds: 30 });
      const notes = shieldNotes(sentAt - 50);
      report.handoverLastStand = { seen, handover: result.parsed?.handover ?? null, notes, outcome: result.receipt.outcome, unit: result.receipt.unit, sentToLockMs: Date.parse(result.receipt.bodyTimes?.lockAt ?? '') - sentAt };
    } else report.handoverLastStand = { seen: null, health: actor.health };
    check('A-6 (10) last stand: the last stand\'s hit at the creeper held the body with the creeper as its enemy', !!seen && seen.capability === 'floor-last-stand', JSON.stringify(seen ?? report.handoverLastStand).slice(0, 300));
    check('A-6 (10) last stand: an act for the same enemy takes the body over from the last stand (confirmed, from floor-last-stand), waiting far less than the hit\'s own end', !!result && result.parsed?.handover?.confirmed === true && result.parsed.handover.from === 'floor-last-stand' && Date.parse(result.receipt.bodyTimes?.lockAt ?? '') - result.startedAt < 2500,
      JSON.stringify(result ? { handover: result.parsed?.handover, bodyTimes: result.receipt.bodyTimes } : null).slice(0, 400));
    produce('measure/handover-last-stand', null, { output: report.handoverLastStand as Record<string, unknown> });
    await ask('fill -1 99 -1 3 103 1 minecraft:air'); await ask('fill -1 90 -1 3 99 1 minecraft:stone');
    await reset(actor);
  }

  if (runs('cap_then_kind')) {
    await reset(actor);
    await ask('give ' + ACTOR + ' minecraft:iron_sword 1'); await ask('give ' + ACTOR + ' minecraft:cobblestone 16'); await ask('effect give ' + ACTOR + ' minecraft:resistance 600 1 true');
    await sleep(500);
    await ask('summon minecraft:zombie 2.5 100 0.5 {PersistenceRequired:1b,Tags:["lab_enemy"],equipment:{head:{id:"minecraft:leather_helmet",count:1}},attributes:[{id:"minecraft:max_health",base:1000d}],Health:1000f}');
    const began = Date.now();
    let cappedAt = 0;
    while (Date.now() - began < 40_000) { const at = actor.floorReflexes?.melee?.cappedAt; if (typeof at === 'number') { cappedAt = at; break; } await sleep(50); }
    const capturedEvents = ((body.events as any)?.pending?.(64) ?? []).filter((event: any) => event.kind === 'reflex.capped');
    if (cappedAt) {
      // the sword goes: what the choice would now be is a hand of another kind (a block between, a step), and it must not be made until the episode ends
      await ask('clear ' + ACTOR + ' minecraft:iron_sword'); await sleep(200);
      const from = Date.now();
      await sleep(3200);
      const after = opLines().filter(entry => entry.kind === 'op' && entry.by === 'floor-melee' && Date.parse(entry.at) > cappedAt + 400 && Date.parse(entry.at) < from + 3300);
      const placed = opLines().filter(entry => entry.kind === 'op' && entry.op === 'placeBlock' && Date.parse(entry.at) > cappedAt + 400);
      report.capThenKind = { cappedAt: new Date(cappedAt).toISOString(), afterOps: after.slice(0, 6), placed: placed.length, capped: capturedEvents.map((event: any) => event.data) };
      check('A-6 (10) cap: the melee reflex said reflex.capped once for the episode', capturedEvents.length >= 1, JSON.stringify(capturedEvents.map((event: any) => event.data)).slice(0, 300));
      check('A-6 (10) cap: after the cap, with the hand kind that would be chosen changed (the sword gone), the reflex sends no new operation until the episode ends', after.length === 0 && placed.length === 0, JSON.stringify({ after: after.length, placed: placed.length }));
    } else {
      report.capThenKind = { cappedAt: null, health: actor.health };
      check('A-6 (10) cap: the melee reflex reached its cap against an enemy with a thousand health', false, JSON.stringify(report.capThenKind));
    }
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
      const oldOps = opLines().filter(entry => entry.kind === 'op' && entry.command === result.command.id && Date.parse(entry.at) > killedAt + 50);
      check(`death while ${moment}: the old command ends cut or not run, with a death reason, and sent no operation after the death`, oldOps.length === 0 && (/death|stale_life|cancelled/u.test(`${result.parsed?.outcome?.cutBy ?? ''}${result.receipt.failureType ?? ''}`) || (result.receipt.outcome === 'cancelled' && result.receipt.unit?.end === 'not_run')),
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
      const stockBefore = (actor.inventory.items() as any[]).filter(item => item.name === 'cobblestone').reduce((sum, item) => sum + item.count, 0);
      // Boundary 2: for the stairs, the floor of the first level is taken away while the hand goes on (the server's block update is what corrects the count).
      if (spec.name === 'stairs') setTimeout(() => { void ask('setblock 0 98 1 minecraft:air'); }, 5500);
      const result = await act(body, { hands: [spec.hand] }, { seconds: 120 });
      await sleep(1500);
      const stockAfter = (actor.inventory.items() as any[]).filter(item => item.name === 'cobblestone').reduce((sum, item) => sum + item.count, 0);
      const progress = result.parsed?.lines?.[0]?.progress;
      const ops = opLines().filter(entry => entry.kind === 'op' && entry.command === result.command.id);
      const count = (name: string) => ops.filter(entry => entry.op === name).length;
      report[`vertical_${spec.name}`] = { line: result.parsed?.lines?.[0], ops: { dig: (count('dig') + count('unconfirmedDig')), placeBlock: count('placeBlock') }, receipt: result.receipt.unit };
      check(`vertical ${spec.name}: the hand ends with a progress in steps and the four counts`, !!progress && progress.unit === 'step' && typeof progress.done === 'number' && !!progress.work, JSON.stringify(progress ?? null));
      check(`vertical ${spec.name}: work.dug equals the digs sent, placeAttempts the places sent (the record of operations)`, !!progress?.work && progress.work.dug === (count('dig') + count('unconfirmedDig')) && (progress.work.placeAttempts ?? 0) === count('placeBlock'),
        JSON.stringify({ work: progress?.work, dig: (count('dig') + count('unconfirmedDig')), place: count('placeBlock') }));
      if (spec.name === 'stairs') {
        const updates = opLines().filter(entry => entry.kind === 'block_update' && entry.command === result.command.id);
        check('boundary 2: a step that was taken away is found by the block update: progress.corrected names it, the record has the row with the ISO time in `at` and the block in `pos`', (progress?.corrected?.length ?? 0) >= 1 && updates.length >= 1 && Number.isFinite(Date.parse(updates[0].at)) && typeof updates[0].pos?.x === 'number', JSON.stringify({ corrected: progress?.corrected, update: updates[0] ?? null }));
        produce('vertical/boundary2-evidence', 'vertical/boundary2-evidence', { substitute: 'one floor taken away with /setblock while the stairs go on', output: { corrected: progress?.corrected ?? null, done: progress?.done, work: progress?.work, evidenceRows: updates.slice(0, 4), opCounts: { dig: (count('dig') + count('unconfirmedDig')), placeBlock: count('placeBlock') } } });
      }
      if (spec.name === 'pillar') check('vertical pillar: stockUsed equals the fall of the pack and the places sent that were confirmed (the four counts keep their meaning)', progress?.work?.stockUsed === stockBefore - stockAfter && progress.work.stockUsed === progress.work.placedConfirmed,
        JSON.stringify({ work: progress?.work, packFall: stockBefore - stockAfter }));
      produce(`vertical/r45-${spec.name === 'stairs' ? 'hold1-stairs-down' : spec.name === 'shaft' ? 'hold5-shaft-down' : 'hold7-pillar-up'}`, `vertical/r45-${spec.name === 'stairs' ? 'hold1-stairs-down' : spec.name === 'shaft' ? 'hold5-shaft-down' : 'hold7-pillar-up'}`,
        { substitute: 'an arena of stone, not the real run\'s ground', input: { hand: spec.hand }, output: { result: result.parsed, receiptUnit: result.receipt.unit, bodyTimes: result.receipt.bodyTimes, opCounts: { dig: (count('dig') + count('unconfirmedDig')), placeBlock: count('placeBlock') } } });
    }
    // a go to a cell walled in rock with nothing it may dig: the search finds no way, and the hand says how far it got and what the search saw
    await reset(actor);
    await ask('fill 5 100 -2 7 103 2 minecraft:stone'); await ask('fill 6 100 0 6 101 0 minecraft:air');
    await ask(`tp ${ACTOR} 0.5 ${FLOOR + 1} 0.5`); await sleep(1500);
    const go = await act(body, { hands: [{ do: 'go', to: { x: 6, y: FLOOR + 1, z: 0 }, canDig: ['dirt'], seconds: 20 }] }, { seconds: 60 });
    const line = go.parsed?.lines?.[0];
    check('a go that stops reports its progress in metres with the two distances and the last search', !!line?.progress && line.progress.unit === 'meter' && typeof line.progress.fromStopM === 'number', JSON.stringify(line ?? null).slice(0, 400));
    produce('result/r45-hold1-go-partial', 'result/r45-hold1-go-partial', { substitute: 'a cell walled in rock with nothing to dig stands for the blocked search of the real run', output: { result: go.parsed, receiptUnit: go.receipt.unit } });
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
    // The receipt carried every event (no eventsMore), the head acknowledged it, and the body let the record go: there is nothing to fetch, and the reader says it lost nothing it owes (lost, total 0). Paging of a record that is kept is the unit test's.
    check('the receipt carried all the events and, once acknowledged, the body keeps no record of them', !result.parsed?.eventsMore && (reply?.lost === true || (reply?.done === true && reply.total === carried.length)), JSON.stringify(reply ?? null).slice(0, 300));
    produce('promise/table-crafted-placed-picked', 'promise/table-crafted-placed-picked', { substitute: 'cobblestone placed (the real run\'s crafting table steps are the lab\'s next)', output: { result: result.parsed, page: reply } });
  }
  // ---- amendment A-3: while stairs are dug, a melee reflex may start; only the placing of a vertical is a laying hand
  if (runs('laying')) {
    await ask('fill -8 60 -8 8 99 8 minecraft:stone'); await ask('fill -8 100 -8 8 120 8 minecraft:air');
    await reset(actor);
    await ask(`give ${ACTOR} minecraft:iron_sword 1`); await ask(`give ${ACTOR} minecraft:diamond_pickaxe 1`); await ask(`effect give ${ACTOR} minecraft:resistance 600 1 true`);
    await ask(`tp ${ACTOR} 0.5 100 -6.5`); await sleep(1500);
    const digging = act(body, { hands: [{ do: 'vertical', dir: 'down', shape: 'stairs', toward: 'south', toY: 86, canDig: ['stone', 'dirt'], maxDig: 80, liquid: 'stop', seconds: 60 }] }, { seconds: 90 });
    await sleep(3500);
    await ask(`execute at ${ACTOR} run summon minecraft:zombie ~ ~ ~-1.5 {PersistenceRequired:1b,Tags:["lab_enemy"],equipment:{head:{id:"minecraft:leather_helmet",count:1}}}`);
    let meleeSeen = false; const began = Date.now();
    while (Date.now() - began < 9000 && !meleeSeen) { meleeSeen = physicalRoots(actor).some(root => root.capability === 'floor-melee' || root.capability === 'floor-flee' || root.capability === 'floor-last-stand'); await sleep(30); }
    const dug = await digging;
    check('while stairs are dug (not placing), an enemy that comes starts the melee reflex (vertical is not a laying hand then)', meleeSeen, JSON.stringify({ meleeSeen, stoppedBy: dug.parsed?.stoppedBy, code: dug.parsed?.lines?.[0]?.code }));
    await ask('kill @e[type=!player]');
  }

  // ---- amendment A-2 (d): vertical is a laying hand: a reflex's note does not stop it in the middle of its placing; a reflex that takes the body still cuts it
  if (runs('laying')) {
    await ask('fill -8 60 -8 8 99 8 minecraft:stone'); await ask('fill -8 100 -8 8 120 8 minecraft:air');
    await reset(actor);
    await ask(`give ${ACTOR} minecraft:cobblestone 32`); await ask(`give ${ACTOR} minecraft:iron_sword 1`); await ask(`effect give ${ACTOR} minecraft:resistance 600 2 true`);
    await ask('summon minecraft:zombie 1.5 100 0.5 {PersistenceRequired:1b,Tags:["lab_enemy"],equipment:{head:{id:"minecraft:leather_helmet",count:1}}}');
    const pillar = { do: 'vertical', dir: 'up', shape: 'pillar', toY: 108, canDig: ['stone'], canPlace: ['cobblestone'], maxPlace: 12, liquid: 'stop', seconds: 60 };
    const first = await act(body, { hands: [pillar] }, { seconds: 90 });
    const line = first.parsed?.lines?.[0];
    check('a pillar with an enemy beside it is not stopped by a reflex note in the middle of its placing (stoppedBy is not reflex)', first.parsed?.stoppedBy !== 'reflex', JSON.stringify([first.parsed?.stoppedBy, line?.goal, line?.code, line?.progress?.done]));
    await ask('fill -3 100 -3 3 120 3 minecraft:air');   // the first pillar's column stays: the body is put back in clear air
    await reset(actor);
    await ask(`give ${ACTOR} minecraft:cobblestone 32`);
    const second = act(body, { hands: [{ ...pillar, toY: 112, maxPlace: 20 }] }, { seconds: 90 });
    await sleep(2500);
    // a reflex that takes the body (a meal on a safety lease) still cuts the hand
    preemptLowerPriorityActions(actor, 200, 'floor-eat');
    const meal = executeAction(actor, 'floor-eat', 3000, async () => { await sleep(300); return { success: true, result: 'ate' }; }, { priority: 200, safetyLease: true, waitForQuiescence: true });
    const cut = await second; await meal;
    check('a reflex that takes the body (a safety lease) still cuts the vertical hand', cut.parsed?.stoppedBy === 'reflex' || cut.receipt.failureType === 'interrupted_by_reflex' || cut.parsed?.lines?.[0]?.end === 'cut', JSON.stringify([cut.parsed?.stoppedBy, cut.receipt.failureType, cut.parsed?.lines?.[0]?.end, cut.parsed?.lines?.[0]?.cutBy]));
    await ask('kill @e[type=!player]');
  }
  report.stats = null;
  await (currentLoop as CommonFcaControlLoop | null)?.stop();
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
