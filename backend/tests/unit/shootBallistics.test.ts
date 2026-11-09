import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arrowFlight, creatureAim, shoot } from '../../src/services/minebot/utils/primitives/shoot.js';

// end1108c S7 (11/8): four shoot hands at blazes were refused because the line to the blaze's middle met a wall (nothing else of it was
// tried), and three draws let no arrow go while the reflex had the hands, each told as 「外れた」.
const solid = new Set<string>();
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
const blockAt = (p: Vec3) => solid.has(key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)))
  ? { name: 'nether_bricks', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: p } : null;
function pillar(x: number, zFrom: number, zTo: number) { for (let y = 60; y <= 72; y++) for (let z = zFrom; z <= zTo; z++) solid.add(key(x, y, z)); }

function fakeBot(blaze: { position: Vec3 }, options: { fires?: boolean; infinity?: boolean; using?: boolean } = {}) {
  const bow = { name: 'bow', type: 1, count: 1 }, arrow = { name: 'arrow', type: 2, count: 8 };
  const calls: string[] = [];
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true, velocity: new Vec3(0, 0, 0) },
    entities: { 7: { id: 7, name: 'blaze', height: 1.8, width: 0.6, ...blaze } }, heldItem: bow,
    inventory: { items: () => [bow, arrow] }, game: { dimension: 'the_nether' }, blockAt, quickBarSlot: 0,
    usingHeldItem: options.using ?? false,
    look: vi.fn(async () => {}), setQuickBarSlot: vi.fn(),
    activateItem: vi.fn(() => { calls.push('draw'); }),
    deactivateItem: vi.fn(() => {
      calls.push(bot.usingHeldItem ? 'let-go-other' : 'release');
      if (bot.usingHeldItem) { bot.usingHeldItem = false; return; }
      if (options.fires === false) return;
      if (!options.infinity) arrow.count--;
      bot.emit('entitySpawn', { name: 'arrow', position: bot.entity.position.offset(0, 1.5, 0) });
    }),
  });
  return { bot, arrow, calls };
}
const ctx = (bot: any) => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 60_000, facing: 'east', base: { x: 0, y: 64, z: 0 } }) as any;
const eyes = new Vec3(0.5, 65.52, 0.5);

beforeEach(() => { solid.clear(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('the arrow\'s flight run as the game runs it, against the creature\'s box', () => {
  it('meets the box of a creature in the open, and the wall in front of one behind it', () => {
    const target = { feet: new Vec3(10.5, 65, 0.5), velocity: new Vec3(0, 0, 0), width: 0.6, height: 1.8 };
    const open = arrowFlight({ blockAt }, eyes, -Math.PI / 2, 0.03, 3, target, 10);
    expect(open.kind).toBe('hit');
    pillar(5, 0, 0);
    expect(arrowFlight({ blockAt }, eyes, -Math.PI / 2, 0.03, 3, target, 10)).toMatchObject({ kind: 'block', x: 5, z: 0, name: 'nether_bricks' });
  });

  it('aims at the side of a blaze whose middle is behind a pillar but whose edge is in the open', () => {
    pillar(8, 0, 0);
    const blaze = { position: new Vec3(10.5, 65, 1.0), height: 1.8, width: 0.6, name: 'blaze' };
    const aim = creatureAim({ blockAt }, eyes, blaze, new Vec3(0, 0, 0), 3);
    expect(aim?.flight.kind).toBe('hit');
    expect(aim?.label).not.toBe('真ん中');
  });

  it('runs the led aim: a blaze moving behind a pillar is not shot at where it will be', () => {
    pillar(8, 1, 4);
    const blaze = { position: new Vec3(10.5, 65, 0.5), height: 1.8, width: 0.6, name: 'blaze' };
    expect(creatureAim({ blockAt }, eyes, blaze, new Vec3(0, 0, 0), 3)?.flight.kind).toBe('hit');
    expect(creatureAim({ blockAt }, eyes, blaze, new Vec3(0, 0, 0.4), 3)?.flight.kind).toBe('block');
  });
});

describe('shoot uses the flight before the draw and tells an arrow that never left', () => {
  it('shoots a blaze whose middle is hidden by aiming at the part in the open', async () => {
    pillar(8, 0, 0);
    const { bot } = fakeBot({ position: new Vec3(10.5, 65, 1.0) });
    const pending = shoot(ctx(bot), { target: 7 });
    await vi.runAllTimersAsync();
    const outcome = await pending;
    expect(bot.activateItem).toHaveBeenCalled();
    expect(outcome.text).toMatch(/を狙った/u);
    expect(outcome.text).not.toMatch(/矢が出なかった/u);
  });

  it('refuses a blaze hidden whole, naming the cell, and draws nothing', async () => {
    pillar(8, -1, 2);
    const { bot } = fakeBot({ position: new Vec3(10.5, 65, 1.0) });
    const pending = shoot(ctx(bot), { target: 7 });
    await vi.runAllTimersAsync();
    const outcome = await pending;
    expect(outcome).toMatchObject({ ok: false, reason: 'line_blocked' });
    expect(outcome.text).toMatch(/どこを狙っても/u);
    expect(bot.activateItem).not.toHaveBeenCalled();
  });

  it('end1108f7: names the nearest places to stand from which the arrow reaches a blaze hidden whole', async () => {
    // A floor at y 63 around the body, a wall at x 3 from z -1 to z 1 hiding the blaze whole: from z 3 the line passes the wall's end.
    for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) solid.add(key(x, 63, z));
    pillar(3, -1, 1);
    const { bot } = fakeBot({ position: new Vec3(10.5, 65, 0.5) });
    const pending = shoot(ctx(bot), { target: 7 });
    await vi.runAllTimersAsync();
    const outcome = await pending;
    expect(outcome).toMatchObject({ ok: false, reason: 'line_blocked' });
    expect(outcome.text).toMatch(/矢が届く立ち位置: \(-?\d+,64,-?\d+\)（\d+m、ほかの射手 \d 体から見える）/u);
    expect(bot.activateItem).not.toHaveBeenCalled();
    // Each spot named is one from which the flight meets the blaze.
    const spot = /立ち位置: \((-?\d+),64,(-?\d+)\)/u.exec(outcome.text)!;
    const from = new Vec3(Number(spot[1]) + 0.5, 64 + 1.52, Number(spot[2]) + 0.5);
    expect(creatureAim(bot, from, bot.entities[7], new Vec3(0, 0, 0), 3)?.flight.kind).toBe('hit');
  });

  it('end1108h7: names first the spot the fewest other shooters see, not the nearest among three blazes', async () => {
    for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) solid.add(key(x, 63, z));
    pillar(3, -1, 1);
    // A wall north of the body (z 2, x -6..1) hides the north side from a second blaze to the south-west; the south side it sees.
    for (let x = -6; x <= 1; x++) for (let y = 64; y <= 72; y++) solid.add(key(x, y, 2));
    const { bot } = fakeBot({ position: new Vec3(10.5, 65, 0.5) });
    bot.entities[9] = { id: 9, name: 'blaze', height: 1.8, width: 0.6, position: new Vec3(-3.5, 65, -6.5) };
    const pending = shoot(ctx(bot), { target: 7 });
    await vi.runAllTimersAsync();
    const outcome = await pending;
    expect(outcome).toMatchObject({ ok: false, reason: 'line_blocked' });
    const spot = /立ち位置: \((-?\d+),64,(-?\d+)\)（\d+m、ほかの射手 (\d) 体から見える）/u.exec(outcome.text)!;
    expect(spot).not.toBeNull();
    expect(Number(spot[2])).toBeGreaterThanOrEqual(3);
    expect(spot[3]).toBe('0');
  });

  it('says 矢が出なかった, not 外れた, and stops after two in a row', async () => {
    const { bot, arrow } = fakeBot({ position: new Vec3(10.5, 65, 0.5) }, { fires: false });
    const pending = shoot(ctx(bot), { target: 7, shots: 4 });
    await vi.runAllTimersAsync();
    const outcome = await pending;
    expect(outcome.text).toMatch(/1発目: 矢が出なかった/u);
    expect(outcome.text).toMatch(/2 回続けて矢が出なかったので止めた/u);
    expect(outcome.text).not.toMatch(/外れた/u);
    expect(bot.activateItem).toHaveBeenCalledTimes(2);
    expect(arrow.count).toBe(8);
  });

  it('counts an arrow seen leaving a bow that takes none from the pack (Infinity) as shot', async () => {
    const { bot } = fakeBot({ position: new Vec3(10.5, 65, 0.5) }, { infinity: true });
    const pending = shoot(ctx(bot), { target: 7, shots: 2 });
    await vi.runAllTimersAsync();
    const outcome = await pending;
    expect(outcome.text).not.toMatch(/矢が出なかった/u);
    expect(bot.activateItem).toHaveBeenCalledTimes(2);
  });

  it('end1108g7: a kind named by its name is the one whose arrow flies clear, not the nearest behind a wall', async () => {
    pillar(4, -1, 2);
    const { bot } = fakeBot({ position: new Vec3(8.5, 65, 0.5) });
    // A second blaze, farther, in the open to the south.
    bot.entities[8] = { id: 8, name: 'blaze', height: 1.8, width: 0.6, position: new Vec3(0.5, 65, 14.5) };
    const pending = shoot(ctx(bot), { target: 'blaze' });
    await vi.runAllTimersAsync();
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    expect(bot.activateItem).toHaveBeenCalledTimes(1);
    expect(outcome.text).toMatch(/1発目/u);
  });

  it('end1108g7: tells a kill with its place and the rod lying there, then goes on at the next clear blaze', async () => {
    const { bot } = fakeBot({ position: new Vec3(10.5, 65, 0.5) });
    bot.entities[8] = { id: 8, name: 'blaze', height: 1.8, width: 0.6, position: new Vec3(0.5, 65, 14.5) };
    let released = 0;
    bot.deactivateItem.mockImplementation(() => {
      released++;
      bot.emit('entitySpawn', { name: 'arrow', position: bot.entity.position.offset(0, 1.5, 0) });
      const victim = bot.entities[7] ?? bot.entities[8];
      bot.emit('entityHurt', victim);
      // The first arrow kills #7: it is gone and its rod lies under where it was.
      if (released === 1) {
        delete bot.entities[7];
        bot.entities[20] = { id: 20, name: 'item', position: new Vec3(10.5, 63, 0.5), getDroppedItem: () => ({ name: 'blaze_rod', count: 1 }) };
      }
    });
    const pending = shoot(ctx(bot), { target: 'blaze', shots: 2 });
    await vi.runAllTimersAsync();
    const outcome = await pending;
    expect(outcome.text).toMatch(/blaze #7 を倒した \(10,65,0\)（10m）。落とし物 blaze_rod×1 が \(10,63,0\)（10m、id 20）（pickup target=#20 でその物へ歩いて拾う）/u);
    expect(outcome.text).toMatch(/矢の通る blaze #8（14m）へ替えた/u);
    expect(outcome.text).toMatch(/2発目/u);
    expect(outcome.text).toMatch(/倒した 1/u);
    expect(released).toBe(2);
  });

  it('end1108h8: lets the arrow go only after a physics tick has sent the last look', async () => {
    const { bot, calls } = fakeBot({ position: new Vec3(10.5, 65, 0.5) });
    bot.look.mockImplementation(async () => { calls.push('look'); });
    const ticker = setInterval(() => { calls.push('tick'); bot.emit('physicsTick'); }, 50);
    const pending = shoot(ctx(bot), { target: 7 });
    await vi.advanceTimersByTimeAsync(10_000);
    clearInterval(ticker);
    await vi.runAllTimersAsync();
    await pending;
    const release = calls.indexOf('release'), lastLook = calls.lastIndexOf('look', release);
    expect(release).toBeGreaterThan(-1);
    expect(calls.slice(lastLook, release).filter(call => call === 'tick').length).toBeGreaterThanOrEqual(2);
  });

  it('lets go of something still in use before the draw', async () => {
    const { bot, calls } = fakeBot({ position: new Vec3(10.5, 65, 0.5) }, { using: true });
    const pending = shoot(ctx(bot), { target: 7 });
    await vi.runAllTimersAsync();
    await pending;
    expect(calls).toEqual(['let-go-other', 'draw', 'release']);
  });
});
