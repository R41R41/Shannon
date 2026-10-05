import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { CombatEventHandler } from '../../src/services/minebot/eventReaction/handlers/CombatEventHandler.js';

describe('Minebot hostile approach transitions', () => {
  it('reports a tracked hostile again when it crosses the critical boundary', () => {
    const zombie = { id: 2, name: 'zombie', position: new Vec3(12, 64, 0) };
    const bot: any = {
      entity: { id: 1, position: new Vec3(0, 64, 0) },
      entities: { 2: zombie },
    };
    const handler = new CombatEventHandler(bot);

    expect(handler.checkHostileApproach()?.threatLevel).toBe('warning');
    expect(handler.checkHostileApproach()).toBeNull();
    zombie.position = new Vec3(7, 64, 0);
    expect(handler.checkHostileApproach()?.threatLevel).toBe('critical');
    expect(handler.checkHostileApproach()).toBeNull();
  });

  it('re-arms when a hostile leaves and later returns', () => {
    const zombie = { id: 2, name: 'zombie', position: new Vec3(7, 64, 0) };
    const bot: any = { entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: { 2: zombie } };
    const handler = new CombatEventHandler(bot);
    expect(handler.checkHostileApproach()?.threatLevel).toBe('critical');
    zombie.position = new Vec3(40, 64, 0);
    expect(handler.checkHostileApproach()).toBeNull();
    zombie.position = new Vec3(7, 64, 0);
    expect(handler.checkHostileApproach()?.threatLevel).toBe('critical');
  });

  it('a hostile still far off that will be here before the body can get safe is an emergency now (paid runs L70, L72: shelters refused as "arrives in 0 seconds")', () => {
    // A zombie 22 blocks off, seen to close at 2.4 blocks a second: on the body in about 8 seconds.
    const zombie = { id: 2, name: 'zombie', position: new Vec3(22, 64, 0) };
    const now = Date.now();
    const closing = (rate: number) => ({ samples: new Map([[2, [{ at: now - 2000, distance: 22 + rate * 2 }, { at: now, distance: 22 }]]]) });
    const bot: any = { entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: { 2: zombie }, threatMotion: closing(2.4) };
    const handler = new CombatEventHandler(bot);
    const event = handler.checkHostileApproach();
    expect(event).toMatchObject({ eventType: 'hostile_approach', threatLevel: 'critical', mobCount: 1 });
    expect(event!.allHostiles[0]).toMatchObject({ mobType: 'zombie', distance: 22, arrivesInSeconds: 8 });
    expect(handler.arrivingBeyond(16)).toHaveLength(1);
    // The same zombie at the same distance, wandering (not closing), or drifting in slowly: nothing yet.
    const idle = new CombatEventHandler({ ...bot, threatMotion: closing(0) });
    expect(idle.checkHostileApproach()).toBeNull();
    const slow = new CombatEventHandler({ ...bot, threatMotion: closing(1) }); // 20 seconds off
    expect(slow.checkHostileApproach()).toBeNull();
    expect(slow.arrivingBeyond(16)).toEqual([]);
    // Inside the usual range and not closing: a warning, as before. Closing: an emergency.
    const near = { id: 2, name: 'zombie', position: new Vec3(13, 64, 0) };
    expect(new CombatEventHandler({ ...bot, entities: { 2: near }, threatMotion: closing(0) }).checkHostileApproach()?.threatLevel).toBe('warning');
    const nearClosing = { samples: new Map([[2, [{ at: now - 2000, distance: 17.8 }, { at: now, distance: 13 }]]]) };
    expect(new CombatEventHandler({ ...bot, entities: { 2: near }, threatMotion: nearClosing }).checkHostileApproach()?.threatLevel).toBe('critical');
  });

  it('a kind measured to hit from further than hostiles are watched for is watched out to that reach (paid run L77e: a ghast at thirty blocks)', () => {
    const ghast = { id: 2, name: 'ghast', position: new Vec3(27, 70, 0) };
    const bot: any = { entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: { 2: ghast } };
    // Before it has ever hit the body from there, it is out of the watch.
    expect(new CombatEventHandler(bot).checkHostileApproach()).toBeNull();
    const taught = new CombatEventHandler(bot);
    taught.setReachProvider(name => (name === 'ghast' ? 30 : 0));
    expect(taught.checkHostileApproach()?.threatLevel).toBe('critical');
    // Beyond what it has been measured to reach, it is left alone again.
    ghast.position = new Vec3(40, 70, 0);
    const further = new CombatEventHandler(bot);
    further.setReachProvider(name => (name === 'ghast' ? 30 : 0));
    expect(further.checkHostileApproach()).toBeNull();
  });

  it('a kind whose attack a reflex of the body answers is not an emergency for standing in its range (paid run L77j: a ghast 59 blocks off)', () => {
    const ghast = { id: 2, name: 'ghast', position: new Vec3(27, 70, 0) };
    const bot: any = { entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: { 2: ghast }, reflexAnswers: new Set(['ghast']) };
    const taught = new CombatEventHandler(bot);
    taught.setReachProvider(name => (name === 'ghast' ? 30 : 0));
    expect(taught.checkHostileApproach()).toBeNull();
    // Close enough to be watched as anything hostile is, it is seen, and not as critical for its reach alone.
    ghast.position = new Vec3(12, 66, 0);
    expect(taught.checkHostileApproach()?.threatLevel).toBe('warning');
  });

  it('a kind measured to hit from afar is critical within that reach', () => {
    const skeleton = { id: 2, name: 'skeleton', position: new Vec3(14, 64, 0) };
    const bot: any = { entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: { 2: skeleton } };
    const untaught = new CombatEventHandler(bot);
    expect(untaught.checkHostileApproach()?.threatLevel).toBe('warning');
    const taught = new CombatEventHandler(bot);
    taught.setReachProvider(name => (name === 'skeleton' ? 15.3 : 0));
    expect(taught.checkHostileApproach()?.threatLevel).toBe('critical');
  });
});

