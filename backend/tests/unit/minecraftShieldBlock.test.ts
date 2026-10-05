import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { flyOn, impact, installShieldBlock, shooterAt } from '../../src/services/minebot/utils/shieldBlock.js';
import { installToldVelocity, toldVelocity } from '../../src/services/minebot/utils/toldVelocity.js';
import { answeredByReflex, answerWith } from '../../src/services/minebot/utils/reflexAnswers.js';
import { beginEngagement } from '../../src/services/minebot/utils/engagement.js';
import { installFireballDeflect } from '../../src/services/minebot/utils/fireballDeflect.js';
import { emptyCombatStats, estimateEncounter, incomingDamagePerSecond, mergeCombatStats, shootsAtBody } from '../../src/modules/minecraftLearning/index.js';
import { EncounterMemory } from '../../src/services/minebot/learning/EncounterMemory.js';

function body(offHand: string | null = 'shield'): any {
  const client = new EventEmitter();
  const calls: string[] = [];
  const controls: Record<string, boolean> = { forward: true, sprint: true };
  const bot: any = Object.assign(new EventEmitter(), { _client: client, entity: { id: 1, position: new Vec3(0.5, 64, 0.5) }, health: 20, entities: {},
    inventory: { slots: Object.assign([], { 45: offHand ? { name: offHand } : null }) }, getEquipmentDestSlot: () => 45,
    look: (yaw: number) => { calls.push(`look ${yaw.toFixed(2)}`); }, activateItem: (off: boolean) => { calls.push(`raise ${off}`); }, deactivateItem: () => { calls.push('lower'); },
    getControlState: (name: string) => !!controls[name], setControlState: (name: string, value: boolean) => { controls[name] = value; }, calls, controls });
  return bot;
}
/** An arrow as the server sends it: where it is when shot, and its speed in the one packet that says it. */
function shoot(bot: any, id: number, from: Vec3, velocity: Vec3, name = 'arrow') {
  bot.entities[id] = { id, name, type: 'projectile', position: from.clone(), velocity: new Vec3(0, 0, 0) };
  bot._client.emit('spawn_entity', { entityId: id, velocity: { x: velocity.x, y: velocity.y, z: velocity.z } });
}

describe('what the server said of a speed is kept as it said it (the library holds an arrow leaving a bow at 1.6 as 0.0002)', () => {
  it('keeps the speed of the packet, in blocks a tick, for either form of the packet, and forgets an entity that is gone', () => {
    const bot = body();
    installToldVelocity(bot);
    bot._client.emit('spawn_entity', { entityId: 7, velocity: { x: -1.6, y: 0.15, z: 0 } });
    expect(toldVelocity(bot, 7)!.x).toBeCloseTo(-1.6);
    bot._client.emit('entity_velocity', { entityId: 7, velocityX: 8000, velocityY: -4000, velocityZ: 0 });   // before 1.21.9: whole numbers, 8000 to the block
    expect(toldVelocity(bot, 7)).toMatchObject({ x: 1, y: -0.5, z: 0 });
    expect(toldVelocity(bot, 8)).toBeNull();
    bot.emit('entityGone', { id: 7 });
    expect(toldVelocity(bot, 7)).toBeNull();
  });
});

describe('a shot is carried on by the game\'s own rule, and one that will pass through the body is told from one that will not', () => {
  it('an arrow slows a little and falls; a fireball gains along its path', () => {
    const arrow = flyOn('arrow', { position: new Vec3(0, 70, 0), velocity: new Vec3(1.6, 0, 0) });
    expect(arrow.position.x).toBeCloseTo(1.6);
    expect(arrow.velocity.x).toBeCloseTo(1.584);
    expect(arrow.velocity.y).toBeCloseTo(-0.05);
    const ball = flyOn('small_fireball', { position: new Vec3(0, 70, 0), velocity: new Vec3(0.5, 0, 0) });
    expect(ball.velocity.x).toBeCloseTo(0.57);
    expect(ball.velocity.y).toBe(0);
  });

  it('says when an arrow shot at the body arrives, and nothing for one shot past it or away from it', () => {
    const at = new Vec3(0.5, 64, 0.5);
    const coming = impact(at, 'arrow', { position: new Vec3(13.5, 65.6, 0.5), velocity: new Vec3(-1.6, 0.12, 0) })!;
    expect(coming.ticks).toBeGreaterThan(6);
    expect(coming.ticks).toBeLessThan(10);
    expect(impact(at, 'arrow', { position: new Vec3(13.5, 65.6, 0.5), velocity: new Vec3(-1.6, 0.12, 0.5) })).toBeNull();   // four blocks wide of it
    expect(impact(at, 'arrow', { position: new Vec3(13.5, 65.6, 0.5), velocity: new Vec3(1.6, 0.12, 0) })).toBeNull();     // going the other way
  });
});

describe('the shield goes up at what is flying at the body (lab: a skeleton thirteen blocks off hit six times of thirteen without, once of fourteen with)', () => {
  it('raises it as soon as the shot is seen to be coming, turned to it and standing still, and lowers it a few ticks after', () => {
    const bot = body();
    installShieldBlock(bot);
    bot.emit('physicsTick');
    expect(bot.calls).toEqual([]);
    shoot(bot, 5, new Vec3(13.5, 65.6, 0.5), new Vec3(-1.6, 0.12, 0));
    bot.emit('physicsTick');
    expect(bot.calls.filter((call: string) => call.startsWith('raise'))).toEqual(['raise true']);   // the off hand
    expect(bot.calls[0]).toBe(`look ${(Math.atan2(-13, 0)).toFixed(2)}`);                           // east, where it comes from
    expect(bot.controls.forward).toBe(false);
    expect(bot.shieldBlock.raised).toBe(1);
    // The server says nothing more of the arrow; it is followed here until it has gone by, and the shield held on a little.
    for (let tick = 0; tick < 12; tick++) bot.emit('physicsTick');
    expect(bot.calls).not.toContain('lower');
    delete bot.entities[5];
    for (let tick = 0; tick < 8; tick++) bot.emit('physicsTick');
    expect(bot.calls.at(-1)).toBe('lower');
    expect(bot.shieldBlock.up).toBe(false);
  });

  it('waits with a slow shot seen far ahead until it is near, so that the look and the legs stay with what the body was doing', () => {
    const bot = body();
    installShieldBlock(bot);
    shoot(bot, 5, new Vec3(18.5, 65, 0.5), new Vec3(-0.45, 0, 0), 'small_fireball');     // a blaze's ball, some twenty ticks out
    bot.emit('physicsTick');
    expect(bot.calls).toEqual([]);
    expect(bot.controls.forward).toBe(true);
    for (let tick = 0; tick < 14 && bot.shieldBlock.raised === 0; tick++) bot.emit('physicsTick');
    expect(bot.shieldBlock.raised).toBe(1);                                               // up in time all the same
    expect(bot.calls).toContain('raise true');
  });

  it('does nothing without a shield in the off hand, for a shot going wide, or for what is no attack', () => {
    const bare = body(null);
    installShieldBlock(bare);
    shoot(bare, 5, new Vec3(13.5, 65.6, 0.5), new Vec3(-1.6, 0.12, 0));
    bare.emit('physicsTick');
    expect(bare.calls).toEqual([]);
    const bot = body();
    installShieldBlock(bot);
    shoot(bot, 5, new Vec3(13.5, 65.6, 0.5), new Vec3(-1.6, 0.12, 0.6));
    shoot(bot, 6, new Vec3(13.5, 65.6, 0.5), new Vec3(-1.6, 0.12, 0), 'ender_pearl');
    bot.emit('physicsTick');
    expect(bot.calls).toEqual([]);
    expect(bot.controls.forward).toBe(true);
  });

  it('in a fight the planner chose, keeps the shield up against whoever is within a blow, and lowers it for the body\'s own blow', () => {
    const bot = body();
    const blows: unknown[] = [];
    bot.attack = (entity: unknown) => { bot.calls.push('strike'); blows.push(entity); };
    bot.entities[2] = { id: 2, name: 'wither_skeleton', type: 'hostile', position: new Vec3(2.5, 64, 0.5), height: 2.4 };
    installShieldBlock(bot);
    bot.emit('physicsTick');
    expect(bot.calls).toEqual([]);                                         // not in a fight of its choosing: the legs are for running
    const end = beginEngagement(bot, ['wither_skeleton']);
    bot.emit('physicsTick');
    expect(bot.calls).toEqual(['raise true']);
    expect(bot.controls.forward).toBe(true);                               // the look and the legs stay the fight's own
    bot.attack(bot.entities[2]);
    expect(bot.calls.slice(-2)).toEqual(['lower', 'strike']);              // down for the blow
    bot.emit('physicsTick');
    expect(bot.calls.at(-1)).toBe('raise true');                           // and up again
    bot.entities[2].position = new Vec3(9.5, 64, 0.5);                     // out of reach: down
    bot.emit('physicsTick');
    expect(bot.calls.at(-1)).toBe('lower');
    end();
  });

  it('leaves a ghast\'s ball to the reflex that strikes it back while that one is on, and takes it when it is off', () => {
    const bot = body();
    bot.fireballDeflect = { enabled: true };
    installShieldBlock(bot);
    shoot(bot, 5, new Vec3(10.5, 65, 0.5), new Vec3(-1, 0, 0), 'fireball');
    bot.emit('physicsTick');
    expect(bot.shieldBlock.raised).toBe(0);
    bot.fireballDeflect.enabled = false;
    bot.emit('physicsTick');
    expect(bot.shieldBlock.raised).toBe(1);
  });
});

describe('a kind whose attack a reflex answers is said by the reflex, as a test asked again each time', () => {
  it('a kind is known to shoot because it was seen to, not from a list; one that only ever struck the body itself is not', () => {
    const memory = new EncounterMemory();
    memory.recordShot('skeleton');
    memory.recordShot('skeleton');
    memory.recordHit('skeleton', 2, 1.5, true);                            // one blow of its bow arm in contact
    memory.recordHit('zombie', 3, 1.2, true);
    memory.recordHit('blaze', 5, 30);                                      // hit from thirty blocks, the shot itself never seen leaving it
    memory.recordHit('creeper', 9, 3.5);                                   // hit from where a blow does not reach from afar
    expect(shootsAtBody(memory.stats(), 'skeleton')).toBe(true);
    expect(shootsAtBody(memory.stats(), 'zombie')).toBe(false);
    expect(shootsAtBody(memory.stats(), 'blaze')).toBe(true);              // nothing strikes from thirty blocks but a shot
    expect(shootsAtBody(memory.stats(), 'creeper')).toBe(false);
    expect(shootsAtBody(memory.stats(), 'pillager')).toBe(false);          // never met: nothing known
    // And it is kept across runs with the rest of what was measured.
    const kept = mergeCombatStats(mergeCombatStats(emptyCombatStats(), memory.stats()), memory.stats());
    expect(kept.mobs.skeleton).toMatchObject({ shots: 4, blows: 2 });
  });

  it('who shot is learned from where the shot began, with a shield or without one', () => {
    const bot = body(null);
    const shotAt: string[] = [];
    bot.shotAtBy = (kind: string) => { shotAt.push(kind); };
    bot.entities[2] = { id: 2, name: 'skeleton', type: 'hostile', position: new Vec3(13.5, 64, 0.5), height: 1.99 };
    bot.entities[3] = { id: 3, name: 'zombie', type: 'hostile', position: new Vec3(-9.5, 64, 0.5), height: 1.95 };
    installShieldBlock(bot);
    shoot(bot, 5, new Vec3(13.2, 65.6, 0.5), new Vec3(-1.6, 0.12, 0));
    for (let tick = 0; tick < 4; tick++) bot.emit('physicsTick');
    expect(shotAt).toEqual(['skeleton']);                                  // once for the shot, however long it is in the air
    expect(bot.calls).toEqual([]);                                         // and no shield to raise
    expect(shooterAt(bot, new Vec3(40, 70, 40), 99)).toBeNull();
  });

  it('the shield answers a shooter only while it is on the arm and its reflex is on; the ghast\'s ball only while its own reflex is on', () => {
    const bot = body();
    bot.shootsAtBody = (kind: string) => kind === 'skeleton' || kind === 'blaze';
    installShieldBlock(bot);
    installFireballDeflect(bot);
    expect(answeredByReflex(bot, 'skeleton')).toBe(true);
    expect(answeredByReflex(bot, 'Blaze')).toBe(true);
    expect(answeredByReflex(bot, 'zombie')).toBe(false);
    expect(answeredByReflex(bot, 'ghast')).toBe(true);
    bot.inventory.slots[45] = null;                                        // the shield broke
    expect(answeredByReflex(bot, 'skeleton')).toBe(false);
    bot.fireballDeflect.enabled = false;
    expect(answeredByReflex(bot, 'ghast')).toBe(false);
    expect(answeredByReflex({}, 'ghast')).toBe(false);
    const other: any = {};
    answerWith(other, () => { throw new Error('broken test'); });
    expect(answeredByReflex(other, 'ghast')).toBe(false);                  // a test that fails answers nothing
  });
});

describe('how fast a kind hurts is taken from its worst seconds, not from the whole time spent near it (lab continuation L77q: "nine seconds to die", dead in two)', () => {
  it('keeps the most a kind has taken within three seconds, and uses it when it is more than the average says', () => {
    const memory = new EncounterMemory();
    memory.recordContact('wither_skeleton', 60_000);                       // a minute near them, most of it behind a wall
    for (let blow = 0; blow < 3; blow++) memory.recordHit('wither_skeleton', 4.5, 1.5, true);
    const stats = memory.stats();
    expect(stats.mobs.wither_skeleton.peak3s).toBeCloseTo(13.5);
    expect(incomingDamagePerSecond(stats, 'wither_skeleton')).toBeCloseTo(4.5);          // not 13.5 over sixty seconds
    // One of them at full health is a race that can be run; two are not.
    const one = estimateEncounter(stats, { target: 'wither_skeleton', health: 20, threats: [{ name: 'wither_skeleton', distance: 0 }], carried: [], escapeFailing: true });
    const two = estimateEncounter(stats, { target: 'wither_skeleton', health: 20, threats: [{ name: 'wither_skeleton', distance: 0 }, { name: 'wither_skeleton', distance: 0 }], carried: [], escapeFailing: true });
    expect(one.timeToDieMs).toBeCloseTo(4444, -2);
    expect(two.timeToDieMs).toBeCloseTo(2222, -2);
    // Kept as the largest seen across runs.
    expect(mergeCombatStats(mergeCombatStats(emptyCombatStats(), stats), { ...emptyCombatStats(), mobs: { wither_skeleton: { hits: 1, damage: 4.5, maxHit: 4.5, contactMs: 0, peak3s: 4.5 } } }).mobs.wither_skeleton.peak3s).toBeCloseTo(13.5);
  });
});
