import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { Incidents } from '../../src/services/minebot/utils/incidents.js';
import type { SceneSaver } from '../../src/services/minebot/utils/sceneSave.js';
import type { ActReport } from '../../src/services/minebot/utils/actReport.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const context = { taskId: 'run50', incident: { hold: true } };
const failed = { ok: false, done: 0, of: 1, lines: [{ i: 1, do: 'place', status: 'stopped', line: '支えになる面が無い' }] } as ActReport;
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r50-recovery-')); dirs.push(root);
  const clock = { t: 1_000_000 }, calls: string[] = [];
  const bot = Object.assign(new EventEmitter(), { health: 2, food: 16,
    entity: { position: new Vec3(153, 36, -70) }, game: { dimension: 'overworld' } });
  const scene = { async freeze() { calls.push('freeze'); return { frozen: true, why: 'The game is frozen' }; },
    async unfreeze() { calls.push('unfreeze'); return 'The game is running'; },
    async save(id: string) { return { ok: true, id, dir: path.join(root, id) }; } } as unknown as SceneSaver;
  const holdFile = path.join(root, 'hold.json');
  fs.writeFileSync(holdFile, JSON.stringify({ id: 'critical-hold', task: 'run50', at: new Date(clock.t).toISOString(),
    frozen: true, command: '', why: 'near_death:2.0', start: null }));
  const incidents = new Incidents(bot, { holdFile, scene, now: () => clock.t });
  return { bot, clock, calls, incidents, lose(hp: number) { bot.health = hp; bot.emit('health'); } };
}

describe('run50 hold2: resume allows recovery from acknowledged critical health', () => {
  it('does not re-hold a failed first placement at unchanged health after skip-replay, across a body restart', async () => {
    const f = fixture();
    await f.incidents.resume('critical-hold');
    await f.incidents.beforeAct(context);
    const result = await f.incidents.afterAct({ id: 'new-place', context }, failed, 100);
    expect(result?.held).toBe(false);
    expect(result?.why).not.toMatch(/^near_death/u);
    expect(f.calls).toEqual(['unfreeze']);
  });
  it('also acknowledges a resume carried directly on the next act', async () => {
    const f = fixture(), resumed = { ...context, incident: { hold: true, resume: 'critical-hold' } };
    await f.incidents.beforeAct(resumed);
    expect((await f.incidents.afterAct({ id: 'place', context: resumed }, failed, 100))?.held).toBe(false);
  });
  it('does not interpret a food-only health event as new near death between acts', async () => {
    const f = fixture(); await f.incidents.resume('critical-hold'); await f.incidents.beforeAct(context); f.incidents.endAct();
    f.clock.t += 20_000; f.bot.food = 20; f.bot.emit('health'); await settle();
    expect(f.incidents.held()).toBeNull(); expect(f.calls).toEqual(['unfreeze']);
  });
  it('holds for new damage during the resumed act, rather than suppressing it as the same failure kind', async () => {
    const f = fixture(), resumed = { ...context, incident: { hold: true, resume: 'critical-hold' } };
    await f.incidents.resume('critical-hold'); await f.incidents.beforeAct(resumed); f.lose(1);
    const result = await f.incidents.afterAct({ id: 'place', context: resumed }, failed, 100);
    expect(result).toMatchObject({ held: true, why: 'near_death:1' }); expect(result?.repeated).toBeUndefined();
  });
  it.each([[1], [3, 2.5], [5, 3]])('holds on a new critical decline between acts: %s', async (...values) => {
    const f = fixture(); await f.incidents.resume('critical-hold'); await f.incidents.beforeAct(context); f.incidents.endAct();
    for (const hp of values.flat()) f.lose(hp);
    await settle(); expect(f.incidents.held()?.why).toMatch(/^near_death/u); expect(f.calls).toContain('freeze');
  });
  it('does not carry the acknowledgement into a different task', async () => {
    const f = fixture(); await f.incidents.resume('critical-hold');
    const other = { ...context, taskId: 'other' }; await f.incidents.beforeAct(other);
    expect((await f.incidents.afterAct({ id: 'place', context: other }, failed, 100))?.held).toBe(true);
  });
  it('still holds for death and other heavy failures', async () => {
    const f = fixture(); await f.incidents.resume('critical-hold'); await f.incidents.beforeAct(context); f.incidents.endAct();
    f.bot.emit('death'); await settle(); expect(f.incidents.held()?.why).toBe('death');
    const g = fixture(); await g.incidents.resume('critical-hold'); await g.incidents.beforeAct(context);
    expect((await g.incidents.afterAct({ id: 'go', context }, { ...failed, lines: [{ i: 1, do: 'go', status: 'stopped', line: 'go 止まった stuck: 道が無い' }] } as ActReport, 100))?.why).toBe('go_stuck');
  });
});
