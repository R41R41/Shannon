import { describe, expect, it } from 'vitest';
import { CompanionBodyClient, chatLines, companionBaseUrl, deathCause } from '../../src/services/minebot/integration/CompanionBodyClient.js';

const token = 'x'.repeat(43);

describe('CompanionBodyClient', () => {
  it('only talks to a companion on this machine', () => {
    expect(companionBaseUrl('http://127.0.0.1:4329/')).toBe('http://127.0.0.1:4329');
    expect(() => companionBaseUrl('https://sh4nnon.com/companion')).toThrow('COMPANION_URL_MUST_BE_LOOPBACK');
  });

  it('sends what the player wrote and returns her reply and intent', async () => {
    const sent: any[] = [];
    const fetcher = (async (url: string, init: any) => {
      sent.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ reply: '任せて。', intent: { kind: 'task', goal: 'オークの原木を16個集める' }, duplicate: false }), { status: 201 });
    }) as unknown as typeof fetch;
    const client = new CompanionBodyClient({ baseUrl: 'http://127.0.0.1:4329', token, serverId: 'lab-0i4Tdi', fetcher });
    const turn = await client.turn({ speakerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146', speakerName: 'Rai1241', message: 'シャノン、木材集めといて' });
    expect(turn?.intent).toEqual({ kind: 'task', goal: 'オークの原木を16個集める' });
    expect(sent[0].url).toBe('http://127.0.0.1:4329/v1/body/minecraft/turns');
    expect(sent[0].auth).toBe(`Bearer ${token}`);
    expect(sent[0].body).toMatchObject({ serverId: 'lab-0i4Tdi', conversation: { kind: 'channel' },
      speaker: { uuid: 'b9191317-c52d-4d67-85fe-ab831e6db146', name: 'Rai1241' }, message: 'シャノン、木材集めといて' });
  });

  it('retries a server error once with the same request id, and gives up quietly', async () => {
    const ids: string[] = [];
    const fetcher = (async (_url: string, init: any) => {
      ids.push(JSON.parse(init.body).requestId);
      return new Response('{}', { status: 502 });
    }) as unknown as typeof fetch;
    const client = new CompanionBodyClient({ baseUrl: 'http://127.0.0.1:4329', token, serverId: 'lab-0i4Tdi', fetcher });
    expect(await client.turn({ speakerUuid: 'u', speakerName: 'Rai1241', message: 'やあ' })).toBeNull();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('reports a death as a closed game event', async () => {
    let body: any;
    const fetcher = (async (_url: string, init: any) => { body = JSON.parse(init.body); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    const client = new CompanionBodyClient({ baseUrl: 'http://127.0.0.1:4329', token, serverId: 'lab-0i4Tdi', fetcher });
    expect(await client.died('minecraft:lava', true)).toBe(true);
    expect(body.events[0]).toMatchObject({ type: 'game.died', audience: 'others', cause: 'minecraft:lava' });
    expect(Object.keys(body.events[0]).sort()).toEqual(['audience', 'cause', 'id', 'occurredAt', 'type']);
  });
});

describe('game chat helpers', () => {
  it('splits long replies at sentence ends within 256 characters', () => {
    const lines = chatLines(`${'あ'.repeat(200)}。${'い'.repeat(100)}`);
    expect(lines).toEqual([`${'あ'.repeat(200)}。`, 'い'.repeat(100)]);
    expect(chatLines('x'.repeat(600)).every(line => line.length <= 256)).toBe(true);
  });

  it('reads the damage type from the death message', () => {
    expect(deathCause('death.attack.lava')).toBe('minecraft:lava');
    expect(deathCause('death.attack.inFire')).toBe('minecraft:in_fire');
    expect(deathCause('death.attack.mob')).toBe('minecraft:mob_attack');
    expect(deathCause('death.fell.accident.ladder')).toBe('minecraft:fall');
    expect(deathCause('death.attack.drown.player')).toBe('minecraft:drown');
    expect(deathCause('chat.type.text')).toBe('minecraft:generic');
  });
});

describe('body present helpers', () => {
  it('names the part of the day and the advancement the chat announced', async () => {
    const { timeOfDayPart, advancementId } = await import('../../src/services/minebot/integration/CompanionBodyClient.js');
    expect([0, 6000, 12500, 18000, 23500].map(timeOfDayPart)).toEqual(['dawn', 'day', 'dusk', 'night', 'dawn']);
    expect(advancementId('advancements.story.smelt_iron.title')).toBe('minecraft:story/smelt_iron');
    expect(advancementId('chat.type.text')).toBeNull();
  });
});
