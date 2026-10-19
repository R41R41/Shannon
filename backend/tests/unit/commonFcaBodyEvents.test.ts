import { describe, expect, it, vi } from 'vitest';
import { BODY_EVENTS, BodyEventWatcher } from '../../src/services/minebot/integration/commonFca/bodyEvents.js';
import { CommonFcaControlLoop, type CommonFcaActuator } from '../../src/services/minebot/integration/commonFca/controlLoop.js';
import type { NearbyNeed } from '../../src/services/minebot/cognition/types.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');

function body() {
  let clock = NOW;
  const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, items: [] as Array<{ name: string; count: number }>,
    inventory: { items: () => bot.items } };
  let needs: NearbyNeed[] = [];
  const watcher = new BodyEventWatcher(bot, () => clock, () => needs);
  return { bot, watcher, setNeeds: (list: NearbyNeed[]) => { needs = list; },
    advance: (ms: number) => { clock += ms; watcher.tick(); } };
}
const need = (id: string, fields: Partial<NearbyNeed> = {}): NearbyNeed => ({ id, need: 'iron', name: 'iron_ore', position: { x: 16, y: 43, z: 0 },
  distance: 16, canReach: true, ...fields });
const kinds = (watcher: BodyEventWatcher) => watcher.pending(999).map(event => event.kind);

describe('body events (mb-arch stage 1)', () => {
  it('tells a move that stops getting closer as stalled once, and again only after it got somewhere', () => {
    const f = body();
    f.watcher.begin({ id: 'op1', skill: 'move-to', arguments: { x: 40, y: 64, z: 0 } });
    f.bot.entity.position.x = 10; f.advance(2_000);
    for (let i = 0; i < 7; i++) f.advance(2_000);
    expect(kinds(f.watcher).filter(kind => kind === 'action.stalled')).toHaveLength(0);
    f.advance(2_000);
    const stalled = f.watcher.pending(999).filter(event => event.kind === 'action.stalled');
    expect(stalled).toHaveLength(1);
    expect(stalled[0]).toMatchObject({ subject: 'op1', data: { skill: 'move-to', measure: 'target', distance: 30 } });
    expect(Number(stalled[0].data.sinceProgressMs)).toBeGreaterThanOrEqual(BODY_EVENTS.stallMs);
    for (let i = 0; i < 10; i++) f.advance(2_000);
    expect(kinds(f.watcher).filter(kind => kind === 'action.stalled')).toHaveLength(1);
    f.bot.entity.position.x = 15; f.advance(2_000);
    for (let i = 0; i < 8; i++) f.advance(2_000);
    expect(kinds(f.watcher).filter(kind => kind === 'action.stalled')).toHaveLength(2);
  });

  it('counts what a dig brings in as progress, and measures nothing for a wait', () => {
    const dig = body();
    dig.watcher.begin({ id: 'dig', skill: 'mc.mine-block', arguments: { blockName: 'iron_ore', count: 6 } });
    for (let i = 0; i < 20; i++) { dig.bot.items = [{ name: 'raw_iron', count: i + 1 }]; dig.advance(2_000); }
    expect(kinds(dig.watcher)).not.toContain('action.stalled');
    expect(dig.watcher.pending(999).at(-1)?.data).toMatchObject({ skill: 'mine-block', gained: 20 });
    const wait = body();
    wait.watcher.begin({ id: 'wait', skill: 'wait-time', arguments: { milliseconds: 58_000 } });
    for (let i = 0; i < 20; i++) wait.advance(2_000);
    expect(kinds(wait.watcher)).not.toContain('action.stalled');
    expect(kinds(wait.watcher).filter(kind => kind === 'action.progress').length).toBeGreaterThanOrEqual(19);
    wait.watcher.end('wait'); const before = wait.watcher.pending(999).length; wait.advance(10_000);
    expect(wait.watcher.pending(999).length).toBe(before);
  });

  it('measures stair-mine by the height still to go and an exploration by the ground it covers', () => {
    const stair = body();
    stair.watcher.begin({ id: 's', skill: 'stair-mine', arguments: { targetY: 44 } });
    for (let i = 0; i < 10; i++) { stair.bot.entity.position.y -= 1; stair.advance(2_000); }
    expect(kinds(stair.watcher)).not.toContain('action.stalled');
    const walk = body();
    walk.watcher.begin({ id: 'w', skill: 'explore-for-structure', arguments: {} });
    for (let i = 0; i < 10; i++) { walk.bot.entity.position.x += i % 2 ? 1 : -1; walk.advance(2_000); }
    expect(kinds(walk.watcher)).toContain('action.stalled');
  });

  it('does not count pacing between two spots as ground covered, and counts a move going round as progress', () => {
    const pace = body();
    pace.watcher.begin({ id: 'p', skill: 'mine-block', arguments: {} });
    for (let i = 0; i < 10; i++) { pace.bot.entity.position.x = i % 2 ? 0 : 5; pace.advance(2_000); }
    expect(kinds(pace.watcher)).toContain('action.stalled');
    const round = body();
    round.watcher.begin({ id: 'r', skill: 'move-to', arguments: { x: 40, z: 0 } });
    for (let i = 0; i < 10; i++) { round.bot.entity.position.z += 3; round.advance(2_000); }
    expect(kinds(round.watcher)).not.toContain('action.stalled');
  });

  it('tells a need again when whether it can be got at changed', () => {
    const f = body();
    f.setNeeds([need('iron:b:16,43,0')]); f.advance(BODY_EVENTS.needsEveryMs);
    f.setNeeds([need('iron:b:16,43,0', { canReach: false, why: 'failed_recently' })]); f.advance(BODY_EVENTS.needsEveryMs);
    f.advance(BODY_EVENTS.needsEveryMs);
    expect(f.watcher.pending(999).map(event => [event.kind, event.data.canReach])).toEqual([['need.appeared', true], ['need.appeared', false]]);
  });

  it('tells a need when it comes into the list, and as gone only after two readings without it', () => {
    const f = body();
    f.setNeeds([need('b:16,43,0'), need('e:7', { need: 'food', name: 'pig', distance: 9, position: { x: 9, y: 64, z: 0 } })]);
    f.advance(BODY_EVENTS.needsEveryMs);
    expect(f.watcher.pending(999).map(event => [event.kind, event.subject])).toEqual([['need.appeared', 'b:16,43,0'], ['need.appeared', 'e:7']]);
    expect(f.watcher.pending(999)[1].data).toMatchObject({ need: 'food', name: 'pig', distance: 9, canReach: true, x: 9 });
    f.setNeeds([need('b:16,43,0')]);
    f.advance(BODY_EVENTS.needsEveryMs);
    expect(f.watcher.pending(999)).toHaveLength(2);
    f.advance(BODY_EVENTS.needsEveryMs);
    expect(f.watcher.pending(999).at(-1)).toMatchObject({ kind: 'need.gone', subject: 'e:7', data: { need: 'food', name: 'pig' } });
    f.advance(BODY_EVENTS.needsEveryMs);
    expect(f.watcher.pending(999)).toHaveLength(3);
  });

  it('drops what the API took, and when too many wait, the oldest progress first', () => {
    const f = body();
    f.setNeeds([need('b:1,1,1')]); f.advance(BODY_EVENTS.needsEveryMs); f.setNeeds([need('b:1,1,1')]);
    f.watcher.begin({ id: 'op', skill: 'wait-time', arguments: {} });
    for (let i = 0; i < BODY_EVENTS.max + 10; i++) f.advance(BODY_EVENTS.progressEveryMs);
    const all = f.watcher.pending(999);
    expect(all).toHaveLength(BODY_EVENTS.max);
    expect(all[0].kind).toBe('need.appeared');
    expect(f.watcher.pending()).toHaveLength(BODY_EVENTS.perPoll);
    f.watcher.acknowledge(all[10].seq);
    expect(f.watcher.pending(999)[0].seq).toBe(all[11].seq);
  });
});

describe('control loop carries the body events', () => {
  function loop(reply: (request: any) => Record<string, unknown>) {
    let clock = NOW, sequence = 0;
    const requests: any[] = [];
    const queue = [{ seq: 1, at: new Date(NOW).toISOString(), kind: 'need.appeared' as const, subject: 'b:1,1,1', data: { need: 'iron' } }];
    const events = { tick: vi.fn(), pending: vi.fn(() => queue.slice()), acknowledge: vi.fn((through: number) => { while (queue[0] && queue[0].seq <= through) queue.shift(); }) };
    const actuator: CommonFcaActuator = { skills: [], events, observe: () => ({ schemaVersion: 1, bodyId: 'minecraft:home', sequence: ++sequence,
      stateAt: new Date(clock).toISOString(), receivedAt: new Date(clock).toISOString(), state: {}, facts: {}, connected: true }),
      candidates: () => [], execute: vi.fn(), release: vi.fn(async () => true) };
    const control = new CommonFcaControlLoop({ baseUrl: 'http://127.0.0.1:3000', token: 'fake-device-token', serverId: 'home', connectionId: 'connection1',
      now: () => clock, actuator, fetcher: vi.fn(async (_, init) => { const request = JSON.parse(init!.body as string); requests.push(request);
        return new Response(JSON.stringify({ schemaVersion: 1, mode: 'common-fca', commands: [], cancel: [], acknowledged: [], ...reply(request) })); }) });
    return { control, requests, events, queue, advance: (ms: number) => { clock += ms; } };
  }

  it('sends the events until the API says it took them', async () => {
    const f = loop(request => request.events ? { eventsThrough: request.events.at(-1).seq } : {});
    await f.control.poll();
    expect(f.requests[0].events).toEqual([expect.objectContaining({ seq: 1, kind: 'need.appeared' })]);
    expect(f.events.acknowledge).toHaveBeenCalledWith(1);
    await f.control.poll();
    expect(f.requests[1].events).toBeUndefined();
    await f.control.stop();
  });

  it('stops offering them to an API that does not read them, and offers them again a minute later', async () => {
    const f = loop(() => ({}));
    await f.control.poll(); await f.control.poll();
    expect(f.requests[0].events).toHaveLength(1);
    expect(f.requests[1].events).toBeUndefined();
    f.advance(60_000); await f.control.poll();
    expect(f.requests[2].events).toHaveLength(1);
    expect(f.events.acknowledge).not.toHaveBeenCalled();
    await f.control.stop();
  });
});
