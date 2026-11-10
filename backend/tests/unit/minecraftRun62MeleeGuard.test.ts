import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelAction, createMotorPort, executeAction, handoverOf, inheritedIdleShield, physicalRoots } from '../../src/services/minebot/execution/ActionExecution.js';
import { installFloorReflexes, lastStandChoice, meleeChoice, meleeThreatsNear, runLastStand, runMelee, type MeleeHand } from '../../src/services/minebot/utils/floorReflexes.js';
import { installShieldBlock } from '../../src/services/minebot/utils/shieldBlock.js';
import { floorConfig } from '../../src/services/minebot/utils/floorConfig.js';

const SWORD = { name: 'iron_sword', type: 20, count: 1 };
const SHIELD = { name: 'shield', type: 21, count: 1 };
const COBBLE = { name: 'cobblestone', type: 1, count: 32 };
const mob = (id: number, name: string, x = 2.6, z = 0.5) => ({ id, name, type: 'hostile', health: 100,
  height: name === 'wither_skeleton' ? 2.4 : 1.95, width: 0.6, position: new Vec3(x, 64, z) });

function fixture(enemies = [mob(7, 'zombie')], options: { items?: any[]; shield?: boolean; roof?: number; rim?: boolean; corridor?: boolean } = {}) {
  const blocks = new Map<string, string>();
  const calls: Array<{ op: string; at: number; value?: unknown }> = [];
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { id: 1, name: 'player', position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, onGround: true, metadata: [0] },
    health: 20, food: 20, game: { dimension: 'the_nether' }, entities: Object.fromEntries(enemies.map(entity => [entity.id, entity])),
    inventory: { items: () => options.items ?? [SWORD, COBBLE], slots: new Array(46).fill(null) },
    heldItem: SWORD, controlState: {}, usingHeldItem: false,
    registry: { entitiesByName: Object.fromEntries(enemies.map(entity => [entity.name, { type: 'hostile' }])), blocksByName: { cobblestone: { id: 1 } } },
    setControlState: vi.fn((key: string, value: boolean) => { bot.controlState[key] = value; calls.push({ op: key, at: Date.now(), value }); }),
    clearControlStates: vi.fn(() => { bot.controlState = {}; }), stopDigging: vi.fn(),
    look: vi.fn((yaw: number) => { bot.entity.yaw = yaw; }), lookAt: vi.fn(async () => undefined),
    equip: vi.fn(async (item: any, destination: string) => { if (destination === 'off-hand') bot.inventory.slots[45] = item; else bot.heldItem = item; }),
    activateItem: vi.fn((off: boolean) => { bot.usingHeldItem = true; calls.push({ op: 'shield', at: Date.now(), value: off }); }),
    deactivateItem: vi.fn(() => { bot.usingHeldItem = false; }),
    attack: vi.fn(() => { calls.push({ op: 'attack', at: Date.now() }); }),
    blockAt: (p: Vec3) => {
      const at = p.floored(), key = `${at.x},${at.y},${at.z}`;
      const floor = at.y < 64 && (!options.rim || (at.x === 0 && at.z === 0));
      const wall = options.corridor && at.y >= 64 && (Math.abs(at.z) >= 2 || at.x <= -6 || at.x >= 10 || at.y >= 67);
      const name = blocks.get(key) ?? (wall ? 'nether_bricks' : floor || at.y === options.roof ? 'stone' : 'air');
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', diggable: true, hardness: 1.5, position: at };
    },
    placeBlock: vi.fn(async (reference: any, face: Vec3) => { const at = reference.position.plus(face); blocks.set(`${at.x},${at.y},${at.z}`, bot.heldItem.name); }),
  });
  if (options.shield !== false) bot.inventory.slots[45] = SHIELD;
  return { bot, calls, blocks };
}

function choose(bot: any): MeleeHand | null { return meleeChoice(bot, meleeThreatsNear(bot), { beingHit: true }).hand; }

async function readyPassiveGuard(elapsed = 250) {
  const enemy = mob(7, 'wither_skeleton', 1.9), f = fixture([enemy], { items: [SWORD] }), { bot } = f;
  bot._client = {};
  bot.registry.entitiesByName.player = { metadataKeys: [...Array(8).fill('other'), 'living_entity_flags'] };
  const activate = bot.activateItem, deactivate = bot.deactivateItem;
  bot.activateItem = (off: boolean) => { activate(off); bot.entity.metadata[8] = 3; };
  bot.deactivateItem = () => { deactivate(); bot.entity.metadata[8] = 0; };
  installShieldBlock(bot); bot.emit('physicsTick');
  await vi.advanceTimersByTimeAsync(elapsed);
  return { ...f, enemy };
}

afterEach(() => { vi.useRealTimers(); });

describe('run62 #5: groups and heavy melee enemies are defended against at full health', () => {
  it('starts before the first hit in the existing 4 m range and ACKs a full-width two-high corridor barrier in one hand', async () => {
    const enemies = [mob(7, 'wither_skeleton', 3.8, -0.15), mob(8, 'wither_skeleton', 3.8, 1.15), mob(9, 'wither_skeleton', 4.3)];
    const { bot, blocks } = fixture(enemies, { corridor: true });
    installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1 });
    expect(bot.health).toBe(20);
    expect(bot.floorReflexes.healthSeen?.fellAt).toBeUndefined();
    bot.emit('physicsTick');
    await vi.waitFor(() => {
      for (const z of [-1, 0, 1]) for (const y of [64, 65]) expect(blocks.get(`1,${y},${z}`)).toBe('cobblestone');
      expect(bot.floorReflexes.busy).toBeNull();
    });
    expect(bot.floorReflexes.melee.hands).toBe(1);
    expect(bot.attack).not.toHaveBeenCalled();
    expect(meleeThreatsNear(bot)).toEqual([]); // fresh exposure after all placement acknowledgements
    const placed = bot.placeBlock.mock.calls.map(([reference, face]: any[]) => reference.position.plus(face));
    expect(placed.map((cell: Vec3) => cell.y)).toEqual([65, 65, 65, 64, 64, 64]);
  });

  it('11/10: one ordinary enemy in the 4 m range is no longer left alone: the engagement rule strikes it first (its own hand, no barrier, no hand of the old episode)', async () => {
    const { bot } = fixture([mob(7, 'zombie', 3.8)], { corridor: true });
    installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1 });
    bot.emit('physicsTick');
    // 3.3 m from the eye: out of reach (3), so the hand steps toward it first; it never lays a block for one enemy.
    await vi.waitFor(() => expect(bot.floorReflexes.melee?.lastKind).toBe('engage'));
    expect(bot.floorReflexes.melee.hands).toBe(0);
    expect(bot.placeBlock).not.toHaveBeenCalled();
  });

  it.each([
    ['wither skeleton', [mob(7, 'wither_skeleton', 6.5)]],
    ['piglin brute', [mob(7, 'piglin_brute', 6.5)]],
    ['two ordinary enemies', [mob(7, 'zombie', 6.3, .3), mob(8, 'zombie', 6.3, .7)]],
  ] as Array<[string, ReturnType<typeof mob>[]]>)('prepares only a barrier by 6 m for %s, while the ordinary 4 m threat reader stays unchanged', async (_name, enemies) => {
    const { bot, blocks } = fixture(enemies, { corridor: true });
    expect(meleeThreatsNear(bot)).toEqual([]);
    installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1 });
    bot.emit('physicsTick');
    await vi.waitFor(() => {
      for (const z of [-1, 0, 1]) for (const y of [64, 65]) expect(blocks.get(`1,${y},${z}`)).toBe('cobblestone');
      expect(bot.floorReflexes.busy).toBeNull();
    });
    expect(bot.floorReflexes.melee.hands).toBe(1);
    expect(bot.attack).not.toHaveBeenCalled();
  });

  it.each([
    ['beyond 6 m', [mob(7, 'wither_skeleton', 6.501)]],
    ['one ordinary enemy', [mob(7, 'zombie', 5.8)]],
  ] as Array<[string, ReturnType<typeof mob>[]]>)('does not extend the reflex to %s, even with a recent health loss', (_name, enemies) => {
    const { bot } = fixture(enemies, { corridor: true });
    installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1 });
    bot.floorReflexes.healthSeen = { last: 19, fellAt: Date.now() };
    bot.emit('physicsTick');
    expect(bot.floorReflexes.melee).toBeUndefined();
    expect(bot.placeBlock).not.toHaveBeenCalled(); expect(bot.attack).not.toHaveBeenCalled();
    expect(bot.setControlState.mock.calls.some(([, value]: [string, boolean]) => value)).toBe(false);
  });

  it('spends no distant hand or fallback when the unchanged six-cell material requirement cannot be met', () => {
    const { bot } = fixture([mob(7, 'wither_skeleton', 5.8)], { corridor: true, items: [SWORD, { ...COBBLE, count: 2 }] });
    installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1 });
    bot.emit('physicsTick');
    expect(bot.floorReflexes.melee).toBeUndefined();
    expect(bot.placeBlock).not.toHaveBeenCalled(); expect(bot.attack).not.toHaveBeenCalled();
    expect(bot.setControlState.mock.calls.some(([, value]: [string, boolean]) => value)).toBe(false);
  });

  it('keeps fresh sealing and an already capped episode ahead of distant preparation', () => {
    const sealed = fixture([mob(7, 'wither_skeleton', 5.8)], { corridor: true });
    for (const z of [-1, 0, 1]) for (const y of [64, 65]) sealed.blocks.set(`2,${y},${z}`, 'cobblestone');
    installFloorReflexes(sealed.bot, floorConfig({}), { fleeTickMs: 1 }); sealed.bot.emit('physicsTick');
    expect(sealed.bot.floorReflexes.melee).toBeUndefined(); expect(sealed.bot.placeBlock).not.toHaveBeenCalled();
    const capped = fixture([mob(7, 'wither_skeleton', 5.8)], { corridor: true }).bot;
    installFloorReflexes(capped, floorConfig({}), { fleeTickMs: 1 });
    capped.floorReflexes.melee = { since: Date.now(), lastEnd: Date.now(), hands: 3, cappedAt: Date.now() };
    capped.emit('physicsTick'); expect(capped.placeBlock).not.toHaveBeenCalled(); expect(capped.floorReflexes.melee.hands).toBe(3);
  });

  it('does not report a completed two-high barrier when one placement is not acknowledged', async () => {
    vi.useFakeTimers();
    const { bot, blocks } = fixture([mob(7, 'wither_skeleton', 3.8)], { corridor: true });
    const hand = meleeChoice(bot, meleeThreatsNear(bot)).hand;
    expect(hand?.kind).toBe('block');
    bot.placeBlock.mockImplementation(async (reference: any, face: Vec3) => {
      const cell = reference.position.plus(face);
      if (cell.y !== 64 || cell.z !== 1) blocks.set(`${cell.x},${cell.y},${cell.z}`, 'cobblestone');
    });
    const running = runMelee(bot, bot, hand!);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await running;
    expect(result.success).toBe(false);
    expect(result.result).toMatch(/^not_placed \(1,64,1\) 設置ACK 5\/6/u);
    expect(blocks.get('1,64,1')).toBeUndefined();
    expect(bot.attack).not.toHaveBeenCalled();
  });

  it('keeps the actual refusal code and second cell ahead of the first successful placement when a mob enters it', async () => {
    const enemy = mob(7, 'wither_skeleton', 3.8);
    const { bot, blocks } = fixture([enemy], { corridor: true });
    const hand = meleeChoice(bot, meleeThreatsNear(bot)).hand;
    expect(hand?.kind).toBe('block');
    bot.placeBlock.mockImplementationOnce(async (reference: any, face: Vec3) => {
      const cell = reference.position.plus(face);
      blocks.set(`${cell.x},${cell.y},${cell.z}`, 'cobblestone');
      enemy.position = new Vec3(1.5, 64, 0.5);
    });
    const result = await runMelee(bot, bot, hand!);
    expect(result.success).toBe(false);
    expect(result.result).toMatch(/^creature_in_cell \(1,65,0\) 設置ACK 1\/6/u);
    expect(bot.placeBlock).toHaveBeenCalledTimes(1);
    expect(blocks.get('1,65,-1')).toBe('cobblestone');
    expect(bot.attack).not.toHaveBeenCalled();
  });

  it('refuses a partial corridor barrier when its full width is occupied or the material only covers one column', () => {
    const enemies = [mob(7, 'wither_skeleton', 3.8), mob(8, 'wither_skeleton', 4.2)];
    const scarce = fixture(enemies, { corridor: true, items: [SWORD, { ...COBBLE, count: 2 }] });
    expect(choose(scarce.bot)?.kind).toBe('shield');
    const occupied = fixture([...enemies, mob(9, 'wither_skeleton', 1.5, -0.5)], { corridor: true });
    expect(choose(occupied.bot)?.kind).not.toBe('block');
    expect(occupied.bot.attack).not.toHaveBeenCalled();
  });

  it.each([
    ['two zombies', [mob(7, 'zombie'), mob(8, 'zombie', 3.5)]],
    ['one wither skeleton', [mob(7, 'wither_skeleton')]],
    ['one piglin brute', [mob(7, 'piglin_brute')]],
  ])('%s: two-high barrier before shield retreat or a pillar', async (_name, enemies) => {
    const { bot, blocks } = fixture(enemies);
    const hand = choose(bot);
    expect(hand).toMatchObject({ kind: 'block', cell: { x: 1, y: 64, z: 0 }, upper: { x: 1, y: 65, z: 0 } });
    const result = await runMelee(bot, bot, hand!);
    expect(result.success).toBe(true);
    expect(blocks.get('1,64,0')).toBe('cobblestone');
    expect(blocks.get('1,65,0')).toBe('cobblestone');
    expect(bot.attack).not.toHaveBeenCalled();
    expect(bot.setControlState.mock.calls.some(([key, value]: [string, boolean]) => key === 'jump' && value)).toBe(false);
  });

  it('with no barrier material, keeps the shield facing the enemy while stepping backward', async () => {
    vi.useFakeTimers();
    const { bot, calls } = fixture([mob(7, 'wither_skeleton', 1.9)], { items: [SWORD] });
    installShieldBlock(bot);
    const hand = choose(bot);
    expect(hand?.kind).toBe('shield');
    const running = runMelee(bot, bot, hand!);
    await vi.advanceTimersByTimeAsync(249);
    expect(calls.some(call => call.value === true && ['forward', 'back', 'left', 'right'].includes(call.op))).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.shieldBlock.up).toBe(true);
    expect(bot.controlState.back).toBe(true);
    expect(bot.controlState.forward).toBe(false);
    expect(bot.entity.yaw).toBeCloseTo(-Math.PI / 2);
    bot.emit('physicsTick');
    expect(bot.shieldBlock.up).toBe(true); // the resident shield must not lower this hand's guard
    if (hand?.kind !== 'shield') throw new Error('shield step required');
    bot.entity.position = new Vec3(hand.to.x + 0.5, hand.to.y, hand.to.z + 0.5);
    await vi.advanceTimersByTimeAsync(50);
    expect((await running).success).toBe(true);
    expect(bot.controlState.back).toBe(false);
    expect(bot.engagements).toEqual([]);
    expect(bot.attack).not.toHaveBeenCalled();
  });

  it('replay without explicit defense adoption: each new safety owner drops the idle guard before raising it again', async () => {
    vi.useFakeTimers();
    const enemy = mob(7, 'wither_skeleton', 1.9);
    const { bot, calls } = fixture([enemy], { items: [SWORD] });
    installShieldBlock(bot);
    bot.emit('physicsTick');
    expect(bot.shieldBlock.idleMeleeGuard).toBe(true);
    expect(bot.usingHeldItem).toBe(true);
    const ownerEntries: boolean[] = [];
    for (const x of [-1, -2]) {
      const hand: MeleeHand = { kind: 'shield', target: enemy, to: { x, y: 64, z: 0 }, detail: 'shield step' };
      const running = executeAction(bot, 'floor-melee', 2500, async () => {
        ownerEntries.push(bot.usingHeldItem);
        return runMelee(bot, createMotorPort(bot), hand);
      }, { priority: 250, safetyLease: true, waitForQuiescence: true });
      await vi.advanceTimersByTimeAsync(250);
      bot.entity.position = new Vec3(x + .5, 64, .5);
      await vi.advanceTimersByTimeAsync(50);
      expect((await running).success).toBe(true);
      expect(bot.engagements).toEqual([]);
      // Normal completion keeps the shield up; the following owner's acquisition is where it drops.
      expect(bot.usingHeldItem).toBe(true);
      bot.emit('physicsTick');
      expect(bot.shieldBlock.idleMeleeGuard).toBe(true);
    }
    expect(ownerEntries).toEqual([false, false]);
    expect(bot.shieldBlock.deactivateCalls).toBe(2);
    expect(calls.filter(call => call.op === 'shield')).toHaveLength(3); // initial passive guard + one re-raise per owner
    await executeAction(bot, 'move-to', 1000, async () => {
      expect(bot.usingHeldItem).toBe(false);
      createMotorPort(bot).setControlState('forward', true);
      return { success: true, result: 'head movement owns the body' };
    }, { waitForQuiescence: true });
    expect(bot.shieldBlock.deactivateCalls).toBe(3);
    expect(bot.attack).not.toHaveBeenCalled();
  });

  it('keeps a server-confirmed warmed idle guard across two explicit shield steps without another USE or RELEASE', async () => {
    vi.useFakeTimers();
    const { bot, enemy, calls } = await readyPassiveGuard();
    for (const x of [-1, -2]) {
      const hand: MeleeHand = { kind: 'shield', target: enemy, to: { x, y: 64, z: 0 }, detail: 'shield step' };
      const running = executeAction(bot, 'floor-melee', 2500, async () => {
        expect(inheritedIdleShield(bot)).toBe('kept');
        expect(handoverOf(bot)).toBeUndefined(); // no synthetic A6 confirmed handover
        return runMelee(bot, createMotorPort(bot), hand);
      }, { priority: 250, safetyLease: true, preserveIdleMeleeShield: true, waitForQuiescence: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(bot.controlState.back).toBe(true); // no new five-tick warmup for an already warmed guard
      bot.entity.position = new Vec3(x + .5, 64, .5);
      await vi.advanceTimersByTimeAsync(50);
      expect((await running).success).toBe(true);
      bot.emit('physicsTick');
    }
    expect(bot.shieldBlock.deactivateCalls).toBe(0);
    expect(calls.filter(call => call.op === 'shield')).toHaveLength(1);
    expect(bot.attack).not.toHaveBeenCalled();
  });

  it('keeps the acquired guard through a full-barrier refusal and then passes it to a shield step', async () => {
    vi.useFakeTimers(); const { bot, enemy, calls } = await readyPassiveGuard();
    const barrier: MeleeHand = { kind: 'block', target: enemy, cell: { x: 1, y: 65, z: -1 }, cells: [{ x: 1, y: 65, z: 0 }], block: 'cobblestone', detail: 'barrier' };
    const result = await executeAction(bot, 'floor-melee', 3500, () => runMelee(bot, createMotorPort(bot), barrier),
      { safetyLease: true, preserveIdleMeleeShield: true, waitForQuiescence: true });
    expect(result.success).toBe(false); expect(result.result).toContain('missing_item');
    expect(bot.usingHeldItem).toBe(true); expect(bot.engagements).toEqual([]);
    bot.emit('physicsTick');
    const running = executeAction(bot, 'floor-melee', 2500, () => runMelee(bot, createMotorPort(bot), {
      kind: 'shield', target: enemy, to: { x: -1, y: 64, z: 0 }, detail: 'shield step',
    }), { safetyLease: true, preserveIdleMeleeShield: true, waitForQuiescence: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(bot.controlState.back).toBe(true);
    bot.entity.position = new Vec3(-.5, 64, .5); await vi.advanceTimersByTimeAsync(50);
    expect((await running).success).toBe(true);
    expect(bot.shieldBlock.deactivateCalls).toBe(0);
    expect(calls.filter(call => call.op === 'shield')).toHaveLength(1);
  });

  it.each(['act', 'floor-flee', 'other-reflex', 'floor-melee-nonsafety'])('yields the idle shield to %s even if the internal option is present', async capability => {
    vi.useFakeTimers(); const { bot } = await readyPassiveGuard();
    await executeAction(bot, capability === 'floor-melee-nonsafety' ? 'floor-melee' : capability, 1000, async () => {
      expect(bot.usingHeldItem).toBe(false);
      expect(inheritedIdleShield(bot)).toBeNull();
      return { success: true, result: 'new owner' };
    }, { safetyLease: capability !== 'floor-melee-nonsafety' && capability !== 'act', preserveIdleMeleeShield: true, waitForQuiescence: true });
    expect(bot.shieldBlock.deactivateCalls).toBe(1);
  });

  it.each(['fresh', 'mainhand', 'no-server-use', 'missing-metadata', 'not-using', 'no-shield', 'disabled', 'client', 'entity', 'dimension', 'death', 'respawn', 'spawn', 'game', 'end'])(
    'does not manufacture a ready inherited shield from %s', async cause => {
      vi.useFakeTimers(); const { bot } = await readyPassiveGuard(cause === 'fresh' ? 249 : 250);
      if (cause === 'mainhand') bot.entity.metadata[8] = 1;
      if (cause === 'no-server-use') bot.entity.metadata[8] = 0;
      if (cause === 'missing-metadata') delete bot.entity.metadata[8];
      if (cause === 'not-using') bot.usingHeldItem = false;
      if (cause === 'no-shield') bot.inventory.slots[45] = null;
      if (cause === 'disabled') bot.shieldBlock.enabled = false;
      if (cause === 'client') bot._client = {};
      if (cause === 'entity') bot.entity = { ...bot.entity };
      if (cause === 'dimension') bot.game.dimension = 'overworld';
      if (['death', 'respawn', 'spawn', 'game', 'end'].includes(cause)) bot.emit(cause);
      await executeAction(bot, 'floor-melee', 1000, async () => {
        expect(inheritedIdleShield(bot)).toBeNull();
        expect(bot.usingHeldItem).toBe(false);
        return { success: true, result: 'not inherited' };
      }, { safetyLease: true, preserveIdleMeleeShield: true, waitForQuiescence: true });
      expect(bot.shieldBlock.deactivateCalls).toBe(1);
    },
  );

  it.each(['cancel', 'respawn', 'server-hand', 'offhand'])('loses an acquired guard on %s without reactivating or moving it in that old owner', async cause => {
    vi.useFakeTimers(); const { bot, enemy, calls } = await readyPassiveGuard();
    let lost: ReturnType<typeof inheritedIdleShield> = null;
    const result = await executeAction(bot, 'floor-melee', 1000, async () => {
      expect(inheritedIdleShield(bot)).toBe('kept');
      if (cause === 'cancel') cancelAction(bot, physicalRoots(bot)[0].actionId);
      else {
        if (cause === 'respawn') bot.emit('respawn');
        if (cause === 'server-hand') bot.entity.metadata[8] = 1;
        if (cause === 'offhand') bot.inventory.slots[45] = null;
        const hand: MeleeHand = { kind: 'shield', target: enemy, to: { x: -1, y: 64, z: 0 }, detail: 'shield step' };
        expect((await runMelee(bot, createMotorPort(bot), hand)).success).toBe(false);
      }
      lost = inheritedIdleShield(bot);
      return { success: true, result: 'old guard stopped' };
    }, { safetyLease: true, preserveIdleMeleeShield: true, waitForQuiescence: true });
    expect(lost).toBe('lost');
    expect(result.success).toBe(cause !== 'cancel' && cause !== 'respawn');
    expect(calls.filter(call => call.op === 'shield')).toHaveLength(1);
    expect(bot.setControlState.mock.calls.some(([, value]: [string, boolean]) => value)).toBe(false);
  });

  it('with no shield and no space for a barrier, requires three blocks and five cells of headroom', () => {
    const { bot } = fixture([mob(7, 'wither_skeleton', 1.9)], { shield: false });
    expect(choose(bot)).toMatchObject({ kind: 'pillar', n: 3 });
    bot.inventory.items = () => [SWORD, { ...COBBLE, count: 2 }];
    expect(choose(bot)?.kind).not.toBe('pillar');
    const lowRoof = fixture([mob(7, 'wither_skeleton', 1.9)], { shield: false, roof: 69 }).bot;
    expect(choose(lowRoof)?.kind).not.toBe('pillar');
  });

  it('preserves S9: a visible blaze overhead and a drop beside the feet both forbid the pillar', () => {
    const { bot } = fixture([mob(7, 'wither_skeleton', 1.9)], { shield: false });
    bot.entities[8] = { ...mob(8, 'blaze', 3.5), position: new Vec3(3.5, 66.5, 0.5) };
    expect(choose(bot)?.kind).not.toBe('pillar');
    const atRim = fixture([mob(7, 'wither_skeleton', 1.9)], { shield: false, rim: true }).bot;
    expect(choose(atRim)?.kind).not.toBe('pillar');
    expect(choose(atRim)?.kind).not.toBe('hit');
  });

  it('low-health last stand does not reopen the attack against three wither skeletons', async () => {
    const { bot } = fixture([mob(7, 'wither_skeleton'), mob(8, 'wither_skeleton', 3.3), mob(9, 'wither_skeleton', 3.8)]);
    bot.health = 3;
    const stand = lastStandChoice(bot);
    expect(stand).toMatchObject({ kind: 'melee', hand: { kind: 'block' } });
    expect((await runLastStand(bot, bot, stand!)).success).toBe(true);
    expect(bot.attack).not.toHaveBeenCalled();
  });
});

describe('one ordinary melee enemy: shield before counterattack, with fresh checks during the hand', () => {
  it('equips a carried shield and waits five ticks before the first blow', async () => {
    vi.useFakeTimers();
    const { bot, calls } = fixture([mob(7, 'zombie')], { shield: false, items: [SWORD, SHIELD] });
    installShieldBlock(bot);
    const hand = choose(bot);
    expect(hand?.kind).toBe('hit');
    const running = runMelee(bot, bot, hand!);
    await vi.advanceTimersByTimeAsync(249);
    expect(bot.attack).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await running).success).toBe(true);
    expect(bot.equip).toHaveBeenCalledWith(SHIELD, 'off-hand');
    expect(calls.find(call => call.op === 'attack')!.at - calls.find(call => call.op === 'shield')!.at).toBeGreaterThanOrEqual(250);
    expect(bot.attack).toHaveBeenCalledTimes(2);
    expect(bot.engagements).toEqual([]);
  });

  it('without a usable shield the sword alone does not authorize a counterattack', () => {
    const { bot } = fixture([mob(7, 'zombie')], { shield: false });
    expect(choose(bot)?.kind).toBe('block');
    const disabled = fixture([mob(7, 'zombie')]).bot;
    installShieldBlock(disabled); disabled.shieldBlock.enabled = false;
    expect(choose(disabled)?.kind).toBe('block');
  });

  it('stops the next blow as soon as a second enemy arrives during the cooldown', async () => {
    vi.useFakeTimers();
    const { bot } = fixture();
    const hand = choose(bot)!;
    const running = runMelee(bot, bot, hand);
    await vi.advanceTimersByTimeAsync(300);
    expect(bot.attack).toHaveBeenCalledTimes(1);
    bot.entities[8] = mob(8, 'zombie', 3.2);
    await vi.advanceTimersByTimeAsync(300);
    const result = await running;
    expect(bot.attack).toHaveBeenCalledTimes(1);
    expect(result.result).toContain('近接の敵2体には打ち返さない');
  });

  it('cancelling the safety owner during shield warmup starts no blow or movement', async () => {
    vi.useFakeTimers();
    const { bot } = fixture();
    const hand = choose(bot)!;
    const running = executeAction(bot, 'floor-melee', 5000, () => runMelee(bot, createMotorPort(bot), hand),
      { priority: 250, safetyLease: true, waitForQuiescence: false });
    await vi.advanceTimersByTimeAsync(100);
    const [root] = physicalRoots(bot);
    cancelAction(bot, root.actionId, 'interrupted');
    await vi.advanceTimersByTimeAsync(1);
    await running;
    expect(bot.attack).not.toHaveBeenCalled();
    expect(bot.setControlState.mock.calls.some(([, value]: [string, boolean]) => value)).toBe(false);
    expect(bot.engagements).toEqual([]);
  });
});
