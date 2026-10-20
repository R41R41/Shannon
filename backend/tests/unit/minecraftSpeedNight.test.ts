import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';

const { descentFloor, descentKitNotice, nightGateFor } = await import('../../src/services/minebot/utils/nightGate.js');
const { sleepRefusal, sleepThroughNight, NIGHT_SLEEP_SKILLS } = await import('../../src/services/minebot/utils/nightSleep.js');

const registry = minecraftData('1.21.11');
const NIGHT = 18_000;
const NOON = 6_000;

function body(y: number, timeOfDay: number, items: Array<{ name: string; count?: number }> = [], worn: string[] = []) {
  const slots: Array<{ name: string } | null> = new Array(46).fill(null);
  worn.forEach((name, i) => { slots[5 + i] = { name }; });
  return { version: '1.21.11', registry, username: 'I_am_Shannon', entity: { position: new Vec3(0.5, y, 0.5), onGround: true },
    time: { timeOfDay, day: 3 }, game: { dimension: 'overworld' }, players: {}, entities: {},
    inventory: { items: () => items.map(item => ({ count: 1, ...item })), slots } } as any;
}
const IRON_SUIT = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];

describe('the night gate shuts on the armour alone (run 19: the iron suit, no bed, its stair refused at 1,790 s)', () => {
  it('lets an armoured body down at night with no bed and no cooked food, from the surface and from underground', () => {
    expect(descentFloor(body(70, NIGHT, [], IRON_SUIT))).toBeNull();
    expect(nightGateFor(body(70, NIGHT, [], IRON_SUIT), -54, 'stair-mine（目標 y-54）')).toBeNull();
    expect(nightGateFor(body(-7, NIGHT, [], IRON_SUIT), -54, 'stair-mine')).toBeNull();
    // Carried counts as worn (the floor's armour reflex puts it on).
    expect(nightGateFor(body(70, NIGHT, [{ name: 'iron_chestplate' }]), -54, 'stair-mine')).toBeNull();
  });

  it('still refuses an unarmoured body, and never tells it to wait on the surface', () => {
    const refused = nightGateFor(body(70, NIGHT, [{ name: 'red_bed' }, { name: 'cooked_beef', count: 4 }]), -54, 'stair-mine（目標 y-54）')!;
    expect(refused).toMatchObject({ success: false, failureType: 'night_unprepared' });
    expect(refused.result).toContain('y16 より上の地下で鉄・石炭を掘って防具を作る（地上で待たない）');
    expect(refused.result).not.toContain('dig-shelter で夜を越す');
    expect(refused.result).toMatch(/足りない: armor$/);
  });

  it('the observation still names the food and the bed as missing, but says the gate is open once armoured', () => {
    expect(descentKitNotice(body(70, NIGHT, [], IRON_SUIT))).toEqual({ missing: ['cooked_food', 'bed'], gated: false });
    expect(descentKitNotice(body(70, NIGHT))).toEqual({ missing: ['armor', 'cooked_food', 'bed'], gated: true });
  });
});

describe('the night slept through before the work (the owner: "ベッドがあれば寝て夜を飛ばす")', () => {
  it('sleeps only at night, with a bed, nobody else awake, no hostile near, standing, once a night', () => {
    const bot = body(64, NIGHT, [{ name: 'white_bed' }]);
    expect(sleepRefusal(bot)).toBeNull();
    expect(sleepRefusal(body(64, NOON, [{ name: 'white_bed' }]))).toBe('not_night');
    expect(sleepRefusal(body(64, NIGHT))).toBe('no_bed');
    const watched = body(64, NIGHT, [{ name: 'white_bed' }]);
    watched.players = { Rai1241: { username: 'Rai1241', gamemode: 0 } };
    expect(sleepRefusal(watched)).toBe('others_awake');
    watched.players = { Rai1241: { username: 'Rai1241', gamemode: 3 } };   // a spectator does not keep the night
    expect(sleepRefusal(watched)).toBeNull();
    const zombie = body(64, NIGHT, [{ name: 'white_bed' }]);
    zombie.entities = { 7: { name: 'zombie', position: new Vec3(4, 64, 0) } };
    expect(sleepRefusal(zombie)).toBe('hostile_near');
    const nether = body(64, NIGHT, [{ name: 'white_bed' }]); nether.game.dimension = 'the_nether';
    expect(sleepRefusal(nether)).toBe('not_overworld');
    expect(NIGHT_SLEEP_SKILLS.has('stair-mine')).toBe(true);
    expect(NIGHT_SLEEP_SKILLS.has('flee-from')).toBe(false);
  });

  it('says the morning came and the bed was taken back; does not try again the same night', async () => {
    const bot = body(64, NIGHT, [{ name: 'white_bed' }]);
    const run = vi.fn(async () => ({ success: true, result: 'ベッドを設置して眠り、朝になりました。ベッドは拾い直しました' }));
    expect(await sleepThroughNight(bot, run)).toBe('（夜だったので、先にベッドで眠って朝にしました。ベッドは拾い直しました）');
    expect(run).toHaveBeenCalledWith('sleep-in-bed', false, false);
    expect(await sleepThroughNight(bot, run)).toBe('');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a night that did not end: gets up and takes the bed it set down', async () => {
    const bot = body(64, NIGHT, [{ name: 'white_bed' }]);
    bot.wake = vi.fn(async () => { bot.isSleeping = false; });
    const run = vi.fn(async (name: string) => name === 'sleep-in-bed'
      ? (bot.isSleeping = true, { success: true, result: 'ベッドを設置して眠りました。置いたベッドは(3, 64, -2)にあります（起きたら dig-block-at takeEquipment=true で拾えます）' })
      : { success: true, result: 'white_bedを持ち物に入れました' });
    const note = await sleepThroughNight(bot, run);
    expect(bot.wake).toHaveBeenCalled();
    expect(run).toHaveBeenLastCalledWith('dig-block-at', 3, 64, -2, true, 'target', true);
    expect(note).toBe('（夜だったのでベッドで眠りましたが、夜は明けませんでした。ベッドは拾い直しました）');
  });
});
