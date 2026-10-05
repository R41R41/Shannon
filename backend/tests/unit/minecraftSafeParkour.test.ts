import { describe, expect, it } from 'vitest';
import { installSafeParkour, installSwimOut } from '../../src/services/minebot/utils/setMovements.js';

// A fake Movements over a column map: solid floor at y=62 except a gap at x=1,
// whose depth below varies per test. The bot stands at x=0 (y=63) and parkour
// lands at x=2.
function movements(gapFloorY: number | null, liquid?: 'water' | 'lava') {
  const solidAt = (x: number, y: number) => (x === 1 ? gapFloorY !== null && y <= gapFloorY : y <= 62);
  const m: any = {
    getBlock(node: any, dx: number, dy: number, _dz: number) {
      const x = node.x + dx, y = node.y + dy;
      if (liquid && x === 1 && gapFloorY !== null && y === gapFloorY + 1) return { physical: false, liquid: true, safe: liquid === 'water' };
      return { physical: solidAt(x, y), liquid: false, safe: !solidAt(x, y) };
    },
    getMoveParkourForward(node: any, dir: any, neighbors: any[]) { neighbors.push({ x: node.x + 2 * dir.x, y: node.y, z: node.z + 2 * dir.z }); },
  };
  installSafeParkour(m, 4);
  const out: any[] = [];
  m.getMoveParkourForward({ x: 0, y: 63, z: 0 }, { x: 1, z: 0 }, out);
  return out;
}

describe('survivable parkour only (paid run L4 fell 26 blocks through a floor gap)', () => {
  it('drops a gap jump over a deep void, keeps one over a shallow dip or water', () => {
    expect(movements(36)).toHaveLength(0);        // 26-block void below the gap
    expect(movements(null)).toHaveLength(0);      // bottomless within the bound
    expect(movements(59)).toHaveLength(1);        // 3-block dip: a missed jump is survivable
    expect(movements(40, 'water')).toHaveLength(1);
    expect(movements(40, 'lava')).toHaveLength(0);
  });
});

describe('the navigator knows a floating body climbs onto a bank level with the water (no route out of a lake, L32)', () => {
  // A lake: water at y<=62 for x<=0, stone at y<=62 for x>=1; `bankTop` raises the bank, `lakeFloor` makes the water shallow.
  function lake(options: { bankTop?: number; lakeFloor?: number; roofed?: boolean; nativeMoves?: any[] } = {}) {
    const bankTop = options.bankTop ?? 62;
    const cell = (x: number, y: number) => {
      if (options.roofed && x >= 1 && y === 64) return 'stone';
      if (x >= 1) return y <= bankTop ? 'stone' : 'air';
      return y <= (options.lakeFloor ?? 40) ? 'stone' : y <= 62 ? 'water' : 'air';
    };
    const m: any = { liquidCost: 2,
      getBlock(node: any, dx: number, dy: number, dz: number) {
        const kind = cell(node.x + dx, node.y + dy);
        return { physical: kind === 'stone', liquid: kind === 'water', safe: kind !== 'stone', height: node.y + dy + (kind === 'stone' ? 1 : 0) };
      },
      getNeighbors: () => [...(options.nativeMoves ?? [])] };
    installSwimOut(m);
    return m;
  }

  it('adds the climb from the top water block onto the flush bank, at swimming cost', () => {
    const moves = lake().getNeighbors({ x: 0, y: 62, z: 0, remainingBlocks: 3 });
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ x: 1, y: 63, z: 0, cost: 4, remainingBlocks: 3, toBreak: [], toPlace: [], parkour: false, hash: '1,63,0' });
    expect(typeof moves[0].offset).toBe('function');
  });

  it('does not invent a climb the body cannot make', () => {
    expect(lake({ bankTop: 63 }).getNeighbors({ x: 0, y: 62, z: 0, remainingBlocks: 0 })).toHaveLength(0);   // a bank one block above the water
    expect(lake({ roofed: true }).getNeighbors({ x: 0, y: 62, z: 0, remainingBlocks: 0 })).toHaveLength(0);    // no headroom on the bank
    expect(lake().getNeighbors({ x: 0, y: 61, z: 0, remainingBlocks: 0 })).toHaveLength(0);                    // still under the surface
    expect(lake().getNeighbors({ x: 2, y: 63, z: 0, remainingBlocks: 0 })).toHaveLength(0);                    // on land
  });

  it('leaves shallow water to the ordinary jump, and does not repeat a move the navigator already has', () => {
    expect(lake({ lakeFloor: 61 }).getNeighbors({ x: 0, y: 62, z: 0, remainingBlocks: 0 })).toHaveLength(0);
    const native = { x: 1, y: 63, z: 0, toBreak: [], toPlace: [] };
    expect(lake({ nativeMoves: [native] }).getNeighbors({ x: 0, y: 62, z: 0, remainingBlocks: 0 })).toEqual([native]);
  });
});
