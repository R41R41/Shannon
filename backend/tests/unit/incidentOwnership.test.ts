import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { Incidents } from '../../src/services/minebot/utils/incidents.js';
import { installBlackBox } from '../../src/services/minebot/utils/blackbox.js';
import type { SceneSaver } from '../../src/services/minebot/utils/sceneSave.js';
import type { ActReport } from '../../src/services/minebot/utils/actReport.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const context = { taskId: 'run51', incident: { hold: true } };
const failed = { ok: false, done: 0, of: 1, lines: [{ i: 1, do: 'go', status: 'stopped', line: 'go 止まった search_timeout' }] } as ActReport;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(persisted = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r51-ownership-')); dirs.push(root);
  const holdFile = path.join(root, 'hold.json'), clock = { t: 1_000_000 }, calls: string[] = [];
  const bot = Object.assign(new EventEmitter(), { health: 2, food: 16,
    entity: { position: new Vec3(153, 36, -70) }, game: { dimension: 'overworld' }, inventory: { slots: [] }, entities: {} });
  const box = installBlackBox(bot, path.join(root, 'boxes'), () => clock.t);
  const block = { freeze: Promise.resolve(), save: Promise.resolve() };
  const scene = { async freeze() { calls.push('freeze'); await block.freeze; return { frozen: true, why: 'frozen' }; },
    async unfreeze() { calls.push('unfreeze'); return 'running'; },
    async save(id: string) { calls.push('save'); await block.save; return { ok: true, id, dir: path.join(root, id) }; } } as unknown as SceneSaver;
  if (persisted) fs.writeFileSync(holdFile, JSON.stringify({ id: 'old', task: 'run51', at: new Date(clock.t).toISOString(),
    frozen: true, command: '', why: 'near_death:2', start: null }));
  const incidents = new Incidents(bot, { holdFile, scene, now: () => clock.t });
  return { bot, box, clock, calls, block, holdFile, incidents };
}
async function until(check: () => boolean) {
  for (let n = 0; n < 100 && !check(); n++) await new Promise(r => setTimeout(r, 5));
  expect(check()).toBe(true);
}
const take = (f: ReturnType<typeof fixture>) => f.incidents.take({ ...context, incident: { take: { id: 'head:death', why: 'death' } } });

describe('run51: persisted ownership and atomic incident holds', () => {
  it.each(['death', 'health'])('owns %s after restart and resume, before any act', async kind => {
    const f = fixture(true);
    await f.incidents.resume('old');
    expect(f.box.task).toBe('run51');
    f.bot.health = kind === 'death' ? 0 : 1; f.bot.emit(kind);
    await until(() => f.incidents.held() !== null);
    expect(f.incidents.held()).toMatchObject({ task: 'run51', why: kind === 'death' ? 'death' : 'near_death:1.0' });
    expect(f.calls).toContain('freeze');
    expect(fs.readdirSync(path.join(path.dirname(f.holdFile), 'boxes', 'run51')).some(p => p.includes(kind))).toBe(true);
  });
  it('does not re-hold unchanged critical health immediately after resume', async () => {
    const f = fixture(true); await f.incidents.resume('old'); f.bot.emit('health');
    await turn(); await turn(); expect(f.incidents.held()).toBeNull(); expect(f.calls).toEqual(['unfreeze']);
  });
  it('cancel removes ownership before a subsequent death and does not re-hold the cancelled task', async () => {
    const f = fixture(true); await f.incidents.resume('old'); await f.incidents.cancel('old');
    f.bot.emit('death'); await until(() => f.calls.includes('save')); await turn(); await turn();
    expect(f.incidents.held()).toBeNull(); expect(f.calls).not.toContain('freeze');
  });
  it('restored ownership still expires after ten minutes without an act', async () => {
    const f = fixture(true); await f.incidents.resume('old'); f.clock.t += 600_001;
    f.bot.emit('death'); await until(() => f.calls.includes('save')); await turn(); await turn();
    expect(f.incidents.held()).toBeNull(); expect(f.calls).not.toContain('freeze');
  });
  it.each(['head', 'body'])('keeps the first hold when %s acquires while freeze and save are pending', async first => {
    const f = fixture(); await f.incidents.beforeAct(context);
    const freeze = deferred(), save = deferred(); f.block.freeze = freeze.promise; f.block.save = save.promise;
    const headFirst = first === 'head';
    const a = headFirst ? take(f) : f.incidents.afterAct({ id: 'act', context }, failed, 100);
    await turn(); expect(f.calls).toEqual(['freeze']);
    const b = headFirst ? f.incidents.afterAct({ id: 'act', context }, failed, 100) : take(f);
    await turn(); expect(f.calls).toEqual(['freeze']);
    freeze.resolve(); await turn(); save.resolve();
    const [left, right] = await Promise.all([a, b]);
    const kept = JSON.parse(fs.readFileSync(f.holdFile, 'utf8'));
    expect(f.incidents.held()?.id).toBe(kept.id); expect(f.calls.filter(c => c === 'freeze')).toHaveLength(1);
    if (headFirst) { expect(kept.id).toBe('head:death'); expect(right).toMatchObject({ id: kept.id, held: true }); }
    else { expect(left).toMatchObject({ id: kept.id, held: true }); expect(right).toMatchObject({ done: false, hold: kept.id }); }
  });
  it.each(['cancel', 'resume'] as const)('serializes %s behind a take in flight', async how => {
    const f = fixture(), frozen = deferred(); f.block.freeze = frozen.promise;
    const acquisition = take(f); await turn(); const release = f.incidents[how]('head:death'); await turn();
    expect(f.calls).toEqual(['freeze']); frozen.resolve(); await acquisition;
    expect(await release).toMatchObject({ done: true, hold: null });
    expect(f.incidents.held()).toBeNull(); expect(fs.existsSync(f.holdFile)).toBe(false); expect(f.calls.at(-1)).toBe('unfreeze');
  });
  it('does not admit an act while the take has not finished persisting', async () => {
    const f = fixture(), saved = deferred(); f.block.save = saved.promise;
    const acquisition = take(f); await turn(); const admission = f.incidents.beforeAct(context);
    let admitted = false; void admission.then(() => { admitted = true; }); await turn(); expect(admitted).toBe(false);
    saved.resolve(); await acquisition; expect(await admission).toContain('保留中');
  });
});
