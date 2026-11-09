import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fight, noteStuckAngry, watchesOnAfter } from '../../src/services/minebot/utils/primitives/fight.js';

// end1108h29 (11/8): 39 of 73 fights came back to the head at once (enderman_not_visible / not_visible) while the body stood under a finished
// roof; each round trip cost a head turn. Under a roof, fight now waits the rest of its seconds for an enderman whose eyes come into sight.
const registry = { entitiesByName: { enderman: { metadataKeys: ['flags', 'carried', 'creepy', 'stared_at'] } } };
function body(roofed: boolean) {
  const blocks: Record<string, string> = {};
  // A wall of stems at x=6 (z -4..4, up to y 69) between the body and the one enderman: its eyes are hidden from the roof and its edge steps.
  for (let y = 64; y <= 69; y++) for (let z = -4; z <= 4; z++) blocks[`6,${y},${z}`] = 'warped_stem';
  if (roofed) for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) blocks[`${x},66,${z}`] = 'cobblestone';
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), height: 1.8, yaw: 0, pitch: 0, onGround: true },
    registry, health: 20, food: 20, game: { dimension: 'the_nether' },
    entities: { 7: { id: 7, name: 'enderman', position: new Vec3(12.5, 64, 0.5), isValid: true, height: 2.9, width: 0.6, metadata: [0, null, false, false] } } as Record<number, any>,
    inventory: { items: () => [], slots: new Array(46).fill(null) },
    blockAt: (p: Vec3) => {
      const at = p.floored();
      const name = blocks[`${at.x},${at.y},${at.z}`] ?? (at.y < 64 ? 'warped_nylium' : 'air');
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: at };
    },
  });
  return bot;
}
const ctx = (bot: any) => ({ bot, stop: new AbortController().signal, deadline: Date.now() + 120_000, facing: 'north' as const, base: { x: 0, y: 64, z: 0 } });

describe('fight target=enderman under a roof waits for eyes to come into sight', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('under the roof: watches the rest of its seconds (less the 6 s kept back) and says how long, before it comes back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bot = body(true);
    const running = fight(ctx(bot) as any, { target: 'enderman', seconds: 12 } as any);
    await vi.advanceTimersByTimeAsync(10_000);
    const out = await running;
    expect(out.ok).toBe(false);
    expect((out as any).reason).toBe('enderman_not_visible');
    expect(out.text).toMatch(/屋根の下で [56]\.\d 秒見張ったが、目の見える個体は来なかった/u);
  });

  // end1108h31: 32 of 43 such stops came right after go to a roof site where no roof stood yet; the watch now runs there too.
  it('not under a roof: watches where it stands too, and says so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bot = body(false);
    const running = fight(ctx(bot) as any, { target: 'enderman', seconds: 12 } as any);
    await vi.advanceTimersByTimeAsync(10_000);
    const out = await running;
    expect((out as any).reason).toBe('enderman_not_visible');
    expect(out.text).toMatch(/その場で [56]\.\d 秒見張ったが、目の見える個体は来なかった/u);
  });

  it('not under a roof: an enderman that walks into sight while it watches is the one fought', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bot = body(false);
    const running = fight(ctx(bot) as any, { target: 'enderman', seconds: 12 } as any);
    await vi.advanceTimersByTimeAsync(1_000);
    bot.entities[7].position = new Vec3(0.5, 64, 9.5);
    await vi.advanceTimersByTimeAsync(20_000);
    const out = await running;
    expect(out.text).toMatch(/その場で \d+\.\d 秒見張り、#7/u);
  });

  // end1109p03: on nether bridges the nearest was 32-40 m off; six fights each waited their whole 60 s for nothing.
  it('does not watch when no enderman is within 24 m, and says so at once', async () => {
    const bot = body(false);
    bot.entities[7].position = new Vec3(36.5, 64, 0.5);
    const t0 = Date.now();
    const out = await fight(ctx(bot) as any, { target: 'enderman', seconds: 60 } as any);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(out.text).not.toContain('秒見張');
  });

  it('with no kill yet, watches 25 s at most even with 60 s asked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bot = body(true);
    const running = fight(ctx(bot) as any, { target: 'enderman', seconds: 60 } as any);
    await vi.advanceTimersByTimeAsync(40_000);
    const out = await running;
    expect(out.text).toMatch(/屋根の下で 2[45]\.\d 秒見張ったが/u);
  });

  it('stops watching at once when health is low', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bot = body(true); bot.health = 6;
    const out = await fight(ctx(bot) as any, { target: 'enderman', seconds: 12 } as any);
    expect(out.text).not.toContain('秒見張り');
  });
});

// end1108h30 (11/9): #637 stood angry 6 m off the roof and never came; the planner's range (8 m by default) counted 6 m as "near", so the
// did-not-arrive stop never fired, and the head named #637 by its id in ten fights running, 40-60 s each (559 s of the run).
describe('an angry enderman that stood off and never came, named again by its id', () => {
  it('comes back at once as did-not-arrive, saying where it stands and to pick another', async () => {
    const bot = body(true);
    bot.entities[7].position = new Vec3(0.5, 64, 6.5);
    bot.entities[7].metadata = [0, null, true, false];
    noteStuckAngry(bot, 7, { x: 0, y: 64, z: 6 });
    const t0 = Date.now();
    const out = await fight(ctx(bot) as any, { target: '#7', seconds: 60 } as any);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect((out as any).reason).toBe('enderman_did_not_arrive');
    expect(out.text).toContain('怒ったまま来なかった個体');
    expect(out.text).toContain('target=enderman');
  });

  it('an id not noted as stuck is fought as before (no did-not-arrive at once)', async () => {
    const bot = body(false);
    const out = await fight(ctx(bot) as any, { target: '#7', seconds: 12 } as any);
    expect((out as any).reason).not.toBe('enderman_did_not_arrive');
  });
});

// end1109p05: 15 of 28 stops were enderman_did_not_arrive on one #619 in a hollow below; each went back to the head, most moved the roof.
describe("the kind's fight watches on after an angry one that did not come", () => {
  it('watches on after did-not-arrive as after not-visible, and not after other stops', () => {
    expect(watchesOnAfter({ ok: false, reason: 'enderman_did_not_arrive', text: '' } as any)).toBe(true);
    expect(watchesOnAfter({ ok: false, reason: 'not_visible', text: '' } as any)).toBe(true);
    expect(watchesOnAfter({ ok: false, reason: 'enderman_not_visible', text: '' } as any)).toBe(true);
    expect(watchesOnAfter({ ok: false, reason: 'build_stalled', text: '' } as any)).toBe(false);
    expect(watchesOnAfter({ ok: true, reason: 'enderman_did_not_arrive', text: '' } as any)).toBe(false);
  });

  it('does not watch for the stuck one alone (it is passed over by the pick)', async () => {
    const bot = body(false);
    bot.entities[7].metadata = [0, null, true, false];
    noteStuckAngry(bot, 7, { x: 12, y: 64, z: 0 });
    const t0 = Date.now();
    const out = await fight(ctx(bot) as any, { target: 'enderman', seconds: 60 } as any);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(out.text).not.toContain('秒見張');
  });
});
