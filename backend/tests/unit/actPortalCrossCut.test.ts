import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { StepStopped } from '../../src/services/minebot/utils/primitives/common.js';
import { ensureReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';

// S2 lab (2026-11-02) and S4's c1 run: a walk into the End portal said "stopped: 反射: lava_escape（手の途中）" and the body was in the End. The old world's lava under the portal's
// sheet reads as lava in the moment the body leaves it, the lava reflex takes the act, and the dimension changes in the same moment. The hand did what it was sent for: the act says so.
const stub: { crossNow: () => void } = { crossNow: () => undefined };
vi.mock('../../src/services/minebot/utils/primitives/walk.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/primitives/walk.js')>();
  return { ...actual, walk: vi.fn(async (ctx: any) => {
    // The body is walking into the portal (the act then does not call a changed dimension a stop of its own) ...
    (actual.portalWalks as any).add(ctx.bot);
    await new Promise(resolve => setTimeout(resolve, 30));
    // ... it crosses and the reflex's entry comes in the same moment; the act's watch stops the hand.
    stub.crossNow();
    await new Promise<void>((resolve, reject) => {
      const check = setInterval(() => { if (ctx.stop.aborted) { clearInterval(check); reject(new StepStopped('反射')); } }, 10);
      setTimeout(() => { clearInterval(check); resolve(); }, 2000);
    });
    return { ok: true, text: 'unreachable in this test' };
  }) };
});

const { runAct, ACT_HANDS } = await import('../../src/services/minebot/instantSkills/act.js');

const AIR = { name: 'air', boundingBox: 'empty' };
function body(dimension = 'overworld') {
  const slots: any[] = new Array(46).fill(null);
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { id: 1, name: 'player', position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, onGround: true, velocity: new Vec3(0, 0, 0), metadata: [0] },
    health: 20, food: 20, game: { dimension }, entities: {}, registry: { entitiesByName: {}, blocksByName: {}, itemsByName: {}, items: {} },
    inventory: { items: () => [], slots }, controlState: {} as Record<string, boolean>, heldItem: null,
    executingSkill: false, interruptExecution: false, setControlState: vi.fn(), clearControlStates: vi.fn(), stopDigging: () => undefined,
    blockAt: () => AIR,
  });
  ensureReflexLedger(bot);
  return bot;
}

describe('a walk into a portal that a reflex cuts in the moment the body crosses', () => {
  it('is told as the crossing it was (ok, the dimension named), not as a stop by the reflex', async () => {
    const bot = body('overworld');
    stub.crossNow = () => {
      bot.game.dimension = 'the_end';
      bot.entity.position = new Vec3(100.5, 49, 0.5);
      const ledger = ensureReflexLedger(bot);
      ledger.end(ledger.begin('lava', '溶岩回避の反射が始まった（脱出は未確認）'), 'done');
    };
    const result = await runAct(bot, ACT_HANDS.parse([{ do: 'walk', to: { x: 1, y: 64, z: 1 } }, { do: 'jump' }]), undefined, undefined, { tickMs: 10 });
    const json = JSON.parse(result.result);
    expect(json.ok).toBe(true);
    expect(json.stoppedBy ?? null).toBeNull();
    expect(json.lines[0]).toMatchObject({ do: 'walk', status: 'done' });
    expect(json.lines[0].line).toContain('エンドへ移った');
    expect(json.lines[1].status).toBe('skipped');
    expect(result.success).toBe(true);
  });

  it('a reflex that cuts the walk with the dimension unchanged is still a stop by the reflex', async () => {
    const bot = body('overworld');
    stub.crossNow = () => {
      const ledger = ensureReflexLedger(bot);
      ledger.end(ledger.begin('lava', '溶岩回避の反射が始まった（脱出は未確認）'), 'done');
    };
    const result = await runAct(bot, ACT_HANDS.parse([{ do: 'walk', to: { x: 1, y: 64, z: 1 } }]), undefined, undefined, { tickMs: 10 });
    const json = JSON.parse(result.result);
    expect(json).toMatchObject({ ok: false, stoppedBy: 'reflex' });
    expect(json.lines[0].status).toBe('stopped');
  });
});

describe('a walk into the End portal cut by a reflex just before the crossing (S5 rig, c1: the lava reflex 0.1 s before the server moved the body; the task paused in the End)', () => {
  it('waits for the crossing while the body touches the portal, and tells it as the crossing', async () => {
    const bot = body('overworld');
    // The End portal's sheet one block over the feet (the body slipped past it into the lava under it).
    bot.blockAt = (p: Vec3) => (Math.floor(p.y) === 65 && Math.abs(Math.floor(p.x)) <= 1 && Math.abs(Math.floor(p.z)) <= 1 ? { name: 'end_portal', boundingBox: 'empty' } : AIR);
    stub.crossNow = () => {
      const ledger = ensureReflexLedger(bot);
      ledger.end(ledger.begin('lava', '溶岩回避の反射が始まった（脱出は未確認）'), 'done');
      setTimeout(() => { bot.game.dimension = 'the_end'; bot.entity.position = new Vec3(100.5, 49, 0.5); bot.blockAt = () => AIR; }, 300);
    };
    const result = await runAct(bot, ACT_HANDS.parse([{ do: 'walk', to: { x: 1, y: 64, z: 1 } }]), undefined, undefined, { tickMs: 10 });
    const json = JSON.parse(result.result);
    expect(json.ok).toBe(true);
    expect(json.lines[0]).toMatchObject({ do: 'walk', status: 'done' });
    expect(json.lines[0].line).toContain('エンドへ移った');
  });
});
