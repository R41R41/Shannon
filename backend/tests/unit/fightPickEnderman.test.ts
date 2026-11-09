import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { endermanMissCount, endermenFarther, endermenWithoutSight, endermanStuckAway, noteStuckAngry, pickEnderman, withMissStreak } from '../../src/services/minebot/utils/primitives/fight.js';
import { noteHiddenFromRoof } from '../../src/services/minebot/utils/huntEndermanCamp.js';
import { closedWord, stoppedLine } from '../../src/services/minebot/utils/actReport.js';

/**
 * `fight target=enderman` (the kind): the one picked is the one the roof hunts of 11/4 won with (S6): an angry one first, else the nearest whose
 * eyes are in sight within 8-48 m (30 m first). A trunk between the body's eyes and an enderman's eyes leaves that one out.
 */
const registry = { entitiesByName: { enderman: { metadataKeys: ['flags', 'carried', 'creepy', 'stared_at'] } } };
function body(blocks: Record<string, string> = {}, entities: any[] = []) {
  const self = { position: new Vec3(0.5, 64, 0.5) };
  const all: Record<number, any> = {};
  for (const e of entities) all[e.id] = e;
  return {
    entity: self, registry, entities: all,
    blockAt: (p: Vec3) => {
      const name = blocks[`${p.x},${p.y},${p.z}`] ?? (p.y < 64 ? 'warped_nylium' : 'air');
      return { name, boundingBox: name === 'air' ? 'empty' : 'block' };
    },
  };
}
const enderman = (id: number, x: number, z = 0.5, angry = false) => ({ id, name: 'enderman', position: new Vec3(x, 64, z), isValid: true,
  metadata: [0, null, angry, false] });

describe('fight picks the enderman of a roof hunt', () => {
  it('takes one 40 m off whose eyes are seen (the old 32 m pick found none)', () => {
    const bot = body({}, [enderman(7, 40.5)]);
    expect(pickEnderman(bot)?.id).toBe(7);
  });

  it('passes over a nearer one whose eyes a trunk hides, for one in sight', () => {
    // A stem column at x=6 from the floor up to the eye's height on the line to #1 (straight east); #2 stands to the north-east, clear.
    const stem: Record<string, string> = {};
    for (let y = 64; y <= 68; y++) stem[`6,${y},0`] = 'warped_stem';
    const bot = body(stem, [enderman(1, 12.5), enderman(2, 14.5, 14.5)]);
    expect(pickEnderman(bot)?.id).toBe(2);
  });

  it('keeps the 8-30 m band ahead of a farther one, and an angry one ahead of all', () => {
    expect(pickEnderman(body({}, [enderman(3, 40.5), enderman(4, 20.5, 5.5)]))?.id).toBe(4);
    expect(pickEnderman(body({}, [enderman(3, 40.5), enderman(4, 20.5, 5.5), enderman(5, 45.5, -9.5, true)]))?.id).toBe(5);
  });

  it('gives none when no eyes are in sight in 8-48 m (the caller keeps its own pick)', () => {
    expect(pickEnderman(body({}, [enderman(6, 4.5), enderman(8, 60.5)]))).toBeNull();
  });

  it('says at once that the endermen about all have their eyes hidden, the nearest and what hides it', () => {
    const stem: Record<string, string> = {};
    for (let y = 64; y <= 68; y++) stem['6,' + y + ',0'] = 'warped_stem';
    const bot = body(stem, [enderman(1, 12.5)]);
    // end1109p08b: with no roof laid, the roof laid here sees #1 from a step out past the one stem, so the fight takes it (the words stay for the probe).
    expect(pickEnderman(bot)?.id).toBe(1);
    const words = endermenWithoutSight(bot)!;
    expect(words).toContain('1 体はどれも目が見えない');
    expect(words).toContain('最寄りの #1 も 12.0m 先で目が隠れている');
    expect(words).toContain('warped_stem');
    expect(endermenWithoutSight(body({}, []))).toBeNull();
    // A near one in sight (under the 8 m band) is not "none in sight": the old pick takes it.
    expect(endermenWithoutSight(body({}, [enderman(6, 4.5)]))).toBeNull();
  });

  it('names the endermen seen beyond 48 m, nearest first, with the way to them', () => {
    const words = endermenFarther(body({}, [enderman(9, 70.5), enderman(10, 0.5, -90.5), enderman(11, 20.5)]));
    expect(words).toContain('#9 70m 東');
    expect(words).toContain('#10 91m 北');
    expect(words).not.toContain('#11');
    expect(endermenFarther(body({}, [enderman(11, 20.5)]))).toBe('');
  });

  it('under a roof already laid, takes one whose eyes only the cap hides (the camp steps to the edge for it), and does not call that none in sight', () => {
    const cap: Record<string, string> = {};
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) cap[x + ',66,' + z] = 'cobblestone';
    const high = { ...enderman(12, 12.5), position: new Vec3(12.5, 68, 0.5) };
    const bot = body(cap, [high]);
    expect(pickEnderman(bot)?.id).toBe(12);
    expect(endermenWithoutSight(bot)).toBeNull();
  });
});

// end1108h29 (11/8): an angry enderman stuck behind the trunks (enderman_did_not_arrive) stayed first in the pick for about 4 minutes, so every
// fight target=enderman stared at it again while others stood in sight.
describe('an angry enderman that did not come is left out of the pick for a while', () => {
  it('passes over it while it stays where it stuck or has not come, and takes it again once it has come near or 5 minutes are past', () => {
    const bot = body({}, [enderman(4, 20.5, 5.5), enderman(5, 45.5, -9.5, true)]);
    expect(pickEnderman(bot)?.id).toBe(5);
    noteStuckAngry(bot, 5, { x: 45, y: 64, z: -10 });
    expect(pickEnderman(bot)?.id).toBe(4);
    // end1109p07b: moved off but still not come (30 m away): still passed over.
    bot.entities[5].position = new Vec3(30.5, 64, -9.5);
    expect(pickEnderman(bot)?.id).toBe(4);
    bot.entities[5].position = new Vec3(2.5, 64, 1.5);   // came within reach
    expect(pickEnderman(bot)?.id).toBe(5);
    const later = body({}, [enderman(4, 20.5, 5.5), enderman(5, 45.5, -9.5, true)]);
    noteStuckAngry(later, 5, { x: 45, y: 64, z: -10 }, Date.now() - 301_000);
    expect(pickEnderman(later)?.id).toBe(5);
  });

  it('end1109p05: one that stuck below and followed underneath, still 3+ below the feet, stays passed over wherever it went', () => {
    const bot = body({}, [enderman(4, 20.5, 5.5), enderman(5, 6.5, 0.5, true)]);
    bot.entities[5].position = new Vec3(6.5, 57, 0.5);
    noteStuckAngry(bot, 5, { x: 6, y: 57, z: 0 });
    bot.entities[5].position = new Vec3(-12.5, 58, 8.5);   // 15 m from where it stuck, 6 below
    expect(pickEnderman(bot)?.id).toBe(4);
    bot.entities[5].position = new Vec3(-12.5, 63, 8.5);   // up to 1 below but still 15 m off: not come yet
    expect(pickEnderman(bot)?.id).toBe(4);
    bot.entities[5].position = new Vec3(2.5, 63, 0.5);    // came up beside the feet
    expect(pickEnderman(bot)?.id).toBe(5);
  });

  it('end1109p07b: one that stuck and wandered on the ledges above (more than 6 m from where it stuck, not below) stays passed over, and is no danger to the next item', () => {
    const bot = body({}, [enderman(4, 20.5, 5.5), enderman(5, 8.5, 0.5, true)]);
    noteStuckAngry(bot, 5, { x: 8, y: 64, z: 0 });
    bot.entities[5].position = new Vec3(-3.5, 69, 6.5);   // 13 m from where it stuck, 5 above, 8 m off
    expect(pickEnderman(bot)?.id).toBe(4);
    expect(endermanStuckAway(bot, bot.entities[5])).toBe(true);
    expect(endermanStuckAway(bot, bot.entities[4])).toBe(false);
  });

  it('says so when it is the only one about, instead of nothing', () => {
    const bot = body({}, [enderman(5, 45.5, -9.5, true)]);
    noteStuckAngry(bot, 5, { x: 45, y: 64, z: -10 });
    expect(pickEnderman(bot)).toBeNull();
    const words = endermenWithoutSight(bot)!;
    expect(words).toContain('48m 内に狙えるエンダーマンが居ない');
    expect(words).toContain('怒ったまま近づけなかった #5（(45,64,-10) 付近） は数えない');
  });
});

describe('fights in a row on one enderman without its death (end1109p01: #929 sixteen times)', () => {
  const stop = (id: number, code: string) => ({ ok: false, reason: code, code, text: `fight 止まった ${code}: enderman #${id} は来なかった。打撃 0` });
  it("says so from the third, with the reasons, and the kind's pick then takes another first", () => {
    const bot = body({}, [enderman(9, 12.5, 0.5, true), enderman(10, 20.5, 5.5)]);
    expect(pickEnderman(bot)?.id).toBe(9);
    expect(withMissStreak(bot, stop(9, 'support_not_removed') as any).text).not.toContain('続けて倒せていない');
    withMissStreak(bot, stop(9, 'enderman_did_not_arrive') as any);
    const third = withMissStreak(bot, stop(9, 'enderman_did_not_arrive') as any);
    expect(third.text).toContain('#9 は 3 回続けて倒せていない（support_not_removed×1・enderman_did_not_arrive×2）');
    expect(endermanMissCount(bot, 9)).toBe(3);
    expect(pickEnderman(bot)?.id).toBe(10);
  });
  it('keeps the only one when no other is there, and a kill or another id starts the count again', () => {
    const bot = body({}, [enderman(11, 12.5, 0.5, true)]);
    for (let i = 0; i < 3; i++) withMissStreak(bot, stop(11, 'limit_time') as any);
    expect(pickEnderman(bot)?.id).toBe(11);
    withMissStreak(bot, stop(12, 'limit_time') as any);
    expect(endermanMissCount(bot, 11)).toBe(0);
    withMissStreak(bot, stop(12, 'limit_time') as any);
    withMissStreak(bot, { ok: true, code: 'target_killed', text: 'fight 済 enderman #12 死んだ・打撃 3' } as any);
    expect(endermanMissCount(bot, 12)).toBe(0);
  });
  it('does not count a reflex taking the body, nor a line about no enderman', () => {
    const bot = body({}, [enderman(13, 12.5)]);
    for (let i = 0; i < 3; i++) withMissStreak(bot, stop(13, 'reflex') as any);
    expect(endermanMissCount(bot, 13)).toBe(0);
    const none = { ok: false, reason: 'enderman_not_visible', text: 'fight 止まった enderman_not_visible: 48m 内のエンダーマン 1 体はどれも目が見えない' };
    expect(withMissStreak(bot, none as any)).toBe(none);
  });
});

// end1109p05 (11/9): under one roof the own cap hid #411's eyes and no step out saw them, yet the head named #411 six times (8 s each, 0 blows):
// the reason was cut off the 160-character line, and the live 「見える（射線の中）」 read as eyes in sight.
describe('an enderman whose eyes the own cap hid from every step out is not picked from that roof', () => {
  const capped = () => {
    const cap: Record<string, string> = {};
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) cap[x + ',66,' + z] = 'cobblestone';
    return cap;
  };
  const high = (id: number, x: number, z = 0.5) => ({ ...enderman(id, x, z), position: new Vec3(x, 68, z) });

  it('leaves it out of the kind pick and says why, the way on first; another takes its place; off the roof it may be picked again', () => {
    const bot = body(capped(), [high(12, 12.5)]);
    expect(pickEnderman(bot)?.id).toBe(12);
    noteHiddenFromRoof(bot, 12, { x: 0, y: 64, z: 0 }, { x: 12, y: 68, z: 0 });
    expect(pickEnderman(bot)).toBeNull();
    const words = endermenWithoutSight(bot)!;
    expect(words).toContain('この屋根 (0,64,0) の下からは #12 を狙えない: 別の個体を fight target=enderman で呼ぶ');
    expect(words.indexOf('probe kind=roofsite')).toBeLessThan(words.indexOf('見える（射線の中）'));
    bot.entities[13] = high(13, 0.5, 14.5);
    expect(pickEnderman(bot)?.id).toBe(13);
    bot.entity.position = new Vec3(5.5, 64, 0.5);
    delete bot.entities[13];
    expect(pickEnderman(bot)?.id).toBe(12);
  });

  it('takes it again once it has moved off where it stood, or 2 minutes are past', () => {
    const bot = body(capped(), [high(12, 12.5)]);
    noteHiddenFromRoof(bot, 12, { x: 0, y: 64, z: 0 }, { x: 12, y: 68, z: 0 });
    bot.entities[12].position = new Vec3(20.5, 68, 0.5);
    expect(pickEnderman(bot)?.id).toBe(12);
    const later = body(capped(), [high(12, 12.5)]);
    noteHiddenFromRoof(later, 12, { x: 0, y: 64, z: 0 }, { x: 12, y: 68, z: 0 }, Date.now() - 121_000);
    expect(pickEnderman(later)?.id).toBe(12);
  });
});

describe("fight's eyes-not-in-the-line stop reads 届かない, not dig's 掘れない (end1109p05 replay r4: the head dug its own cap)", () => {
  it("gives the word 届かない to eyes_not_visible and keeps 掘れない for a dig's not_visible", () => {
    expect(closedWord('eyes_not_visible')).toBe('届かない');
    expect(closedWord('not_visible')).toBe('掘れない');
    expect(closedWord('enderman_did_not_arrive')).toBe('届かない');
    expect(closedWord('build_stalled')).toBe('時間切れ');
    expect(stoppedLine('eyes_not_visible', 'fight 止まった not_visible: enderman #4 この屋根の下からは #4 を狙えない')).toMatch(/^届かない: /u);
  });
});

// end1109p07b: a roofsite read that found no eyes said only "move somewhere open or high, or wait"; it now says where the endermen are.
describe('roofsite without eyes names where the endermen are', () => {
  it('the way most of them lie and the nearest three with height', async () => {
    const { endermenWay } = await import('../../src/services/minebot/instantSkills/probe.js');
    const high = { ...enderman(21, 0.5, -10.5), position: new Vec3(0.5, 69, -10.5) };
    const words = endermenWay(body({}, [high, enderman(22, 3.5, -30.5), enderman(23, 40.5, 0.5), enderman(24, 0.5, 90.5)]));
    expect(words).toContain('64m 内の 3 体のうち 2 体が北');
    expect(words).toContain('#21 12m 北・5 上');
    expect(words).toContain('#23 40m 東・同じ高さ');
    expect(words).not.toContain('#24');
    expect(endermenWay(body({}, []))).toBe('');
  });
});

// end1109p08b: at the roof site the stop line named, the pick read only the bare spot and stopped before any roof; the site's count was the finished roof's.
describe('with no roof laid, fight picks the one the roof laid here would see', () => {
  it('a stem right by the body hides #31 from the bare spot, but the finished roof sees it from a step out: picked (the camp lays the roof)', () => {
    const stem: Record<string, string> = {};
    for (let y = 64; y <= 68; y++) stem[`4,${y},0`] = 'warped_stem';
    const bot = body(stem, [enderman(31, 12.5)]);
    expect(pickEnderman(bot)?.id).toBe(31);
  });
  it('one the finished roof does not see either: none (the watch keeps the seconds on the spot)', () => {
    const wall: Record<string, string> = {};
    for (let y = 64; y <= 69; y++) for (let z = -4; z <= 4; z++) wall[`6,${y},${z}`] = 'warped_stem';
    expect(pickEnderman(body(wall, [enderman(32, 12.5)]))).toBeNull();
  });
});
