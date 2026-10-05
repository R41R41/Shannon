import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { closedByServer, installServerRefusals, noteServerRefusal, refusedCells, serverRefusalStepCost } from '../../src/services/minebot/utils/serverRefusals.js';

describe('the body learns from the server refusing it (65 corrections beside dripstone, L36)', () => {
  it('names the cells the body was entering, at feet and head level', () => {
    // Flush against the cell to the north (z=1) and stepping into it.
    expect(refusedCells({ x: -90.6, y: 55.2, z: 2.27 }, { x: -90.6, y: 55.2, z: 2.3 }).sort()).toEqual(['-91,55,1', '-91,56,1']);
    // A diagonal step that crosses into three new columns.
    expect(new Set(refusedCells({ x: -90.74, y: 55.2, z: 2.27 }, { x: -90.69, y: 55.2, z: 2.3 }))).toEqual(
      new Set(['-92,55,2', '-92,56,2', '-92,55,1', '-92,56,1', '-91,55,1', '-91,56,1']));
    // Refused without leaving its own cell (something inside it): the cell its leading edge is in.
    expect(refusedCells({ x: 4.5, y: 64, z: 0.5 }, { x: 4.45, y: 64, z: 0.5 }).sort()).toEqual(['4,64,0', '4,65,0']);
  });

  it('does not take a teleport or a purely vertical correction for a refused step', () => {
    expect(refusedCells({ x: 9.5, y: 163, z: 8.5 }, { x: -499.5, y: 150, z: -499.5 })).toEqual([]);
    expect(refusedCells({ x: 0.5, y: 64.2, z: 0.5 }, { x: 0.5, y: 64, z: 0.5 })).toEqual([]);
  });

  it('closes a cell after three refusals in a row, not after one, and opens it again later', () => {
    const state = { strikes: new Map(), closed: new Map() };
    const bot = { serverRefusals: state };
    const claimed = { x: 2.27, y: 64, z: 0.5 }, server = { x: 2.3, y: 64, z: 0.5 };
    const t0 = Date.now();
    expect(noteServerRefusal(state, claimed, server, t0)).toEqual([]);
    expect(noteServerRefusal(state, claimed, server, t0 + 50)).toEqual([]);
    expect(closedByServer(bot, { x: 1, y: 64, z: 0 }, t0 + 60)).toBe(false);
    expect(noteServerRefusal(state, claimed, server, t0 + 100).sort()).toEqual(['1,64,0', '1,65,0']);
    expect(closedByServer(bot, { x: 1, y: 64, z: 0 }, t0 + 200)).toBe(true);
    expect(serverRefusalStepCost(bot)({ position: { x: 1, y: 65, z: 0 } })).toBe(100);
    expect(serverRefusalStepCost(bot)({ position: { x: 2, y: 64, z: 0 } })).toBe(0);
    // Three refusals spread over a long time are three separate bumps, not a closed way.
    const slow = { strikes: new Map(), closed: new Map() };
    for (const at of [0, 5000, 10000]) expect(noteServerRefusal(slow, claimed, server, at)).toEqual([]);
    expect(closedByServer(bot, { x: 1, y: 64, z: 0 }, t0 + 100 + 2 * 60_000 + 1)).toBe(false);
  });

  it('has the navigator plan again, goal unchanged, when a way is closed', () => {
    const events = new EventEmitter();
    const movements = {};
    const water = { name: 'water', type: 34, shapes: [], boundingBox: 'empty' };
    const bot: any = { entity: { position: { x: 2.3, y: 64, z: 0.5 } }, on: (event: string, listener: () => void) => events.on(event, listener),
      pathfinder: { movements, setMovements: vi.fn() }, blockAt: () => water };
    installServerRefusals(bot);
    expect(bot.blockAt({ x: 1, y: 64, z: 0 }, false)).toBe(water);
    for (let i = 0; i < 3; i++) {
      bot.entity.position = { x: 2.27, y: 64, z: 0.5 }; events.emit('physicsTick');   // the body claims a step west
      bot.entity.position = { x: 2.3, y: 64, z: 0.5 }; events.emit('forcedMove');     // the server puts it back
    }
    expect(bot.pathfinder.setMovements).toHaveBeenCalledTimes(1);
    expect(bot.pathfinder.setMovements).toHaveBeenCalledWith(movements);
    expect(closedByServer(bot, { x: 1, y: 64, z: 0 })).toBe(true);
    // The client's own physics and planning now meet a full block there; it is still water to everything else.
    expect(bot.blockAt({ x: 1.4, y: 64.2, z: 0.7 }, false)).toMatchObject({ name: 'water', type: 34, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] });
    expect(bot.blockAt({ x: 2, y: 64, z: 0 }, false)).toBe(water);
    expect(water).toMatchObject({ shapes: [], boundingBox: 'empty' });
    // The picture of that cell changes (the server sends its block): the old refusal no longer applies to it.
    events.emit('blockUpdate', { type: 0 }, { type: 9, position: { x: 1, y: 64, z: 0 } });
    expect(closedByServer(bot, { x: 1, y: 64, z: 0 })).toBe(false);
    expect(closedByServer(bot, { x: 1, y: 65, z: 0 })).toBe(true);
    // A change of state only (same block) is not a new picture.
    events.emit('blockUpdate', { type: 9 }, { type: 9, position: { x: 1, y: 65, z: 0 } });
    expect(closedByServer(bot, { x: 1, y: 65, z: 0 })).toBe(true);
  });
});
