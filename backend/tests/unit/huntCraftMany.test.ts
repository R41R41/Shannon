import { describe, expect, it } from 'vitest';
import { craft } from '../../src/services/minebot/utils/primitives/craft.js';

// Crafting in the hand, many at a time (S2 lab, 2026-11-02): mineflayer's own loop over the rounds started the second round of a recipe of two ingredients before the first one's result
// had settled: `craft ender_eye count 6` took two pairs of pearl and powder, left no eye and ended "missing ingredient", while six acts of one made six eyes. The hand now makes
// the rounds one by one and lets the answer settle between them.

const PEARL = 1115, POWDER = 1124, EYE = 1128;
const NAMES: Record<number, { name: string }> = { [PEARL]: { name: 'ender_pearl' }, [POWDER]: { name: 'blaze_powder' }, [EYE]: { name: 'ender_eye' } };

function body(options: { pearls: number; powder: number; breakAfter?: number; simultaneous?: boolean }) {
  const stock: Record<string, number> = { ender_pearl: options.pearls, blaze_powder: options.powder, ender_eye: 0 };
  const calls: number[] = [];
  let lastEnd = 0;
  const recipe = { requiresTable: false, result: { id: EYE, count: 1 }, delta: [{ id: PEARL, count: -1 }, { id: POWDER, count: -1 }, { id: EYE, count: 1 }], ingredients: [{ id: PEARL }, { id: POWDER }] };
  const bot: any = {
    entity: { position: { x: 0.5, y: 64, z: 0.5, offset: () => ({ x: 0.5, y: 65.6, z: 0.5 }) } },
    registry: { itemsByName: { ender_eye: { id: EYE } }, items: NAMES },
    inventory: { items: () => Object.entries(stock).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })), slots: [] },
    recipesAll: (id: number, _meta: unknown, table: unknown) => (id === EYE && table === null ? [recipe] : []),
    blockAt: () => null, world: { getColumns: () => [] },
    craft: async (_recipe: unknown, count: number) => {
      calls.push(count);
      const now = Date.now();
      // Like the real thing: a round begun before the last one has settled (under 150 ms) finds its materials gone.
      if (!options.simultaneous && lastEnd && now - lastEnd < 150) throw new Error('Error: missing ingredient');
      for (let i = 0; i < count; i++) {
        if (options.breakAfter !== undefined && calls.length > options.breakAfter) throw new Error('Error: missing ingredient');
        if (stock.ender_pearl < 1 || stock.blaze_powder < 1) throw new Error('Error: missing ingredient');
        stock.ender_pearl--; stock.blaze_powder--; stock.ender_eye++;
        lastEnd = Date.now();
      }
    },
  };
  return { bot, stock, calls };
}
const ctx = (bot: any) => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 60_000, facing: 'north' as const, base: { x: 0, y: 64, z: 0 } });

describe('craft in the hand, many rounds', () => {
  it('makes the rounds one by one (never one call of six), and every eye is made', async () => {
    const { bot, stock, calls } = body({ pearls: 6, powder: 6 });
    const result = await craft(ctx(bot), { item: 'ender_eye', count: 6 });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([1, 1, 1, 1, 1, 1]);
    expect(stock.ender_eye).toBe(6);
    expect(result.text).toContain('ender_eye を 6 個作った');
  }, 20_000);

  it('one round is one call, as before', async () => {
    const { bot, stock, calls } = body({ pearls: 2, powder: 2 });
    expect((await craft(ctx(bot), { item: 'ender_eye' })).ok).toBe(true);
    expect(calls).toEqual([1]);
    expect(stock.ender_eye).toBe(1);
  });

  it('a round that fails says how far it got and what is short, and the eyes made stay counted', async () => {
    const { bot, stock } = body({ pearls: 3, powder: 6 });
    const result = await craft(ctx(bot), { item: 'ender_eye', count: 6 });
    expect(result.ok).toBe(false);
    expect(result.reason === 'missing_material' || result.reason === 'craft_failed').toBe(true);
    expect(stock.ender_eye).toBe(0);                       // nothing was made: the shortfall is said before any round
    expect(result.text).toContain('ender_pearl');
  });
});

describe('a shortfall says what the pack makes now and how the short ingredient is made (S5 rig, c1: eleven powder and three rods, craft ender_eye 12 refused)', () => {
  it('names the eyes the pack makes now and the craft of the powder from a rod', async () => {
    const ROD = 1123;
    const stock: Record<string, number> = { ender_pearl: 14, blaze_powder: 11, blaze_rod: 3, ender_eye: 0 };
    const eye = { requiresTable: false, result: { id: EYE, count: 1 }, delta: [{ id: PEARL, count: -1 }, { id: POWDER, count: -1 }, { id: EYE, count: 1 }] };
    const powder = { requiresTable: false, result: { id: POWDER, count: 2 }, delta: [{ id: ROD, count: -1 }, { id: POWDER, count: 2 }] };
    const bot: any = {
      entity: { position: { x: 0.5, y: 64, z: 0.5, offset: () => ({ x: 0.5, y: 65.6, z: 0.5 }) } },
      registry: { itemsByName: { ender_eye: { id: EYE }, blaze_powder: { id: POWDER }, blaze_rod: { id: ROD } }, items: { ...NAMES, [ROD]: { name: 'blaze_rod' } } },
      inventory: { items: () => Object.entries(stock).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })), slots: [] },
      recipesAll: (id: number, _meta: unknown, table: unknown) => (table !== null ? [] : id === EYE ? [eye] : id === POWDER ? [powder] : []),
      blockAt: () => null, world: { getColumns: () => [] },
      craft: async () => { throw new Error('not reached'); },
    };
    const result = await craft(ctx(bot), { item: 'ender_eye', count: 12 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_material');
    expect(result.text).toContain('blaze_powder 1（持っている 11／要る 12）');
    expect(result.text).toContain('今作れるのは 11 個');
    expect(result.text).toContain('blaze_powder は blaze_rod×1 から 2 個ずつ作れる（持ち物で 6 個まで');
    expect(result.text).toContain('craft item=blaze_powder count=2');
  });
});

describe('make in the hand, many rounds (S5 rig, c1: make ender_eye 12 made the powder, then failed the eyes with "missing ingredient")', () => {
  it('makes the powder from the rods and then the twelve eyes one round at a time', async () => {
    const { make } = await import('../../src/services/minebot/utils/primitives/make.js');
    const ROD = 1123;
    const stock: Record<string, number> = { ender_pearl: 14, blaze_powder: 0, blaze_rod: 7, ender_eye: 0 };
    const eye = { requiresTable: false, result: { id: EYE, count: 1 }, delta: [{ id: PEARL, count: -1 }, { id: POWDER, count: -1 }, { id: EYE, count: 1 }], ingredients: [{ id: PEARL }, { id: POWDER }] };
    const powder = { requiresTable: false, result: { id: POWDER, count: 2 }, delta: [{ id: ROD, count: -1 }, { id: POWDER, count: 2 }], ingredients: [{ id: ROD }] };
    const calls: Array<[string, number]> = [];
    let lastEnd = 0;
    const bot: any = {
      entity: { position: { x: 0.5, y: 64, z: 0.5, offset: () => ({ x: 0.5, y: 65.6, z: 0.5 }) } },
      registry: { itemsByName: { ender_eye: { id: EYE, stackSize: 64 }, blaze_powder: { id: POWDER, stackSize: 64 }, blaze_rod: { id: ROD, stackSize: 64 }, ender_pearl: { id: PEARL, stackSize: 16 } },
        items: { ...NAMES, [ROD]: { name: 'blaze_rod' } } },
      inventory: { items: () => Object.entries(stock).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })), slots: [], emptySlotCount: () => 20 },
      recipesAll: (id: number) => (id === EYE ? [eye] : id === POWDER ? [powder] : []),
      blockAt: () => null, world: { getColumns: () => [] },
      craft: async (recipe: any, count: number) => {
        const name = recipe === eye ? 'ender_eye' : 'blaze_powder';
        calls.push([name, count]);
        // Like the real thing: a round begun before the last one has settled (under 150 ms) finds its materials gone.
        if (lastEnd && Date.now() - lastEnd < 150) throw new Error('Error: missing ingredient');
        for (let i = 0; i < count; i++) {
          if (i > 0) throw new Error('Error: missing ingredient');
          if (recipe === eye) { stock.ender_pearl--; stock.blaze_powder--; stock.ender_eye++; } else { stock.blaze_rod--; stock.blaze_powder += 2; }
        }
        lastEnd = Date.now();
      },
    };
    const result = await make(ctx(bot), { item: 'ender_eye', count: 12 });
    expect(result.ok).toBe(true);
    expect(stock.ender_eye).toBe(12);
    expect(calls.every(([, count]) => count === 1)).toBe(true);
  }, 30_000);
});
