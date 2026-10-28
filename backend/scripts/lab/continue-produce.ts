#!/usr/bin/env node
// Makes what the body really says, for the head's tests (continue contracts, 9): the catalog the body offers, and the outputs of the body's real code
// for the inputs of the contract's fixtures (tests/fixtures/continue). The head copies the result (scripts/sync-body-produced.sh <body rev>) and reads it
// with its own readers (continueProduced.test.ts). A produced file that was made from another body revision is not used for a pass.
//
//   vite-node scripts/lab/continue-produce.ts [--out contracts/continue/produced]       (offline: the cases a fake world can show)
//
// The cases that need a real world (the real go and its search, the reflex and its handover, the death at each moment, the vertical hand on stone)
// are made by the isolated lab (scripts/minecraft-continue-lab-probe.ts, scripts/lab/run-continue-lab.sh), which writes into the same directory with
// `bench: "B"`. Every file says: the body's revision, the script and the bench it came from, the fixture it answers and that fixture's sha256.
//
// Environment: SHANNON_BODY_REV (the revision; the working copy's git HEAD is read when it is not given). No network, no model.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { bodyRevision } from '../../src/services/minebot/utils/bodyRevision.js';
import { bodySkillCatalog } from '../../src/services/minebot/integration/commonFca/skillCatalog.js';
import { GOAL_EVIDENCE_SKILL } from '../../src/services/minebot/integration/commonFca/goalEvidence.js';
import { EVENTS_SKILL, EventStore } from '../../src/services/minebot/integration/commonFca/eventStore.js';
import { LifeKeeper } from '../../src/services/minebot/utils/life.js';
import { BodyQueue, readEnvelope } from '../../src/services/minebot/integration/commonFca/bodyQueue.js';
import { dependStateOf } from '../../src/services/minebot/integration/commonFca/continueContract.js';
import { ACT_HANDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
import { executeAction, handoverOf, physicalRoots, reserveHandover, reservationOf } from '../../src/services/minebot/execution/ActionExecution.js';

const args = Object.fromEntries(process.argv.slice(2).reduce<Array<[string, string]>>((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1] ?? '']);
  return pairs;
}, []));
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'));
const backend = path.resolve(here, '../..');
const out = path.resolve(backend, args.out || 'contracts/continue/produced');
const fixtureRoot = path.join(backend, 'tests/fixtures/continue');
fs.mkdirSync(out, { recursive: true });

const rev = bodyRevision(backend);
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const fixtureHash = (name: string): string | null => { try { return sha(fs.readFileSync(path.join(fixtureRoot, `${name}.json`))); } catch { return null; } };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function write(name: string, answers: string | null, bench: string, body: Record<string, unknown>): void {
  const file = path.join(out, `${name.replace(/\//gu, '--')}.json`);
  fs.writeFileSync(file, JSON.stringify({ producedBy: 'backend/scripts/lab/continue-produce.ts', bench, bodyRevision: rev, madeAt: new Date().toISOString(),
    answers, fixtureSha256: answers ? fixtureHash(answers) : null, ...body }, null, 1));
  console.log(`produced ${name} (${bench})`);
}

// ---- the catalog: what the body offers, built as the catalog check builds it (every instant skill, a bot with no world)
async function catalogCase(): Promise<void> {
  const require = createRequire(path.join(backend, 'package.json'));
  const minecraftData = require('minecraft-data');
  const skills: any[] = [];
  const bot: any = Object.assign(new EventEmitter(), { version: '1.21.11', registry: minecraftData('1.21.11'), entity: { position: new Vec3(0, 65, 0) }, entities: {},
    inventory: { items: () => [], slots: [] }, instantSkills: { getSkills: () => skills, getSkill: (n: string) => skills.find(s => s.skillName === n) },
    constantSkills: { getSkills: () => [], getSkill: () => undefined }, selfState: {}, environmentState: {} });
  const dir = path.join(backend, 'src/services/minebot/instantSkills');
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts')).sort()) {
    const module = await import(path.join(dir, file));
    if (typeof module.default === 'function') { try { skills.push(new module.default(bot)); } catch { /* a skill that needs a world is not offered here */ } }
  }
  const catalog = bodySkillCatalog(skills, bot);
  const props = (schema: any, depth = 0): number => {
    if (!schema || typeof schema !== 'object' || depth > 8) return 0;
    const own = schema.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties).length : 0;
    return Math.max(own, ...[...Object.values(schema.properties ?? {}), schema.items, ...(schema.anyOf ?? [])].map(item => props(item, depth + 1)), 0);
  };
  const act = catalog.definitions.find(definition => definition.name === 'act');
  const offered = [...catalog.definitions, GOAL_EVIDENCE_SKILL];
  write('catalog', null, 'offline', {
    catalogHash: sha(JSON.stringify(catalog.definitions)).slice(0, 16), offered, internal: [EVENTS_SKILL.name], runnable: catalog.runnable.map(definition => definition.name),
    actHandFieldCount: props(act?.inputSchema), maxProperties: Math.max(0, ...catalog.definitions.map(definition => props(definition.inputSchema))),
  });
}

// ---- the dependency table, run through the body's own rules
async function tableCase(): Promise<void> {
  const table = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'continue/dependency-table.json'), 'utf8'));
  write('continue/dependency-table', 'continue/dependency-table', 'offline', {
    output: { rows: table.outcomes.map((row: any) => ({ goal: row.goal, end: row.end, released: row.released, dependState: dependStateOf({ goal: row.goal, end: row.end, released: row.released, ended: true }) })) },
  });
}

// ---- the queue: what a failure does to the items that wait (the body's BodyQueue, the fixture's scenes)
async function queueCase(): Promise<void> {
  const made = { life: 1, dim: 'overworld', dimSince: 'd', bodyBoot: 'bb', connectionId: 'c', headBoot: 'h', obsSeq: 1 };
  const Q = 't-run:hb-1:40';
  const item = (id: string, after: string | null, dependsOn?: string[], pre?: unknown) => ({ id: `skill:${id}`, kind: 'skill', skill: 'act',
    queue: { item: id, after, node: null, maxMs: 10_000, startBy: new Date(Date.now() + 60_000).toISOString(), queue: Q, madeIn: made, ...(dependsOn ? { dependsOn } : {}), ...(pre ? { pre } : {}) } }) as never;
  const queue = new BodyQueue();
  queue.begin(item('q12', null));
  queue.waiting.push(item('q13', 'q12', []), item('q14', 'q13'));
  const judged = queue.judgeWaiting({ queue: Q, item: 'q12', unit: { goal: 'failed', end: 'finished', released: true } });
  write('continue/queue-item-depends', 'continue/queue-item-depends', 'offline', {
    note: 'two of the five items (the queue holds three); the rest is in the lab',
    output: { kept: judged.kept.map(entry => ({ item: entry.command.queue?.item, keptDespite: { item: entry.item, code: entry.code } })),
      dropped: judged.dropped.map(entry => ({ item: entry.command.queue?.item, droppedBecause: { code: entry.code, item: entry.item } })),
      envelopeAccepted: readEnvelope(item('q13', 'q12', [])) !== null },
  });
}

// ---- the act's result on a small fake world: the closed words, the two axes, the hands that depend on each other
function fakeBody(): any {
  return Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true, height: 1.8 }, health: 20, food: 20, game: { dimension: 'overworld' }, entities: {},
    inventory: { items: () => [{ name: 'bread', count: 4 }], slots: new Array(46).fill(null) },
    blockAt: (p: Vec3) => Math.floor(p.y) < 64 ? { name: 'stone', boundingBox: 'block', diggable: true, hardness: 1.5, position: p.floored() } : { name: 'air', boundingBox: 'empty', position: p.floored() },
    setControlState: () => undefined, clearControlStates: () => undefined,
  });
}
async function actCases(): Promise<void> {
  const far = { x: 9, y: 63, z: 0 };
  const run = async (hands: unknown[]) => JSON.parse((await runAct(fakeBody(), ACT_HANDS.parse(hands))).result);
  write('result/r43-reflex-ate-first', 'result/r43-reflex-ate-first', 'offline', {
    substitute: 'eat only (pillarUp needs physics: the lab makes the whole act)', input: { food: 20, hands: [{ do: 'eat', item: 'bread' }] },
    output: { result: await run([{ do: 'eat', item: 'bread' }]) },
  });
  const dependent = [{ do: 'dig', at: [far] }, { do: 'wait', seconds: 0.05, dependsOn: [] }, { do: 'wait', seconds: 0.05, dependsOn: [1] }, { do: 'wait', seconds: 0.05 }];
  write('continue/act-hand-depends', 'continue/act-hand-depends', 'offline', { substitute: 'a dig out of reach stands for the go that stops stuck', input: { hands: dependent }, output: { result: await run(dependent) } });
  const keep = [{ do: 'dig', at: [far], onFail: 'continue' }, { do: 'wait', seconds: 0.05, dependsOn: [1] }, { do: 'wait', seconds: 0.05 }];
  write('continue/onfail-continue-does-not-exempt', 'continue/onfail-continue-does-not-exempt', 'offline', { substitute: 'a dig out of reach stands for the craft that fails', input: { hands: keep }, output: { result: await run(keep) } });
  const chain = [{ do: 'dig', at: [far], onFail: 'continue' }, { do: 'wait', seconds: 0.05, dependsOn: [1] }, { do: 'wait', seconds: 0.05, dependsOn: [2] }];
  write('continue/indirect-depends', 'continue/indirect-depends', 'offline', { substitute: 'a dig out of reach stands for the go', input: { hands: chain }, output: { result: await run(chain) } });
}

// ---- the life number: the file that cannot be read, the pair of death numbers
async function lifeCases(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'produce-life-'));
  const botOf = () => Object.assign(new EventEmitter(), { username: 'shannon', health: 20, game: { dimension: 'overworld' } });
  const missing = new LifeKeeper(botOf(), { file: path.join(dir, 'missing.json') }).view();
  fs.writeFileSync(path.join(dir, 'corrupt.json'), '{ broken');
  const notes: string[] = [];
  const corrupt = new LifeKeeper(botOf(), { file: path.join(dir, 'corrupt.json'), now: () => 1793164759174, note: what => notes.push(what) }).view();
  const bot: any = botOf();
  const keeper = new LifeKeeper(bot, { file: path.join(dir, 'death.json') });
  const first = keeper.view(); bot.health = 0; bot.emit('death'); const afterDeath = keeper.view();
  write('life/life-file-unreadable', 'life/life-file-unreadable', 'offline', { output: { missing, corrupt, notes } });
  write('life/death-epoch-pair', 'life/death-epoch-pair', 'offline', { output: { first, afterDeath } });
}

// ---- the events a receipt could not carry, fetched page by page
async function eventCases(): Promise<void> {
  const store = new EventStore();
  const events = Array.from({ length: 340 }, (_, index) => ({ id: `skill:q70:${Math.floor(index / 100) + 1}:1:${index % 100}`, obsSeq: 1, item: 'cobblestone', count: -1, reason: 'placed' as const, deliverySeq: index }));
  store.add('skill:q70', events);
  const pages = [store.page('skill:q70', 120, 120), store.page('skill:q70', 240, 120), store.page('skill:q70', 120, 120)];
  write('promise/events-split-delivery', 'promise/events-split-delivery', 'offline', {
    output: { replies: pages.map(page => ({ ...page, eventCount: page.events.length })), sameEventsAsFirst: JSON.stringify(pages[0].events) === JSON.stringify(pages[2].events), lostAfterRestart: new EventStore().page('skill:q70', 0).lost },
  });
}

// ---- the handover reservation on the real execution layer (the three cases of the fixture)
async function reservationCases(): Promise<void> {
  const body = () => { const calls: string[] = []; const bot: any = Object.assign(new EventEmitter(), { entity: { position: new Vec3(0, 64, 0) }, health: 20, game: { dimension: 'overworld' },
    executingSkill: false, interruptExecution: false, shieldBlock: { up: true }, deactivateItem: () => calls.push('deactivate'), clearControlStates: () => undefined, stopDigging: () => undefined }); return { bot, calls }; };
  const results: Array<Record<string, unknown>> = [];
  for (const name of ['ok', 'timeout', 'other_holder']) {
    const { bot, calls } = body();
    const reflex = executeAction(bot, 'floor-melee', 5000, () => new Promise(resolve => setTimeout(() => resolve({ success: true, result: 'x' }), 30)), { priority: 250, safetyLease: true, waitForQuiescence: false });
    await delay(5);
    const [root] = physicalRoots(bot);
    const window = name === 'timeout' ? 20 : 300;
    reserveHandover(bot, { fromActionId: root.actionId, reflex: 'floor-melee', target: 7, life: 1, forCommand: 'cmd', shield: true }, Date.now(), window);
    let handover: unknown = null;
    if (name === 'other_holder') await executeAction(bot, 'floor-eat', 2000, async () => ({ success: true, result: 'ate' }), { priority: 200, safetyLease: true, waitForQuiescence: true });
    const act = executeAction(bot, 'act', 2000, async () => { handover = handoverOf(bot) ?? null; return { success: true, result: 'ok' }; }, { waitForQuiescence: true, handover: { command: 'cmd', verify: () => true } });
    await reflex;
    await act;
    results.push({ name, shieldLowered: calls.includes('deactivate'), reservationRemoved: reservationOf(bot) === null, handover });
  }
  write('control/handover-reservation', 'control/handover-reservation', 'offline', { note: 'the execution layer only; the reflex and the enemy are the lab\'s', output: { cases: results } });
}

await catalogCase();
await tableCase();
await queueCase();
await actCases();
await lifeCases();
await eventCases();
await reservationCases();
console.log(`done: body revision ${rev}, ${fs.readdirSync(out).length} files in ${out}`);
process.exit(0);
