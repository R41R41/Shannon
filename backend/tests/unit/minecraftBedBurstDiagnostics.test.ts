import { describe, expect, it, vi } from 'vitest';
import { bedBurstFireCells, noteBedBurstDiagnostic, watchBedBurstDiagnostics } from '../../src/services/minebot/utils/bedBurstDiagnostics.js';

describe('passive bed-burst lab diagnostics', () => {
  it('does no diagnostic read without a watcher or after unsubscribe and isolates exceptions/mutations', () => {
    const bot = {}, detail = vi.fn(() => ({ tick: 1, stage: 'ready', code: 'head_window_closed', actor: { x: 1 } }));
    noteBedBurstDiagnostic(bot, detail); expect(detail).not.toHaveBeenCalled();
    const first = watchBedBurstDiagnostics(bot, row => { (row.actor as any).x = 9; throw Error('observer failed'); });
    const seen: any[] = [], second = watchBedBurstDiagnostics(bot, row => seen.push(row));
    noteBedBurstDiagnostic(bot, detail); expect(seen[0].actor.x).toBe(1);
    first(); second(); noteBedBurstDiagnostic(bot, detail); expect(detail).toHaveBeenCalledTimes(1);
    const stop = watchBedBurstDiagnostics(bot, () => { throw Error('not reached'); });
    expect(() => noteBedBurstDiagnostic(bot, () => { throw Error('read failed'); })).not.toThrow(); stop();
  });
  it('retains the exact 36-cell fire neighbourhood with separate fire and unread flags', () => {
    const cells = bedBurstFireCells(p => p.x === 0 && p.y === 63 && p.z === 1 ? null :
      { name: p.x === 1 && p.y === 64 && p.z === 1 ? 'fire' : p.x === -1 && p.y === 65 && p.z === 2 ? 'soul_fire' : 'air' }, { x: .5, y: 64, z: 1.5 });
    expect(cells).toHaveLength(36);
    expect(cells.filter(c => !c.loaded)).toEqual([{ at: { x: 0, y: 63, z: 1 }, name: null, loaded: false, fire: false }]);
    expect(cells.filter(c => c.fire).map(c => c.name)).toEqual(['soul_fire', 'fire']);
  });
});
