import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { advance, approach, installFireballDeflect, LEAD_CAP, leadPoint, returnTicks, shooterOf, STRIKE_RANGE } from '../../src/services/minebot/utils/fireballDeflect.js';

const eyes = new Vec3(0.5, 65.62, 0.5);

describe('a ghast\'s fireball is struck back along the line of the look (paid runs L77c, L77e, L77f died to them)', () => {
  it('tells a ball coming at the body from one passing by or flying away, and counts the ticks until it is in reach', () => {
    const coming = approach(eyes, { position: new Vec3(0.5, 66, 20.5), velocity: new Vec3(0, 0, -1.5) });
    expect(coming.incoming).toBe(true);
    expect(coming.ticksToReach).toBeCloseTo((coming.distance - STRIKE_RANGE) / 1.5, 0);
    expect(approach(eyes, { position: new Vec3(8.5, 66, 20.5), velocity: new Vec3(0, 0, -1.5) }).incoming).toBe(false);   // passes eight blocks to the side
    expect(approach(eyes, { position: new Vec3(0.5, 66, 20.5), velocity: new Vec3(0, 0, 1.5) }).incoming).toBe(false);    // going away
    expect(approach(eyes, { position: new Vec3(0.5, 66, 20.5), velocity: new Vec3(0, 0, 0) }).incoming).toBe(false);      // not moving yet
  });

  it('counts the flight back (one block a tick at first, gaining) and leads a drifting ghast by it', () => {
    expect(returnTicks(1)).toBe(1);
    expect(returnTicks(30)).toBeGreaterThan(15);
    expect(returnTicks(30)).toBeLessThan(30);
    const still = leadPoint(new Vec3(0, 66, 3), { position: new Vec3(0, 70, 33), height: 4 });
    expect(still).toMatchObject({ x: 0, y: 72, z: 33 });                    // its middle
    const drifting = leadPoint(new Vec3(0, 66, 3), { position: new Vec3(0, 70, 33), velocity: new Vec3(0.2, 0, 0), height: 4 });
    expect(drifting.x).toBeGreaterThan(3);                                   // some twenty ticks of drift ahead of it
    expect(drifting.x).toBeLessThan(6);
    // Never further ahead than the cap: a ghast changes its mark, and a long lead on its drift now loses more than it gains.
    const fast = leadPoint(new Vec3(0, 66, 3), { position: new Vec3(0, 70, 60), velocity: new Vec3(0.4, 0, 0), height: 4 });
    expect(fast.x).toBeCloseTo(LEAD_CAP, 1);
  });

  it('takes the ghast back along the ball\'s path for the shooter, not one off to the side', () => {
    const behind = { id: 2, name: 'ghast', position: new Vec3(0, 70, 40) };
    const aside = { id: 3, name: 'ghast', position: new Vec3(40, 70, 0) };
    const ball = { position: new Vec3(0.5, 66, 10.5), velocity: new Vec3(0, -0.1, -1.5) };
    expect(shooterOf({ entities: { 2: behind, 3: aside } }, ball)).toBe(behind);
    expect(shooterOf({ entities: { 3: aside } }, ball)).toBeNull();
  });

  it('carries a ball forward between the server\'s words by the server\'s own rule (measured: a word every ten ticks, the last one six blocks off)', () => {
    // As measured in the lab: told at 20.3 blocks with speed 1.21, told again ten ticks later 13.6 blocks nearer with speed 1.46.
    let ball = { position: new Vec3(0, 0, 20.32), velocity: new Vec3(0, 0, -1.21) };
    for (let step = 0; step < 10; step++) ball = advance(ball);
    expect(20.32 - ball.position.z).toBeGreaterThan(12.8);
    expect(20.32 - ball.position.z).toBeLessThan(14.4);
    expect(ball.velocity.norm()).toBeGreaterThan(1.4);
    expect(ball.velocity.norm()).toBeLessThan(1.56);
  });

  it('strikes a ball the server has not spoken of for ten ticks, at the tick it comes into reach', () => {
    const ghast = { id: 2, name: 'ghast', position: new Vec3(0.5, 70, 40.5), height: 4 };
    // Last word: 20 blocks off, coming at 1.2 a tick. Nothing more is said (the next word would come after it has hit).
    const ball = { id: 3, name: 'fireball', position: new Vec3(0.5, 66, 20.5), velocity: new Vec3(0, 0, -1.2) };
    const struckAt: number[] = [];
    let now = 0;
    const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, position: new Vec3(0.5, 64, 0.5) }, health: 20, entities: { 2: ghast, 3: ball },
      look: () => {}, attack: () => { struckAt.push(now); }, getControlState: () => false, setControlState: () => {} });
    installFireballDeflect(bot);
    let truth = { position: ball.position.clone(), velocity: ball.velocity.clone() };
    const eyes = new Vec3(0.5, 65.62, 0.5);
    let distanceAtFirstBlow = -1;
    for (now = 1; now <= 16; now++) {
      bot.emit('physicsTick');
      if (struckAt.length && distanceAtFirstBlow < 0) distanceAtFirstBlow = truth.position.distanceTo(eyes);
      truth = advance(truth);
    }
    expect(struckAt.length).toBeGreaterThan(0);
    // The first blow goes a tick before the ball is in reach (it costs nothing if the server finds it too far);
    // the blows go on every tick after, so at least two land inside the six blocks the server allows.
    expect(distanceAtFirstBlow).toBeLessThan(7.2);
    expect(distanceAtFirstBlow).toBeGreaterThan(1.5);
    expect(struckAt.length).toBeGreaterThanOrEqual(3);
  });

  it('turns the look to the ghast as the ball closes, stops walking, and strikes once it is in reach', () => {
    const ghast = { id: 2, name: 'ghast', position: new Vec3(0.5, 70, 40.5), height: 4 };
    const ball = { id: 3, name: 'fireball', position: new Vec3(0.5, 66.5, 20.5), velocity: new Vec3(0, 0, 0) };
    const controls: Record<string, boolean> = { forward: true, sprint: true };
    const looks: Array<{ yaw: number; pitch: number }> = [];
    const struck: unknown[] = [];
    const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, position: new Vec3(0.5, 64, 0.5) }, health: 20, entities: { 2: ghast, 3: ball },
      look: (yaw: number, pitch: number) => { looks.push({ yaw, pitch }); }, attack: (entity: unknown) => { struck.push(entity); },
      getControlState: (name: string) => !!controls[name], setControlState: (name: string, value: boolean) => { controls[name] = value; } });
    installFireballDeflect(bot);
    for (let step = 0; step < 14 && struck.length === 0; step++) {
      ball.position = ball.position.offset(0, -0.01, -1.5);
      bot.emit('physicsTick');
    }
    expect(struck).toEqual([ball]);
    expect(ball.position.distanceTo(new Vec3(0.5, 65.62, 0.5))).toBeLessThanOrEqual(STRIKE_RANGE + 2);
    expect(controls.forward).toBe(false);
    // Looking south and up, at the ghast: yaw near pi (towards +z), pitch above level.
    expect(Math.abs(looks.at(-1)!.yaw)).toBeCloseTo(Math.PI, 1);
    expect(looks.at(-1)!.pitch).toBeGreaterThan(0.1);
    expect(looks.length).toBeGreaterThan(2);                                 // aimed for some ticks before the blow
    expect(bot.fireballDeflect.strikes).toBe(1);
  });

  it('leads the ghast by the step between the server\'s last two words of it, and takes one long unspoken of to be still', () => {
    const run = (stepEvery: number | null) => {
      const ghast = { id: 2, name: 'ghast', position: new Vec3(0.5, 70, 40.5), height: 4 };
      const ball = { id: 3, name: 'fireball', position: new Vec3(0.5, 66.5, 26.5), velocity: new Vec3(0, 0, 0) };
      const looks: number[] = [];
      const struck: unknown[] = [];
      const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, position: new Vec3(0.5, 64, 0.5) }, health: 20, entities: { 2: ghast, 3: ball },
        look: (yaw: number) => { looks.push(yaw); }, attack: (entity: unknown) => { struck.push(entity); }, getControlState: () => false, setControlState: () => {} });
      installFireballDeflect(bot);
      for (let step = 0; step < 20 && struck.length === 0; step++) {
        ball.position = ball.position.offset(0, -0.01, -1.5);
        // The server speaks of the ghast every third tick: 0.9 of a block east each time (0.3 a tick).
        if (stepEvery && step < 9 && step % stepEvery === 0) ghast.position = ghast.position.offset(0.9, 0, 0);
        bot.emit('physicsTick');
      }
      expect(struck.length).toBe(1);
      return looks.at(-1)!;
    };
    // East is +x, and a look with +x in it has a negative sine of yaw.
    expect(Math.abs(Math.sin(run(null)))).toBeLessThan(0.03);          // a ghast that never moved: straight at it
    expect(Math.sin(run(3))).toBeLessThan(-0.12);                      // drifting east: led east of where it is
  });

  it('leaves a blaze\'s small fireball and a ball passing wide alone', () => {
    const struck: unknown[] = [];
    const small = { id: 3, name: 'small_fireball', position: new Vec3(0.5, 66, 6.5) };
    const wide = { id: 4, name: 'fireball', position: new Vec3(10.5, 66, 6.5) };
    const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, position: new Vec3(0.5, 64, 0.5) }, health: 20, entities: { 3: small, 4: wide },
      look: () => {}, attack: (entity: unknown) => { struck.push(entity); }, getControlState: () => false, setControlState: () => {} });
    installFireballDeflect(bot);
    for (let step = 0; step < 6; step++) {
      small.position = small.position.offset(0, 0, -1); wide.position = wide.position.offset(0, 0, -1.5);
      bot.emit('physicsTick');
    }
    expect(struck).toEqual([]);
  });
});
