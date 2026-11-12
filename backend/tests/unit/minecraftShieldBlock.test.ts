import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import minecraftData from 'minecraft-data';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { flyOn, holdShieldForDraw, impact, installShieldBlock, msSinceShotComing, ownShot, shooterAt } from '../../src/services/minebot/utils/shieldBlock.js';
import { installToldVelocity, toldVelocity } from '../../src/services/minebot/utils/toldVelocity.js';
import { answeredByReflex, answerWith } from '../../src/services/minebot/utils/reflexAnswers.js';
import { beginEngagement } from '../../src/services/minebot/utils/engagement.js';
import { installFireballDeflect } from '../../src/services/minebot/utils/fireballDeflect.js';
import { emptyCombatStats, estimateEncounter, incomingDamagePerSecond, mergeCombatStats, shootsAtBody } from '../../src/modules/minecraftLearning/index.js';
import { EncounterMemory } from '../../src/services/minebot/learning/EncounterMemory.js';
import { createMotorPort, executeAction, physicalRoots } from '../../src/services/minebot/execution/ActionExecution.js';

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

function waitingBody(): any {
  const bot = body();
  bot.controls.forward = false; bot.controls.sprint = false;
  bot.usingHeldItem = false;
  const activate = bot.activateItem, deactivate = bot.deactivateItem;
  bot.activateItem = (off: boolean) => { bot.usingHeldItem = true; activate(off); };
  bot.deactivateItem = () => { bot.usingHeldItem = false; deactivate(); };
  bot.attack = vi.fn();
  bot.entities[2] = { id: 2, name: 'wither_skeleton', type: 'hostile', position: new Vec3(2.5, 64, 0.5), height: 2.4 };
  bot.blockAt = (at: Vec3) => ({ boundingBox: at.y < 64 ? 'block' : 'empty' });
  return bot;
}

describe('the head waiting between defensive hands keeps a passive shield, without another movement owner', () => {
  it('continues guarding after the hand ends its engagement, without attacks, steps or another activation gap', () => {
    const bot = waitingBody();
    installShieldBlock(bot);
    const end = beginEngagement(bot, ['wither_skeleton']);
    bot.emit('physicsTick');
    expect(bot.shieldBlock.up).toBe(true);
    end();
    for (let tick = 0; tick < 20; tick++) bot.emit('physicsTick');
    expect(bot.shieldBlock.idleMeleeGuard).toBe(true);
    expect(bot.usingHeldItem).toBe(true);
    expect(bot.calls.filter((call: string) => call.startsWith('raise'))).toEqual(['raise true']);
    expect(bot.calls).not.toContain('lower');
    expect(bot.controls).toEqual({ forward: false, sprint: false });
    expect(bot.attack).not.toHaveBeenCalled();
    expect(physicalRoots(bot)).toEqual([]);
  });

  it.each(['gone', 'far', 'above', 'running', 'broken', 'dead', 'disabled'])(
    'releases a waiting guard when the threat or the safe idle condition is %s', reason => {
      const bot = waitingBody();
      installShieldBlock(bot); bot.emit('physicsTick');
      expect(bot.shieldBlock.up).toBe(true);
      if (reason === 'gone') delete bot.entities[2];
      if (reason === 'far') bot.entities[2].position = new Vec3(9.5, 64, 0.5);
      if (reason === 'above') bot.entity.position = new Vec3(0.5, 67, 0.5);
      if (reason === 'running') bot.controls.forward = true;
      if (reason === 'broken') bot.inventory.slots[45] = null;
      if (reason === 'dead') bot.health = 0;
      if (reason === 'disabled') bot.shieldBlock.enabled = false;
      bot.emit('physicsTick');
      expect(bot.shieldBlock.up).toBe(false);
      expect(bot.shieldBlock.idleMeleeGuard).toBe(false);
      expect(bot.usingHeldItem).toBe(false);
      expect(bot.calls.at(-1)).toBe('lower');
      expect(bot.controls.forward).toBe(reason === 'running');
    },
  );

  it('leaves a neutral enderman alone and does not guard or look through a sealed shelter', () => {
    const neutral = waitingBody();
    neutral.entities[2].name = 'enderman';
    installShieldBlock(neutral); neutral.emit('physicsTick');
    expect(neutral.calls).toEqual([]);
    const sealed = waitingBody();
    sealed.blockAt = (at: Vec3) => ({ boundingBox: Math.floor(at.x) === 0 && Math.floor(at.z) === 0
      && [64, 65].includes(Math.floor(at.y)) ? 'empty' : 'block' });
    installShieldBlock(sealed); sealed.emit('physicsTick');
    expect(sealed.calls).toEqual([]);
  });

  it.each([false, true])('a new physical owner releases the idle shield before its own look and movement (safety=%s)', async safetyLease => {
    const bot = waitingBody();
    installShieldBlock(bot); bot.emit('physicsTick');
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const untilDone = new Promise<void>(resolve => { release = resolve; });
    const running = executeAction(bot, safetyLease ? 'flee-from' : 'act', 5000, async () => {
      const port = createMotorPort(bot);
      expect(bot.usingHeldItem).toBe(false); // released at acquisition, before consuming/looking/walking could be disturbed
      port.look(-1.23, 0, true); port.setControlState('forward', true);
      entered(); await untilDone;
      return { success: true, result: 'owner finished' };
    }, { priority: safetyLease ? 300 : 0, safetyLease, waitForQuiescence: true });
    try {
      await started;
      const before = bot.calls.length;
      bot.emit('physicsTick');
      expect(bot.calls.slice(before)).toEqual([]);
      expect(bot.controls.forward).toBe(true);
      expect(bot.shieldBlock.idleMeleeGuard).toBe(false);
      expect(physicalRoots(bot)).toHaveLength(1);
    } finally { release(); await running; }
  });
});


/** 1.21.11の実際のsound/inventory pluginで、パケットから通知・Itemまでを通す。接続はしない。 */
function serverBody() {
  const bot = body();
  const registry = minecraftData('1.21.11');
  Object.assign(bot, { registry, version: '1.21.11', supportFeature: registry.supportFeature, QUICK_BAR_START: 36 });
  const require = createRequire(import.meta.url);
  require('mineflayer/lib/plugins/inventory.js')(bot, { hideErrors: true });
  require('mineflayer/lib/plugins/sound.js')(bot);
  bot.quickBarSlot = 0;
  installShieldBlock(bot);
  const slot = (used: number | null, index = 45) => bot._client.emit('set_slot', { windowId: 0, stateId: 1, slot: index,
    item: used === null ? { itemCount: 0 } : { itemId: registry.itemsByName.shield.id, itemCount: 1, components: [{ type: 'damage', data: used }], removeComponents: [] } });
  // wire: node-minecraft-protocolが実際に返す形（holderの n-1。1.21.11のminecraft-dataのidより1小さい）。
  const sound = (at = bot.entity.position, named = false, name = 'item.shield.block', wire = false) => bot._client.emit('sound_effect', {
    sound: named ? { data: { soundName: `minecraft:${name}` } } : { soundId: (registry as unknown as { soundsArray: Array<{ name: string; id: number }> }).soundsArray.find(s => s.name === name)!.id - (wire ? 1 : 0) },
    soundCategory: 'player', x: Math.trunc(at.x * 8), y: Math.trunc(at.y * 8), z: Math.trunc(at.z * 8), volume: 1, pitch: 1,
  });
  return { bot, slot, sound };
}

describe('1.21.11のサーバーが確かめた盾の受けと摩耗', () => {
  it('火の玉を受けた成功音を数え、耐久や構えから受けた数を推測しない', () => {
    const { bot, slot, sound } = serverBody();
    slot(0);
    bot.entities[7] = { id: 7, name: 'small_fireball', type: 'projectile', position: new Vec3(0.5, 65, 0.5) };
    slot(6); // 摩耗だけでは回数や相手は分からない
    expect(bot.shieldBlock.shieldCaught).toBe(0);
    sound(); sound(bot.entity.position, true);
    bot._client.emit('entity_status', { entityId: 1, entityStatus: 29 });
    expect(bot.shieldBlock.shieldCaught).toBe(2);
    expect(bot.shieldBlock.shieldWear).toBe(6);
    bot._client.emit('damage_event', { entityId: 1, sourceDirectId: 8, sourceCauseId: 10 });
    bot.health = 15; bot.emit('health');
    expect(bot.shieldBlock.shieldMissed).toBe(1);
    expect(bot.shieldBlock.shieldCaught).toBe(2);
  });

  it('別の位置・同じ位置の別人・盾の無効化音は自分の受けにしない', () => {
    const { bot, sound } = serverBody();
    sound(new Vec3(1.5, 64, 0.5));
    sound(bot.entity.position, false, 'item.shield.break');
    bot.entities[2] = { id: 2, type: 'player', position: bot.entity.position.clone() };
    sound();
    expect(bot.shieldBlock.shieldCaught).toBe(0);
    delete bot.entities[2];
    bot.entity.position = new Vec3(-0.54, 64, -0.54);
    sound(); // 負座標でもパケットの1/8マス丸めを許す
    expect(bot.shieldBlock.shieldCaught).toBe(1);
  });

  it('ライブラリが1つ手前の音に読むidでも数え、走って1〜2tickずれた位置も自分の受けにする', () => {
    const { bot, sound } = serverBody();
    const heard: string[] = [];
    bot.on('soundEffectHeard', (name: string) => heard.push(name));
    sound(bot.entity.position, false, 'item.shield.block', true);
    expect(heard).toEqual(['block.shelf.take_item']); // mineflayerの名前は手前の音になる
    expect(bot.shieldBlock.shieldCaught).toBe(1);
    sound(bot.entity.position.offset(0.45, 0, -0.3), false, 'item.shield.block', true);
    expect(bot.shieldBlock.shieldCaught).toBe(2);
    sound(bot.entity.position.offset(0.9, 0, 0), false, 'item.shield.block', true);
    expect(bot.shieldBlock.shieldCaught).toBe(2);
  });

  it('破損の最後の摩耗と予備の摩耗を足し、装備・空slot・死亡・再送で消さない', () => {
    const { bot, slot } = serverBody();
    slot(320); // 場面以前の摩耗を足さない
    const before = bot.shieldBlock.shieldWear;
    slot(326); slot(326);
    bot._client.emit('entity_status', { entityId: 1, entityStatus: 48 });
    slot(null); slot(0); slot(6); slot(18);
    expect(bot.shieldBlock.shieldWear - before).toBe(16 + 18);
    // ローカルな持ち替えはserverのset_slotではない。
    const spare = { name: 'shield', durabilityUsed: 90, slot: 45 };
    bot.inventory.updateSlot(45, spare); slot(90); slot(96);
    expect(bot.shieldBlock.shieldWear - before).toBe(16 + 18 + 6);
    slot(null); bot.emit('respawn'); slot(0);
    expect(bot.shieldBlock.shieldWear - before).toBe(40);
  });
});

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

  it('in a fight the planner chose, keeps the shield up against whoever is within a blow, and strikes from behind it', () => {
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
    expect(bot.calls.slice(-1)).toEqual(['strike']);                       // the blow goes out with the shield up (lab, 2026-11-03)
    bot.emit('physicsTick');
    expect(bot.calls.filter((call: string) => call === 'lower')).toEqual([]);
    bot.entities[2].position = new Vec3(9.5, 64, 0.5);                     // out of reach: down
    bot.emit('physicsTick');
    expect(bot.calls.at(-1)).toBe('lower');
    end();
  });

  it('raises it again when another hand lowered it (a fight\'s own deactivateItem, a bow), in a guard or against a shot', () => {
    const bot = body();
    bot.entities[2] = { id: 2, name: 'zombie', type: 'hostile', position: new Vec3(2.5, 64, 0.5), height: 1.9 };
    installShieldBlock(bot);
    const end = beginEngagement(bot, ['zombie']);
    bot.usingHeldItem = false;
    bot.emit('physicsTick');
    expect(bot.calls).toEqual(['raise true']);
    bot.usingHeldItem = true;
    bot.emit('physicsTick');
    bot.usingHeldItem = false;                                              // lowered elsewhere: the hand says so
    bot.emit('physicsTick');
    expect(bot.calls.filter((call: string) => call === 'raise true')).toHaveLength(2);
    end();
    delete bot.entities[2];
    bot.usingHeldItem = true;
    shoot(bot, 5, new Vec3(13.5, 65.6, 0.5), new Vec3(-1.6, 0.12, 0));
    bot.emit('physicsTick');
    bot.usingHeldItem = false;
    bot.emit('physicsTick');
    expect(bot.calls.filter((call: string) => call === 'raise true')).toHaveLength(3);
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

describe('a bow draw holds the hands (lab s1d1107: among blazes the reflex kept every draw from starting)', () => {
  it('lowers a raised shield for the draw, keeps off the hands while it is held, and raises again after the release', () => {
    const bot = body();
    installShieldBlock(bot);
    shoot(bot, 5, new Vec3(13.5, 65.6, 0.5), new Vec3(-1.6, 0.12, 0));
    bot.emit('physicsTick');
    expect(bot.shieldBlock.up).toBe(true);
    expect(msSinceShotComing(bot)).toBeLessThan(50);
    bot.calls.length = 0;
    const hold = holdShieldForDraw(bot, 5000);
    expect(hold.lowered).toBe(true);
    expect(bot.calls).toEqual(['lower']);
    bot.usingHeldItem = true;                                   // the bow is drawn
    shoot(bot, 6, new Vec3(13.5, 65.6, 0.5), new Vec3(-1.6, 0.12, 0));
    for (let tick = 0; tick < 12; tick++) bot.emit('physicsTick');
    expect(bot.calls).toEqual(['lower']);                       // no raise, no lower, no turn while the bow is drawn
    bot.usingHeldItem = false;                                  // released
    hold.release();
    shoot(bot, 7, new Vec3(13.5, 65.6, 0.5), new Vec3(-1.6, 0.12, 0));
    bot.emit('physicsTick');
    expect(bot.calls.filter((call: string) => call.startsWith('raise'))).toEqual(['raise true']);
  });
  it('lowers nothing when the shield was down, and a stale release does not free a newer hold', () => {
    const bot = body();
    installShieldBlock(bot);
    const first = holdShieldForDraw(bot, 5000);
    expect(first.lowered).toBe(false);
    expect(bot.calls).toEqual([]);
    const second = holdShieldForDraw(bot, 6000);
    first.release();
    expect(bot.shieldBlock.drawUntil).toBeDefined();
    second.release();
    expect(bot.shieldBlock.drawUntil).toBeUndefined();
    expect(msSinceShotComing({})).toBe(Infinity);
  });
});

describe('the body\'s own arrow (end1108h13: the shield went up "arrow, in 0 ticks" after each shot among the blazes)', () => {
  it('is not taken as a shot coming at the body: leaving the eyes outward, or with no speed told while a draw just ended', () => {
    const bot = body();
    installShieldBlock(bot);
    bot.calls.length = 0;
    shoot(bot, 30, new Vec3(0.5, 65.52, 0.5), new Vec3(0, 1.0, 2.5));
    for (let tick = 0; tick < 4; tick++) bot.emit('physicsTick');
    expect(bot.calls.filter((call: string) => call.startsWith('raise'))).toEqual([]);
    expect(bot.controls.forward).toBe(true);
    holdShieldForDraw(bot, 1000).release();
    bot.entities[31] = { id: 31, name: 'arrow', type: 'projectile', position: new Vec3(0.5, 65.6, 1.0), velocity: new Vec3(0, 0, 0) };
    for (let tick = 0; tick < 4; tick++) bot.emit('physicsTick');
    expect(bot.calls.filter((call: string) => call.startsWith('raise'))).toEqual([]);
  });
  it('still raises the shield for an arrow near the eyes coming in', () => {
    const bot = body();
    installShieldBlock(bot);
    shoot(bot, 32, new Vec3(0.5, 65.5, 2.5), new Vec3(0, 0, -2.5));
    bot.emit('physicsTick');
    expect(bot.calls.some((call: string) => call.startsWith('raise'))).toBe(true);
  });
  it('ownShot: near and outward is own, far or inward is not', () => {
    const eyes = new Vec3(0, 65.62, 0);
    expect(ownShot(eyes, new Vec3(0, 65.6, 0.5), new Vec3(0, 0, 2), false)).toBe(true);
    expect(ownShot(eyes, new Vec3(0, 65.6, 0.5), new Vec3(0, 0, -2), true)).toBe(false);
    expect(ownShot(eyes, new Vec3(0, 65.6, 4), new Vec3(0, 0, 2), true)).toBe(false);
    expect(ownShot(eyes, new Vec3(0, 65.6, 0.5), undefined, false)).toBe(false);
    // As the game spawns it: at the eyes 0.1 below, aimed up at a blaze (end1108h14: the dot rule missed these).
    expect(ownShot(eyes, new Vec3(0, 65.52, 0), new Vec3(0.3, 1.2, 2.2), false)).toBe(true);
    expect(ownShot(eyes, new Vec3(0, 65.52, 0), new Vec3(0, -0.4, 2.8), false)).toBe(true);
  });
});

// Run 8 (11/13, design-skeleton B1): of 86 raises 8 caught an arrow; most came 0 to 4 ticks before the hit (the server counts a shield five ticks after it goes up).
// A skeleton is seen drawing (its living-entity flags' "hand in use" bit) about twenty ticks before its arrow leaves: the shield goes up for the draw.
describe('the shield goes up for a skeleton drawing its bow (run 8)', () => {
  const registry = minecraftData('1.21.4');
  function drawingScene(yaw?: number) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const bot = body();
    bot.registry = registry;
    if (yaw !== undefined) bot.entity.yaw = yaw;
    const metadata: unknown[] = []; metadata[8] = 0;
    bot.entities[5] = { id: 5, name: 'skeleton', type: 'hostile', position: new Vec3(0.5, 64, -9.5), height: 1.99, metadata };
    installShieldBlock(bot);
    const draw = (on: boolean) => { metadata[8] = on ? 1 : 0; };
    const tickFor = (ms: number) => { for (let t = 0; t < ms; t += 50) { vi.setSystemTime(Date.now() + 50); bot.emit('physicsTick'); } };
    return { bot, draw, tickFor };
  }
  it('raises it about ten ticks before the arrow can come, not at the start of the draw, and turns to the skeleton behind', () => {
    try {
      const { bot, draw, tickFor } = drawingScene(0);   // yaw 0 faces north (-z)... the skeleton is moved behind below
      bot.entities[5].position = new Vec3(0.5, 64, 10.5);   // south: behind a body facing north
      draw(true); bot.emit('physicsTick');
      expect(bot.shieldBlock.up).toBe(false);              // 20 + 10/1.6 ticks away
      tickFor(800);
      expect(bot.shieldBlock.up).toBe(true);
      expect(bot.shieldBlock.drawRaised).toBe(1);
      expect(bot.shieldBlock.keepLegs).toBe(false);
      expect(bot.calls.some((call: string) => call.startsWith('look'))).toBe(true);
      expect(bot.controls.forward).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('does not turn or stop the legs for a skeleton in front', () => {
    try {
      const { bot, draw, tickFor } = drawingScene(0);   // facing north, the skeleton 10 m north
      draw(true); tickFor(800);
      expect(bot.shieldBlock.up).toBe(true);
      expect(bot.shieldBlock.keepLegs).toBe(true);
      expect(bot.calls.some((call: string) => call.startsWith('look'))).toBe(false);
      expect(bot.controls.forward).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('a draw let go early, a zombie, or a skeleton beyond 16 m raises nothing', () => {
    try {
      const early = drawingScene(0);
      early.draw(true); early.tickFor(300); early.draw(false); early.tickFor(1500);
      expect(early.bot.shieldBlock.raised).toBe(0);
      const zombie = drawingScene(0);
      zombie.bot.entities[5].name = 'zombie'; zombie.draw(true); zombie.tickFor(1500);
      expect(zombie.bot.shieldBlock.raised).toBe(0);
      const far = drawingScene(0);
      far.bot.entities[5].position = new Vec3(0.5, 64, -20.5); far.draw(true); far.tickFor(1500);
      expect(far.bot.shieldBlock.raised).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
