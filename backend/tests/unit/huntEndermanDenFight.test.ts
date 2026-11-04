import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import type { DigArgs } from '../../src/services/minebot/utils/primitives/dig.js';
import type { GoArgs } from '../../src/services/minebot/utils/primitives/go.js';
import { StepStopped, wait, type StepContext, type StepOutcome } from '../../src/services/minebot/utils/primitives/common.js';
import { denCenter, denDigCells, denOffset, type DenBlock } from '../../src/services/minebot/utils/huntEndermanDen.js';
import { DEN_ARRIVAL_MS, EndermanDenFight, endermanDenObservation, type DenEntity, type DenStep } from '../../src/services/minebot/utils/huntEndermanDenFight.js';
import { fight } from '../../src/services/minebot/utils/primitives/fight.js';
import { ACT_HANDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
import type { Cell } from '../../src/services/minebot/utils/localMap.js';
import { huntDenField } from './fixtures/huntDenField.js';

const mocks = vi.hoisted(() => ({ dig: vi.fn<[StepContext, DigArgs], Promise<StepOutcome>>(), go: vi.fn<[StepContext, GoArgs], Promise<StepOutcome>>() }));
vi.mock('../../src/services/minebot/utils/primitives/dig.js', () => ({ dig: mocks.dig }));
// Keep go's argument checker for runAct, while replacing only physical navigation. The den must grant it no edits.
vi.mock('../../src/services/minebot/utils/primitives/go.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/services/minebot/utils/primitives/go.js')>(), go: mocks.go,
}));

interface Item { name: string; count: number; slot: number; type: number }
interface TestEntity extends DenEntity { type?: string; health?: number; getDroppedItem?(): { name: string; count: number } }
class FieldBot extends EventEmitter {
  readonly field = huntDenField();
  readonly entity = { id: 1, position: denCenter(denOffset(this.field.den, -1)), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true, height: 1.8, width: 0.6 };
  readonly mob: TestEntity = { id: 200, name: 'enderman', type: 'hostile', position: new Vec3(-10.5, 64, 0.5), width: 0.6, height: 2.9, metadata: [false], isValid: true, health: 6 };
  readonly entities: Record<string, TestEntity> = { 200: this.mob };
  readonly registry = { entitiesByName: { enderman: { metadataKeys: ['creepy'] } } };
  readonly game = { dimension: 'the_nether' };
  readonly gazeGuard = { enabled: true };
  readonly control: Record<string, boolean> = {};
  readonly sword: Item = { name: 'iron_sword', count: 1, type: 10, slot: 36 };
  readonly slots: Array<Item | null> = Array.from({ length: 46 }, () => null);
  readonly inventory = { slots: this.slots, items: (): Item[] => this.slots.slice(9, 45).filter((item): item is Item => item !== null) };
  readonly pathfinder = { movements: {}, setMovements: (_value: unknown): void => undefined, setGoal: (_value: unknown): void => undefined, stop: (): void => undefined };
  readonly log: string[] = [];
  readonly attacks: Vec3[] = [];
  health = 20;
  food = 20;
  heldItem: Item | null = this.sword;
  usingHeldItem = false;
  arrives = true;
  angerOnGaze = true;
  lavaReflex?: { engaged: boolean };
  afterDig?: (cell: Cell) => void;
  constructor() { super(); this.slots[36] = this.sword; }
  blockAt = (at: Vec3): DenBlock | null => this.field.bot.blockAt(at);
  setControlState(name: string, value: boolean): void { this.control[name] = value; }
  clearControlStates(): void { Object.keys(this.control).forEach(k => { this.control[k] = false; }); }
  stopDigging(): void { this.log.push('stop-dig'); }
  deactivateItem(): void { this.usingHeldItem = false; }
  async look(yaw: number, pitch: number): Promise<void> { this.entity.yaw = yaw; this.entity.pitch = pitch; }
  async lookAt(point: Vec3): Promise<void> {
    const d = point.minus(this.entity.position.offset(0, 1.62, 0));
    this.entity.yaw = Math.atan2(-d.x, -d.z); this.entity.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
    if (Math.abs(point.y - this.mob.position.y - 2.55) < 0.01) {
      this.log.push('gaze'); expect(this.gazeGuard.enabled).toBe(false);
      if (this.angerOnGaze) this.mob.metadata![0] = true;
    } else this.log.push('legs-or-walk');
  }
  async equip(item: Item): Promise<void> { this.heldItem = item; }
  digCell(cell: Cell): void { this.log.push(`dig:${cell.x},${cell.y},${cell.z}`); this.field.set(cell, 'air'); this.afterDig?.(cell); }
  attack(entity: TestEntity): void {
    this.attacks.push(this.entity.position.clone());
    expect(entity.id).toBe(200);
    this.emit('entityHurt', entity);
    entity.health = (entity.health ?? 6) - 6;
    if (entity.health <= 0) {
      this.emit('entityDead', entity);
      this.entities[900] = { id: 900, name: 'item', position: new Vec3(-0.6, 64, 0.5), isValid: true, getDroppedItem: () => ({ name: 'ender_pearl', count: 1 }) };
    }
  }
  tick(): void {
    if (this.control.forward) {
      const step = this.control.sprint ? 0.25 : 0.18;
      this.entity.position.x -= Math.sin(this.entity.yaw) * step;
      this.entity.position.z -= Math.cos(this.entity.yaw) * step;
    }
    if (this.arrives && this.mob.metadata?.[0] === true && (this.mob.health ?? 0) > 0) this.mob.position = new Vec3(-0.5, 64, 0.5);
    for (const drop of Object.values(this.entities)) if (drop.name === 'item' && drop.position.distanceTo(this.entity.position) < 1.35) {
      this.slots[9] = { name: 'ender_pearl', count: (this.slots[9]?.count ?? 0) + 1, type: 20, slot: 9 }; delete this.entities[drop.id];
    }
    this.emit('physicsTick');
  }
}
function field() {
  const bot = new FieldBot(), stop = new AbortController();
  const ctx: StepContext = { bot, stop: stop.signal, deadline: Date.now() + 120_000, facing: 'north', base: { x: -1, y: 64, z: 0 } };
  const den = new EndermanDenFight(ctx, bot.field.den, bot.mob.id, ctx.deadline);
  const timer = setInterval(() => bot.tick(), 50);
  return { bot, stop, ctx, den, timer };
}
type Field = ReturnType<typeof field>;
/** Resolve real production promises while advancing the model's movement clock. No wall-clock sleeps and no server. */
async function settle<T>(pending: Promise<T>): Promise<T> {
  let done = false;
  const watched = pending.finally(() => { done = true; });
  // Observe rejection immediately (cancellation tests deliberately reject while a fake timer is advancing).
  void watched.catch(() => undefined);
  for (let i = 0; i < 2_500 && !done; i++) await vi.advanceTimersByTimeAsync(50);
  if (!done) throw new Error('model did not settle within 125 seconds');
  return watched;
}
async function toPhase(f: Field, phase: string): Promise<void> {
  for (let i = 0; i < 20 && f.den.phase !== phase; i++) {
    const step = await settle(f.den.advance(f.bot.mob));
    expect(step.kind, step.kind === 'stop' ? step.outcome.text : '').not.toBe('stop');
  }
  expect(f.den.phase).toBe(phase);
}
const stopCode = (step: DenStep): string | undefined => step.kind === 'stop' ? step.outcome.code : undefined;
/** Inject only after the kill, once pickup has actually brought the body outside. Keep the return route observable. */
function onPickupOutside(f: Field, effect: () => void) {
  const trace: { at: Vec3 | null; positions: Vec3[] } = { at: null, positions: [] };
  f.bot.on('physicsTick', () => {
    if (!trace.at && endermanDenObservation(f.bot)?.phase === 'pickup' && f.bot.entity.position.x <= -0.3) {
      trace.at = f.bot.entity.position.clone(); effect();
    }
    if (trace.at) trace.positions.push(f.bot.entity.position.clone());
  });
  return trace;
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T00:00:00Z'));
  mocks.dig.mockReset(); mocks.go.mockReset();
  mocks.dig.mockImplementation(async (ctx, args) => { const bot = ctx.bot as FieldBot; for (const cell of args.at) bot.digCell(cell); return { ok: true, text: '掘った' }; });
  mocks.go.mockImplementation(async (ctx, args) => { const bot = ctx.bot as FieldBot; const to = args.goals[0]; bot.entity.position = denCenter(to); return { ok: true, text: '着いた' }; });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('指定された横穴の手', () => {
  it('入口上→入口下→奥上→奥下の4マスだけを掘り、完成・内部確認の後で敵対し、奥へ戻る', async () => {
    const f = field();
    await toPhase(f, 'provoke');
    expect(mocks.dig.mock.calls.map(([, args]) => args.at)).toEqual(denDigCells(f.bot.field.den).map(p => [p]));
    expect(mocks.dig.mock.calls.every(([, args]) => args.collect === false && Array.isArray(args.exposeOk) && args.exposeOk[0] === 'enderman')).toBe(true);
    expect(f.bot.log).not.toContain('gaze');
    expect(f.den.observation.setupComplete).toBe(true);
    expect(f.bot.entity.position.distanceTo(denCenter(denOffset(f.bot.field.den, -1)))).toBeLessThan(0.2);
    await toPhase(f, 'hold');
    expect(f.bot.log.indexOf('gaze')).toBeGreaterThan(Math.max(...f.bot.log.map((line, index) => line.startsWith('dig:') ? index : -1)));
    expect(f.bot.entity.position.distanceTo(denCenter(denOffset(f.bot.field.den, 1)))).toBeLessThan(0.2);
    expect(f.bot.gazeGuard.enabled).toBe(true);
    expect(f.den.observation.dug).toHaveLength(4);
  });
  it('既に掘ってあれば一度も掘らず、同じ穴を再利用する', async () => {
    const f = field(); denDigCells(f.bot.field.den).forEach(p => f.bot.field.set(p, 'air'));
    await toPhase(f, 'hold');
    expect(mocks.dig).not.toHaveBeenCalled(); expect(f.den.observation.reused).toBe(true);
  });
  it('前回途中で止めた穴では、空いた入口2マスを飛ばして奥2マスだけを掘る', async () => {
    const f = field(), cells = denDigCells(f.bot.field.den);
    cells.slice(0, 2).forEach(p => f.bot.field.set(p, 'air'));
    await toPhase(f, 'hold');
    expect(mocks.dig.mock.calls.map(([, args]) => args.at[0])).toEqual(cells.slice(2));
  });
  it('入口へ寄る短い go に掘る・置く権限を渡さない', async () => {
    const f = field(); f.bot.entity.position = new Vec3(-3.5, 64, 0.5);
    await settle(f.den.advance(f.bot.mob));
    expect(mocks.go).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ maxDig: 0, maxPlace: 0, maxDrop: 0, waterOk: false }));
  });
  it('溶岩へ開口する壁は最初から掘らず、敵対もしない', async () => {
    const f = field(); f.bot.field.set({ x: 1, y: 64, z: 1 }, 'lava');
    expect(stopCode(await f.den.advance(f.bot.mob))).toBe('den_hazard');
    expect(mocks.dig).not.toHaveBeenCalled(); expect(f.bot.log).not.toContain('gaze');
  });
  it('掘削中に見えた溶岩・空洞・天井欠けで次の掘削を止め、元に戻さない', async () => {
    for (const name of ['lava', 'air']) {
      const f = field();
      f.bot.afterDig = () => f.bot.field.set({ x: 1, y: 66, z: 0 }, name);
      await settle(f.den.advance(f.bot.mob)); // approach
      expect(stopCode(await settle(f.den.advance(f.bot.mob)))).toBe(name === 'lava' ? 'den_hazard' : 'den_open_shell');
      expect(f.bot.log.filter(line => line.startsWith('dig:'))).toHaveLength(1);
      expect(f.bot.blockAt(new Vec3(0, 65, 0))?.name).toBe('air');
      expect(f.den.observation.dug).toHaveLength(1);
      expect(f.bot.log).not.toContain('gaze'); f.den.release(); clearInterval(f.timer);
    }
  });
  it('最初から怒っている時、または掘削途中で敵対した時は追加で掘らない', async () => {
    const f = field(); f.bot.mob.metadata![0] = true;
    expect(stopCode(await f.den.advance(f.bot.mob))).toBe('den_angry_before_ready');
    expect(mocks.dig).not.toHaveBeenCalled();
    f.bot.mob.metadata![0] = false;
    f.bot.afterDig = () => { f.bot.mob.metadata![0] = true; };
    await settle(f.den.advance(f.bot.mob));
    expect(stopCode(await settle(f.den.advance(f.bot.mob)))).toBe('den_angry_before_ready');
    expect(mocks.dig).toHaveBeenCalledTimes(1);
  });
  it('既存の穴が完成済みなら、既に怒った相手のために外へ誘い直さない', async () => {
    const f = field(); denDigCells(f.bot.field.den).forEach(p => f.bot.field.set(p, 'air')); f.bot.mob.metadata![0] = true;
    await toPhase(f, 'hold');
    expect(mocks.dig).not.toHaveBeenCalled(); expect(f.bot.log).not.toContain('gaze');
  });
  it('穴の奥で来ない相手を20秒以上待たない（上限で止まる）', async () => {
    const f = field(); f.bot.arrives = false;
    await toPhase(f, 'hold');
    await vi.advanceTimersByTimeAsync(DEN_ARRIVAL_MS);
    expect(stopCode(await f.den.advance(f.bot.mob))).toBe('enderman_did_not_arrive');
    expect(f.bot.attacks).toEqual([]);
  });
  it.each(['hurt', 'low_hp', 'displaced', 'ceiling'])('%s により中止し、入口へ詰めたり別の穴を作らない', async why => {
    const f = field(); await toPhase(f, 'hold'); const digs = mocks.dig.mock.calls.length;
    if (why === 'hurt') f.bot.health -= 1;
    if (why === 'low_hp') f.bot.health = 7;
    if (why === 'displaced') f.bot.entity.position = denCenter(f.bot.field.den.entrance);
    if (why === 'ceiling') f.bot.field.set(denOffset(f.bot.field.den, 1, 2), 'air');
    expect((await f.den.advance(f.bot.mob)).kind).toBe('stop');
    expect(mocks.dig).toHaveBeenCalledTimes(digs);
    expect(f.bot.gazeGuard.enabled).toBe(true);
    expect(Object.values(f.bot.control).every(on => !on)).toBe(true);
  });
  it('native掘削を待つ間でも被弾で中止し、次のブロックへ進まない', async () => {
    const f = field(); await f.den.advance(f.bot.mob);
    mocks.dig.mockImplementation(async ctx => { await wait(ctx, 5_000); return { ok: true, text: 'unexpected' }; });
    setTimeout(() => { f.bot.health = 19; }, 100);
    expect(stopCode(await settle(f.den.advance(f.bot.mob)))).toBe('den_hurt');
    expect(mocks.dig).toHaveBeenCalledTimes(1); expect(f.bot.log).not.toContain('gaze');
  });
  it('中断はnative掘削中にも伝わり、gaze guardを戻す', async () => {
    const f = field(); await f.den.advance(f.bot.mob);
    mocks.dig.mockImplementation(async ctx => { await wait(ctx, 5_000); return { ok: true, text: 'unexpected' }; });
    setTimeout(() => f.stop.abort('operator_stop'), 100);
    await expect(settle(f.den.advance(f.bot.mob))).rejects.toBeInstanceOf(StepStopped);
    f.den.release(); expect(f.bot.gazeGuard.enabled).toBe(true);
  });
  it('既存の溶岩反射が体を取れば、待機も掘削も即中止する', async () => {
    const f = field(); await toPhase(f, 'hold');
    const before = mocks.dig.mock.calls.length; f.bot.lavaReflex = { engaged: true };
    expect(stopCode(await f.den.advance(f.bot.mob))).toBe('reflex');
    expect(mocks.dig).toHaveBeenCalledTimes(before); expect(f.bot.gazeGuard.enabled).toBe(true);
  });
  it('別の個体を渡されても対象を切り替えない', async () => {
    const f = field(); await toPhase(f, 'hold');
    expect(stopCode(await f.den.advance({ ...f.bot.mob, id: 201 }))).toBe('target_lost');
    expect(f.bot.attacks).toEqual([]);
  });
  it('指定相手の目に別個体が重なる時はgaze guardを解除しない', async () => {
    const f = field(); await toPhase(f, 'provoke');
    f.bot.entities[201] = { ...f.bot.mob, id: 201, position: f.bot.mob.position.clone() };
    expect(stopCode(await f.den.advance(f.bot.mob))).toBe('den_gaze_conflict');
    expect(f.bot.gazeGuard.enabled).toBe(true); expect(f.bot.log).not.toContain('gaze');
  });
  it('入口外から目が見えない場合は8秒で理由つきで止まる', async () => {
    const f = field(); await toPhase(f, 'provoke'); f.bot.field.set({ x: -6, y: 66, z: 0 }, 'warped_stem');
    expect((await f.den.advance(f.bot.mob)).kind).toBe('wait');
    await vi.advanceTimersByTimeAsync(8_000);
    expect(stopCode(await f.den.advance(f.bot.mob))).toBe('enderman_not_visible');
  });
});

describe('fight / act のden接続', () => {
  it('fight は同じ #id の脚を奥から打って倒し、入口近くのパールを短く回収する（屋根の設置なし）', async () => {
    const f = field();
    const result = await settle(fight(f.ctx, { target: '#200', den: f.bot.field.den, seconds: 50 }));
    expect(result.code).toBe('target_killed');
    expect(f.bot.attacks.length).toBeGreaterThan(0);
    for (const position of f.bot.attacks) expect(position.distanceTo(denCenter(denOffset(f.bot.field.den, 1)))).toBeLessThan(0.25);
    expect(f.bot.inventory.items().some(i => i.name === 'ender_pearl')).toBe(true);
    expect(f.bot.log.filter(line => line.startsWith('dig:'))).toHaveLength(4);
    expect(endermanDenObservation(f.bot)?.pickupMs).toBeLessThanOrEqual(5_000);
    expect(endermanDenObservation(f.bot)?.setupComplete).toBe(true);
    expect(f.bot.gazeGuard.enabled).toBe(true);
  });
  it.each([
    { code: 'den_hurt', hp: 13, reflex: false, reason: '受けた体力 7', returns: true },
    { code: 'reflex', hp: 13, reflex: true, reason: '反射が体を握った', returns: false },
    { code: 'retreat', hp: 7, reflex: false, reason: '体力 7 < 8', returns: false },
  ])('倒した後の回収中の $code は成功にせず、帰還は被弾だけで反射が無い時に試みる', async ({ code, hp, reflex, reason, returns }) => {
    const f = field(), keys = vi.spyOn(f.bot, 'setControlState'), look = vi.spyOn(f.bot, 'look');
    const trace = onPickupOutside(f, () => {
      expect(f.bot.health).toBe(20); expect(f.bot.mob.health).toBeLessThanOrEqual(0);
      f.bot.health = hp; f.bot.emit('health');
      if (reflex) f.bot.lavaReflex = { engaged: true };
      keys.mockClear(); look.mockClear();
    });
    const result = await settle(fight(f.ctx, { target: '#200', den: f.bot.field.den, seconds: 50 }));
    expect(trace.at).not.toBeNull();
    expect(result).toMatchObject({ ok: false, code, reason: code, progress: { unit: 'blow', done: 1 } });
    expect(result.text).toContain('倒した（死んだ）が、回収中に'); expect(result.text).toContain(reason);
    expect(endermanDenObservation(f.bot)).toMatchObject({ killed: true, stopReason: code, healthLost: 20 - hp });
    expect(f.bot.attacks).toHaveLength(1); expect(mocks.dig).toHaveBeenCalledTimes(4); expect(mocks.go).not.toHaveBeenCalled();
    if (returns) {
      const outside = denCenter(denOffset(f.bot.field.den, -1)), rear = denCenter(denOffset(f.bot.field.den, 1));
      expect(trace.positions.some(p => p.distanceTo(outside) <= 0.14)).toBe(true);
      expect(f.bot.entity.position.distanceTo(rear)).toBeLessThan(0.2);
      expect(keys.mock.calls.some(([, on]) => on)).toBe(true); expect(look).toHaveBeenCalled();
    } else {
      expect(f.bot.entity.position).toEqual(trace.at);
      expect(keys.mock.calls.some(([, on]) => on)).toBe(false); expect(look).not.toHaveBeenCalled();
    }
    expect(endermanDenObservation(f.bot)!.pickupMs).toBeLessThanOrEqual(5_000);
    expect(f.bot.gazeGuard.enabled).toBe(true); expect(Object.values(f.bot.control).every(on => !on)).toBe(true);
  });
  it('倒した後、まだ穴の中で被弾したら入口の外へ出ず、まっすぐ奥へ戻る', async () => {
    const f = field(); let at: Vec3 | null = null; const positions: Vec3[] = [];
    f.bot.on('physicsTick', () => {
      if (!at && endermanDenObservation(f.bot)?.phase === 'pickup' && f.bot.entity.position.x >= 0.9) {
        at = f.bot.entity.position.clone(); f.bot.health = 13; f.bot.emit('health');
      }
      if (at) positions.push(f.bot.entity.position.clone());
    });
    const result = await settle(fight(f.ctx, { target: '#200', den: f.bot.field.den, seconds: 50 }));
    expect(at).not.toBeNull();
    expect(result).toMatchObject({ ok: false, code: 'den_hurt' });
    const outside = denCenter(denOffset(f.bot.field.den, -1)), rear = denCenter(denOffset(f.bot.field.den, 1));
    expect(positions.some(p => p.distanceTo(outside) <= 0.5 || p.x < -0.3)).toBe(false);
    expect(f.bot.entity.position.distanceTo(rear)).toBeLessThan(0.2);
  });
  it('倒した後、回収の移動中に手の期限を迎えたら limit_time の失敗で返し、動かない', async () => {
    const f = field(), endAt = Date.now() + 50_000, keys = vi.spyOn(f.bot, 'setControlState'), look = vi.spyOn(f.bot, 'look');
    const trace = onPickupOutside(f, () => { vi.setSystemTime(endAt); keys.mockClear(); look.mockClear(); });
    const result = await settle(fight(f.ctx, { target: '#200', den: f.bot.field.den, seconds: 50 }));
    expect(trace.at).not.toBeNull();
    expect(result).toMatchObject({ ok: false, code: 'limit_time', reason: 'limit_time', progress: { unit: 'blow', done: 1 } });
    expect(result.text).toContain('倒した（死んだ）が、回収中に 横穴の手の期限に達した');
    expect(endermanDenObservation(f.bot)).toMatchObject({ killed: true, stopReason: 'limit_time' });
    expect(f.bot.entity.position).toEqual(trace.at);
    expect(keys.mock.calls.some(([, on]) => on)).toBe(false); expect(look).not.toHaveBeenCalled();
    expect(f.bot.attacks).toHaveLength(1);
  });
  it('落とし物の出現を待つ間の期限切れも collect の limit_time として返す', async () => {
    const f = field(); await toPhase(f, 'hold');
    vi.setSystemTime(f.ctx.deadline - 100);
    const before = f.bot.entity.position.clone();
    const result = await settle(f.den.collect());
    expect(result).toMatchObject({ ok: false, code: 'limit_time', reason: '横穴の手の期限に達した' });
    expect(f.bot.entity.position).toEqual(before); expect(f.den.observation.stopReason).toBe('limit_time');
  });
  it.each(['wall', 'stuck', 'reflex', 'deadline', 'fresh_hurt'] as const)('被弾後の帰還が %s で中止されても再試行せず、元の den_hurt を残す', async why => {
    const f = field(), endAt = Date.now() + 50_000, keys = vi.spyOn(f.bot, 'setControlState');
    const trace = onPickupOutside(f, () => {
      f.bot.health = 13; f.bot.emit('health'); keys.mockClear();
      if (why === 'wall') f.bot.field.set(f.bot.field.den.entrance, 'netherrack');
      if (why === 'stuck') clearInterval(f.timer);
      if (why === 'reflex' || why === 'deadline' || why === 'fresh_hurt') {
        vi.spyOn(f.bot, 'look').mockImplementationOnce(async () => {
          if (why === 'reflex') f.bot.lavaReflex = { engaged: true };
          if (why === 'deadline') vi.setSystemTime(endAt);
          if (why === 'fresh_hurt') { f.bot.health = 12; f.bot.emit('health'); }
        });
      }
    });
    const result = await settle(fight(f.ctx, { target: '#200', den: f.bot.field.den, seconds: 50 }));
    expect(trace.at).not.toBeNull();
    expect(result).toMatchObject({ ok: false, code: 'den_hurt', reason: 'den_hurt' });
    expect(result.text).toContain('倒した（死んだ）が、回収中に 受けた体力 7');
    expect(f.bot.entity.position).toEqual(trace.at); expect(endermanDenObservation(f.bot)?.stopReason).toBe('den_hurt');
    if (why !== 'stuck') expect(keys.mock.calls.some(([, on]) => on)).toBe(false);
    if (why !== 'deadline') expect(endermanDenObservation(f.bot)!.pickupMs).toBeLessThanOrEqual(5_000);
    expect(f.bot.attacks).toHaveLength(1); expect(mocks.dig).toHaveBeenCalledTimes(4); expect(mocks.go).not.toHaveBeenCalled();
    expect(Object.values(f.bot.control).every(on => !on)).toBe(true);
  });
  it('被弾が回収に出る前なら collect は den_hurt を返し、穴の奥から外へ出直さない', async () => {
    const f = field(); await toPhase(f, 'hold');
    f.bot.health = 13; f.bot.emit('health');
    const before = f.bot.entity.position.clone(), look = vi.spyOn(f.bot, 'look');
    expect(await settle(f.den.collect())).toMatchObject({ ok: false, code: 'den_hurt', reason: expect.stringContaining('受けた体力 7') });
    expect(f.bot.entity.position).toEqual(before); expect(look).not.toHaveBeenCalled();
  });
  it('回収へ向き直る間に被弾してまだ奥にいれば、帰還のために外へ出ない', async () => {
    const f = field(); await toPhase(f, 'hold');
    f.bot.entities[900] = { id: 900, name: 'item', position: new Vec3(-0.6, 64, 0.5) };
    const before = f.bot.entity.position.clone(), keys = vi.spyOn(f.bot, 'setControlState');
    const look = vi.spyOn(f.bot, 'look').mockImplementationOnce(async () => { f.bot.health = 13; f.bot.emit('health'); });
    expect(await settle(f.den.collect())).toMatchObject({ ok: false, code: 'den_hurt' });
    expect(f.bot.entity.position).toEqual(before); expect(look).toHaveBeenCalledTimes(1);
    expect(keys.mock.calls.some(([, on]) => on)).toBe(false);
  });
  it('回収中に別個体が近づいた場合は回収省略を伝え、target_killed の成功を保つ', async () => {
    const f = field();
    const trace = onPickupOutside(f, () => { f.bot.entities[201] = { ...f.bot.mob, id: 201, position: new Vec3(-2.5, 64, 0.5) }; });
    const result = await settle(fight(f.ctx, { target: '#200', den: f.bot.field.den, seconds: 50 }));
    expect(trace.at).not.toBeNull();
    expect(result).toMatchObject({ ok: true, code: 'target_killed' });
    expect(result.text).toContain('死んだ'); expect(result.text).toContain('他の個体が近いので回収中止');
    expect(endermanDenObservation(f.bot)).toMatchObject({ killed: true, stopReason: 'den_pickup_threat' });
    expect(f.bot.entity.position).toEqual(trace.at); expect(f.bot.attacks).toHaveLength(1);
  });
  it('近くに他の個体がいれば穴から回収に出ない', async () => {
    const f = field(); await toPhase(f, 'hold');
    f.bot.entities[201] = { ...f.bot.mob, id: 201, position: new Vec3(-2.5, 64, 0.5) };
    f.bot.entities[900] = { id: 900, name: 'item', position: new Vec3(-0.6, 64, 0.5) };
    const before = f.bot.entity.position.clone();
    await settle(f.den.collect());
    expect(f.bot.entity.position).toEqual(before);
    expect(f.den.observation.pickupReason).toContain('他の個体');
  });
  it('入口外3mより遠い落とし物は追わない', async () => {
    const f = field(); await toPhase(f, 'hold');
    f.bot.entities[900] = { id: 900, name: 'item', position: new Vec3(-5.5, 64, 0.5) };
    const before = f.bot.entity.position.clone(); await settle(f.den.collect());
    expect(f.bot.entity.position).toEqual(before); expect(f.bot.entities[900]).toBeDefined();
  });
  it('denのschemaは絶対整数と東西南北のみ。設置権限や掘るリストを追加できない', () => {
    const f = field();
    expect(ACT_HANDS.safeParse([{ do: 'fight', target: '#200', den: f.bot.field.den }]).success).toBe(true);
    for (const den of [{ ...f.bot.field.den, direction: 'up' }, { ...f.bot.field.den, entrance: { x: 0.5, y: 64, z: 0 } }, { ...f.bot.field.den, canDig: ['chest'] }]) {
      expect(ACT_HANDS.safeParse([{ do: 'fight', target: '#200', den }]).success).toBe(false);
    }
  });
  it('直接呼ぶ場合も種類名・他種の個体・fleeにはdenの権限を使わない', async () => {
    const f = field();
    expect((await fight(f.ctx, { target: 'enderman', den: f.bot.field.den })).reason).toBe('invalid_input');
    expect((await fight(f.ctx, { target: '#200', den: f.bot.field.den, stance: 'flee' })).reason).toBe('invalid_input');
    f.bot.mob.name = 'zombie';
    expect((await fight(f.ctx, { target: '#200', den: f.bot.field.den })).reason).toBe('invalid_input');
    expect(mocks.dig).not.toHaveBeenCalled();
  });
  it('actの実行検証でもdenの名前target・rel・flee・他の手を拒否する', async () => {
    for (const hand of [
      { do: 'fight', target: 'enderman' }, { do: 'fight', target: '#200', rel: true },
      { do: 'fight', target: '#200', stance: 'flee' }, { do: 'wait', seconds: 1 },
    ]) {
      const f = field(), hands = ACT_HANDS.parse([{ ...hand, den: f.bot.field.den }]);
      const result = await settle(runAct(f.bot, hands));
      expect(result).toMatchObject({ success: false, failureType: 'invalid_input' });
      expect(mocks.dig).not.toHaveBeenCalled();
    }
  });
});
