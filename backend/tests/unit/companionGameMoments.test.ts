import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { GAME_MOMENT_LIMITS, watchGameMoments, type GameMomentDetail, type GameMomentType } from '../../src/services/minebot/integration/companionGameMoments.js';
import { CompanionBodyClient } from '../../src/services/minebot/integration/CompanionBodyClient.js';

/** Phase 2 of her Minecraft body (owner 2026-10-26): what happens to her body, as closed game events; nothing waits on them. */
function fixture() {
  let clock = 1_000_000;
  const bot = new EventEmitter() as any;
  Object.assign(bot, { username: 'I_am_Shannon', health: 20, oxygenLevel: 20, game: { dimension: 'overworld' }, time: { timeOfDay: 6000 },
    entity: { position: { x: 0, y: 64, z: 0 }, velocity: { y: 0 } }, entities: {}, players: {}, inventory: { items: () => bot.items },
    items: [{ name: 'iron_ingot', count: 3 }], registry: { blocksByName: { nether_bricks: { id: 42 } } }, findBlock: () => null });
  const sent: Array<{ type: GameMomentType; detail?: GameMomentDetail }> = [];
  const reflexes: string[] = [];
  const watch = watchGameMoments(bot, { send: (type, detail) => sent.push({ type, ...(detail ? { detail } : {}) }),
    reflex: expression => reflexes.push(expression), ownerName: () => 'Rai1241', now: () => clock,
    setTimer: () => 0 as any, clearTimer: () => {} });
  return { bot, sent, reflexes, watch, advance: (ms: number) => { clock += ms; } };
}
const types = (sent: Array<{ type: string }>) => sent.map(item => item.type);

describe('game moments of her Minecraft body', () => {
  it('tells a hit of one heart or more, small ones at most every 20 s, bad ones at once, with a reflex face', () => {
    const { bot, sent, reflexes, advance } = fixture();
    bot.health = 19.5; bot.emit('health');
    expect(sent).toEqual([]);
    bot.health = 17; bot.emit('health');
    expect(sent).toEqual([{ type: 'game.hurt', detail: { strength: 0.13 } }]);
    expect(reflexes).toEqual(['surprised']);
    bot.health = 15; bot.emit('health');
    expect(sent).toHaveLength(1);
    bot.health = 7; bot.emit('health');
    expect(sent.at(-1)).toEqual({ type: 'game.hurt', detail: { strength: 0.4 } });
    advance(GAME_MOMENT_LIMITS.smallHitEveryMilliseconds);
    bot.health = 5; bot.emit('health');
    expect(sent).toHaveLength(3);
    // Healing and dying are not hits.
    bot.health = 20; bot.emit('health'); bot.health = 0; bot.emit('health');
    expect(sent).toHaveLength(3);
  });

  it('tells each danger at most once a minute', () => {
    const { bot, sent, watch, advance } = fixture();
    bot.entity.isInLava = true; watch.check(); watch.check();
    expect(sent).toEqual([{ type: 'game.danger', detail: { cause: 'danger:lava' } }]);
    bot.entity.isInLava = false; bot.entity.isInWater = true; bot.oxygenLevel = 4; watch.check();
    expect(sent.at(-1)).toEqual({ type: 'game.danger', detail: { cause: 'danger:drown' } });
    bot.entity.isInWater = false; bot.entity.velocity.y = -1.5; watch.check();
    expect(sent.at(-1)!.detail).toEqual({ cause: 'danger:fall' });
    bot.entity.velocity.y = 0;
    bot.entities = { 1: { name: 'creeper', position: { x: 2, y: 64, z: 0 } } }; watch.check();
    expect(sent.at(-1)!.detail).toEqual({ cause: 'danger:explosion' });
    bot.entities = { 1: { type: 'hostile', position: { x: 2, y: 64, z: 0 } }, 2: { type: 'hostile', position: { x: 0, y: 64, z: 3 } },
      3: { type: 'hostile', position: { x: -4, y: 64, z: 0 } } }; watch.check();
    expect(sent.at(-1)!.detail).toEqual({ cause: 'danger:mob' });
    bot.entities = {}; bot.entity.isInLava = true; watch.check();
    expect(sent.filter(item => item.detail?.cause === 'danger:lava')).toHaveLength(1);
    advance(GAME_MOMENT_LIMITS.dangerEveryMilliseconds); watch.check();
    expect(sent.filter(item => item.detail?.cause === 'danger:lava')).toHaveLength(2);
  });

  it('tells each first once: not what she carried when she came in; a dimension, a fortress, the dragon', () => {
    const { bot, sent, watch, advance } = fixture();
    watch.check();
    expect(sent).toEqual([]);
    bot.items = [...bot.items, { name: 'diamond', count: 1 }]; watch.check(); watch.check();
    expect(sent).toEqual([{ type: 'game.milestone', detail: { cause: 'milestone:first_diamond' } }]);
    bot.game.dimension = 'minecraft:the_nether'; watch.check();
    expect(sent.at(-1)!.detail).toEqual({ cause: 'milestone:nether_entered' });
    bot.findBlock = ({ matching }: { matching: number }) => matching === 42 ? {} : null; watch.check();
    expect(sent.at(-1)!.detail).toEqual({ cause: 'milestone:nether_entered' });
    advance(GAME_MOMENT_LIMITS.fortressEveryMilliseconds); watch.check();
    expect(sent.at(-1)!.detail).toEqual({ cause: 'milestone:fortress_found' });
    bot.items = [...bot.items, { name: 'blaze_rod', count: 1 }]; watch.check();
    expect(sent.at(-1)!.detail).toEqual({ cause: 'milestone:blaze_rod' });
    bot.game.dimension = 'overworld'; watch.check(); bot.game.dimension = 'the_nether'; watch.check();
    expect(sent.filter(item => item.detail?.cause === 'milestone:nether_entered')).toHaveLength(1);
    bot.emit('entityDead', { name: 'ender_dragon' }); bot.emit('entityDead', { name: 'ender_dragon' });
    expect(sent.filter(item => item.detail?.cause === 'milestone:dragon_killed')).toHaveLength(1);
    expect(types(sent).every(type => type === 'game.milestone')).toBe(true);
  });

  it('tells a night lived through in the Overworld, and not one she died in', () => {
    const { bot, sent, watch } = fixture();
    bot.time.timeOfDay = 18_000; watch.check(); bot.time.timeOfDay = 23_500; watch.check();
    expect(types(sent)).toEqual(['game.night_survived']);
    bot.time.timeOfDay = 18_000; watch.check(); bot.emit('death'); bot.time.timeOfDay = 23_500; watch.check();
    expect(types(sent)).toEqual(['game.night_survived']);
  });

  it('tells the owner come near only after five minutes away', () => {
    const { bot, sent, watch, advance } = fixture();
    const near = { entity: { position: { x: 2, y: 64, z: 0 } } }, far = { entity: { position: { x: 50, y: 64, z: 0 } } };
    bot.players = { Rai1241: near }; watch.check();
    expect(sent).toEqual([]);
    bot.players = { Rai1241: far }; advance(60_000); watch.check();
    bot.players = { Rai1241: near }; watch.check();
    expect(sent).toEqual([]);
    bot.players = { Rai1241: far }; watch.check(); advance(GAME_MOMENT_LIMITS.ownerAwayMilliseconds); watch.check();
    bot.players = { Rai1241: near }; watch.check();
    expect(types(sent)).toEqual(['game.owner_near']);
  });

  it('removes its listeners when disposed', () => {
    const { bot, watch } = fixture();
    watch.dispose();
    expect(bot.listenerCount('health') + bot.listenerCount('entityDead') + bot.listenerCount('death') + bot.listenerCount('spawn')).toBe(0);
  });
});

describe('a game moment on the wire', () => {
  it('sends each type with only its own closed fields, once, and answers false on failure', async () => {
    const bodies: any[] = [];
    let status = 200;
    const client = new CompanionBodyClient({ baseUrl: 'http://127.0.0.1:4329', token: 'synthetic-token-123456', serverId: 'shannon-home',
      fetcher: (async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response('{}', { status }); }) as any });
    expect(await client.gameEvent('game.hurt', { strength: 0.456, cause: 'minecraft:mob_attack' }, true)).toBe(true);
    expect(await client.gameEvent('game.danger', { cause: 'danger:lava' }, false)).toBe(true);
    expect(await client.gameEvent('game.owner_near', { cause: 'danger:lava' }, false)).toBe(true);
    status = 500;
    expect(await client.gameEvent('game.milestone', { cause: 'milestone:first_diamond' }, false)).toBe(false);
    expect(bodies).toHaveLength(4);
    const events = bodies.map(body => body.events[0]);
    expect(events[0]).toMatchObject({ type: 'game.hurt', audience: 'others', strength: 0.46, cause: 'minecraft:mob_attack' });
    expect(events[1]).toMatchObject({ type: 'game.danger', audience: 'owner', cause: 'danger:lava' });
    expect(events[1].strength).toBeUndefined();
    expect(Object.keys(events[2]).sort()).toEqual(['audience', 'id', 'occurredAt', 'type']);
    expect(events[0].id).toMatch(/^shannon-home-hurt-\d+-[0-9a-f]{8}$/u);
  });
});
