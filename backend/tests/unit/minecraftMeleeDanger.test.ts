import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMotorPort, executeAction } from '../../src/services/minebot/execution/ActionExecution.js';
import { runAct } from '../../src/services/minebot/instantSkills/act.js';
import { floorConfig } from '../../src/services/minebot/utils/floorConfig.js';
import { fleeStart, fleeThreat, floorEatChoice, installFloorReflexes, lastStandChoice, meleeChoice, meleeDanger, meleeThreatsNear, runLowHealthFlee, runMelee, watchDamage } from '../../src/services/minebot/utils/floorReflexes.js';
import { ensureReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';
import { takeActReport } from '../../src/services/minebot/utils/actReport.js';

// act の監視を試す。移動・fight の中身は既存の各練習場が受け持つ。
vi.mock('../../src/services/minebot/utils/primitives/go.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/primitives/go.js')>();
  const { wait } = await import('../../src/services/minebot/utils/primitives/common.js');
  return { ...actual, go: vi.fn(async (ctx: any) => { await wait(ctx, 400); return { ok: true, text: '着いた' }; }) };
});
vi.mock('../../src/services/minebot/utils/primitives/fight.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/primitives/fight.js')>();
  const { wait } = await import('../../src/services/minebot/utils/primitives/common.js');
  return { ...actual, fight: vi.fn(async (ctx: any) => { await wait(ctx, 400); return { ok: true, text: 'fight 済' }; }) };
});
vi.mock('../../src/services/minebot/utils/primitives/pickup.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/primitives/pickup.js')>();
  const { wait } = await import('../../src/services/minebot/utils/primitives/common.js');
  return { ...actual, pickup: vi.fn(async (ctx: any) => { await wait(ctx, 400); return { ok: true, text: '拾った' }; }) };
});
vi.mock('../../src/services/minebot/utils/primitives/pillarUp.js', () => ({ pillarUp: vi.fn(async () => ({ ok: true, text: '2段積んで上がった' })) }));

function fixture(count = 2, health = 20) {
  const slots = new Array(46).fill(null);
  const items: any[] = [{ name: 'wooden_sword', count: 1 }, { name: 'bread', count: 3 }];
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), onGround: true, yaw: 0, height: 1.8 },
    health, food: 20, game: { dimension: 'the_nether' }, entities: {}, inventory: { slots, items: () => items },
    heldItem: items[0], executingSkill: false, interruptExecution: false,
    blockAt: (p: Vec3) => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', position: p.floored() }),
    setControlState: vi.fn(), clearControlStates: vi.fn(), stopDigging: vi.fn(),
    look: vi.fn(async () => {}), lookAt: vi.fn(async () => {}), attack: vi.fn(), equip: vi.fn(async () => {}), consume: vi.fn(async () => {}),
  });
  for (let i = 0; i < count; i++) bot.entities[i + 2] = { id: i + 2, name: 'wither_skeleton', position: new Vec3(2.5, 64, 0.5 + i * 0.3), height: 2.4, width: 0.7 };
  const ledger = ensureReflexLedger(bot);
  watchDamage(bot);
  return { bot, items, ledger };
}
const hp = (bot: any, value: number) => { bot.health = value; bot.emit('health'); };
const state = () => ({ retreat: { engaged: false, ticks: 0, cooldown: 0, engagements: 0 }, busy: null, retryAt: 0, engagements: { eat: 0, armor: 0 } });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('run62: 受けた一撃と届く近接敵で打ち返しをやめる', () => {
  it('一撃8、敵2体、体力14: 木の剣で打ち返さず既存の flee へ渡す', async () => {
    const { bot, ledger } = fixture();
    installFloorReflexes(bot, floorConfig({}));
    hp(bot, 12); hp(bot, 14);
    expect(meleeDanger(bot)).toMatchObject({ hit: 8, count: 2, health: 17 });
    expect(meleeChoice(bot, meleeThreatsNear(bot), { beingHit: true }).hand).toBeNull();
    bot.emit('physicsTick');
    await vi.advanceTimersByTimeAsync(10);
    expect(bot.floorReflexes.busy).toBe('flee');
    expect(bot.attack).not.toHaveBeenCalled();
    expect(bot.setControlState).toHaveBeenCalledWith('forward', true);
    expect(ledger.entriesSince(0).some(entry => entry.detail.includes('打ち返しをやめる：wither_skeleton 2体、一撃 8.0、体力 14.0'))).toBe(true);
    expect(bot.floorReflexes.engagements.meleeStopped).toBe(1);
    await vi.advanceTimersByTimeAsync(400);
  });

  it('一撃2、敵1体、体力10: 今まで通り打ち返す', () => {
    const { bot } = fixture(1, 12); hp(bot, 10);
    expect(meleeChoice(bot, meleeThreatsNear(bot), { beingHit: true }).hand?.kind).toBe('hit');
    expect(fleeStart(bot, state(), Date.now())).toBeNull();
  });

  it('危険域で始めた flee は3.5mを出ただけでは終わらず、既存の継続範囲まで離れる', async () => {
    const { bot } = fixture(); installFloorReflexes(bot, floorConfig({}));
    hp(bot, 12); hp(bot, 14); bot.emit('physicsTick');
    bot.entity.position.x -= 3;
    expect(meleeDanger(bot).health).toBe(0);
    expect(fleeThreat(bot, true)).not.toBeNull();
    hp(bot, 18); expect(fleeThreat(bot, true)).toBeNull();
    await vi.advanceTimersByTimeAsync(400);
  });

  it('3体以上でも見積もりは2発分で、回復しても最大の一撃を保ち、4秒で失効する', async () => {
    const { bot } = fixture(3); hp(bot, 12); hp(bot, 16); hp(bot, 14);
    expect(meleeDanger(bot)).toMatchObject({ hit: 8, count: 3, blows: 2, health: 17 });
    await vi.advanceTimersByTimeAsync(4001);
    expect(meleeDanger(bot).health).toBe(0);
    expect(fleeStart(bot, state(), Date.now())).toBeNull();
  });

  it('遠い敵・壁で遮断された敵は数えない', () => {
    const { bot } = fixture(); hp(bot, 12);
    bot.entities[3].position = new Vec3(10.5, 64, 0.5);
    expect(meleeDanger(bot).count).toBe(1);
    bot.blockAt = (p: Vec3) => ({ name: p.x >= 1 && p.x < 2 || p.y < 64 ? 'stone' : 'air', boundingBox: p.x >= 1 && p.x < 2 || p.y < 64 ? 'block' : 'empty', position: p.floored() });
    expect(meleeDanger(bot).count).toBe(0);
  });

  it('motor port と床で同じ一撃を読み、死亡・再出現で前の命を引き継がない', async () => {
    const { bot } = fixture(); hp(bot, 12);
    await executeAction(bot, 'act', 1000, async () => {
      expect(meleeDanger(createMotorPort(bot)).hit).toBe(8);
      return { success: true, result: '' };
    });
    hp(bot, 0); hp(bot, 20); bot.emit('spawn');
    expect(meleeDanger(bot).hit).toBe(0);
    hp(bot, 18); expect(meleeDanger(bot).hit).toBe(2);
  });

  it('打ち返しの2発目を待つ間でも、危ない傷を受けたら50ms以内にやめる', async () => {
    const { bot } = fixture();
    const hand = meleeChoice(bot, meleeThreatsNear(bot), { beingHit: true }).hand!;
    expect(hand.kind).toBe('hit');
    const run = runMelee(bot, bot, hand);
    await vi.advanceTimersByTimeAsync(170);
    expect(bot.attack).toHaveBeenCalledTimes(1);
    hp(bot, 12);
    await vi.advanceTimersByTimeAsync(50);
    expect((await run).result).toContain('打ち返しをやめる');
    expect(bot.attack).toHaveBeenCalledTimes(1);
  });

  it('積む物があれば pillarOver を使い、逃げ道なしでも危ない殴り合いへ戻らない', () => {
    const { bot, items } = fixture(); hp(bot, 12);
    items.push({ name: 'cobblestone', count: 8 });
    expect(meleeChoice(bot, meleeThreatsNear(bot), { beingHit: true }).hand).toMatchObject({ kind: 'pillar', n: 2 });
    expect(lastStandChoice(bot)).toMatchObject({ kind: 'melee', hand: { kind: 'pillar' } });
    items.pop(); expect(lastStandChoice(bot)).toBeNull();
  });
});

describe('run62: accept は殴り負けを隠さない', () => {
  it.each(['go', 'pickup'] as const)('%s: accept wither_skeleton でも一撃8、体力12、2体なら頭へ理由を返す', async kind => {
    const { bot } = fixture();
    const run = runAct(bot, kind === 'go' ? [{ do: 'go', to: { x: 12, y: 64, z: 0 } }] : [{ do: 'pickup', range: 8 }], { hostileWithin: 6 }, undefined, { accept: ['wither_skeleton'], tickMs: 20 });
    hp(bot, 12);
    await vi.advanceTimersByTimeAsync(500);
    const result = await run, report = JSON.parse(result.result);
    expect(result.failureType).toBe('damage_taken');
    expect(report.stoppedWhy).toBe('受け切れない: wither_skeleton の一撃 8.0 ×2、残り 12.0');
  });

  it('遠い blaze の小さな傷では止まらず、accept の近くに居てよい意味を保つ', async () => {
    const { bot } = fixture(0, 16);
    bot.entities[2] = { id: 2, name: 'blaze', position: new Vec3(10, 64, 0.5) };
    const run = runAct(bot, [{ do: 'go', to: { x: 12, y: 64, z: 0 } }], { hostileWithin: 12 }, undefined, { accept: ['blaze'], tickMs: 20 });
    hp(bot, 15); await vi.advanceTimersByTimeAsync(500);
    expect((await run).success).toBe(true);
  });

  it('fight の間は同じ傷でも新しい止まりを出さず、fight に任せる', async () => {
    const { bot } = fixture();
    const run = runAct(bot, [{ do: 'fight', target: 'wither_skeleton', retreatHp: 12 }], undefined, undefined, { accept: ['wither_skeleton'], tickMs: 20 });
    hp(bot, 12); await vi.advanceTimersByTimeAsync(500);
    expect((await run).success).toBe(true);
  });

  it('床が act を先に中断しても、受け切れない理由を失わない', async () => {
    const { bot } = fixture();
    installFloorReflexes(bot, floorConfig({}));
    const run = executeAction(bot, 'act', 2000, () => runAct(createMotorPort(bot), [{ do: 'go', to: { x: 12, y: 64, z: 0 } }], undefined, undefined, { accept: ['wither_skeleton'], tickMs: 100 }));
    await vi.advanceTimersByTimeAsync(1); hp(bot, 12); bot.emit('physicsTick');
    await vi.advanceTimersByTimeAsync(500);
    await run;
    expect(takeActReport(bot, 0)?.stoppedWhy).toContain('受け切れない: wither_skeleton の一撃 8.0 ×2');
  });
});

describe('run62: flee の区切りの中で詰まりを見る', () => {
  it.each([true, false])('6tick動かないと区切りを切り、次の候補へ向きを変える（接地 %s）', async onGround => {
    const { bot } = fixture(1, 7), memory = {};
    bot.entity.onGround = onGround;
    const first = runLowHealthFlee(bot, bot, 50, memory);
    await vi.advanceTimersByTimeAsync(300);
    expect((await first).ended).toBe('stuck');
    const yaw = bot.look.mock.calls[0][0];
    const next = runLowHealthFlee(bot, bot, 50, memory);
    expect(bot.look.mock.calls.at(-1)[0]).not.toBe(yaw);
    await vi.advanceTimersByTimeAsync(300); await next;
    expect(bot.setControlState).toHaveBeenCalledWith('forward', false);
  });

  it('床の episode も7tick目で次の向きを取り、向きを変えた回数を残す', async () => {
    const { bot } = fixture(1, 7);
    installFloorReflexes(bot, floorConfig({})); bot.emit('physicsTick');
    await vi.advanceTimersByTimeAsync(300);
    const yaw = bot.look.mock.calls[0][0];
    bot.emit('physicsTick'); await vi.advanceTimersByTimeAsync(1);
    expect(bot.look.mock.calls.at(-1)[0]).not.toBe(yaw);
    expect(bot.floorReflexes.engagements.fleeStuckTurns).toBe(1);
    expect(bot.floorReflexes.fleeEpisode.segments).toBe(2);
    await vi.advanceTimersByTimeAsync(300);
  });

  it('詰まった向き以外は壁なら、7tick目で既存の pillarOver へ渡す', async () => {
    const { bot, items } = fixture(1, 7); items.push({ name: 'cobblestone', count: 8 });
    bot.blockAt = (p: Vec3) => {
      const solid = p.y < 64 || p.y >= 64 && (Math.floor(p.z) !== 0);
      return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', position: p.floored() };
    };
    installFloorReflexes(bot, floorConfig({})); bot.emit('physicsTick');
    await vi.advanceTimersByTimeAsync(300);
    bot.emit('physicsTick'); await vi.advanceTimersByTimeAsync(1);
    expect(bot.floorReflexes.engagements.pillar).toBe(1);
    expect(bot.floorReflexes.fleeEpisode).toBeUndefined();
    expect(bot.attack).not.toHaveBeenCalled();
  });

  it('普通に走れる時は24tickを最後まで使う', async () => {
    const { bot } = fixture(1, 7);
    const move = setInterval(() => {
      bot.entity.position.x -= 0.2; bot.entities[2].position = bot.entity.position.offset(2, 0, 0);
    }, 50);
    const run = runLowHealthFlee(bot, bot);
    await vi.advanceTimersByTimeAsync(1200); clearInterval(move);
    expect(await run).toMatchObject({ ended: 'cap', moved: expect.any(Number) });
    expect(bot.look).toHaveBeenCalledTimes(24);
  });
});

describe('run62: 食事より先に届く近接敵から離れる', () => {
  it.each([2, 10])('体力7、敵%sm: 2mでは離れ、10mでは従来通り食べる', async distance => {
    const { bot } = fixture(1, 7); bot.food = 2;
    bot.entities[2].position = bot.entity.position.offset(distance, 0, 0);
    expect(floorEatChoice(bot)?.name ?? null).toBe(distance === 2 ? null : 'bread');
    installFloorReflexes(bot, floorConfig({})); bot.emit('physicsTick');
    await vi.advanceTimersByTimeAsync(10);
    if (distance === 2) {
      expect(bot.floorReflexes.busy).toBe('flee'); expect(bot.consume).not.toHaveBeenCalled();
    } else expect(bot.consume).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400);
  });
});
