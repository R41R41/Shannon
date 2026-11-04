import { describe, it, expect, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { assessBreathingDig, assessBreathingWork, breathingWorkWords, BREATHING_WORK_MARGIN_SECONDS } from '../../src/services/minebot/utils/breathingWork.js';
import { airRunningOut } from '../../src/services/minebot/utils/breathingReflex.js';

function bot(oxygen: number, ceiling = false) {
  return { entity: { position: new Vec3(0.5, 10, 0.5), isInWater: true }, oxygenLevel: oxygen, health: 20,
    digTime: () => 2000,
    blockAt: (p: Vec3) => {
      const name = ceiling ? 'water' : p.y >= 13 ? 'air' : 'water';
      return { name, boundingBox: 'empty', diggable: true };
    } };
}
describe('work reserves enough breath to return', () => {
  it('allows a short job with a known surface and rejects the same job with too little breath', () => {
    expect(assessBreathingWork(bot(20), 2).allowed).toBe(true);
    expect(assessBreathingWork(bot(6), 2).reason).toBe('insufficient_air');
  });
  it('does not turn a route outside the observed search into zero return time', () => {
    const deep = bot(20, true);
    expect(assessBreathingWork(deep, 1).reason).toBe('return_unknown');
    // The dig is the thing refused. The reflex still waits for the critical threshold: engaging at full air with no way known pinned the
    // body jumping against the ceiling for as long as it stayed in the water (minecraftBreathingReflex.test.ts keeps that rule).
    expect(airRunningOut(deep as any)).toBe(false);
    expect(airRunningOut({ ...deep, oxygenLevel: 5 } as any)).toBe(true);
  });
  it('does not limit a dry job by the last underwater oxygen reading', () => {
    const dry = bot(0); dry.blockAt = () => ({ name: 'air', boundingBox: 'empty', diggable: true });
    expect(assessBreathingWork(dry, 80).reason).toBe('dry');
  });
  it('does not approve an unmeasured underwater dig or an unknown oxygen reading', () => {
    expect(assessBreathingWork(bot(20), Infinity).allowed).toBe(false);
    expect(assessBreathingWork({ ...bot(20), oxygenLevel: undefined }, 1).reason).toBe('air_unknown');
  });
  it('counts actual ceiling excavation once but does not exempt another block with an escape label', () => {
    const b = bot(12);
    b.blockAt = (p: Vec3) => p.y === 12 ? { name: 'stone', boundingBox: 'block', diggable: true }
      : { name: p.y > 12 ? 'air' : 'water', boundingBox: 'empty', diggable: true };
    const escape = assessBreathingWork(b, 5, { x: 0, y: 12, z: 0 });
    expect(escape.escapeWork).toBe(true);
    expect(escape.allowed).toBe(true);
    expect(escape.neededSeconds).toBe(escape.returnSeconds! + BREATHING_WORK_MARGIN_SECONDS);
    expect(breathingWorkWords(escape)).toContain('脱出掘削込み帰還');
    expect(breathingWorkWords(escape)).toContain('掘削5秒×1マスは重複計上しない');
    expect(assessBreathingWork(b, 5, { x: 1, y: 12, z: 0 }).allowed).toBe(false);
  });
});

describe('breathing work reports the budget the decision actually used', () => {
  it('shows the per-cell underwater work, return, margin, remaining air and shortfall, with conditional advice', () => {
    const breath = assessBreathingWork(bot(20), 20);
    expect(breath).toMatchObject({ allowed: false, workSeconds: 20, airSeconds: 15, reason: 'insufficient_air' });
    expect(breath.neededSeconds).toBe(20 + breath.returnSeconds! + BREATHING_WORK_MARGIN_SECONDS);
    const words = breathingWorkWords(breath);
    expect(words).toContain(`必要${Number(breath.neededSeconds!.toFixed(1))}秒`);
    expect(words).toContain('掘削20秒×1マス＋帰還');
    expect(words).toContain('＋余裕3秒');
    expect(words).toContain('残り息15秒');
    expect(words).toContain(`不足${Number((breath.neededSeconds! - 15).toFixed(1))}秒`);
    expect(words).toContain('呼吸を回復し1〜2マス単位で再判定');
    expect(words).toContain('1マスでも不足なら水外から掘る');
  });

  it('does not call an unknown work time, oxygen reading or return route a zero-second budget', () => {
    const cases = [
      [assessBreathingWork(bot(20), Infinity), '掘削時間が未確認'],
      [assessBreathingWork({ ...bot(20), oxygenLevel: undefined }, 1), '残り息が未確認'],
      [assessBreathingWork(bot(20, true), 1), '帰還が未確認'],
    ] as const;
    for (const [breath, expected] of cases) {
      expect(breath.allowed).toBe(false);
      const words = breathingWorkWords(breath);
      expect(words).toContain(expected);
      expect(words).not.toMatch(/Infinity|NaN|不足0秒|帰還0秒/u);
    }
  });

  it('keeps the strict boundary: exactly enough measured air is still no reserve', () => {
    const b = bot(20);
    const budget = assessBreathingWork(b, 2).neededSeconds!;
    b.oxygenLevel = budget / 0.75;
    const breath = assessBreathingWork(b, 2);
    expect(breath.allowed).toBe(false);
    expect(breathingWorkWords(breath)).toContain('差0秒（同量では不可）');
  });

  it('labels only the remaining dig time during a dig', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(3000);
    try {
      const b = bot(6);
      b.digTime = () => 6000;
      const breath = assessBreathingDig(b, {}, { x: 1, y: 11, z: 0 }, 1000);
      expect(breath).toMatchObject({ allowed: false, workSeconds: 4 });
      expect(breathingWorkWords(breath, true)).toContain('残り掘削4秒×1マス');
    } finally { now.mockRestore(); }
  });
});
