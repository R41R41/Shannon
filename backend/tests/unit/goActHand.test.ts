import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSim, type Ground, type Sim } from '../helpers/physicsBody.js';
import { ACT_HANDS, HAND_KINDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
import { stepLabel } from '../../src/services/minebot/utils/actLabel.js';

// `go` as a hand of `act`: the hand's fields, the line it leaves in the result, and the act's own ways of stopping a hand (stopIf, done) with the body
// walking by the real physics and the real route search (tests/helpers/physicsBody). No server, no API.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const R = 40;
const flat: Ground = (x, y, z) => (Math.abs(x) > R || Math.abs(z) > R ? null : y < 64 ? 'stone' : 'air');
async function drive<T>(sim: Sim, promise: Promise<T>, each?: (elapsedMs: number) => void, maxMs = 240_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); each?.(elapsed); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}
const hands = (value: unknown) => ACT_HANDS.parse(value);
const parse = (result: { result: string }) => JSON.parse(result.result);

describe('act: the hand go', () => {
  it('is a kind of hand with the contract\'s fields, and takes nothing the head would not send', () => {
    expect(HAND_KINDS).toContain('go');
    const ok = hands([{ do: 'go', goals: [{ x: 1, y: 64, z: 2 }, { x: 5, y: 64, z: 2 }], canDig: ['stone', 'dirt'], canPlace: ['cobblestone'], maxDrop: 4, waterOk: true,
      range: 2, seconds: 45, maxDig: 30, maxPlace: 10, sprint: true, rel: true, note: '外へ', onFail: 'continue' }]);
    expect(ok[0].do).toBe('go');
    expect(() => hands([{ do: 'go', to: { x: 1, y: 2, z: 3 }, canDig: [] }])).toThrow();
    expect(() => hands([{ do: 'go', goals: [{ x: 1, y: 2, z: 3 }] }])).toThrow();
    expect(() => hands([{ do: 'go', to: { x: 1, y: 2, z: 3 }, maxDrop: 11 }])).toThrow();
    expect(() => hands([{ do: 'go', to: { x: 1, y: 2, z: 3 }, canPlace: Array.from({ length: 7 }, () => 'dirt') }])).toThrow();
    expect(stepLabel({ do: 'go', to: { x: 1, y: 2, z: 3 } } as never)).toBe('go → (1,2,3)');
    expect(stepLabel({ do: 'go', goals: [{}, {}] } as never)).toBe('go → 2か所のどれか');
  });

  it('goes to a place counted from the feet (rel) and leaves the contract\'s line', async () => {
    const sim = makeSim(flat);
    const result = await drive(sim, runAct(sim.bot, hands([{ do: 'go', to: { x: 6, y: 0, z: 3 }, rel: true }])));
    expect(result.success).toBe(true);
    const json = parse(result);
    expect(json).toMatchObject({ ok: true, done: 1, of: 1 });
    expect(json.lines[0]).toMatchObject({ i: 1, do: 'go', status: 'done' });
    expect(json.lines[0].line).toMatch(/^go 着いた \(6,64,3\) 道 \d+ 歩・掘 0・置 0・引き直し \d+ 回（\d+\.\d秒）$/u);
  });

  it('says why it stopped in the line itself, whole and within 160 characters, and the hands after it are not run', async () => {
    // A river across the whole ground, nothing allowed.
    const river: Ground = (x, y, z) => (Math.abs(x) > R || Math.abs(z) > R ? null : x >= 2 && x <= 4 && y >= 60 && y < 64 ? 'air' : y < 64 ? 'stone' : 'air');
    const sim = makeSim(river);
    const result = await drive(sim, runAct(sim.bot, hands([{ do: 'go', to: { x: 8, y: 64, z: 0 } }, { do: 'wait', seconds: 1 }])));
    expect(result.success).toBe(false);
    expect(result.failureType).toBe('dead_end');
    const json = parse(result);
    expect(json).toMatchObject({ ok: false, done: 0, of: 2, stoppedBy: 'failure' });
    const line: string = json.lines[0].line;
    expect(line.startsWith('go 止まった dead_end: ')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(160);
    expect(line).toMatch(/\(\d+,64,0\) 道 \d+ 歩・掘 0・置 0・引き直し \d+ 回/u);
    expect(json.lines[0].status).toBe('stopped');
    expect(json.lines[1].status).toBe('skipped');
  });

  it('refuses a go with both to and goals, or neither, or a limit outside the contract, as an invalid input', async () => {
    const sim = makeSim(flat);
    const both = await runAct(sim.bot, hands([{ do: 'go', to: { x: 1, y: 64, z: 0 }, goals: [{ x: 2, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }] }]));
    expect(parse(both).lines[0].line).toContain('to か goals');
    const neither = await runAct(sim.bot, hands([{ do: 'go' }]));
    expect(neither.failureType).toBe('invalid_input');
    const seconds = await runAct(sim.bot, hands([{ do: 'go', to: { x: 1, y: 64, z: 0 }, seconds: 2 }]));
    expect(parse(seconds).lines[0].line).toContain('seconds は 5〜120');
  });

  it('lets a go that may drop fall what it may, where the act would stop any other hand at a fall of four', async () => {
    const platform: Ground = (x, y, z) => (Math.abs(x) > R || Math.abs(z) > R ? null : y < 64 || (x <= 2 && y < 70) ? 'stone' : 'air');
    const high = makeSim(platform, { start: [0.5, 70, 0.5] });
    const dropped = await drive(high, runAct(high.bot, hands([{ do: 'go', to: { x: 6, y: 64, z: 0 }, maxDrop: 7 }])));
    expect(dropped.success).toBe(true);
    expect(parse(dropped).lines[0].line).toMatch(/^go 着いた \(6,64,0\)/u);
    const careful = makeSim(platform, { start: [0.5, 70, 0.5] });
    const kept = await drive(careful, runAct(careful.bot, hands([{ do: 'go', to: { x: 6, y: 64, z: 0 } }])));
    expect(kept.success).toBe(false);
    expect(parse(kept).lines[0].line).toContain('go 止まった dead_end:');
  });

  it('is stopped from outside like any hand: stopIf hostileWithin cuts the walk and leaves the body still', async () => {
    const sim = makeSim(flat);
    const walking = runAct(sim.bot, hands([{ do: 'go', to: { x: 30, y: 64, z: 0 } }]), { hostileWithin: 6 });
    const result = await drive(sim, walking, elapsed => {
      if (elapsed === 1500) sim.bot.entities[77] = { id: 77, name: 'zombie', type: 'hostile', position: sim.bot.entity.position.offset(4, 0, 0), metadata: [], height: 1.95, width: 0.6 };
    });
    expect(result.success).toBe(false);
    const json = parse(result);
    expect(json.stoppedBy).toBe('stopIf');
    expect(json.stoppedWhy).toContain('hostileWithin:zombie');
    expect(json.lines[0].status).toBe('stopped');
    expect(Object.values(sim.bot.controlState).some(Boolean)).toBe(false);
    const where = sim.bot.entity.position.clone();
    for (let i = 0; i < 40; i++) { sim.tick(); await vi.advanceTimersByTimeAsync(50); }
    expect(sim.bot.entity.position.distanceTo(where)).toBeLessThan(0.6);
    expect(sim.bot.entity.position.x).toBeLessThan(25);
  });

  it('ends ok in the middle of the hand when the act\'s done condition holds', async () => {
    const sim = makeSim(flat);
    const walking = runAct(sim.bot, hands([{ do: 'go', to: { x: 35, y: 64, z: 0 } }]), undefined, undefined, { done: [[{ k: 'at', x: 12, y: 64, z: 0, r: 3, dim: 'overworld' }]] });
    const result = await drive(sim, walking);
    expect(result.success).toBe(true);
    const json = parse(result);
    expect(json.ok).toBe(true);
    expect(json.doneMet).toContain('at:12,64,0');
    expect(sim.bot.entity.position.x).toBeGreaterThan(8);
    expect(sim.bot.entity.position.x).toBeLessThan(20);
    expect(Object.values(sim.bot.controlState).some(Boolean)).toBe(false);
  });
});
