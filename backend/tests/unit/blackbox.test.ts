import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { BLACKBOX_WINDOW_MS, installBlackBox } from '../../src/services/minebot/utils/blackbox.js';
import { heavyReason, holdsFor, Incidents } from '../../src/services/minebot/utils/incidents.js';
import { regionsAround, SceneSaver, selfNames } from '../../src/services/minebot/utils/sceneSave.js';

// 2026-10-28 (owner: 「黒箱・現場の保存・止めて直す実走」): the body's black box, the scene of a heavy failure, and the hold of a fix run.
const dirs: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fakeBot(clock: { t: number }) {
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(10.5, 64, -3.5), velocity: new Vec3(0, -0.08, 0), onGround: true, yaw: 1, pitch: 0 },
    health: 20, food: 18, game: { dimension: 'overworld' }, controlState: { forward: true, jump: false } as Record<string, boolean>,
    entities: {} as Record<string, any>, inventory: { slots: Object.assign(new Array(46).fill(null), { 36: { name: 'cobblestone', count: 12 }, 5: { name: 'iron_helmet', count: 1 } }) },
    heldItem: { name: 'cobblestone' },
    dig: async () => undefined,
    placeBlock: async () => { throw new Error('No block has been placed : the server did not answer within 5000ms'); },
    attack: () => undefined,
    pathfinder: { getPathFromTo: function* () { yield { result: { status: 'success', visitedNodes: 42, time: 7, path: [{ x: 11, y: 64, z: -3 }, { x: 12, y: 64, z: -3 }] } }; } },
  });
  bot.entities[2] = { id: 2, name: 'zombie', type: 'hostile', position: new Vec3(13, 64, -3), health: 20 };
  return bot;
}
const ticks = (bot: any, clock: { t: number }, n: number) => { for (let i = 0; i < n; i++) { clock.t += 50; bot.emit('physicsTick'); } };

describe('the black box', () => {
  it('keeps the ticks, the searches, the places with the server\'s answer, corrections and creatures of the last 90 s, and writes them', async () => {
    const clock = { t: 1_000_000 }, root = temp();
    const bot = fakeBot(clock);
    const box = installBlackBox(bot, root, () => clock.t);
    box.task = 'task-1';
    ticks(bot, clock, 40);
    const generator = bot.pathfinder.getPathFromTo({}, bot.entity.position, { x: 12, y: 64, z: -3, constructor: { name: 'GoalBlock' } }, { timeout: 5000 });
    generator.next();
    await expect(bot.placeBlock({ position: new Vec3(11, 63, -3), name: 'stone' }, new Vec3(0, 1, 0))).rejects.toThrow();
    bot.entity.position = new Vec3(10.5, 64.4, -3.5); bot.emit('forcedMove');
    bot.emit('blockUpdate', { name: 'air', position: new Vec3(11, 64, -3) }, { name: 'cobblestone', position: new Vec3(11, 64, -3) });
    bot.health = 14; bot.emit('entityHurt', bot.entity);
    ticks(bot, clock, 10);
    const written = await box.dump('act', 'go_stuck', { id: 'case-1', act: { command: 'c1', arguments: { hands: [{ do: 'go' }] } } });
    expect(written?.file).toBe(path.join(root, 'task-1', 'case-1.json.gz'));
    const dumped = JSON.parse(gunzipSync(fs.readFileSync(written!.file)).toString('utf8'));
    expect(dumped.ticks).toHaveLength(50);
    expect(dumped.ticks[0].slice(1, 9)).toEqual([10.5, 64, -3.5, 0, -0.08, 0, 1, 1]);
    const kinds = dumped.events.map((event: any) => event.k);
    expect(kinds).toEqual(expect.arrayContaining(['search', 'place', 'forced', 'block', 'hurt']));
    expect(dumped.events.find((event: any) => event.k === 'search')).toMatchObject({ status: 'success', nodes: 42, ms: 7, len: 2, end: [12, 64, -3] });
    expect(dumped.events.find((event: any) => event.k === 'place')).toMatchObject({ at: [11, 64, -3], ok: false, error: expect.stringContaining('did not answer') });
    expect(dumped.events.find((event: any) => event.k === 'hurt').near[0]).toMatchObject({ id: 2, name: 'zombie' });
    expect(dumped.near.at(-1).c[0]).toEqual([2, 'zombie', 13, 64, -3, 20]);
    expect(dumped.body).toMatchObject({ health: 14, items: [{ slot: 36, name: 'cobblestone', count: 12 }], armor: [{ slot: 5, name: 'iron_helmet' }] });
    expect(dumped.stats.ticks).toBe(50);
    // Older than the window is gone.
    clock.t += BLACKBOX_WINDOW_MS + 1000; ticks(bot, clock, 1);
    expect(box.snapshot('x', 'y').ticks).toHaveLength(1);
  });

  it('wraps placeBlock again when a plugin put its own over it after the box (promptPlace), before the next act', async () => {
    const clock = { t: 1_500_000 };
    const bot = fakeBot(clock);
    const box = installBlackBox(bot, temp(), () => clock.t);
    bot.placeBlock = async () => { throw new Error('No block has been placed : the server did not answer within 1500ms'); };
    box.ensureWrapped();
    await expect(bot.placeBlock({ position: new Vec3(1, 63, 1), name: 'stone' }, new Vec3(0, 1, 0))).rejects.toThrow();
    box.ensureWrapped();
    await expect(bot.placeBlock({ position: new Vec3(1, 63, 1), name: 'stone' }, new Vec3(0, 1, 0))).rejects.toThrow();
    expect(box.snapshot('x', 'y').events.filter(event => event.k === 'place')).toHaveLength(2);
  });

  it('costs little on the tick (measured, said in every file)', () => {
    const clock = { t: 2_000_000 };
    const bot = fakeBot(clock);
    for (let i = 0; i < 40; i++) bot.entities[100 + i] = { id: 100 + i, name: 'cow', type: 'passive', position: new Vec3(10 + (i % 8), 64, -3 + Math.floor(i / 8)) };
    const box = installBlackBox(bot, temp(), () => clock.t);
    ticks(bot, clock, 2000);
    const stats = box.stats();
    expect(stats.ticks).toBe(2000);
    expect(stats.meanUs).toBeLessThan(500);
  });
});

describe('heavy or light', () => {
  const lines = (line: string, d = 'go') => ({ ok: false, lines: [{ i: 1, do: d, status: 'stopped' as const, line }] });
  it('a go stuck, out of search time, or at its limit with few steps; a minute lost; near death; a death; the first of a kind', () => {
    const seen = new Set<string>();
    expect(heavyReason(lines('go 止まった stuck: 置いたブロックが世界に現れない (196,40,209) 道 61 歩・掘 24・置 28・引き直し 12 回') as never, 9000, 18, false, seen, 't')).toBe('go_stuck');
    expect(heavyReason(lines('go 止まった search_timeout: 道探しが…') as never, 9000, 18, false, seen, 't')).toBe('go_search_timeout');
    expect(heavyReason(lines('go 止まった limit_time: 120 秒の上限に着いた (153,2,226) 道 3 歩・掘 0・置 0・引き直し 1 回') as never, 125_000, 18, false, seen, 't')).toBe('go_limit_time_low:3');
    expect(heavyReason(lines('go 止まった limit_time: 120 秒の上限に着いた 道 122 歩・掘 81') as never, 120_000, 18, false, seen, 't')).toBe('long:120s');
    expect(heavyReason(lines('無い: mine 止まった no_block: …', 'mine') as never, 3000, 3.5, false, seen, 't')).toBe('near_death:3.5');
    expect(heavyReason(lines('無い: mine 止まった no_block: …', 'mine') as never, 3000, 18, true, seen, 't')).toBe('death');
    expect(heavyReason(lines('無い: mine 止まった no_block: …', 'mine') as never, 3000, 18, false, seen, 't')).toBe('first:mine/no_block');
    expect(heavyReason(lines('無い: mine 止まった no_block: …', 'mine') as never, 3000, 18, false, seen, 't')).toBeNull();
    expect(heavyReason({ ok: true, lines: [] } as never, 125_000, 2, true, seen, 't')).toBeNull();
  });
  it('holds only for a go stuck, out of search time or at its time with few steps, a minute lost, near death and a death (not the first of a kind)', () => {
    for (const reason of ['go_stuck', 'go_search_timeout', 'go_limit_time_low:3', 'long:61s', 'near_death:3.5', 'death']) expect(holdsFor(reason), reason).toBe(true);
    for (const reason of ['first:mine/no_block', null]) expect(holdsFor(reason)).toBe(false);
  });
});

describe('the scene and the hold', () => {
  function server(players: string) {
    const serverDir = temp();
    const world = path.join(serverDir, 'my_world');
    fs.mkdirSync(path.join(world, 'region'), { recursive: true }); fs.mkdirSync(path.join(world, 'entities'), { recursive: true }); fs.mkdirSync(path.join(serverDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'server.properties'), 'level-name=my_world\n');
    fs.writeFileSync(path.join(world, 'level.dat'), 'L');
    for (const file of regionsAround(10, -3)) { fs.writeFileSync(path.join(world, 'region', file), 'R'); fs.writeFileSync(path.join(world, 'entities', file), 'E'); }
    fs.writeFileSync(path.join(serverDir, 'logs', 'latest.log'), "[10:00:00] [Server thread/INFO]: Done\n");
    const said: string[] = [];
    const saver = new SceneSaver({ serverDir, root: path.join(serverDir, 'scenes'), self: () => ['MinebotTrial'], ignore: ['ShannonProbe'],
      command: async text => { said.push(text); return text === 'list' ? `There are 2 of a max of 20 players online: ${players}` : text.startsWith('save-all') ? 'Saved the game' : 'ok'; } });
    return { saver, said, serverDir };
  }
  it('saves the region, entities and level.dat around the body after save-all, and does not freeze with anyone else on', async () => {
    const { saver, said, serverDir } = server('MinebotTrial, ShannonProbe');
    expect(regionsAround(10, -3)).toEqual(['r.-1.-1.mca', 'r.-1.0.mca', 'r.0.-1.mca', 'r.0.0.mca']);
    const result = await saver.save('s1', [10, 64, -3], 'minecraft:overworld', { box: 's1' });
    expect(said[0]).toBe('save-all flush');
    expect(result.ok).toBe(true);
    expect(result.files).toEqual(expect.arrayContaining(['world/level.dat', 'world/region/r.0.0.mca', 'world/entities/r.-1.-1.mca']));
    expect(JSON.parse(fs.readFileSync(path.join(serverDir, 'scenes', 's1', 'scene.json'), 'utf8'))).toMatchObject({ id: 's1', box: 's1', ok: true });
    expect((await saver.freeze()).frozen).toBe(true);
    const busy = server('MinebotTrial, ShannonProbe, Rai1241').saver;
    expect(await busy.freeze()).toEqual({ frozen: false, why: 'others_present:Rai1241' });
  });

  it('holds a task on a heavy failure that asked for it, refuses its acts across a restart, and lets the resume through', async () => {
    const clock = { t: 3_000_000 };
    const { saver, said } = server('MinebotTrial');
    const holdFile = path.join(temp(), 'hold.json');
    const bot = fakeBot(clock);
    installBlackBox(bot, temp(), () => clock.t);
    const first = new Incidents(bot, { holdFile, scene: saver, now: () => clock.t });
    const context = { taskId: 'task-9', incident: { hold: true } };
    expect(await first.beforeAct(context)).toBeNull();
    const report = { ok: false, startedAt: clock.t, done: 0, of: 1, lines: [{ i: 1, do: 'go' as const, status: 'stopped' as const, line: 'go 止まった stuck: …' }] };
    const incident = (await first.afterAct({ id: 'cmd-1', context, arguments: { hands: [] } }, report as never, 8000))!;
    expect(incident).toMatchObject({ heavy: true, held: true, frozen: true, why: 'go_stuck' });
    expect(said).toEqual(expect.arrayContaining(['list', 'tick freeze', 'save-all flush']));
    expect(said.indexOf('tick freeze')).toBeLessThan(said.indexOf('save-all flush'));
    expect(incident.box).toMatch(/task-9/u);
    expect(await first.beforeAct({ taskId: 'task-9' })).toMatch(/^保留中/u);
    // A new body (a restart): still held, from the file.
    const second = new Incidents(fakeBot(clock), { holdFile, scene: saver, now: () => clock.t });
    expect(await second.beforeAct({ taskId: 'task-9' })).toMatch(/^保留中/u);
    expect(await second.beforeAct({ taskId: 'task-9', incident: { resume: 'other' } })).toMatch(/^保留中/u);
    expect(await second.beforeAct({ taskId: 'task-9', incident: { resume: incident.id } })).toBeNull();
    expect(said.at(-1)).toBe('tick unfreeze');
    expect(fs.existsSync(holdFile)).toBe(false);
    expect(incident.start).toEqual([10.5, 64, -3.5]);
    // The first of a kind: the box and the scene, no hold (the coordinator's choice of 2026-10-28).
    const light = await second.afterAct({ id: 'cmd-2', context: { taskId: 'task-9', incident: { hold: true } } },
      { ...report, lines: [{ i: 1, do: 'mine', status: 'stopped', line: '無い: mine 止まった no_block' }] } as never, 2000);
    expect(light).toMatchObject({ heavy: true, why: 'first:mine/no_block', held: false });
    expect(await second.beforeAct({ taskId: 'task-9' })).toBeNull();
    const again = await second.afterAct({ id: 'cmd-3', context: { taskId: 'task-9' } }, { ...report, lines: [{ i: 1, do: 'mine', status: 'stopped', line: '無い: mine 止まった no_block' }] } as never, 2000);
    expect(again).toMatchObject({ heavy: false, held: false, scene: null });
    // Held again, then cancelled by the operator: the world moves and the hold ends.
    const held = (await second.afterAct({ id: 'cmd-4', context: { taskId: 'task-9', incident: { hold: true } } }, report as never, 8000))!;
    expect(held.held).toBe(true);
    expect(await second.cancel('not-this')).toEqual({ done: false, hold: held.id, unfreeze: null });
    expect(await second.cancel(held.id)).toMatchObject({ done: true, hold: null });
    expect(said.at(-1)).toBe('tick unfreeze');
    expect(fs.existsSync(holdFile)).toBe(false);
    expect(await second.beforeAct({ taskId: 'task-9' })).toBeNull();
  });
});

describe('run 44, hold 1: the body counted itself as someone else, held in a moving world, and died', () => {
  const HOLD1 = { id: '20261027T184214-act-vpvqh', task: 'ca51baee-7f08-4c6c-83fa-ae5eb1a2460a', at: '2026-10-27T18:42:15.255Z', frozen: false,
    freeze: 'others_present:I_am_Shannon', command: 'skill:ff8884d2', why: 'go_stuck', start: [222.5, 66, 206.5] };
  function lab(players: string, self: () => ReadonlyArray<string | null | undefined>) {
    const serverDir = temp();
    fs.mkdirSync(path.join(serverDir, 'world', 'region'), { recursive: true }); fs.mkdirSync(path.join(serverDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'world', 'level.dat'), 'L');
    for (const file of regionsAround(10, -3)) fs.writeFileSync(path.join(serverDir, 'world', 'region', file), 'R');
    fs.writeFileSync(path.join(serverDir, 'logs', 'latest.log'), '');
    const said: string[] = [];
    const saver = new SceneSaver({ serverDir, root: path.join(serverDir, 'scenes'), self,
      command: async text => { said.push(text); return text === 'list' ? `There are 1 of a max of 20 players online: ${players}` : text.startsWith('save-all') ? 'Saved the game' : 'ok'; } });
    return { saver, said };
  }

  it('reads the body\'s own name at the freeze, not when the body was made (before its login gave it one), and without case', async () => {
    const bot: any = { username: undefined, _client: {} };
    const { saver, said } = lab('I_am_Shannon', () => selfNames(bot));
    // Made before the login, as client.ts makes it: the old ports read [''] here and called the body someone else.
    bot.username = 'I_am_Shannon'; bot._client.username = 'i_am_shannon';
    expect(await saver.freeze()).toMatchObject({ frozen: true });
    expect(said).toEqual(['list', 'tick freeze']);
    expect(selfNames({ username: 'A', _client: { username: 'b' } })).toEqual(['A', 'b']);
    expect(await lab('I_am_Shannon, Rai1241', () => selfNames(bot)).saver.freeze()).toEqual({ frozen: false, why: 'others_present:Rai1241' });
  });

  it('does not hold when the world cannot be stopped: the box and the scene are taken, the receipt says why, and the task goes on', async () => {
    const clock = { t: 5_000_000 };
    const { saver, said } = lab('MinebotTrial, Rai1241', () => ['MinebotTrial']);
    const holdFile = path.join(temp(), 'hold.json');
    const bot = fakeBot(clock);
    installBlackBox(bot, temp(), () => clock.t);
    const incidents = new Incidents(bot, { holdFile, scene: saver, now: () => clock.t });
    const context = { taskId: 'task-44', incident: { hold: true } };
    expect(await incidents.beforeAct(context)).toBeNull();
    const report = { ok: false, startedAt: clock.t, done: 0, of: 1, lines: [{ i: 1, do: 'go' as const, status: 'stopped' as const, line: 'go 止まった stuck: …' }] };
    const incident = (await incidents.afterAct({ id: 'cmd-1', context, arguments: { hands: [] } }, report as never, 8000))!;
    expect(incident).toMatchObject({ heavy: true, held: false, frozen: false, freeze: 'others_present:Rai1241', notHeld: 'others_present:Rai1241' });
    expect(incident.box).toMatch(/task-44/u);
    expect(incident.scene).not.toBeNull();
    expect(said).not.toContain('tick freeze');
    expect(fs.existsSync(holdFile)).toBe(false);
    expect(incidents.hold).toBeNull();
    expect(await incidents.beforeAct(context)).toBeNull();
  });

  it('reads hold 1\'s own file (written as not frozen) after a new body, holds its acts, and moves the world on the resume (stopped by hand)', async () => {
    const clock = { t: 6_000_000 };
    const { saver, said } = lab('I_am_Shannon', () => ['I_am_Shannon']);
    const holdFile = path.join(temp(), 'incident-hold.json');
    fs.writeFileSync(holdFile, JSON.stringify(HOLD1));
    const incidents = new Incidents(fakeBot(clock), { holdFile, scene: saver, now: () => clock.t });
    expect(await incidents.beforeAct({ taskId: HOLD1.task })).toMatch(/^保留中（20261027T184214-act-vpvqh: go_stuck）/u);
    expect(said).toEqual([]);
    expect(await incidents.beforeAct({ taskId: HOLD1.task, incident: { resume: HOLD1.id } })).toBeNull();
    expect(said).toEqual(['tick unfreeze']);
    expect(fs.existsSync(holdFile)).toBe(false);
    // The cancel and a stale hold move the world too, whatever the file says.
    fs.writeFileSync(holdFile, JSON.stringify(HOLD1));
    const cancelled = new Incidents(fakeBot(clock), { holdFile, scene: saver, now: () => clock.t });
    expect(await cancelled.cancel(HOLD1.id)).toMatchObject({ done: true });
    fs.writeFileSync(holdFile, JSON.stringify(HOLD1));
    const stale = new Incidents(fakeBot(clock), { holdFile, scene: saver, now: () => clock.t });
    expect(await stale.beforeAct({ taskId: 'another-task' })).toBeNull();
    expect(said).toEqual(['tick unfreeze', 'tick unfreeze', 'tick unfreeze']);
  });
});
