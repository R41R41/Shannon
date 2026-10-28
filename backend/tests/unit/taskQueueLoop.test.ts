import { describe, expect, it, vi } from 'vitest';
import { CommonFcaControlLoop, type CommonFcaActuator, type CommonFcaObserver } from '../../src/services/minebot/integration/commonFca/controlLoop.js';
import type { MinecraftControlCommand, MinecraftControlReceipt } from '../../src/services/minebot/integration/commonFca/minecraftControlContract.js';
import { lapseOf, madenessOf, type BodyNow } from '../../src/services/minebot/integration/commonFca/lapse.js';
import type { Dim, MadeIn } from '../../src/services/minebot/integration/commonFca/continueContract.js';
import { fixture as sample } from './helpers/dependencyTable.js';
import { madeFor } from './helpers/madeFor.js';

// The task queue in the control loop (`tq/contract.md` section 3): the owner's items run one after another with up to two waiting, a
// good end starts the next at once, and an item's limit counts from its start.
//
// Continue contracts (2, 5): an item that does not end well no longer drops everything that waits. What waits is judged by what it says it depends on
// (`dependsOn`): an item that says nothing is dropped as before, one that names a list without the failed item is kept and starts in its turn (`keptDespite`).
// Before that, the lapses (a death, a dimension, a head or connection that is not the one the item was made in) are checked, and they drop whatever the
// item says it depends on. Every item carries the queue's name and what its decision read (`madeIn`); a command that moves the body also carries its life.
// The scenes of the second half are the contract's samples (tests/fixtures/continue/{continue,life}/*.json), each named by the `it` that takes it.
const NOW = Date.parse('2026-10-26T10:00:00Z');
/** The queue's name (`${taskId}:${headBoot}:${step}`; the samples' own). */
const Q = 't-run:hb-1:40';
/** What the items' decision read when nothing has moved since: the fixture's body (life 1, the overworld generation d1, this connection, head hb-1). */
const MADE_IN: MadeIn = { life: 1, dim: 'overworld', dimSince: 'd1', bodyBoot: 'bb-test', connectionId: 'connection1', headBoot: 'hb-1', obsSeq: 1 };
const context = { scopeKey: 'owner', taskId: 'task1', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 'session1', generation: 1, goal: 'test', completionCondition: 'done',
  life: 1, headBoot: 'hb-1' };
const lease = { id: 'lease1', generation: 1, holder: 'task1' };
const SKILLS = [{ name: 'act', description: '', inputSchema: {}, readOnly: false, maxDurationMs: 180_000 },
  { name: 'probe', description: '', inputSchema: {}, readOnly: true, maxDurationMs: 15_000 }];
/** A queue item: `act` with the envelope (its queue's name and what it was made in); the deadline is as far as the head sets it. */
const item = (id: string, name: string, after: string | null, queue: Record<string, unknown> = {}, fields: Record<string, unknown> = {}): MinecraftControlCommand => ({
  schemaVersion: 1, id, serverId: 'home', connectionId: 'connection1', kind: 'skill', context, lease, deadlineAt: new Date(NOW + 120_000).toISOString(),
  skill: 'act', arguments: { hands: [{ do: 'wait', seconds: 1 }] },
  queue: { item: name, after, node: 'p7', maxMs: 60_000, startBy: new Date(NOW + 300_000).toISOString(), queue: Q, madeIn: MADE_IN, ...queue }, ...fields } as MinecraftControlCommand);
/** The receipt of the stand-in body: an act ends with the unit's two axes (as the native body says them): done and finished, a failed or cut run whose aim failed, an unknown end held. */
const receipt = (c: MinecraftControlCommand, fields: Partial<MinecraftControlReceipt> = {}): MinecraftControlReceipt => {
  const made: MinecraftControlReceipt = { id: c.id, connectionId: c.connectionId, outcome: 'completed', inputsReleased: true, observedAt: new Date(NOW).toISOString(), ...fields };
  if (c.skill === 'act' && !made.unit) {
    made.unit = made.outcome === 'completed' ? { goal: 'done', end: 'finished', released: made.inputsReleased }
      : made.outcome === 'unknown' ? { goal: 'unknown', end: 'unknown', released: made.inputsReleased }
      : { goal: 'failed', end: made.outcome === 'cancelled' ? 'cut' : 'finished', released: made.inputsReleased };
  }
  return made;
};
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

interface FixtureOptions { check?: CommonFcaActuator['check']; observer?: CommonFcaObserver; life?: number }
function fixture(options: FixtureOptions = {}) {
  const requests: any[] = [], responses: any[] = [];
  const running = new Map<string, { command: MinecraftControlCommand; signal: AbortSignal; finish(fields?: Partial<MinecraftControlReceipt>): void }>();
  const started: Array<{ id: string; at: number }> = [];
  let sequence = 0, clock = NOW;
  // The body's side of the lapses, as the native body keeps it (nativeBody.ts): its life and dimension generation, its start-up and connection ids, the head it was told.
  // The lapse itself is the real one (lapse.ts); the fixture only holds the numbers it is checked against and lets a test change them.
  const now: BodyNow = { life: { life: options.life ?? MADE_IN.life, since: 's', alive: true, dimension: 'overworld', dimensionSince: 'd1' }, bodyBoot: MADE_IN.bodyBoot,
    connectionId: MADE_IN.connectionId, headBoot: null };
  const deaths = new Set<() => void>();
  const readerSkills = new Set(SKILLS.filter(skill => skill.readOnly).map(skill => skill.name));
  const actuator: CommonFcaActuator = {
    skills: SKILLS, observe: () => ({ schemaVersion: 1, bodyId: 'minecraft:home', sequence: ++sequence, stateAt: new Date(NOW).toISOString(), receivedAt: new Date(NOW).toISOString(),
      state: { life: { ...now.life }, bodyRun: { bodyBoot: now.bodyBoot, connectionId: now.connectionId } }, facts: {}, connected: true }),
    candidates: () => [], release: vi.fn(async () => true),
    bindConnection: (connectionId: string) => { now.connectionId = connectionId; },
    noteHead: (headBoot: string) => { now.headBoot = headBoot; },
    onDeath: (listener: () => void) => { deaths.add(listener); return () => { deaths.delete(listener); }; },
    movesBody: command => command.kind === 'reflex' || command.kind === 'skill' && !readerSkills.has(command.skill ?? ''),
    lapseOf: (command, dimension) => lapseOf(madenessOf(command.context, command.queue?.madeIn), now, { dimension }),
    execute: vi.fn(async (command, signal) => {
      started.push({ id: command.id, at: performance.now() });
      return new Promise<MinecraftControlReceipt>(resolve => {
        const finish = (fields: Partial<MinecraftControlReceipt> = {}) => resolve(receipt(command, { outcome: signal.aborted ? 'cancelled' : 'completed', ...fields }));
        running.set(command.id, { command, signal, finish });
        signal.addEventListener('abort', () => finish(), { once: true });
      });
    }),
    progress: () => ({ hand: 2, of: 3, iteration: 1, repeat: 1 }),
    ...(options.check ? { check: options.check } : {}),
  };
  const loop = new CommonFcaControlLoop({ baseUrl: 'http://127.0.0.1:3000', token: 'fake', serverId: 'home', connectionId: 'connection1', now: () => clock, actuator,
    ...(options.observer ? { observer: options.observer } : {}),
    fetcher: vi.fn(async (_, init) => {
      requests.push(JSON.parse(init!.body as string));
      const response = responses.shift(); if (response instanceof Error) throw response;
      return new Response(JSON.stringify({ schemaVersion: 1, mode: 'common-fca', commands: [], cancel: [], acknowledged: [], ...response }));
    }) });
  const deliver = async (...commands: MinecraftControlCommand[]) => { responses.push({ commands }); await loop.poll(); await tick(); };
  /** A reply with more than commands (the head's start-up id, a cancel). */
  const reply = async (fields: Record<string, unknown>) => { responses.push(fields); await loop.poll(); await tick(); };
  /** A poll, then the receipts it carried (the last request). */
  const receipts = async () => { responses.push({}); await loop.poll(); return Object.fromEntries((requests.at(-1).receipts as MinecraftControlReceipt[]).map(r => [r.id, r])); };
  /** The body dies (its life number goes up, it is not alive until it respawns) and tells the loop; a change of dimension moves the generation the decisions read. */
  const die = () => { now.life = { ...now.life, life: now.life.life + 1, alive: false }; for (const listener of [...deaths]) listener(); };
  const respawn = () => { now.life = { ...now.life, alive: true }; };
  const enterDimension = (dimension: Dim, since: string) => { now.life = { ...now.life, dimension, dimensionSince: since }; };
  return { loop, actuator, requests, responses, running, started, deliver, reply, receipts, now, die, respawn, enterDimension, advance: (ms: number) => { clock += ms; } };
}

describe('the queue: who may wait and in what order', () => {
  it('runs one item and keeps two waiting; the poll names the waiting ones and how far the running one is; a fourth is refused as full', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1'));
    await f.deliver(item('c', 'q3', 'q2'));
    expect(f.started.map(entry => entry.id)).toEqual(['a']);
    await f.loop.poll();
    expect(f.requests.at(-1)).toMatchObject({ activeOperationIds: ['a'], queuedOperationIds: ['b', 'c'], queue: { id: 'a', hand: 2, of: 3, iteration: 1, repeat: 1 } });
    await f.deliver(item('d', 'q4', 'q3'));
    expect((await f.receipts()).d).toMatchObject({ outcome: 'failed', inputsReleased: true, failureType: 'queue_full' });
    expect(f.started).toHaveLength(1);
    await f.loop.stop();
  });

  it('refuses an item whose after is not the last of the queue, and one with no after while the queue is busy; the queue stays as it was', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q9'));
    await f.deliver(item('c', 'q3', null));
    const out = await f.receipts();
    expect(out.b).toMatchObject({ outcome: 'failed', inputsReleased: true, failureType: 'queue_after_gone' });
    expect(out.c).toMatchObject({ outcome: 'failed', inputsReleased: true, failureType: 'queue_busy' });
    await f.loop.poll();
    expect(f.requests.at(-1).queuedOperationIds).toEqual([]);
    await f.deliver(item('d', 'q4', 'q1'));
    await f.loop.poll();
    expect(f.requests.at(-1).queuedOperationIds).toEqual(['d']);
    await f.loop.stop();
  });

  it('an idle body starts an item after one that ended well, and refuses one that follows a stopped or unknown item', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    f.running.get('a')!.finish(); await tick();
    await f.deliver(item('b', 'q2', 'q1'));
    expect(f.started.map(entry => entry.id)).toEqual(['a', 'b']);
    f.running.get('b')!.finish({ outcome: 'failed', failureType: 'out_of_reach' }); await tick();
    await f.deliver(item('c', 'q3', 'q2'));
    await f.deliver(item('d', 'q4', 'q77'));
    const out = await f.receipts();
    expect(out.c).toMatchObject({ failureType: 'queue_after_gone', inputsReleased: true });
    expect(out.d).toMatchObject({ failureType: 'queue_after_gone', inputsReleased: true });
    expect(f.started).toHaveLength(2);
    await f.loop.stop();
  });

  it('another owner\'s command is refused while the queue is busy, with the receipt of any refusal for an owner (not released); a command without an envelope too', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('other', 'q1', null, {}, { lease: { id: 'lease2', generation: 1, holder: 'task2' }, context: { ...context, taskId: 'task2' } }));
    await f.deliver({ ...item('plain', 'q9', null), queue: undefined } as MinecraftControlCommand);
    const out = await f.receipts();
    expect(out.other).toMatchObject({ outcome: 'failed', result: 'BODY_COMMAND_REFUSED', inputsReleased: false });
    expect(out.plain).toMatchObject({ outcome: 'failed', result: 'BODY_COMMAND_REFUSED', inputsReleased: false });
    expect(f.started).toHaveLength(1);
    await f.loop.stop();
  });

  it('an envelope that is not a well formed act item is refused as a shape (nothing ran)', async () => {
    const f = fixture();
    await f.deliver(item('x', 'qx', null, { maxMs: 5 }));
    await f.deliver(item('y', 'q1', null, { pre: [[{ k: 'bogus' }]] }));
    await f.deliver(item('z', 'q2', null, {}, { skill: 'probe' }));
    const out = await f.receipts();
    for (const id of ['x', 'y', 'z']) expect(out[id]).toMatchObject({ outcome: 'failed', result: 'BODY_COMMAND_REFUSED', inputsReleased: true });
    expect(f.started).toHaveLength(0);
    await f.loop.stop();
  });

  it('a read-only command of the owner runs beside the running item; the item\'s owner is given back when nothing runs or waits', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver({ ...item('p', 'q1', null), skill: 'probe', queue: undefined } as MinecraftControlCommand);
    expect(f.started.map(entry => entry.id)).toEqual(['a', 'p']);
    f.running.get('p')!.finish(); f.running.get('a')!.finish(); await tick(10);
    const other = { ...item('o', 'q1', null), lease: { id: 'lease2', generation: 1, holder: 'task2' }, context: { ...context, taskId: 'task2' } } as MinecraftControlCommand;
    await f.deliver(other);
    expect(f.started.map(entry => entry.id)).toEqual(['a', 'p', 'o']);
    await f.loop.stop();
  });

  it('ignores a command id it has seen', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('a', 'q1', null));
    expect(f.started).toHaveLength(1);
    await f.loop.stop();
  });
});

describe('the queue: what an end does', () => {
  it('starts the next item at once when one ends well: no poll between them (well under 50 ms)', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1'));
    const before = f.requests.length;
    const endedAt = performance.now();
    f.running.get('a')!.finish();
    await tick(2);
    expect(f.requests.length).toBe(before);
    const second = f.started.find(entry => entry.id === 'b')!;
    expect(second.at - endedAt).toBeLessThan(50);
    await f.loop.stop();
  });

  it('a failure drops every item that waits, each with a receipt that says no hand moved and which item stopped', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1'));
    await f.deliver(item('c', 'q3', 'q2'));
    f.running.get('a')!.finish({ outcome: 'failed', failureType: 'out_of_reach' }); await tick(2);
    const out = await f.receipts();
    for (const id of ['b', 'c']) {
      expect(out[id]).toMatchObject({ outcome: 'cancelled', inputsReleased: true, failureType: 'queue_dropped' });
      expect(out[id]!.result).toBe('捨てた: 前の項目 q1 が止まった（out_of_reach）。手は動いていない');
      // Contract 2: the receipt's unit says it did not start and why, naming the item that stopped (an item that says nothing of what it depends on is dropped as before).
      expect(out[id]!.unit).toMatchObject({ goal: 'not_started', end: 'not_run', released: true, droppedBecause: { code: 'depends_failed', item: { queue: Q, item: 'q1' } } });
      expect(out[id]!.unit?.startedAt).toBeUndefined();
      expect(out[id]!.bodyTimes).toMatchObject({ failedAt: expect.any(String), endedAt: expect.any(String) });
    }
    // The one that ended says how: a finished run whose aim failed.
    expect(out.a!.unit).toMatchObject({ goal: 'failed', end: 'finished', released: true, startedAt: expect.any(String) });
    expect(f.started.map(entry => entry.id)).toEqual(['a']);
    await f.loop.stop();
  });

  it('a cancelled item (the head\'s cancel of the running one) drops the rest, and a dropped item\'s id is not usable as an `after` afterwards', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1'));
    f.responses.push({ cancel: ['a'] }); await f.loop.poll(); await tick(2);
    const out = await f.receipts();
    expect(out.a).toMatchObject({ outcome: 'cancelled' });
    // (The reason now comes from the item's end on the two axes: this stand-in body's cancelled receipt has no unit and no failure type, so the loop reads it as a
    // finished-or-cut run whose aim failed, and the words say `failed`; they used to say the receipt's outcome, `cancelled`. The unit's `end: 'cut'` carries the cancel.)
    expect(out.a!.unit).toMatchObject({ goal: 'failed', end: 'cut' });
    expect(out.b).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped', result: '捨てた: 前の項目 q1 が止まった（cancelled）。手は動いていない' });
    expect(out.b!.unit).toMatchObject({ goal: 'not_started', end: 'not_run', droppedBecause: { code: 'depends_failed', item: { queue: Q, item: 'q1' } } });
    await f.deliver(item('c', 'q3', 'q2'));
    expect((await f.receipts()).c).toMatchObject({ failureType: 'queue_after_gone' });
    await f.loop.stop();
  });

  it('a cancel of a waiting item removes it and the ones behind it; the running item goes on', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1'));
    await f.deliver(item('c', 'q3', 'q2'));
    f.responses.push({ cancel: ['b'] }); await f.loop.poll();
    const out = await f.receipts();
    expect(out.b).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped', result: '捨てた: 取り消された。手は動いていない', inputsReleased: true });
    expect(out.c).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped' });
    expect(f.running.get('a')!.signal.aborted).toBe(false);
    await f.loop.poll();
    expect(f.requests.at(-1)).toMatchObject({ activeOperationIds: ['a'], queuedOperationIds: [] });
    await f.loop.stop();
  });

  it('a stop command aborts the running item and drops what waits', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1'));
    await f.deliver({ ...item('s', 'q0', null), kind: 'stop', skill: undefined, queue: undefined, arguments: undefined,
      stop: { context, requestId: 'stop-1', reason: 'handoff' } } as unknown as MinecraftControlCommand);
    await tick(5);
    const out = await f.receipts();
    expect(out.a).toMatchObject({ outcome: 'cancelled' });
    expect(out.b).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped', inputsReleased: true });
    expect(f.started.map(entry => entry.id)).toEqual(['a']);
    await f.loop.stop();
  });

  it('the operator\'s stop (abortActive) and a lost API both stop the running item and drop what waits', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1'));
    expect(f.loop.abortActive()).toBe(1);
    await tick(2);
    const out = await f.receipts();
    expect(out.b).toMatchObject({ failureType: 'queue_dropped', result: '捨てた: 操作者が止めた。手は動いていない' });
    const g = fixture();
    await g.deliver(item('a', 'q1', null));
    await g.deliver(item('b', 'q2', 'q1'));
    g.advance(16_000);
    g.responses.push(new Error('network')); await expect(g.loop.poll()).rejects.toThrow();
    await tick(2);
    expect(g.running.get('a')!.signal.aborted).toBe(true);
    g.responses.push({}); await g.loop.poll();
    expect(g.requests.at(-1).receipts.find((r: any) => r.id === 'b')).toMatchObject({ failureType: 'queue_dropped', result: '捨てた: API と話せなくなった。手は動いていない' });
    await f.loop.stop(); await g.loop.stop();
  });

  it('an unknown end holds the body: what waits is dropped and says so with its inputs not released', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1'));
    f.running.get('a')!.finish({ outcome: 'unknown', inputsReleased: false }); await tick(2);
    const out = await f.receipts();
    expect(out.b).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped', inputsReleased: false });
    await f.loop.stop();
  });
});

describe('the queue: the start of an item', () => {
  it('an item whose start-by time passed when its turn came is not started, and what waits is dropped', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1', { startBy: new Date(NOW + 1000).toISOString() }));
    await f.deliver(item('c', 'q3', 'q2'));
    f.advance(2000);
    f.running.get('a')!.finish(); await tick(2);
    const out = await f.receipts();
    expect(out.b).toMatchObject({ outcome: 'cancelled', failureType: 'queue_expired', inputsReleased: true });
    expect(out.c).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped' });
    expect(f.started.map(entry => entry.id)).toEqual(['a']);
    await f.loop.stop();
  });

  it('a waiting item past its start-by time is dropped at the next poll, with the ones behind it, without waiting for the item ahead to end', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1', { startBy: new Date(NOW + 1000).toISOString() }));
    await f.deliver(item('c', 'q3', 'q2'));
    f.advance(2000);
    const out = await f.receipts();
    expect(out.b).toMatchObject({ outcome: 'cancelled', failureType: 'queue_expired', inputsReleased: true });
    expect(out.c).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped' });
    expect(f.running.get('a')!.signal.aborted).toBe(false);
    await f.loop.stop();
  });

  it('a pre that does not hold is checked right before the item starts: it is not started, says what is lacking, and what waits is dropped', async () => {
    const check = vi.fn(() => ({ ok: false, words: 'raw_iron 1/3' }));
    const f = fixture({ check });
    const pre = [[{ k: 'have', item: 'raw_iron', n: 3 }]];
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1', { pre }));
    await f.deliver(item('c', 'q3', 'q2'));
    expect(check).not.toHaveBeenCalled();
    f.running.get('a')!.finish(); await tick(2);
    expect(check).toHaveBeenCalledWith(pre);
    const out = await f.receipts();
    expect(out.b).toMatchObject({ outcome: 'failed', failureType: 'precondition', inputsReleased: true, result: '前提を満たさず始めなかった: raw_iron 1/3（手は動かしていない）' });
    expect(out.c).toMatchObject({ failureType: 'queue_dropped' });
    expect(f.started.map(entry => entry.id)).toEqual(['a']);
    // An item that starts at once is checked at once; one whose pre holds starts.
    const g = fixture({ check: () => ({ ok: true, words: '' }) });
    await g.deliver(item('a', 'q1', null, { pre }));
    expect(g.started.map(entry => entry.id)).toEqual(['a']);
    const h = fixture({ check });
    await h.deliver(item('a', 'q1', null, { pre }));
    expect((await h.receipts()).a).toMatchObject({ failureType: 'precondition', inputsReleased: true });
    // No way to check: a pre is not taken for met, and it is not a "no" either: it could not be judged (`precondition_unknown`, contract 2).
    const i = fixture();
    await i.deliver(item('a', 'q1', null, { pre }));
    expect((await i.receipts()).a).toMatchObject({ outcome: 'failed', failureType: 'precondition_unknown', inputsReleased: true });
    await f.loop.stop(); await g.loop.stop(); await h.loop.stop(); await i.loop.stop();
  });

  it('the clock of an item starts when it starts: one that waited longer than its limit is not cut, and is cut after its limit from its start', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null, { maxMs: 60_000 }));
    await f.deliver(item('b', 'q2', 'q1', { maxMs: 1000 }));
    await tick(1200);
    f.running.get('a')!.finish(); await tick(5);
    const b = f.running.get('b')!;
    expect(b.signal.aborted).toBe(false);
    await tick(400);
    expect(b.signal.aborted).toBe(false);
    await tick(800);
    expect(b.signal.aborted).toBe(true);
    expect(b.signal.reason).toBe('deadline');
    await f.loop.stop();
  }, 10_000);

  it('tells the watcher: queued, started, ended (also for an item that never started)', async () => {
    const seen: string[] = [];
    const f = fixture({ observer: { commandQueued: c => seen.push(`queued ${c.id}`), commandStarted: c => seen.push(`started ${c.id}`),
      commandEnded: (c, r) => seen.push(`ended ${c.id} ${r.outcome}`) } });
    await f.deliver(item('a', 'q1', null));
    await f.deliver(item('b', 'q2', 'q1'));
    f.running.get('a')!.finish({ outcome: 'failed' }); await tick(2);
    expect(seen).toEqual(['started a', 'queued b', 'ended a failed', 'ended b cancelled']);
    await f.loop.stop();
  });
});

describe('the envelope and the receipt (contract 1, 2)', () => {
  it('an envelope without its queue\'s name or without what it was made in, or with a dependsOn that is not well formed, is refused as a shape (nothing ran)', async () => {
    const f = fixture();
    await f.deliver(item('x', 'q1', null, { queue: undefined }));
    await f.deliver(item('y', 'q2', null, { madeIn: undefined }));
    await f.deliver(item('z', 'q3', null, { dependsOn: ['q3'] }));
    await f.deliver(item('w', 'q4', null, { dependsOn: ['q1', 'q1'] }));
    const out = await f.receipts();
    for (const id of ['x', 'y', 'z', 'w']) {
      expect(out[id], id).toMatchObject({ outcome: 'failed', result: 'BODY_COMMAND_REFUSED', inputsReleased: true, unit: { goal: 'not_started', end: 'not_run' } });
    }
    expect(f.started).toHaveLength(0);
    await f.loop.stop();
  });

  it('a command that moves the body without its life is life_missing: not started, the hands did not move, and what waits is not touched by it', async () => {
    const f = fixture();
    const { life: _life, ...bare } = context;
    await f.deliver(item('a', 'q1', null, {}, { context: bare }));
    const out = await f.receipts();
    expect(out.a).toMatchObject({ outcome: 'failed', failureType: 'life_missing', inputsReleased: true, recoverable: true, unit: { goal: 'not_started', end: 'not_run', released: true } });
    expect(out.a!.result).toContain('手は動いていない');
    expect(f.started).toHaveLength(0);
    // A reader moves nothing: no life is asked of it.
    await f.deliver({ ...item('p', 'q1', null), skill: 'probe', queue: undefined, context: bare } as MinecraftControlCommand);
    expect(f.started.map(entry => entry.id)).toEqual(['p']);
    await f.loop.stop();
  });

  it('the receipt of an item that ran says when it started and the times the body took; the one that was refused has its accept and its end', async () => {
    const f = fixture();
    await f.deliver(item('a', 'q1', null));
    f.running.get('a')!.finish(); await tick(2);
    await f.deliver(item('b', 'q9', 'q7'));
    const out = await f.receipts();
    expect(out.a).toMatchObject({ outcome: 'completed', unit: { goal: 'done', end: 'finished', released: true, startedAt: expect.any(String) },
      bodyTimes: { acceptedAt: expect.any(String), startedAt: expect.any(String), endedAt: expect.any(String) } });
    expect(out.b).toMatchObject({ failureType: 'queue_after_gone', unit: { goal: 'not_started', end: 'not_run' }, bodyTimes: { acceptedAt: expect.any(String), endedAt: expect.any(String) } });
    expect(out.b!.unit?.startedAt).toBeUndefined();
    await f.loop.stop();
  });
});

/** An item made in another life than the fixture's first (its context and its envelope say which). */
const itemIn = (life: number, id: string, name: string, after: string | null, queue: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) =>
  item(id, name, after, { madeIn: { ...MADE_IN, life }, ...queue }, { context: { ...context, life }, ...fields });
const ref = (name: string) => ({ queue: Q, item: name });

describe('after a failure: what names nothing is dropped, what names others stays (fixtures continue/*.json)', () => {
  it('queue-item-depends: the independent one starts (kept despite), the ones whose pre does not hold or cannot be judged do not, the ones that name it or nothing are dropped', async () => {
    const scene = sample('continue/queue-item-depends.json');
    const waiting: Record<string, any> = Object.fromEntries(scene.input.waiting.map((entry: any) => [entry.item, entry]));
    // The pre are judged on the scene's observation: raw_iron 2, food 30 points, a furnace that cannot be judged.
    const seen = scene.input.observation;
    const clause = (c: any): boolean | null => c.k === 'have' ? (seen.have[c.item] ?? 0) >= c.n : c.k === 'food' ? seen.foodPoints >= c.n : null;
    const check: NonNullable<CommonFcaActuator['check']> = pre => {
      const groups = pre.map(group => group.map(clause));
      const ok = groups.some(group => group.every(verdict => verdict === true));
      return { ok, words: ok ? '' : '足りない', ...(!ok && groups.some(group => group.includes(null)) ? { unknown: true } : {}) };
    };
    expect(check(waiting.q13.pre).ok).toBe(scene.expected.preComputed.q13);
    expect(check(waiting.q13b.pre).ok).toBe(scene.expected.preComputed.q13b);
    expect(check(waiting.q13c.pre)).toMatchObject({ ok: false, unknown: true });
    // The sample calls two items q13b and q13c; the body's item ids are q and a number (bodyQueue's ENVELOPE refuses these two as a shape), so they are q131 and q132 here.
    const id = (name: string) => ({ q13b: 'q131', q13c: 'q132' } as Record<string, string>)[name] ?? name;
    // (the sample's chain is q12, q13, q13b, q13c, q14, q15; a queue holds three, so each part of it starts again behind q12 or behind the item it names)
    const make = (name: string, after: string = waiting[name].after) => item(id(name), id(name), id(after), { ...(waiting[name].dependsOn ? { dependsOn: waiting[name].dependsOn.map(id) } : {}), ...(waiting[name].pre ? { pre: waiting[name].pre } : {}) });
    const running = (name: string) => item(name, name, null);

    // q12 fails with q13 and q13b waiting behind it (a queue holds three at a time): q13 starts, and when it is done q13b is not started.
    const f = fixture({ check });
    await f.deliver(running('q12'), make('q13'), make('q13b'));
    f.running.get('q12')!.finish({ outcome: 'failed', failureType: 'stuck' }); await tick(2);
    expect(f.started.map(entry => entry.id)).toEqual(['q12', 'q13']);
    f.running.get('q13')!.finish(); await tick(2);
    expect(f.started.map(entry => entry.id)).toEqual(['q12', 'q13']);
    const out = await f.receipts();
    expect(out.q12!.unit).toMatchObject({ goal: 'failed', end: 'finished', released: true });
    expect(out.q13!.unit).toMatchObject({ goal: 'done', end: 'finished', startedAt: expect.any(String), keptDespite: scene.expected.q13.keptDespite });
    expect(out.q131).toMatchObject({ outcome: 'failed', failureType: scene.expected.q13b.failureType, inputsReleased: true, unit: { goal: 'not_started', end: 'not_run' } });
    expect(out.q131!.unit?.droppedBecause).toBeUndefined();

    // The one whose pre cannot be judged is not started either, and says so.
    const g = fixture({ check });
    await g.deliver(running('q12'), make('q13c', 'q12'));
    g.running.get('q12')!.finish({ outcome: 'failed', failureType: 'stuck' }); await tick(2);
    expect(g.started.map(entry => entry.id)).toEqual(['q12']);
    expect((await g.receipts()).q132).toMatchObject({ outcome: 'failed', failureType: scene.expected.q13c.failureType, unit: { goal: 'not_started', end: 'not_run' } });

    // q14 names nothing and q15 names q12: both are dropped, naming the item that stopped.
    const h = fixture({ check });
    await h.deliver(running('q12'), make('q14', 'q12'), make('q15', 'q14'));
    h.running.get('q12')!.finish({ outcome: 'failed', failureType: 'stuck' }); await tick(2);
    expect(h.started.map(entry => entry.id)).toEqual(['q12']);
    const dropped = await h.receipts();
    for (const name of ['q14', 'q15']) {
      expect(dropped[name], name).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped', unit: { goal: 'not_started', end: 'not_run', droppedBecause: scene.expected[name].droppedBecause } });
    }
    await f.loop.stop(); await g.loop.stop(); await h.loop.stop();
  });

  it('indirect-depends (the queue): a dropped item is not an outcome to lean on, so the one that names it is dropped too, naming the dropped item', async () => {
    const scene = sample('continue/indirect-depends.json');
    const f = fixture();
    await f.deliver(item('q1', 'q1', null), item('q2', 'q2', 'q1', { dependsOn: ['q1'] }), item('q3', 'q3', 'q2', { dependsOn: ['q2'] }));
    f.running.get('q1')!.finish({ outcome: 'failed', failureType: 'stuck' }); await tick(2);
    const out = await f.receipts();
    expect(out.q2).toMatchObject({ outcome: 'cancelled', unit: { goal: 'not_started', end: 'not_run', droppedBecause: scene.expected.queue.q2.droppedBecause } });
    expect(out.q3).toMatchObject({ outcome: 'cancelled', unit: { goal: 'not_started', end: 'not_run', droppedBecause: scene.expected.queue.q3.droppedBecause } });
    expect(f.started.map(entry => entry.id)).toEqual(['q1']);
    await f.loop.stop();
  });

  it('keep-vs-start-pending: the one that names one still waiting is kept and waits, and starts when that one has succeeded', async () => {
    const scene = sample('continue/keep-vs-start-pending.json');
    const f = fixture();
    await f.deliver(item('q1', 'q1', null), item('q2', 'q2', 'q1', { dependsOn: [] }), item('q3', 'q3', 'q2', { dependsOn: ['q2'] }));
    f.running.get('q1')!.finish({ outcome: 'failed', failureType: 'stuck' }); await tick(2);
    // after q1: q2 starts, q3 is kept and waits (it is not dropped, not started)
    expect(scene.expected.afterQ1).toEqual({ q2: 'start', q3: 'keep_waiting' });
    expect(f.started.map(entry => entry.id)).toEqual(['q1', 'q2']);
    await f.loop.poll();
    expect(f.requests.at(-1)).toMatchObject({ activeOperationIds: ['q2'], queuedOperationIds: ['q3'] });
    f.running.get('q2')!.finish(); await tick(2);
    expect(scene.expected.afterQ2).toEqual({ q3: 'start' });
    expect(f.started.map(entry => entry.id)).toEqual(['q1', 'q2', 'q3']);
    const out = await f.receipts();
    expect(out.q2!.unit).toMatchObject({ goal: 'done', keptDespite: { item: ref('q1'), code: 'failed' } });
    expect(out.q3).toBeUndefined();   // still running: no receipt yet
    f.running.get('q3')!.finish(); await tick(2);
    expect((await f.receipts()).q3!.unit).toMatchObject({ goal: 'done', keptDespite: { item: ref('q1'), code: 'failed' } });
    await f.loop.stop();
  });

  it('admit-after-stopped: an item behind one that stopped is admitted when it names what it depends on without it, and never skips the tail', async () => {
    const scene = sample('continue/admit-after-stopped.json');
    expect(scene.expected.cases.map((entry: any) => entry.admission)).toEqual(['start', 'queue_after_gone', 'queue_after_gone']);
    const stopped = async () => {
      const f = fixture();
      await f.deliver(item('q20', 'q20', null));
      f.running.get('q20')!.finish({ outcome: 'failed', failureType: 'stuck' }); await tick(2);
      return f;
    };
    // case 1: idle, behind q20 (failed), names [] -> start
    const one = await stopped();
    await one.deliver(item('q21', 'q21', 'q20', { dependsOn: [] }));
    expect(one.started.map(entry => entry.id)).toEqual(['q20', 'q21']);
    // case 2: idle, behind q20, names nothing -> queue_after_gone
    const two = await stopped();
    await two.deliver(item('q21', 'q21', 'q20'));
    expect((await two.receipts()).q21).toMatchObject({ outcome: 'failed', failureType: 'queue_after_gone', inputsReleased: true });
    expect(two.started.map(entry => entry.id)).toEqual(['q20']);
    // case 3: busy (q22 runs behind q20), a new one behind q20 skips the tail -> queue_after_gone, naming q22
    const three = await stopped();
    await three.deliver(item('q22', 'q22', 'q20', { dependsOn: [] }));
    await three.deliver(item('q23', 'q23', 'q20', { dependsOn: [] }));
    const out = await three.receipts();
    expect(out.q23).toMatchObject({ outcome: 'failed', failureType: 'queue_after_gone' });
    expect(out.q23!.result).toContain('q22');
    expect(three.started.map(entry => entry.id)).toEqual(['q20', 'q22']);
    await one.loop.stop(); await two.loop.stop(); await three.loop.stop();
  });

  it('no-depends-as-now: an item that writes no dependsOn is dropped after a failure, as it always was', async () => {
    const scene = sample('continue/no-depends-as-now.json');
    const f = fixture();
    await f.deliver(item('q30', 'q30', null), item('q31', 'q31', 'q30'));
    f.running.get('q30')!.finish({ outcome: 'failed', failureType: 'stuck' }); await tick(2);
    const out = await f.receipts();
    expect(out.q31).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped', unit: { goal: 'not_started', end: 'not_run', droppedBecause: { code: scene.expected.q31.droppedBecause.code, item: ref('q30') } } });
    expect(f.started.map(entry => entry.id)).toEqual(['q30']);
    await f.loop.stop();
  });

  it('replace-keeps-explicit-independent: a cancel takes the item and what names it or names nothing; the item that explicitly names others stays and goes on in its turn', async () => {
    const scene = sample('continue/replace-keeps-explicit-independent.json');
    expect(scene.expected.removed).toEqual(['q13', 'q14', 'q15']);
    // q13 and q14 (names nothing): both go; q14 says the cancelled q13 is why.
    const f = fixture();
    await f.deliver(item('q12', 'q12', null), item('q13', 'q13', 'q12'), item('q14', 'q14', 'q13'));
    await f.reply({ cancel: ['q13'] });
    const out = await f.receipts();
    expect(out.q13).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped', unit: { droppedBecause: { code: 'cancelled' } } });
    expect(out.q14).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped', unit: { droppedBecause: { code: 'depends_failed', item: ref('q13') } } });
    await f.loop.poll();
    expect(f.requests.at(-1)).toMatchObject({ activeOperationIds: ['q12'], queuedOperationIds: [] });
    // q13 and q16 (names []): q13 goes, q16 stays and starts when q12 has ended well. (The chain of the sample, four waiting, does not fit a queue of three: BodyQueue's own
    // test in continueBody.test.ts takes all four.)
    const g = fixture();
    await g.deliver(item('q12', 'q12', null), item('q13', 'q13', 'q12'), item('q16', 'q16', 'q13', { dependsOn: [] }));
    await g.reply({ cancel: ['q13'] });
    expect((await g.receipts()).q13).toMatchObject({ outcome: 'cancelled', unit: { droppedBecause: { code: 'cancelled' } } });
    await g.loop.poll();
    expect(g.requests.at(-1)).toMatchObject({ activeOperationIds: ['q12'], queuedOperationIds: ['q16'] });
    g.running.get('q12')!.finish(); await tick(2);
    expect(g.started.map(entry => entry.id)).toEqual(['q12', 'q16']);
    await f.loop.stop(); await g.loop.stop();
  });
});

describe('the lapses come first (fixtures continue/death-before-depends.json, life/*.json)', () => {
  it('death-before-depends: a death drops what waits whatever it says it depends on, stops what runs, and the end of the running item brings nothing back', async () => {
    const scene = sample('continue/death-before-depends.json');
    const f = fixture({ life: scene.input.waiting[0].madeIn.life });
    await f.deliver(itemIn(4, 'q1', 'q1', null), itemIn(4, 'q2', 'q2', 'q1', { dependsOn: [] }));
    expect(f.started.map(entry => entry.id)).toEqual(['q1']);
    f.die();                                                   // t 1: life 4 -> 5
    await tick(2);                                             // t 1.1: q1 ends, cut by the death
    const out = await f.receipts();
    expect(f.running.get('q1')!.signal.reason).toBe('death');
    expect(out.q2).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped', unit: { goal: 'not_started', end: 'not_run', droppedBecause: scene.expected.q2.droppedBecause } });
    // The reason is the death, not the dependency table: the item that ended did not fail it (the receipt says the lapse, nothing about q1's end).
    expect(out.q2!.unit?.droppedBecause?.item).toBeUndefined();
    expect(f.started.map(entry => entry.id)).toEqual(['q1']);
    await f.loop.stop();
  });

  it('portal-pending-other-dimension: an item that waited and was made in the other dimension\'s generation is not started (dimension_changed); the item that went through the portal is not hindered', async () => {
    const scene = sample('life/portal-pending-other-dimension.json');
    const f = fixture({ life: scene.input.waiting[0].madeIn.life });
    await f.deliver(itemIn(4, 'q1', 'q1', null), itemIn(4, 'q2', 'q2', 'q1', { dependsOn: [] }));
    f.enterDimension('the_nether', 'd2');                      // q1's portal hand carried the body off; same life
    expect(f.running.get('q1')!.signal.aborted).toBe(false);
    f.running.get('q1')!.finish(); await tick(2);
    const out = await f.receipts();
    expect(out.q1).toMatchObject({ outcome: 'completed', unit: { goal: scene.expected.q1.goal, end: 'finished' } });
    expect(out.q2).toMatchObject({ outcome: 'failed', failureType: 'dimension_changed', inputsReleased: true, unit: { goal: 'not_started', end: 'not_run', droppedBecause: scene.expected.q2.droppedBecause } });
    expect(f.started.map(entry => entry.id)).toEqual(['q1']);
    // A command whose decision read the old generation is refused at once as well; one that read the new one starts.
    await f.deliver(itemIn(4, 'q3', 'q3', null));
    await f.deliver(itemIn(4, 'q4', 'q4', null, { madeIn: { ...MADE_IN, life: 4, dimSince: 'd2', dim: 'the_nether' } }));
    const again = await f.receipts();
    expect(again.q3).toMatchObject({ failureType: 'dimension_changed', unit: { droppedBecause: { code: 'dimension_changed' } } });
    expect(f.started.map(entry => entry.id)).toEqual(['q1', 'q4']);
    await f.loop.stop();
  });

  it('head-boot-registration: the head\'s start-up id is the last reply\'s; a new one drops the waiting items of the old head and stops its running one, and refuses its commands afterwards', async () => {
    const scene = sample('life/head-boot-registration.json');
    const forHead = (headBoot: string, id: string, name: string, after: string | null) =>
      item(id, name, after, { madeIn: { ...MADE_IN, headBoot } }, { context: { ...context, headBoot } });
    const f = fixture();
    await f.reply({ headBoot: 'hb-1', commands: [forHead('hb-1', 'q1', 'q1', null)] });
    await f.reply({ headBoot: 'hb-1', commands: [forHead('hb-1', 'q2', 'q2', 'q1')] });
    expect(f.started.map(entry => entry.id)).toEqual(['q1']);
    await f.reply({ headBoot: 'hb-2' });
    expect(scene.expected.currentHeadBoot).toBe('hb-2');
    expect(f.now.headBoot).toBe('hb-2');
    expect(f.running.get('q1')!.signal.reason).toBe('connection_changed');
    await tick(2);
    await f.reply({ headBoot: 'hb-2', commands: [forHead('hb-1', 'q9', 'q9', null)] });
    const out = await f.receipts();
    expect(out.q2).toMatchObject({ outcome: 'cancelled', failureType: 'queue_dropped', unit: { droppedBecause: scene.expected.q2.droppedBecause } });
    expect(out.q9).toMatchObject({ outcome: 'failed', failureType: scene.expected.q9.refused, inputsReleased: true, unit: { goal: 'not_started', end: 'not_run' } });
    // A command made for the head now is taken.
    await f.deliver(forHead('hb-2', 'q10', 'q10', null));
    expect(f.started.map(entry => entry.id)).toEqual(['q1', 'q10']);
    await f.loop.stop();
  });

  it('death-at-each-moment: in the hand, in the queue and before a late decision\'s command arrives, nothing of the old life starts or goes on after the death', async () => {
    const scene = sample('life/death-at-each-moment.json');
    expect(scene.input.moments).toEqual(['running_hand', 'waiting_for_reflex', 'queued', 'awaiting_model']);
    expect(scene.expected.each).toEqual({ oldLifeMotorOpsAfterDeath: 0, oldWaitingStarted: 0 });
    const f = fixture({ life: 4 });
    // running_hand and queued: q1 runs, q2 waits (it names nothing to wait for either way).
    await f.deliver(itemIn(4, 'q1', 'q1', null), itemIn(4, 'q2', 'q2', 'q1', { dependsOn: [] }));
    const startsBefore = f.started.length;
    f.die();
    await tick(2);
    expect(f.running.get('q1')!.signal.aborted).toBe(true);
    expect(f.running.get('q1')!.signal.reason).toBe('death');
    const out = await f.receipts();
    expect(out.q2).toMatchObject({ outcome: 'cancelled', unit: { droppedBecause: { code: scene.expected.queued.droppedBecause } } });
    // awaiting_model: the decision read the old life; its command comes after the death (also after the respawn) and is not started. A command of the new life is.
    await f.deliver(itemIn(4, 'q3', 'q3', null));
    f.respawn();
    await f.deliver(itemIn(4, 'q4', 'q4', null));
    await f.deliver(itemIn(5, 'q5', 'q5', null));
    const late = await f.receipts();
    expect(late.q3).toMatchObject({ outcome: 'failed', failureType: 'stale_life', unit: { goal: 'not_started', end: 'not_run' } });
    expect(late.q4).toMatchObject({ outcome: 'failed', failureType: 'stale_life', unit: { goal: 'not_started', end: 'not_run' } });
    expect(f.started.slice(startsBefore).map(entry => entry.id)).toEqual(['q5']);
    expect(f.started.map(entry => entry.id)).not.toContain('q2');
    await f.loop.stop();
  });

  it('a body that is dead starts nothing, whatever life the command was made for; the first lapse that applies is the reason (connection before life)', async () => {
    const f = fixture({ life: 4 });
    f.die(); f.die();                                          // life 6, not alive
    await f.deliver(itemIn(6, 'a', 'q1', null));
    expect((await f.receipts()).a).toMatchObject({ failureType: 'not_alive' });
    f.respawn();
    await f.deliver(itemIn(4, 'b', 'q2', null, { madeIn: { ...MADE_IN, life: 4, connectionId: 'other-connection' } }, { context: { ...context, life: 4 } }));
    expect((await f.receipts()).b).toMatchObject({ failureType: 'connection_changed' });
    expect(f.started).toHaveLength(0);
    // madeFor (the helper the other tests use) reads the same numbers from this body's own observation.
    const made = madeFor(f.actuator);
    expect(made.madeIn).toMatchObject({ life: 6, dim: 'overworld', dimSince: 'd1', bodyBoot: 'bb-test', connectionId: 'connection1' });
    await f.loop.stop();
  });
});
