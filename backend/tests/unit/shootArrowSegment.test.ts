import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { arrowSegmentCells, firstSolidInArrowSegment } from '../../src/services/minebot/utils/arrowSegment.js';
import { arrowBlockedAt, besideBody, shoot } from '../../src/services/minebot/utils/primitives/shoot.js';

// Recorded core7 m7-21: reportSHA2676d5bb946d9adfa730793ebe193fb10d05cdc41e3cebbe219c1d47e01bdb11.
// m7-13 placed this cobble; m7-20 public map still has it. Actual impact/movement was not captured.
const origin = new Vec3(64.68007687620872, 61.520000003278255, .5130320840442053);
const goal = new Vec3(33.5, 78, -24.5), cell = { x: 64, y: 61, z: -1 };
const velocities = [
  { name: 'wire nominal', v: new Vec3(-2.041891544469258, 1.467865529684979, -1.6358635968159398) },
  { name: 'native initial', v: new Vec3(-2.0333272294451565, 1.4268449002014283, -1.6529939571507049) },
];
const isCell = (p: { x: number; y: number; z: number }) => p.x === cell.x && p.y === cell.y && p.z === cell.z;
const block = (p: Vec3) => isCell(p) ? { name: 'cobblestone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: p } : null;
afterEach(() => { vi.useRealTimers(); });

describe('continuous known-cell arrow checks', () => {
  for (const { name, v } of velocities) it(`sees the saved corner between point samples: ${name}`, () => {
    for (const f of [.25, .5, .75, 1]) expect(isCell(origin.plus(v.scaled(f)).floored())).toBe(false);
    const hit = arrowBlockedAt({ blockAt: block }, origin, Math.atan2(-v.x, -v.z),
      Math.atan2(v.y, Math.hypot(v.x, v.z)), v.norm(), 19, goal);
    expect(hit).toEqual({ ...cell, name: 'cobblestone' });
  });

  it('refuses the saved known obstruction before a bow draw or release', async () => {
    vi.useFakeTimers();
    const bow = { name: 'bow', type: 1, count: 1 }, arrow = { name: 'arrow', count: 4 };
    const target = { id: 104, name: 'end_crystal', position: new Vec3(33.5, 77, -24.5), width: 2, height: 2 };
    const bot: any = Object.assign(new EventEmitter(), {
      entity: { position: new Vec3(origin.x, 60, origin.z), onGround: true, velocity: new Vec3(0, 0, 0) },
      entities: { 104: target }, heldItem: bow, inventory: { items: () => [bow, arrow] }, game: { dimension: 'the_end' },
      blockAt: block, look: vi.fn(async () => {}), activateItem: vi.fn(), deactivateItem: vi.fn(), setQuickBarSlot: vi.fn(),
    });
    const pending = shoot({ bot, stop: new AbortController().signal, deadline: 10_000,
      facing: 'north', base: { x: 64, y: 60, z: 0 } }, { target: 104 });
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ ok: false, reason: 'line_blocked', at: cell });
    expect(bot.activateItem).not.toHaveBeenCalled(); expect(bot.deactivateItem).not.toHaveBeenCalled();
    expect(arrow.count).toBe(4);
  });

  it('keeps unknown/non-solid cells non-blocking and counts actual null lookups once per cell', () => {
    const calls: string[] = [], trace = { unreadSamples: 0 };
    const bot = { blockAt: (p: Vec3) => { calls.push(p.toString()); return null; } };
    expect(arrowBlockedAt(bot, origin, .9, .51, 3, 3, goal, trace)).toBeNull();
    expect(trace.unreadSamples).toBe(calls.length);
    expect(new Set(calls).size).toBe(calls.length);
    expect(firstSolidInArrowSegment(origin, origin.plus(velocities[0].v), () => ({ name: 'air', solid: false }))).toBeNull();
  });

  it('preserves the1.2 goal endpoint exemption before any segment read', () => {
    const v = velocities[0].v, first = origin.plus(v.scaled(.25)), read = vi.fn(() => ({ name: 'cobblestone', boundingBox: 'block' }));
    expect(arrowBlockedAt({ blockAt: read }, origin, Math.atan2(-v.x, -v.z),
      Math.atan2(v.y, Math.hypot(v.x, v.z)), v.norm(), 1, first)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('has closed-face contact but does not ban a separated neighbouring voxel', () => {
    const read = (x: number, y: number, z: number) => x === 0 && y === 0 && z === 0 ? { name: 'stone', solid: true } : null;
    expect(firstSolidInArrowSegment({ x: -.5, y: 1, z: .5 }, { x: 1.5, y: 1, z: .5 }, read)).toEqual({ x: 0, y: 0, z: 0, name: 'stone' });
    expect(firstSolidInArrowSegment({ x: -.5, y: 1.0001, z: .5 }, { x: 1.5, y: 1.0001, z: .5 }, read)).toBeNull();
  });

  it('preserves the corner under translation, reversed travel and axis permutation', () => {
    const end = origin.plus(velocities[1].v);
    for (const shift of [new Vec3(0, 0, 0), new Vec3(-1000, 300, 777)]) {
      const a = origin.plus(shift), b = end.plus(shift), wanted = new Vec3(cell.x, cell.y, cell.z).plus(shift);
      for (const [from, to] of [[a, b], [b, a]]) {
        expect(arrowSegmentCells(from, to).some(c => c.x === wanted.x && c.y === wanted.y && c.z === wanted.z)).toBe(true);
      }
    }
    expect(arrowSegmentCells({ x: origin.z, y: origin.x, z: origin.y }, { x: end.z, y: end.x, z: end.y })
      .some(c => c.x === cell.z && c.y === cell.x && c.z === cell.y)).toBe(true);
  });

  it('walks grid-plane crossings instead of a bounding-box volume', () => {
    const cells = arrowSegmentCells({ x: .1, y: .2, z: .3 }, { x: 100.1, y: 100.2, z: 100.3 });
    expect(cells.length).toBeLessThan(1200);
    expect(cells[0]).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(cells.at(-1)).toMatchObject({ x: 100, y: 100, z: 100 });
    expect(cells.every((v, i) => i === 0 || cells[i - 1].entry <= v.entry)).toBe(true);
  });

  it('refuses invalid numeric geometry without reading the world', () => {
    const read = vi.fn(() => null);
    expect(() => firstSolidInArrowSegment({ x: NaN, y: 0, z: 0 }, origin, read)).toThrow('finite');
    expect(() => firstSolidInArrowSegment(origin, { x: Infinity, y: 0, z: 0 }, read)).toThrow('finite');
    expect(() => firstSolidInArrowSegment(origin, { x: 2 ** 53, y: 0, z: 0 }, read)).toThrow('finite');
    expect(read).not.toHaveBeenCalled();
  });
});

// S1 lab 11/8: a window cell beside the body (plugged by the cover reflex) is told as a dig away, not "move or wait".
describe('besideBody', () => {
  const bot = { entity: { position: new Vec3(141.5, 77, 73.4) } };
  it('is the eight columns around the feet, at the feet\'s and the head\'s height', () => {
    expect(besideBody(bot, { x: 141, y: 78, z: 74 })).toBe(true);
    expect(besideBody(bot, { x: 140, y: 77, z: 72 })).toBe(true);
    expect(besideBody(bot, { x: 141, y: 78, z: 73 })).toBe(false);
    expect(besideBody(bot, { x: 141, y: 79, z: 74 })).toBe(false);
    expect(besideBody(bot, { x: 141, y: 78, z: 75 })).toBe(false);
  });
});
