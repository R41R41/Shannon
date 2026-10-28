import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { installBlackBox } from '../../src/services/minebot/utils/blackbox.js';
import { Incidents, installIncidents, readTake, TAKE_NOTES } from '../../src/services/minebot/utils/incidents.js';
import { regionsAround, SceneSaver } from '../../src/services/minebot/utils/sceneSave.js';
import { NativeCommonFcaBody } from '../../src/services/minebot/integration/commonFca/nativeBody.js';
import { ACT_HANDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
import { createMotorPort } from '../../src/services/minebot/execution/ActionExecution.js';
import { madeFor } from './helpers/madeFor.js';

// Amendment A-12 (body) (the coordinator's request of 2026-10-29): the head finds a stall itself and asks the body to hold the task (`context.incident.take` = { id, why, notes? }): the world
// stopped, the box with the notes, the scene, the hold file; its resume and cancel name the head's own id.
const dirs: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headtake-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fakeBot() {
  return Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(10.5, 64, -3.5), velocity: new Vec3(0, -0.08, 0), onGround: true, yaw: 1, pitch: 0 },
    username: 'headtake', health: 20, food: 18, game: { dimension: 'overworld' }, controlState: {} as Record<string, boolean>, entities: {} as Record<string, any>,
    inventory: { items: () => [], slots: new Array(46).fill(null) }, heldItem: null, executingSkill: false, interruptExecution: false,
    clearControlStates: () => undefined, setControlState: () => undefined, look: async () => undefined, stopDigging: () => undefined,
  }) as any;
}
function server(players: string) {
  const serverDir = temp();
  const world = path.join(serverDir, 'my_world');
  fs.mkdirSync(path.join(world, 'region'), { recursive: true }); fs.mkdirSync(path.join(world, 'entities'), { recursive: true }); fs.mkdirSync(path.join(serverDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'server.properties'), 'level-name=my_world\n'); fs.writeFileSync(path.join(world, 'level.dat'), 'L');
  for (const file of regionsAround(10, -3)) { fs.writeFileSync(path.join(world, 'region', file), 'R'); fs.writeFileSync(path.join(world, 'entities', file), 'E'); }
  fs.writeFileSync(path.join(serverDir, 'logs', 'latest.log'), '');
  const said: string[] = [];
  const saver = new SceneSaver({ serverDir, root: path.join(serverDir, 'scenes'), self: () => ['headtake'], ignore: [],
    command: async text => { said.push(text); return text === 'list' ? `There are 1 of a max of 20 players online: ${players}` : text.startsWith('save-all') ? 'Saved the game' : 'ok'; } });
  return { saver, said };
}
const HEAD_ID = 'head:node_stalled:p3:1793164759174';
const take = { id: HEAD_ID, why: '節 p3 が 120 秒、進みが無い', notes: Array.from({ length: 30 }, (_, index) => `row ${index}`) };

describe('A-12 (body): the head asks for the hold (context.incident.take)', () => {
  it('stops the world, then writes the scene and the box with the head\'s reason and the last 20 rows, keeps the hold under the head\'s id, and refuses the task\'s acts until its resume', async () => {
    const { saver, said } = server('headtake');
    const holdFile = path.join(temp(), 'hold.json');
    const bot = fakeBot();
    installBlackBox(bot, temp(), () => 1_000);
    const incidents = new Incidents(bot, { holdFile, scene: saver, now: () => 1_000 });
    const result = (await incidents.take({ taskId: 'task-9', incident: { take } }))!;
    expect(result).toMatchObject({ done: true, hold: HEAD_ID, incident: { id: HEAD_ID, kind: 'head', held: true, frozen: true, why: take.why } });
    expect(said.indexOf('tick freeze')).toBeGreaterThanOrEqual(0);
    expect(said.indexOf('tick freeze')).toBeLessThan(said.indexOf('save-all flush'));
    // The box: a file whose name is safe, with the head's id, reason and the last 20 rows.
    const file = result.incident!.box!;
    expect(path.basename(file)).not.toMatch(/[:]/u);
    const box = JSON.parse(gunzipSync(fs.readFileSync(file)).toString('utf8'));
    expect(box).toMatchObject({ kind: 'head', task: 'task-9', reason: take.why, head: { id: HEAD_ID, why: take.why } });
    expect(box.head.notes).toHaveLength(TAKE_NOTES);
    expect(box.head.notes[0]).toBe('row 10'); expect(box.head.notes.at(-1)).toBe('row 29');
    expect(result.incident!.scene).toMatch(/headtake|head_node_stalled/u);
    expect(JSON.parse(fs.readFileSync(holdFile, 'utf8'))).toMatchObject({ id: HEAD_ID, task: 'task-9', frozen: true, why: take.why });
    expect(incidents.held()).toEqual({ id: HEAD_ID, task: 'task-9', why: take.why });
    expect(await incidents.beforeAct({ taskId: 'task-9' })).toMatch(/^保留中/u);
    // The same take again is the same hold; another id while this one is kept changes nothing.
    expect(await incidents.take({ taskId: 'task-9', incident: { take } })).toMatchObject({ done: true, hold: HEAD_ID, again: true });
    expect(await incidents.take({ taskId: 'task-9', incident: { take: { id: 'head:other', why: 'x' } } })).toMatchObject({ done: false, hold: HEAD_ID });
    // A resume that names the head's id moves the world again and clears the hold; a second one, with nothing held, is done too.
    expect(await incidents.resume('head:other')).toMatchObject({ done: false, hold: HEAD_ID });
    expect(await incidents.resume(HEAD_ID)).toEqual({ done: true, hold: null, unfreeze: 'ok' });
    expect(said.at(-1)).toBe('tick unfreeze');
    expect(fs.existsSync(holdFile)).toBe(false);
    expect(incidents.held()).toBeNull();
    expect(await incidents.resume(HEAD_ID)).toMatchObject({ done: true, hold: null });
    expect(await incidents.beforeAct({ taskId: 'task-9' })).toBeNull();
  });

  it('does not hold a world with someone else on it: the scene and the box are taken, notHeld says why', async () => {
    const { saver, said } = server('headtake, Rai1241');
    const holdFile = path.join(temp(), 'hold.json');
    const bot = fakeBot();
    installBlackBox(bot, temp(), () => 1_000);
    const incidents = new Incidents(bot, { holdFile, scene: saver, now: () => 1_000 });
    const result = (await incidents.take({ taskId: 'task-9', incident: { take } }))!;
    expect(result).toMatchObject({ done: true, hold: null, incident: { held: false, frozen: false, notHeld: 'others_present:Rai1241' } });
    expect(result.incident!.box).toBeTruthy(); expect(result.incident!.scene).toBeTruthy();
    expect(said).not.toContain('tick freeze');
    expect(fs.existsSync(holdFile)).toBe(false);
    expect(await incidents.beforeAct({ taskId: 'task-9' })).toBeNull();
  });

  it('reads a take only with an id and a reason, keeps the last 20 notes, and cuts a long line', () => {
    expect(readTake(undefined)).toBeNull();
    expect(readTake({ id: '', why: 'x' })).toBeNull();
    expect(readTake({ id: 'a', why: 5 })).toBeNull();
    expect(readTake({ id: 'a', why: 'w', notes: ['x'.repeat(900), 3, 'y'] })).toEqual({ id: 'a', why: 'w', notes: ['x'.repeat(400), 'y'] });
    expect(readTake(take)!.notes).toHaveLength(20);
  });

  it('through the body: a release that carries the take says what was kept in the receipt, and a release naming the id ends it; an act that carries it is refused as held with the incident', async () => {
    const { saver, said } = server('headtake');
    const holdFile = path.join(temp(), 'hold.json');
    const bot = fakeBot();
    installBlackBox(bot, temp());
    installIncidents(bot, { holdFile, scene: saver });
    const act: any = { skillName: 'act', description: 'act', isToolForLLM: true, maxDurationMs: 180_000, params: [{ name: 'hands', type: 'json', schema: ACT_HANDS, description: 'hands', required: true }],
      run: vi.fn(async (hands: any) => runAct(createMotorPort(bot), hands)) };
    bot.instantSkills = { getSkills: () => [act] };
    const body = new NativeCommonFcaBody(bot, { serverId: 'home', capture: async () => ({ dataUrl: 'data:image/jpeg;base64,YQ==', capturedAt: new Date().toISOString() }) });
    const kept = await body.takeIncident({ taskId: 'task-9', incident: { take } } as never);
    expect(kept).toMatchObject({ done: true, hold: HEAD_ID, held: true, frozen: true });
    expect(kept!.box).toBeTruthy(); expect(kept!.scene).toBeTruthy();
    expect((body.observe().state as any).incidentHold).toMatchObject({ id: HEAD_ID, task: 'task-9' });
    const resumed = await body.resumeIncident(HEAD_ID);
    expect(resumed).toMatchObject({ done: true, hold: null });
    expect(said.at(-1)).toBe('tick unfreeze');
    // Nothing held: a resume is done (the world is moved anyway).
    expect(await body.resumeIncident('head:nothing')).toMatchObject({ done: true, hold: null });
  });
it('an act that carries the take is refused as held with the incident in its receipt, and runs with notHeld when the world cannot be stopped', async () => {
    for (const players of ['headtake', 'headtake, Rai1241']) {
      const { saver } = server(players);
      const bot = fakeBot();
      installBlackBox(bot, temp());
      installIncidents(bot, { holdFile: path.join(temp(), 'hold.json'), scene: saver });
      const act: any = { skillName: 'act', description: 'act', isToolForLLM: true, maxDurationMs: 180_000, params: [{ name: 'hands', type: 'json', schema: ACT_HANDS, description: 'hands', required: true }],
        run: vi.fn(async (hands: any) => runAct(createMotorPort(bot), hands)) };
      bot.instantSkills = { getSkills: () => [act] };
      const body = new NativeCommonFcaBody(bot, { serverId: 'home', capture: async () => ({ dataUrl: 'data:image/jpeg;base64,YQ==', capturedAt: new Date().toISOString() }) });
      const command = { schemaVersion: 1, id: 'skill:q1', serverId: 'home', connectionId: 'c1', kind: 'skill', skill: 'act', arguments: { hands: [{ do: 'wait', seconds: 0.1 }] },
        context: { scopeKey: 'o', taskId: 'task-9', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 's', generation: 1, goal: 'g', completionCondition: 'done', ...madeFor(body), incident: { take } },
        lease: { id: 'l', generation: 1, holder: 't' }, deadlineAt: new Date(Date.now() + 5000).toISOString() };
      const receipt: any = await body.execute(command as never, new AbortController().signal);
      const said = JSON.parse(receipt.result).incident;
      if (players === 'headtake') {
        expect(receipt).toMatchObject({ outcome: 'failed', failureType: 'held' });
        expect(said).toMatchObject({ id: HEAD_ID, held: true, frozen: true, box: true, scene: true });
      } else {
        expect(receipt.outcome).toBe('completed');
        expect(said).toMatchObject({ id: HEAD_ID, held: false, notHeld: 'others_present:Rai1241' });
      }
      await body.dispose();
    }
  });
});

