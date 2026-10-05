import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { closeInterruption, describeInterruptions, emptyInterruptionLog, hurtWhileInterrupted, openInterruption, summariseInterruptions } from '../../src/modules/minecraftLearning/interruptions.js';
import { EventReactionSystem } from '../../src/services/minebot/eventReaction/EventReactionSystem.js';
import { captureWorldObservation } from '../../src/services/minebot/cognition/worldFrame.js';

const MINUTE = 60_000;

describe('what has kept stopping the task is counted and said (paid run L77k: stopped for the same blazes twelve times in twenty minutes, and walked back each time)', () => {
  it('says nothing of a stop or two, or of stops each for something else', () => {
    const log = emptyInterruptionLog();
    openInterruption(log, { cause: 'hostile_approach', kinds: ['blaze'] }, 0);
    closeInterruption(log, 30_000);
    openInterruption(log, { cause: 'hostile_approach', kinds: ['blaze', 'blaze'] }, MINUTE);
    closeInterruption(log, 2 * MINUTE);
    expect(summariseInterruptions(log, 3 * MINUTE)).toBeNull();
    openInterruption(log, { cause: 'damage', kinds: ['skeleton'] }, 3 * MINUTE);
    expect(summariseInterruptions(log, 4 * MINUTE)).toBeNull();          // three stops, no kind three times
  });

  it('says the kind that has come up three times, with the time and the health it took', () => {
    const log = emptyInterruptionLog();
    for (let round = 0; round < 3; round++) {
      openInterruption(log, { cause: 'hostile_approach', kinds: ['blaze', 'wither_skeleton'].slice(0, round === 2 ? 2 : 1) }, round * 2 * MINUTE);
      hurtWhileInterrupted(log, 5);
      closeInterruption(log, round * 2 * MINUTE + MINUTE);
    }
    hurtWhileInterrupted(log, 9);                                         // the task has the body: not a stop's cost
    const summary = summariseInterruptions(log, 6 * MINUTE)!;
    expect(summary).toMatchObject({ count: 3, repeated: ['blaze'], spentMs: 3 * MINUTE, damage: 15 });
    const line = describeInterruptions(summary);
    expect(line).toContain('緊急対応に3回中断された（blaze 3回、wither_skeleton 1回）');
    expect(line).toContain('計3.0分');
    expect(line).toContain('被ダメージ計15');
    // A fact, not an order: nothing of what to do about it.
    expect(line).not.toMatch(/べき|してください|しろ/);
    // Old stops fall out of it.
    expect(summariseInterruptions(log, 13 * MINUTE)).toBeNull();
  });

  it('a stop still holding the body when the next begins is ended by it, and counts its time up to now while open', () => {
    const log = emptyInterruptionLog();
    openInterruption(log, { cause: 'hostile_approach', kinds: ['ghast'] }, 0);
    openInterruption(log, { cause: 'damage', kinds: ['ghast'] }, MINUTE);
    openInterruption(log, { cause: 'damage', kinds: ['ghast'] }, 2 * MINUTE);
    expect(log.entries.map(entry => entry.endedAt)).toEqual([MINUTE, 2 * MINUTE, undefined]);
    expect(summariseInterruptions(log, 3 * MINUTE)!.spentMs).toBe(3 * MINUTE);
  });
});

describe('the count reaches the planner that holds the task, with what the body has measured of that kind', () => {
  const settings: any = { reactions: [], hostileDetection: { criticalDistance: 8, detectionDistance: 16, multiMobCriticalCount: 2 } };
  const fixture = () => {
    const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0) }, entities: {}, health: 14, food: 12,
      inventory: { items: () => [{ name: 'stone_sword', count: 1 }], slots: [] }, game: { dimension: 'the_nether' },
      instantSkills: { getSkill: () => undefined, getSkills: () => [] }, constantSkills: { getSkills: () => [] },
      oxygenLevel: 20, blockAt: () => ({ name: 'netherrack', boundingBox: 'block' }) });
    const resumed: number[] = [];
    const runtime: any = { resumePreviousTask: async () => { resumed.push(1); } };
    const system: any = new EventReactionSystem(bot, runtime, settings);
    system.reflexPolicy = null;
    return { system, bot, resumed };
  };

  it('opens a stop for each emergency, ends it when the task is given back, and tells the learning once when a kind turns into a pattern', async () => {
    const { system, resumed } = fixture();
    const told: string[] = [];
    system.learningStalled = (detail: string) => { told.push(detail); };
    system.encounters.recordHit('blaze', 5, 31);
    expect(system.describeRecentInterruptions()).toBeNull();
    for (let round = 0; round < 4; round++) {
      system.noteInterruption({ eventType: 'hostile_approach', allHostiles: [{ mobType: 'blaze', distance: 30 }, { mobType: 'blaze', distance: 33 }] });
      await system.giveTaskBack();
    }
    expect(resumed.length).toBe(4);
    const line: string = system.describeRecentInterruptions();
    expect(line).toContain('緊急対応に4回中断された（blaze 4回）');
    expect(line).toContain('実測: blaze: 最大31m先から当ててくる、被弾1回あたり平均5.0、いまの手持ち（stone_sword）で倒すまで約');
    expect(told.length).toBe(1);                                           // at the third, and not again at the fourth
    expect(told[0]).toContain('繰り返し中断');
    // A hit named for a mob, and one for the body's own state.
    system.noteInterruption({ eventType: 'damage', possibleSource: 'skeleton（約12m）' });
    system.noteInterruption({ eventType: 'damage', harm: '溶岩の中にいる' });
    expect(system.interruptions.entries.slice(-2).map((entry: any) => entry.kinds)).toEqual([['skeleton'], ['溶岩の中にいる']]);
  });

  it('is in what the planner is shown of the world only while there is something to say', () => {
    const { system, bot } = fixture();
    bot.recentInterruptions = () => system.describeRecentInterruptions();
    expect(captureWorldObservation(bot)).not.toHaveProperty('recentInterruptions');
    for (let round = 0; round < 3; round++) system.noteInterruption({ eventType: 'hostile_approach', allHostiles: [{ mobType: 'blaze', distance: 30 }] });
    expect(String((captureWorldObservation(bot) as any).recentInterruptions)).toContain('blaze 3回');
  });
});
