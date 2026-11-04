import fs from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as burst from '../../src/services/minebot/utils/bedBurst.js';
import { bedHalves } from '../../src/services/minebot/utils/bedRules.js';

const require = createRequire(import.meta.url);
const mcData = require('minecraft-data')('1.21.11');
const { createSerializer, createDeserializer } = require('minecraft-protocol/src/transforms/serializer');
const serializer = createSerializer({ version: '1.21.11', state: 'play', isServer: false });
const parser = createDeserializer({ version: '1.21.11', state: 'play', isServer: true });
const source = fs.readFileSync(new URL('../../scripts/minecraft-end-fight-probe.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
const helpers = ['observeBedBurstProtocol', 'bedBurstOnMove'].map(name => ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name)!.getText()).join('\n');
const deps = { ...burst, bedHalves, Vec3 };
const { observeBedBurstProtocol, bedBurstOnMove } = new Function(...Object.keys(deps),
  ts.transpileModule(helpers, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  + '\nreturn { observeBedBurstProtocol, bedBurstOnMove };')(...Object.values(deps));
const foot = { x: 113, y: 75, z: -42 }, head = { ...foot, z: foot.z - 1 };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function rig(last: number | null = null) {
  let tick = 20, inMove = false, failure: string | null = null;
  const bot: any = new EventEmitter(), writes: any[] = [], blocks = new Map<string, any>();
  const cellKey = (p: any) => `${p.x},${p.y},${p.z}`;
  bot._client = new EventEmitter(); bot.entity = { position: new Vec3(113.5, 72, -39.5), yaw: 2, pitch: 0, onGround: true };
  bot.look = vi.fn(async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; });
  bot.setControlState = vi.fn(); bot.blockAt = (p: any) => blocks.get(cellKey(p)) ?? { name: 'air' };
  const write = vi.fn((name: string, data: any) => {
    writes.push({ name, data, tick, inMove });
    // Real 1.21.11 codec validates EVERY write, not just the two clicks.
    const bytes = serializer.createPacketBuffer({ name, params: data });
    expect(parser.parsePacketBuffer(bytes).data.name).toBe(name);
  });
  bot._client.write = write;
  const protocol = observeBedBurstProtocol(bot, () => tick);
  let evidence: burst.BedBurstEvidence;
  const options = { tick: () => tick, foot, head, previousDetonationTick: last, check: () => failure,
    before: vi.fn(), onEvidence: (e: burst.BedBurstEvidence) => { evidence = e; } };
  const move = () => { inMove = true; try { bot.emit('move'); } finally { inMove = false; } };
  // Include internally emitted stationary moves in the same call-stack check.
  const emit = bot.emit;
  bot.emit = function (name: string, ...args: any[]) { const previous = inMove; if (name === 'move') inMove = true;
    try { return emit.call(this, name, ...args); } finally { inMove = previous; } };
  const advance = async (n = 1, naturalMove = true) => {
    for (let i = 0; i < n; i++) { tick++; bot.emit('physicsTick');
      if (naturalMove) { const p = bot.entity.position; bot._client.write('position', { x: p.x, y: p.y, z: p.z, flags: { onGround: true, hasHorizontalCollision: false } }); move(); }
      await flush();
    }
  };
  const block = (part: 'foot' | 'head', facing = 'north') => {
    const cell = part === 'foot' ? foot : head;
    const b = { name: 'white_bed', position: cell, getProperties: () => ({ part, facing }) };
    blocks.set(cellKey(cell), b); bot.emit('blockUpdate', null, b);
  };
  return { bot, writes, write, protocol, options, move, advance, block, now: () => tick, fail: (reason: string) => { failure = reason; },
    evidence: () => evidence!, run: () => bedBurstOnMove(bot, protocol, options) as Promise<burst.BedBurstEvidence> };
}

afterEach(() => { vi.useRealTimers(); });

describe('1.21.11 raw bed packet values', () => {
  it('uses the registry names and roundtrips all fields through the installed protocol codec', () => {
    expect(mcData.version.minecraftVersion).toBe('1.21.11');
    const types = mcData.protocol.play.toServer.types;
    expect(types.packet_use_item_on).toBeUndefined();
    const packets = burst.bedBurstPackets(foot, head, 0, -Math.PI / 4, true, 41);
    expect(packets.map(p => p.name)).toEqual(['player_input', 'look', 'block_place', 'block_place']);
    for (const p of packets) {
      expect(Object.keys(p.data).sort()).toEqual(types[`packet_${p.name}`][1].map((f: any) => f.name).sort());
      const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: p.name, params: p.data })).data;
      expect(decoded).toMatchObject({ name: p.name, params: p.data });
    }
    expect(packets[0].data.inputs.shift).toBe(false);
    expect(packets[1].data).toMatchObject({ yaw: 180, pitch: 45 });
    expect(packets[2].data).toMatchObject({ location: { ...foot, y: foot.y - 1 }, direction: 1, cursorX: 0.5, cursorY: 1, cursorZ: 0.5, sequence: 41 });
    expect(packets[3].data).toMatchObject({ location: foot, direction: 1, cursorY: 0.5625, sequence: 42 });
  });
  it.each([0, Math.PI / 2, Math.PI, -Math.PI / 2])('converts radians to explicit Notchian degrees (%s)', yaw => {
    expect(burst.bedBurstPackets(foot, head, yaw, 0, false, 1)[1].data.yaw).toBeCloseTo(180 - yaw * 180 / Math.PI);
  });
  it('rejects non-cells, non-adjacent halves, invalid rotation and sequence overflow', () => {
    expect(() => burst.bedBurstPackets({ ...foot, x: 1.5 }, head, 0, 0, true, 1)).toThrow();
    expect(() => burst.bedBurstPackets(foot, foot, 0, 0, true, 1)).toThrow();
    expect(() => burst.bedBurstPackets(foot, head, NaN, 0, true, 1)).toThrow();
    expect(() => burst.bedBurstPackets(foot, head, 0, 0, true, 0x7fffffff)).toThrow();
  });
  it('uses eye to clicked block bounds for the server reach diagnostic', () => {
    expect(burst.bedBurstReach({ x: foot.x + 6.5, y: foot.y - 1.62, z: foot.z + 0.5 }, foot)).toBe(5.5);
    expect(burst.bedBurstReach({ x: foot.x + 6.501, y: foot.y - 1.62, z: foot.z + 0.5 }, foot)).toBeGreaterThan(5.5);
  });
});

describe('actual probe move callback and receipt window', () => {
  it('synchronously writes unsneak, look, place, use inside one move and snapshots immediately before EACH write', async () => {
    const r = rig(), promise = r.run(); await flush(); r.move();
    const sent = r.evidence().sent;
    expect(sent.map(p => p.stage)).toEqual(['unsneak', 'look', 'place', 'use']);
    expect(sent.every(p => p.written && p.tick === 20)).toBe(true);
    expect(r.writes.filter(p => p.name !== 'position').every(p => p.inMove)).toBe(true);
    expect(r.bot.setControlState).toHaveBeenCalledWith('sneak', false);
    expect(r.bot.look).toHaveBeenCalledWith(-0, expect.any(Number), true);
    for (const p of sent) expect(p).toMatchObject({ position: { x: 113.5, y: 72, z: -39.5 }, yaw: -0, pitch: r.bot.entity.pitch });
    r.block('foot'); r.block('head');
    r.bot._client.emit('explosion', { center: { x: head.x + 0.5, y: head.y + 0.5, z: head.z + 0.5 } });
    await r.advance(4); const result = await promise;
    expect(result.placeToUseTicks).toBe(0); expect(result.useToDetonationTicks).toBe(0);
    expect(result.samples).toHaveLength(3); expect(result.classification).toMatchObject({ placed: 'block_update_confirmed', used: 'explosion_confirmed', orientation: 'confirmed', reasons: [] });
    r.protocol.stop(); expect(r.bot._client.write).toBe(r.write);
    expect(r.bot.listenerCount('move')).toBe(0); expect(r.bot._client.listenerCount('explosion')).toBe(0);
  });
  it('never reaches either click if the actual rotation write fails', async () => {
    const r = rig(); const base = r.bot._client.write;
    r.bot._client.write = (name: string, data: any) => { if (name === 'look') throw new Error('wire rejected'); return base(name, data); };
    const promise = r.run(); await flush(); r.move(); const result = await promise;
    expect(r.writes.some(p => p.name === 'block_place')).toBe(false);
    expect(result.sent.find(p => p.stage === 'look')?.written).toBe(false);
    expect(result.failure).toContain('packet_write_failed'); r.protocol.stop();
  });
  it('samples the entity anew immediately before each write, even when a writer changes its values', async () => {
    const r = rig(), base = r.bot._client.write, snapshots: any[] = [];
    r.bot._client.write = (name: string, data: any) => {
      if (['look', 'player_input', 'block_place'].includes(name)) {
        snapshots.push({ position: { x: r.bot.entity.position.x, y: r.bot.entity.position.y, z: r.bot.entity.position.z }, yaw: r.bot.entity.yaw, pitch: r.bot.entity.pitch });
        const result = base(name, data);
        r.bot.entity.position.x += 0.01; r.bot.entity.yaw += 0.1; r.bot.entity.pitch += 0.01;
        return result;
      }
      return base(name, data);
    };
    const promise = r.run(); await flush(); r.move();
    expect(r.evidence().sent.map(({ position, yaw, pitch }) => ({ position, yaw, pitch }))).toEqual(snapshots);
    expect(new Set(snapshots.map(p => p.position.x)).size).toBe(4);
    r.bot.emit('end'); await promise; r.protocol.stop();
  });
  it('sends at previous detonation +10, even with NO natural moves at rest; a forced look cannot send early', async () => {
    const r = rig(20), promise = r.run(); await flush(); r.move();
    await r.advance(9, false); expect(r.evidence().sent).toHaveLength(0);
    await r.advance(1, false); expect(r.evidence().sent.map(p => p.tick)).toEqual([30, 30, 30, 30]);
    await r.advance(4, false); const result = await promise;
    expect(result.detonationToBurstTicks).toBe(10); expect(result.placeToUseTicks).toBe(0); r.protocol.stop();
  });
  it('anchors a consecutive burst to the actual delayed explosion receipt, rather than the first use tick', async () => {
    const r = rig(), first = r.run(); await flush(); r.move(); await r.advance(2);
    r.bot._client.emit('explosion', { center: { x: head.x + 0.5, y: head.y + 0.5, z: head.z + 0.5 } });
    await r.advance(2); const one = await first;
    expect(one.useToDetonationTicks).toBe(2);
    r.options.previousDetonationTick = one.detonationTick;
    const second = r.run(); await flush(); await r.advance(7, false);
    expect(r.evidence().sent).toHaveLength(0);
    await r.advance(1, false);
    expect(r.evidence().sent.every(p => p.tick === one.detonationTick! + 10)).toBe(true);
    await r.advance(4, false); expect((await second).detonationToBurstTicks).toBe(10); r.protocol.stop();
  });
  it('retains receipts arriving AFTER the third move, and ignores unrelated explosions', async () => {
    const r = rig(), promise = r.run(); await flush(); r.move(); await r.advance(3);
    r.bot._client.emit('explosion', { center: { x: head.x + 20, y: head.y, z: head.z } });
    expect(r.evidence().detonationTick).toBeNull();
    r.bot._client.emit('explosion', { center: { x: head.x + 0.5, y: head.y + 0.5, z: head.z + 0.5 } });
    await r.advance(); const result = await promise;
    expect(result.useToDetonationTicks).toBe(3); expect(result.classification?.orientation).toBe('unobserved');
    expect(result.classification?.placed).toBe('inferred_from_explosion'); r.protocol.stop();
  });
  it('retains a wrong facing even when the bed immediately disappears and explodes at that pillow', async () => {
    const r = rig(), promise = r.run(); await flush(); r.move(); r.block('foot', 'east');
    r.bot._client.emit('explosion', { center: { x: foot.x + 1.5, y: foot.y + 0.5, z: foot.z + 0.5 } });
    await r.advance(4); const result = await promise;
    expect(result.classification).toMatchObject({ orientation: 'mismatch', used: 'explosion_confirmed', reasons: ['orientation_mismatch'] }); r.protocol.stop();
  });
  it('tracks teleport BEFORE Mineflayer replies; waits for confirm, post-confirm position and the next physics tick', async () => {
    const r = rig(), promise = r.run(); await flush();
    r.bot._client.emit('position', { teleportId: 7 }); r.move(); expect(r.evidence().sent).toEqual([]);
    r.bot._client.write('teleport_confirm', { teleportId: 6 }); await r.advance(); expect(r.evidence().sent).toEqual([]);
    r.bot._client.write('teleport_confirm', { teleportId: 7 });
    const p = r.bot.entity.position; r.bot._client.write('position', { x: p.x, y: p.y, z: p.z, flags: { onGround: true, hasHorizontalCollision: false } });
    r.move(); expect(r.evidence().sent).toEqual([]);
    await r.advance(); expect(r.evidence().sent).toHaveLength(4); await r.advance(4); await promise;
    expect(r.protocol.state.corrections[0]).toMatchObject({ teleportId: 7, acknowledgedTick: 21, positionTick: 21 }); r.protocol.stop();
  });
  it.each(['self_damage', 'seated_window_ended', 'reflex_or_action_owns_body', 'head_in_dragon'])('sends no packets after a live veto: %s', async reason => {
    const r = rig(), promise = r.run(); await flush(); r.fail(reason); await r.advance(1, false);
    const result = await promise; expect(result.sent).toEqual([]); expect(result.failure).toBe(reason); r.protocol.stop();
  });
  it('allocates distinct sequences beyond prior Mineflayer writes and cleans up on disconnect', async () => {
    const r = rig(); r.bot._client.write('block_place', burst.bedBurstPackets(foot, head, 0, 0, true, 91)[2].data);
    const promise = r.run(); await flush(); r.move();
    expect(r.evidence().sent.filter(p => p.name === 'block_place').map(p => p.data.sequence)).toEqual([92, 93]);
    r.bot.emit('end'); expect((await promise).failure).toBe('disconnected');
    expect(r.bot.listenerCount('physicsTick')).toBe(0); r.protocol.stop();
  });
  it('ends receipt waiting immediately on the scene takeoff signal so evacuation keeps priority', async () => {
    const r = rig(), controller = new AbortController(); Object.assign(r.options, { signal: controller.signal });
    const promise = r.run(); await flush(); r.move(); controller.abort('takeoff_leave_now');
    const result = await promise;
    expect(result.completedTick).toBe(20); expect(result.observationInterrupted).toBe('takeoff_leave_now');
    expect(result.samples).toEqual([]); expect(r.bot.listenerCount('move')).toBe(0); r.protocol.stop();
  });
});

describe('honest rejection classification', () => {
  const missing = { placeSeen: false, orientationMatches: null, orientationMismatch: false, detonationTick: null, awaitingPosition: false, reach: 4, dragonOverlap: null };
  it.each([
    [{}, ['placement_unconfirmed']], [{ placeSeen: true }, ['use_without_explosion']],
    [{ reach: 5.501 }, ['out_of_reach', 'placement_unconfirmed']],
    [{ awaitingPosition: true }, ['awaitingPositionFromClient_possible', 'placement_unconfirmed']],
    [{ dragonOverlap: 'dragon_overlaps_head' }, ['dragon_overlap', 'placement_unconfirmed']],
    [{ orientationMismatch: true, placeSeen: true }, ['orientation_mismatch', 'use_without_explosion']],
  ])('classifies evidence without inventing a server rejection: %o', (change, reasons) => {
    expect(burst.classifyBedBurst({ ...missing, ...change }).reasons).toEqual(reasons);
  });
});
